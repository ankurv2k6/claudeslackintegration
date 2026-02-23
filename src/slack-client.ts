/**
 * M-05: SlackClient Module
 *
 * Initialize @slack/bolt with Socket Mode, handle incoming thread messages,
 * route to correct session task queue, send chunked messages with retry logic,
 * and handle message edits/deletes.
 *
 * Security: Input validation, authorized user filtering, rate limiting
 * Logging: Comprehensive structured logging with correlation IDs
 */

import { App, LogLevel } from '@slack/bolt';
import PQueue from 'p-queue';
import { z } from 'zod';
import { getConfig, type Config } from './config.js';
import { createLogger, withRequestId, withSessionId, type Logger } from './logger.js';
import * as registry from './registry.js';
import * as taskQueue from './task-queue.js';

const logger = createLogger('slack-client');

// Rate limiting queue: 1 message per second (Slack rate limit compliance)
const messageQueue = new PQueue({
  concurrency: 1,
  interval: 1000,
  intervalCap: 1,
});

// Message deduplication cache (SEC-005: Prevent replay attacks)
const processedMessages = new Map<string, number>();
const DEDUP_WINDOW_MS = 60000; // 60 seconds

// Max retry configuration
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

// Message chunk size (buffer below Slack's 4000 char limit)
const MAX_MESSAGE_LENGTH = 3900;

// Zod schema for Slack message event validation (SEC-001)
const SlackMessageEventSchema = z.object({
  type: z.literal('message'),
  user: z.string().startsWith('U').optional(),
  text: z.string().max(40000).optional(),
  ts: z.string().regex(/^\d+\.\d+$/),
  thread_ts: z.string().regex(/^\d+\.\d+$/).optional(),
  channel: z.string().startsWith('C'),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
});

// Schema for message_deleted subtype
const SlackDeletedEventSchema = z.object({
  type: z.literal('message'),
  subtype: z.literal('message_deleted'),
  deleted_ts: z.string().regex(/^\d+\.\d+$/),
  channel: z.string().startsWith('C'),
  thread_ts: z.string().regex(/^\d+\.\d+$/).optional(),
});

// Module-level app reference for message sending
let _app: App | null = null;

/**
 * Sanitize Slack message text to prevent prompt injection (SEC-003)
 * Removes control characters, decodes Slack formatting
 */
function sanitizeSlackText(text: string): string {
  return text
    // Decode Slack user mentions
    .replace(/<@U[A-Z0-9]+>/g, '[user-mention]')
    // Decode Slack channel mentions
    .replace(/<#C[A-Z0-9]+\|[^>]+>/g, '[channel-mention]')
    // Decode Slack URLs
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    // Remove control characters (except newlines)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // Truncate to max prompt length
    .slice(0, 4000);
}

/**
 * Chunk a long message into multiple parts
 * Each chunk stays under MAX_MESSAGE_LENGTH
 */
function chunkMessage(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Try to break at newline if possible
    let breakPoint = maxLength;
    if (remaining.length > maxLength) {
      const lastNewline = remaining.lastIndexOf('\n', maxLength);
      if (lastNewline > maxLength * 0.5) {
        breakPoint = lastNewline + 1;
      }
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint);
  }

  return chunks;
}

/**
 * Clean up old entries from the deduplication cache
 */
function cleanupDedupCache(): void {
  const now = Date.now();
  for (const [key, timestamp] of processedMessages) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      processedMessages.delete(key);
    }
  }
}

/**
 * Exponential backoff retry wrapper with Retry-After support
 */
async function sendWithRetry<T>(
  fn: () => Promise<T>,
  log: Logger,
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let delay = BASE_DELAY_MS;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const error = err as { data?: { error?: string }; headers?: Record<string, string>; message?: string };
      const isRateLimited = error.data?.error === 'ratelimited';
      const isRetryable = isRateLimited || error.data?.error === 'service_unavailable';

      if (!isRetryable || attempt === maxRetries) {
        // LOG-008: Log final failure with structured error
        log.error({
          action: 'SLACK_SEND_FAILED',
          error: {
            code: error.data?.error || 'SLACK_API_ERROR',
            message: error.message || 'Unknown error',
            cause: error.data?.error,
            recoveryHint: 'Check Slack API status and token validity',
          },
          attempts: attempt,
        });
        throw err;
      }

      // Respect Retry-After header if present
      const retryAfter = error.headers?.['retry-after'];
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(delay, MAX_DELAY_MS);

      // LOG-009: Log rate limit with context
      log.warn({
        action: 'SLACK_RATE_LIMITED',
        attempt,
        waitMs,
        retryAfter: retryAfter || null,
        errorCode: error.data?.error,
      });

      await new Promise((r) => setTimeout(r, waitMs));
      delay *= 2;
    }
  }

  // Should never reach here
  throw new Error('Unexpected retry loop exit');
}

