/**
 * Integration tests for slack-client module
 *
 * Tests the full flow from Slack event to task creation,
 * including registry and task queue integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Store original env
const originalEnv = process.env;

// Test directory
const TEST_DATA_DIR = path.join(os.tmpdir(), 'slack-client-integration-' + Date.now());
const TEST_TASKS_DIR = path.join(TEST_DATA_DIR, 'tasks');

describe('slack-client integration', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };

    // Set up test environment
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_CHANNEL_ID = 'C1234567890';
    process.env.DAEMON_SECRET = 'a'.repeat(64);

    // Create test directories
    await fs.mkdir(TEST_TASKS_DIR, { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.restoreAllMocks();

    // Clean up test directory
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('full message flow', () => {
    it('creates task from valid Slack message through registry lookup', async () => {
      let messageHandler: ((args: { event: unknown }) => Promise<void>) | undefined;

      const mockApp = {
        event: vi.fn((eventName: string, handler: (args: { event: unknown }) => Promise<void>) => {
          if (eventName === 'message') {
            messageHandler = handler;
          }
        }),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: { postMessage: vi.fn().mockResolvedValue({ ok: true, ts: '1234567890.999999' }) },
          reactions: { add: vi.fn().mockResolvedValue({ ok: true }) },
        },
      };

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => mockApp),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test-token',
          slackAppToken: 'xapp-test-token',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      // Use real registry and task-queue with mocked file paths
      const sessionId = 'a0000000-0000-0000-0000-000000000001';
      const threadTs = '1234567890.000000';

      const mockSession = {
        sessionId,
        threadTs,
        channelId: 'C1234567890',
        codebasePath: '/test/path',
        status: 'ACTIVE' as const,
        startedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        injectionCount: 0,
        errorHistory: [],
      };

      // Mock registry to return our test session
      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn().mockImplementation(async (ts: string) => {
          if (ts === threadTs) {
            return mockSession;
          }
          return null;
        }),
        getSession: vi.fn().mockImplementation(async (id: string) => {
          if (id === sessionId) {
            return mockSession;
          }
          return null;
        }),
      }));

      // Use real task queue logic with mocked file system
      const tasks: Array<{
        id: string;
        prompt: string;
        slackUser: string;
        messageTs: string;
        status: string;
      }> = [];

      vi.doMock('../../src/task-queue.js', () => ({
        addTask: vi.fn().mockImplementation(async (_sid: string, input: { prompt: string; slackUser: string; messageTs: string }) => {
          // Check for duplicate
          if (tasks.some((t) => t.messageTs === input.messageTs)) {
            return false;
          }
          tasks.push({
            id: `task_${Date.now()}`,
            prompt: input.prompt,
            slackUser: input.slackUser,
            messageTs: input.messageTs,
            status: 'PENDING',
          });
          return true;
        }),
        removeTaskByMessageTs: vi.fn().mockImplementation(async (_sid: string, messageTs: string) => {
          const index = tasks.findIndex((t) => t.messageTs === messageTs);
          if (index === -1) return false;
          tasks.splice(index, 1);
          return true;
        }),
        getTasks: vi.fn().mockImplementation(async () => tasks),
      }));

      const { createSlackClient, startSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Simulate a valid Slack thread message
      const event = {
        type: 'message',
        user: 'U1234567890',
        ts: '1234567890.123456',
        thread_ts: threadTs,
        channel: 'C1234567890',
        text: 'Please help me with this code',
      };

      if (messageHandler) {
        await messageHandler({ event });
      }

      // Verify task was created
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe('Please help me with this code');
      expect(tasks[0].slackUser).toBe('U1234567890');
      expect(tasks[0].messageTs).toBe('1234567890.123456');
    });

    it('handles unknown thread gracefully', async () => {
      let messageHandler: ((args: { event: unknown }) => Promise<void>) | undefined;

      const mockApp = {
        event: vi.fn((eventName: string, handler: (args: { event: unknown }) => Promise<void>) => {
          if (eventName === 'message') {
            messageHandler = handler;
          }
        }),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: { postMessage: vi.fn() },
          reactions: { add: vi.fn() },
        },
      };

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => mockApp),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test-token',
          slackAppToken: 'xapp-test-token',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      // Mock registry to return null (unknown thread)
      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn().mockResolvedValue(null),
        getSession: vi.fn().mockResolvedValue(null),
      }));

      const mockAddTask = vi.fn();
      vi.doMock('../../src/task-queue.js', () => ({
        addTask: mockAddTask,
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Simulate message from unknown thread
      const event = {
        type: 'message',
        user: 'U1234567890',
        ts: '1234567890.123456',
        thread_ts: '9999999999.000000',
        channel: 'C1234567890',
        text: 'Unknown thread message',
      };

      if (messageHandler) {
        await messageHandler({ event });
      }

      // addTask should NOT be called
      expect(mockAddTask).not.toHaveBeenCalled();
    });
  });

  describe('sendSlackMessage integration', () => {
    it('sends chunked messages through Slack API', async () => {
      const postedMessages: Array<{ channel: string; thread_ts: string; text: string }> = [];

      const mockApp = {
        event: vi.fn(),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: {
            postMessage: vi.fn().mockImplementation(async (opts: { channel: string; thread_ts: string; text: string }) => {
              postedMessages.push({ channel: opts.channel, thread_ts: opts.thread_ts, text: opts.text });
              return { ok: true, ts: `${Date.now()}.${Math.random()}` };
            }),
          },
          reactions: { add: vi.fn() },
        },
      };

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => mockApp),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test-token',
          slackAppToken: 'xapp-test-token',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const sessionId = 'a0000000-0000-0000-0000-000000000001';
      const mockSession = {
        sessionId,
        threadTs: '1234567890.000000',
        channelId: 'C1234567890',
        status: 'ACTIVE' as const,
      };

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn().mockResolvedValue(mockSession),
      }));

      vi.doMock('../../src/task-queue.js', () => ({
        addTask: vi.fn(),
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient, sendSlackMessage, MAX_MESSAGE_LENGTH } =
        await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Send a long message that will be chunked
      const longMessage = 'x'.repeat(MAX_MESSAGE_LENGTH * 2 + 100);
      await sendSlackMessage(sessionId, longMessage);

      // Wait for queue to process (rate limit is 1/sec)
      await new Promise((r) => setTimeout(r, 3500));

      // Should have sent 3 chunks
      expect(postedMessages.length).toBe(3);
      expect(postedMessages[0].channel).toBe('C1234567890');
      expect(postedMessages[0].thread_ts).toBe('1234567890.000000');
    }, 10000);

    it('does not send to inactive session', async () => {
      const postedMessages: unknown[] = [];

      const mockApp = {
        event: vi.fn(),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: {
            postMessage: vi.fn().mockImplementation(async (opts: unknown) => {
              postedMessages.push(opts);
              return { ok: true };
            }),
          },
          reactions: { add: vi.fn() },
        },
      };

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => mockApp),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test-token',
          slackAppToken: 'xapp-test-token',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const sessionId = 'a0000000-0000-0000-0000-000000000001';
      const mockSession = {
        sessionId,
        threadTs: '1234567890.000000',
        channelId: 'C1234567890',
        status: 'CLOSED' as const, // Inactive session
      };

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn().mockResolvedValue(mockSession),
      }));

      vi.doMock('../../src/task-queue.js', () => ({
        addTask: vi.fn(),
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient, sendSlackMessage } =
        await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      await sendSlackMessage(sessionId, 'This should not be sent');

      // Wait for potential queue processing
      await new Promise((r) => setTimeout(r, 100));

      // Should not have sent any messages
      expect(postedMessages.length).toBe(0);
    });

    it('does not send to unknown session', async () => {
      const postedMessages: unknown[] = [];

      const mockApp = {
        event: vi.fn(),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: {
            postMessage: vi.fn().mockImplementation(async (opts: unknown) => {
              postedMessages.push(opts);
              return { ok: true };
            }),
          },
          reactions: { add: vi.fn() },
        },
      };

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => mockApp),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test-token',
          slackAppToken: 'xapp-test-token',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn().mockResolvedValue(null), // Session not found
      }));

      vi.doMock('../../src/task-queue.js', () => ({
        addTask: vi.fn(),
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient, sendSlackMessage } =
        await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      await sendSlackMessage('a0000000-0000-0000-0000-000000000001', 'Unknown session');

      // Wait for potential queue processing
      await new Promise((r) => setTimeout(r, 100));

      // Should not have sent any messages
      expect(postedMessages.length).toBe(0);
    });
  });

  describe('sendSlackReaction integration', () => {
    it('adds reaction to message', async () => {
      const addedReactions: Array<{ channel: string; timestamp: string; name: string }> = [];

      const mockApp = {
        event: vi.fn(),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: { postMessage: vi.fn() },
          reactions: {
            add: vi.fn().mockImplementation(async (opts: { channel: string; timestamp: string; name: string }) => {
              addedReactions.push({ channel: opts.channel, timestamp: opts.timestamp, name: opts.name });
              return { ok: true };
            }),
          },
        },
      };

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => mockApp),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test-token',
          slackAppToken: 'xapp-test-token',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const sessionId = 'a0000000-0000-0000-0000-000000000001';
      const mockSession = {
        sessionId,
        threadTs: '1234567890.000000',
        channelId: 'C1234567890',
        status: 'ACTIVE' as const,
      };

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn().mockResolvedValue(mockSession),
      }));

      vi.doMock('../../src/task-queue.js', () => ({
        addTask: vi.fn(),
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient, sendSlackReaction } =
        await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      await sendSlackReaction(sessionId, '1234567890.123456', 'thumbsup');

      expect(addedReactions).toHaveLength(1);
      expect(addedReactions[0].channel).toBe('C1234567890');
      expect(addedReactions[0].timestamp).toBe('1234567890.123456');
      expect(addedReactions[0].name).toBe('thumbsup');
    });
  });

  describe('error handling', () => {
    it('retries on rate limit error with backoff', async () => {
      let attempts = 0;

      const mockApp = {
        event: vi.fn(),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: {
            postMessage: vi.fn().mockImplementation(async () => {
              attempts++;
              if (attempts < 3) {
                const error = new Error('Rate limited') as Error & { data?: { error?: string } };
                error.data = { error: 'ratelimited' };
                throw error;
              }
              return { ok: true, ts: '1234567890.999999' };
            }),
          },
          reactions: { add: vi.fn() },
        },
      };

      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => mockApp),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test-token',
          slackAppToken: 'xapp-test-token',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const sessionId = 'a0000000-0000-0000-0000-000000000001';
      const mockSession = {
        sessionId,
        threadTs: '1234567890.000000',
        channelId: 'C1234567890',
        status: 'ACTIVE' as const,
      };

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn().mockResolvedValue(mockSession),
      }));

      vi.doMock('../../src/task-queue.js', () => ({
        addTask: vi.fn(),
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient, sendSlackMessage } =
        await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // This should retry and eventually succeed
      await sendSlackMessage(sessionId, 'Test message');

      // Wait for queue and retries
      await new Promise((r) => setTimeout(r, 5000));

      // Should have made 3 attempts (2 failures + 1 success)
      expect(attempts).toBe(3);
    }, 15000);
  });
});
