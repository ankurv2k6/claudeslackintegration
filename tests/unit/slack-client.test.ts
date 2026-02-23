import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Store original env
const originalEnv = process.env;

// Test directory
const TEST_DATA_DIR = path.join(os.tmpdir(), 'slack-client-test-' + Date.now());

describe('slack-client', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };

    // Set up test environment
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_CHANNEL_ID = 'C1234567890';
    process.env.DAEMON_SECRET = 'a'.repeat(64);

    // Create test directories
    await fs.mkdir(path.join(TEST_DATA_DIR, 'tasks'), { recursive: true });
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

  describe('chunkMessage', () => {
    it('returns single chunk for short message', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { chunkMessage } = await import('../../src/slack-client.js');

      const chunks = chunkMessage('Hello world');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe('Hello world');
    });

    it('splits long message into multiple chunks', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { chunkMessage, MAX_MESSAGE_LENGTH } = await import('../../src/slack-client.js');

      // Create a message longer than MAX_MESSAGE_LENGTH
      const longMessage = 'x'.repeat(MAX_MESSAGE_LENGTH * 2.5);
      const chunks = chunkMessage(longMessage);

      expect(chunks).toHaveLength(3);
      expect(chunks[0].length).toBe(MAX_MESSAGE_LENGTH);
      expect(chunks[1].length).toBe(MAX_MESSAGE_LENGTH);
      expect(chunks[2].length).toBe(Math.ceil(MAX_MESSAGE_LENGTH * 0.5));
    });

    it('respects custom maxLength parameter', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { chunkMessage } = await import('../../src/slack-client.js');

      const message = 'Hello world, this is a test message';
      const chunks = chunkMessage(message, 10);

      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk, i) => {
        if (i < chunks.length - 1) {
          expect(chunk.length).toBeLessThanOrEqual(10);
        }
      });
    });

    it('handles empty message', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { chunkMessage } = await import('../../src/slack-client.js');

      const chunks = chunkMessage('');
      expect(chunks).toHaveLength(0);
    });
  });

  describe('sanitizeSlackText', () => {
    it('decodes user mentions', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { sanitizeSlackText } = await import('../../src/slack-client.js');

      const text = 'Hello <@U1234567890>, how are you?';
      const sanitized = sanitizeSlackText(text);

      expect(sanitized).toBe('Hello [user-mention], how are you?');
    });

    it('decodes channel mentions', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { sanitizeSlackText } = await import('../../src/slack-client.js');

      const text = 'Check out <#C1234567890|general>';
      const sanitized = sanitizeSlackText(text);

      expect(sanitized).toBe('Check out [channel-mention]');
    });

    it('decodes URLs with labels', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { sanitizeSlackText } = await import('../../src/slack-client.js');

      const text = 'Check out <https://example.com|Example Site>';
      const sanitized = sanitizeSlackText(text);

      expect(sanitized).toBe('Check out Example Site (https://example.com)');
    });

    it('decodes plain URLs', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { sanitizeSlackText } = await import('../../src/slack-client.js');

      const text = 'Visit <https://example.com>';
      const sanitized = sanitizeSlackText(text);

      expect(sanitized).toBe('Visit https://example.com');
    });

    it('removes control characters', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { sanitizeSlackText } = await import('../../src/slack-client.js');

      const text = 'Hello\x00\x01\x02World';
      const sanitized = sanitizeSlackText(text);

      expect(sanitized).toBe('HelloWorld');
    });

    it('preserves newlines', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { sanitizeSlackText } = await import('../../src/slack-client.js');

      const text = 'Hello\nWorld\nTest';
      const sanitized = sanitizeSlackText(text);

      expect(sanitized).toBe('Hello\nWorld\nTest');
    });

    it('truncates to 4000 characters', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { sanitizeSlackText } = await import('../../src/slack-client.js');

      const text = 'x'.repeat(5000);
      const sanitized = sanitizeSlackText(text);

      expect(sanitized.length).toBe(4000);
    });

    it('handles complex mixed content', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { sanitizeSlackText } = await import('../../src/slack-client.js');

      const text = 'Hey <@U1234567890>, check <#C9876543210|dev> and <https://docs.example.com|the docs>';
      const sanitized = sanitizeSlackText(text);

      expect(sanitized).toBe('Hey [user-mention], check [channel-mention] and the docs (https://docs.example.com)');
    });
  });

  describe('createSlackClient', () => {
    it('creates Bolt app instance', async () => {
      // Mock @slack/bolt
      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => ({
          event: vi.fn(),
          error: vi.fn(),
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          client: {
            chat: { postMessage: vi.fn() },
            reactions: { add: vi.fn() },
          },
        })),
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

      const { createSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      expect(app).toBeDefined();
    });
  });

  describe('startSlackClient', () => {
    it('registers event handlers and starts app', async () => {
      const mockApp = {
        event: vi.fn(),
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

      const { createSlackClient, startSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Verify event handlers were registered
      expect(mockApp.event).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockApp.error).toHaveBeenCalledWith(expect.any(Function));
      expect(mockApp.start).toHaveBeenCalled();
    });
  });

  describe('stopSlackClient', () => {
    it('stops the app gracefully', async () => {
      const mockApp = {
        event: vi.fn(),
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

      const { createSlackClient, startSlackClient, stopSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);
      await stopSlackClient(app);

      expect(mockApp.stop).toHaveBeenCalled();
    });

    it('throws error if stop fails', async () => {
      const mockApp = {
        event: vi.fn(),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockRejectedValue(new Error('Stop failed')),
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

      const { createSlackClient, startSlackClient, stopSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      await expect(stopSlackClient(app)).rejects.toThrow('Stop failed');
    });
  });

  describe('getQueueStatus', () => {
    it('returns queue status', async () => {
      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => ({
          event: vi.fn(),
          error: vi.fn(),
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          client: {
            chat: { postMessage: vi.fn() },
            reactions: { add: vi.fn() },
          },
        })),
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

      const { getQueueStatus } = await import('../../src/slack-client.js');

      const status = getQueueStatus();
      expect(status).toHaveProperty('pending');
      expect(status).toHaveProperty('size');
      expect(typeof status.pending).toBe('number');
      expect(typeof status.size).toBe('number');
    });
  });

  describe('message handler behavior', () => {
    it('ignores bot messages', async () => {
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

      // Mock registry and taskQueue to verify they're not called
      const mockAddTask = vi.fn();
      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn(),
      }));
      vi.doMock('../../src/task-queue.js', () => ({
        addTask: mockAddTask,
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Simulate bot message
      const botEvent = {
        type: 'message',
        bot_id: 'B1234567890',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000000',
        channel: 'C1234567890',
        text: 'Bot message',
      };

      if (messageHandler) {
        await messageHandler({ event: botEvent });
      }

      // addTask should not be called for bot messages
      expect(mockAddTask).not.toHaveBeenCalled();
    });

    it('ignores non-thread messages', async () => {
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

      const mockAddTask = vi.fn();
      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn(),
      }));
      vi.doMock('../../src/task-queue.js', () => ({
        addTask: mockAddTask,
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Simulate non-thread message (no thread_ts)
      const nonThreadEvent = {
        type: 'message',
        user: 'U1234567890',
        ts: '1234567890.123456',
        channel: 'C1234567890',
        text: 'Regular message',
      };

      if (messageHandler) {
        await messageHandler({ event: nonThreadEvent });
      }

      expect(mockAddTask).not.toHaveBeenCalled();
    });

    it('filters unauthorized users', async () => {
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
          authorizedUsers: ['U9999999999'], // Only this user is authorized
          logLevel: 'error',
        }),
      }));

      const mockAddTask = vi.fn();
      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn(),
      }));
      vi.doMock('../../src/task-queue.js', () => ({
        addTask: mockAddTask,
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Simulate message from unauthorized user
      const unauthorizedEvent = {
        type: 'message',
        user: 'U1234567890', // Not in authorizedUsers
        ts: '1234567890.123456',
        thread_ts: '1234567890.000000',
        channel: 'C1234567890',
        text: 'Unauthorized message',
      };

      if (messageHandler) {
        await messageHandler({ event: unauthorizedEvent });
      }

      expect(mockAddTask).not.toHaveBeenCalled();
    });

    it('filters messages from wrong channel', async () => {
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

      const mockAddTask = vi.fn();
      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn(),
      }));
      vi.doMock('../../src/task-queue.js', () => ({
        addTask: mockAddTask,
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Simulate message from wrong channel
      const wrongChannelEvent = {
        type: 'message',
        user: 'U1234567890',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000000',
        channel: 'C9999999999', // Wrong channel
        text: 'Wrong channel message',
      };

      if (messageHandler) {
        await messageHandler({ event: wrongChannelEvent });
      }

      expect(mockAddTask).not.toHaveBeenCalled();
    });

    it('routes valid thread message to session', async () => {
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

      const mockAddTask = vi.fn().mockResolvedValue(true);
      const mockSession = {
        sessionId: 'a0000000-0000-0000-0000-000000000001',
        threadTs: '1234567890.000000',
        channelId: 'C1234567890',
        status: 'ACTIVE',
      };

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn().mockResolvedValue(mockSession),
        getSession: vi.fn().mockResolvedValue(mockSession),
      }));
      vi.doMock('../../src/task-queue.js', () => ({
        addTask: mockAddTask,
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient } = await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Simulate valid thread message
      const validEvent = {
        type: 'message',
        user: 'U1234567890',
        ts: '1234567890.123456',
        thread_ts: '1234567890.000000',
        channel: 'C1234567890',
        text: 'Hello, Claude!',
      };

      if (messageHandler) {
        await messageHandler({ event: validEvent });
      }

      expect(mockAddTask).toHaveBeenCalledWith(
        'a0000000-0000-0000-0000-000000000001',
        expect.objectContaining({
          prompt: 'Hello, Claude!',
          slackUser: 'U1234567890',
          messageTs: '1234567890.123456',
        }),
      );
    });
  });

  describe('sendSlackMessage edge cases', () => {
    it('throws error when client not initialized', async () => {
      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => ({
          event: vi.fn(),
          error: vi.fn(),
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          client: {
            chat: { postMessage: vi.fn() },
            reactions: { add: vi.fn() },
          },
        })),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn(),
      }));

      // Import without creating client first
      const { sendSlackMessage } = await import('../../src/slack-client.js');

      // This should throw because client wasn't initialized
      await expect(sendSlackMessage('a0000000-0000-0000-0000-000000000001', 'test'))
        .rejects.toThrow('Slack client not initialized');
    });
  });

  describe('sendSlackReaction edge cases', () => {
    it('returns early for unknown session', async () => {
      const mockApp = {
        event: vi.fn(),
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

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn().mockResolvedValue(null), // Session not found
      }));

      vi.doMock('../../src/task-queue.js', () => ({
        addTask: vi.fn(),
        removeTaskByMessageTs: vi.fn(),
      }));

      const { createSlackClient, startSlackClient, sendSlackReaction } =
        await import('../../src/slack-client.js');

      const app = createSlackClient();
      await startSlackClient(app);

      // Should not throw, just return early
      await sendSlackReaction('a0000000-0000-0000-0000-000000000001', '1234567890.123456', 'thumbsup');

      // Reaction.add should NOT have been called
      expect(mockApp.client.reactions.add).not.toHaveBeenCalled();
    });

    it('throws and logs error on reaction failure', async () => {
      const mockApp = {
        event: vi.fn(),
        error: vi.fn(),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: { postMessage: vi.fn() },
          reactions: {
            add: vi.fn().mockRejectedValue(new Error('Reaction failed')),
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

      // Should throw
      await expect(sendSlackReaction(sessionId, '1234567890.123456', 'thumbsup'))
        .rejects.toThrow('Reaction failed');
    });

    it('throws error when client not initialized', async () => {
      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => ({
          event: vi.fn(),
          error: vi.fn(),
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          client: {
            chat: { postMessage: vi.fn() },
            reactions: { add: vi.fn() },
          },
        })),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      vi.doMock('../../src/registry.js', () => ({
        getSessionByThread: vi.fn(),
        getSession: vi.fn(),
      }));

      const { sendSlackReaction } = await import('../../src/slack-client.js');

      await expect(sendSlackReaction('a0000000-0000-0000-0000-000000000001', '1234567890.123456', 'thumbsup'))
        .rejects.toThrow('Slack client not initialized');
    });
  });

  describe('constants', () => {
    it('exports MAX_MESSAGE_LENGTH', async () => {
      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => ({
          event: vi.fn(),
          error: vi.fn(),
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          client: {
            chat: { postMessage: vi.fn() },
            reactions: { add: vi.fn() },
          },
        })),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { MAX_MESSAGE_LENGTH } = await import('../../src/slack-client.js');

      expect(MAX_MESSAGE_LENGTH).toBe(3900);
    });

    it('exports DEDUP_WINDOW_MS', async () => {
      vi.doMock('@slack/bolt', () => ({
        App: vi.fn().mockImplementation(() => ({
          event: vi.fn(),
          error: vi.fn(),
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn().mockResolvedValue(undefined),
          client: {
            chat: { postMessage: vi.fn() },
            reactions: { add: vi.fn() },
          },
        })),
        LogLevel: { WARN: 'warn' },
      }));

      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({
          slackBotToken: 'xoxb-test',
          slackAppToken: 'xapp-test',
          slackChannelId: 'C1234567890',
          authorizedUsers: [],
          logLevel: 'error',
        }),
      }));

      const { DEDUP_WINDOW_MS } = await import('../../src/slack-client.js');

      expect(DEDUP_WINDOW_MS).toBe(60000);
    });
  });
});