/**
 * Create a Slack Bolt app with Socket Mode configuration
 */
export function createSlackClient(): App {
  const config = getConfig();

  logger.info({ action: 'SLACK_CLIENT_CREATING' });

  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: LogLevel.WARN, // Reduce Bolt's internal logging
  });

  // Store reference for message sending
  _app = app;

  logger.info({ action: 'SLACK_CLIENT_CREATED' });

  return app;
}

/**
 * Start the Slack client with Socket Mode connection
 * Registers all event handlers
 */
export async function startSlackClient(app: App): Promise<void> {
  const config = getConfig();

  logger.info({ action: 'SLACK_CLIENT_STARTING' });

  // Register error handler (LOG-001)
  app.error(async (error) => {
    logger.error({
      action: 'SLACK_ERROR',
      error: {
        code: 'SLACK_APP_ERROR',
        message: error.message,
        stack: error.stack,
      },
    });
  });

  // Message event handler
  app.event('message', async ({ event }) => {
    const startTime = Date.now();
    const log = withRequestId(logger, event.ts);

    // LOG-003: Log message received
    log.debug({
      action: 'SLACK_MESSAGE_RECEIVED',
      threadTs: ('thread_ts' in event) ? event.thread_ts : undefined,
      hasText: !!('text' in event && event.text),
      subtype: ('subtype' in event) ? event.subtype : undefined,
    });

    // SEC-001: Validate event structure
    const parsed = SlackMessageEventSchema.safeParse(event);
    if (!parsed.success) {
      log.warn({
        action: 'INVALID_EVENT_STRUCTURE',
        errors: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
      return;
    }

    const validEvent = parsed.data;

    // Filter bot messages (prevent infinite loops)
    if (validEvent.bot_id) {
      log.debug({ action: 'BOT_MESSAGE_FILTERED' });
      return;
    }

    // Only process thread replies
    if (!validEvent.thread_ts) {
      log.debug({ action: 'NON_THREAD_MESSAGE_FILTERED' });
      return;
    }

    // SEC-006: Channel validation
    if (validEvent.channel !== config.slackChannelId) {
      log.warn({ action: 'WRONG_CHANNEL', channel: validEvent.channel });
      return;
    }

    // Handle message subtypes
    if (validEvent.subtype) {
      await handleMessageSubtype(event, validEvent, log, config);
      return;
    }

    // SEC-005: Deduplication check
    if (processedMessages.has(validEvent.ts)) {
      log.debug({ action: 'DUPLICATE_MESSAGE_FILTERED', messageTs: validEvent.ts });
      return;
    }
    processedMessages.set(validEvent.ts, Date.now());

    // Periodic cleanup
    if (processedMessages.size > 1000) {
      cleanupDedupCache();
    }

    // Authorization check (SEC-002)
    if (config.authorizedUsers.length > 0 && validEvent.user) {
      if (!config.authorizedUsers.includes(validEvent.user)) {
        log.warn({ action: 'UNAUTHORIZED_USER' });
        return;
      }
    }

    // Route to session
    const session = await registry.getSessionByThread(validEvent.thread_ts);
    if (!session) {
      log.warn({
        action: 'UNKNOWN_THREAD',
        threadTs: validEvent.thread_ts,
      });
      return;
    }

    // LOG-005: Create session-scoped logger
    const sessionLog = withSessionId(log, session.sessionId);

    sessionLog.info({
      action: 'MESSAGE_ROUTED_TO_SESSION',
      duration_ms: Date.now() - startTime,
    });

    // SEC-003: Sanitize message text
    const sanitizedText = sanitizeSlackText(validEvent.text || '');

    // Add task to queue
    const added = await taskQueue.addTask(session.sessionId, {
      prompt: sanitizedText,
      slackUser: validEvent.user || 'unknown',
      messageTs: validEvent.ts,
    });

    if (added) {
      sessionLog.info({
        action: 'TASK_ADDED_FROM_SLACK',
        promptLength: sanitizedText.length,
      });
    } else {
      sessionLog.info({ action: 'TASK_DUPLICATE_REJECTED' });
    }
  });

  // Start Socket Mode
  await app.start();

  logger.info({ action: 'SLACK_CLIENT_STARTED' });
}

/**
 * Handle message subtypes (edit, delete)
 */
async function handleMessageSubtype(
  event: unknown,
  validEvent: z.infer<typeof SlackMessageEventSchema>,
  log: Logger,
  _config: Config,
): Promise<void> {
  if (validEvent.subtype === 'message_changed') {
    // LOG-006: Log edit event
    log.info({
      action: 'MESSAGE_EDITED',
      messageTs: validEvent.ts,
    });
    return;
  }

  if (validEvent.subtype === 'message_deleted') {
    // Validate deleted event structure
    const deletedParsed = SlackDeletedEventSchema.safeParse(event);
    if (!deletedParsed.success) {
      log.warn({ action: 'INVALID_DELETE_EVENT' });
      return;
    }

    const deletedEvent = deletedParsed.data;

    // LOG-007: Find session and remove task
    if (deletedEvent.thread_ts) {
      const session = await registry.getSessionByThread(deletedEvent.thread_ts);
      if (session) {
        const removed = await taskQueue.removeTaskByMessageTs(
          session.sessionId,
          deletedEvent.deleted_ts,
        );

        log.info({
          action: 'TASK_REMOVED_FROM_DELETE',
          messageTs: deletedEvent.deleted_ts,
          removed,
        });
      }
    }
  }
}

/**
 * Gracefully stop the Slack client
 */
export async function stopSlackClient(app: App): Promise<void> {
  logger.info({ action: 'SLACK_CLIENT_STOPPING' });

  try {
    await app.stop();
    _app = null;
    logger.info({ action: 'SLACK_CLIENT_STOPPED' });
  } catch (err) {
    const error = err as Error;
    logger.error({
      action: 'SLACK_STOP_FAILED',
      error: {
        code: 'SLACK_STOP_ERROR',
        message: error.message,
        stack: error.stack,
      },
    });
    throw err;
  }
}

/**
 * Send a message to a session's Slack thread
 * Handles chunking for long messages and rate limiting
 */
export async function sendSlackMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  if (!_app) {
    throw new Error('Slack client not initialized');
  }

  const log = withSessionId(logger, sessionId);
  const startTime = Date.now();

  // Get session for thread info
  const session = await registry.getSession(sessionId);
  if (!session) {
    log.warn({
      action: 'SEND_TO_UNKNOWN_SESSION',
      currentStatus: 'NOT_FOUND',
    });
    return;
  }

  if (session.status !== 'ACTIVE' && session.status !== 'PENDING') {
    // LOG-011: Log inactive session context
    log.warn({
      action: 'SEND_TO_INACTIVE_SESSION',
      currentStatus: session.status,
      expectedStatus: 'ACTIVE',
    });
    return;
  }

  const chunks = chunkMessage(text);

  // LOG-010: Entry log
  log.info({
    action: 'SLACK_MESSAGE_SEND_STARTED',
    messageLength: text.length,
    chunks: chunks.length,
  });

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    await messageQueue.add(async () => {
      log.debug({
        action: 'SLACK_CHUNK_SENDING',
        chunk: i + 1,
        total: chunks.length,
      });

      await sendWithRetry(
        async () => {
          await _app!.client.chat.postMessage({
            channel: session.channelId,
            thread_ts: session.threadTs,
            text: chunk,
          });
        },
        log,
      );

      log.debug({
        action: 'SLACK_CHUNK_SENT',
        chunk: i + 1,
      });
    });
  }

  // LOG-010: Exit log
  log.info({
    action: 'SLACK_MESSAGE_SENT',
    chunks: chunks.length,
    duration_ms: Date.now() - startTime,
  });
}

/**
 * Add a reaction to a message in a session's thread
 */
export async function sendSlackReaction(
  sessionId: string,
  messageTs: string,
  emoji: string,
): Promise<void> {
  if (!_app) {
    throw new Error('Slack client not initialized');
  }

  const log = withSessionId(logger, sessionId);

  // Get session for channel info
  const session = await registry.getSession(sessionId);
  if (!session) {
    log.warn({ action: 'REACTION_TO_UNKNOWN_SESSION' });
    return;
  }

  // LOG-016: Log reaction send
  log.info({
    action: 'SLACK_REACTION_SENDING',
    messageTs,
    emoji,
  });

  try {
    await sendWithRetry(
      async () => {
        await _app!.client.reactions.add({
          channel: session.channelId,
          timestamp: messageTs,
          name: emoji,
        });
      },
      log,
    );

    log.info({
      action: 'SLACK_REACTION_SENT',
      messageTs,
      emoji,
    });
  } catch (err) {
    const error = err as Error;
    log.error({
      action: 'SLACK_REACTION_FAILED',
      error: {
        code: 'SLACK_REACTION_ERROR',
        message: error.message,
      },
      messageTs,
      emoji,
    });
    throw err;
  }
}

/**
 * Get the current message queue status
 * Useful for monitoring and health checks
 */
export function getQueueStatus(): { pending: number; size: number } {
  return {
    pending: messageQueue.pending,
    size: messageQueue.size,
  };
}

// Export for testing
export { MAX_MESSAGE_LENGTH, DEDUP_WINDOW_MS };
export { chunkMessage, sanitizeSlackText };
