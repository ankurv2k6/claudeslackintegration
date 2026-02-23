#!/usr/bin/env node
/**
 * M-07: Session Start Hook
 *
 * Claude Code hook executed when a new Claude Code session starts.
 * Registers the session with the daemon and creates a Slack thread.
 *
 * Exit behavior:
 * - Always exits with allow (don't block Claude from starting)
 * - Fails open on any error (logs error, continues session)
 */

import { readStdin, exitAllow, exitWithError } from './lib/hook-helpers.js';
import { createHookLogger, withSessionId } from './lib/hook-logger.js';
import { createDaemonClient, CircuitOpenError } from './lib/daemon-client.js';

const baseLogger = createHookLogger('session-start');

async function main(): Promise<void> {
  const startTime = Date.now();

  try {
    // Parse stdin from Claude Code
    const input = await readStdin();
    const logger = withSessionId(baseLogger, input.session_id);

    logger.info({
      event: 'HOOK_START',
      cwd: input.cwd.slice(0, 50), // Log truncated path
    });

    // Create daemon client and register session
    const client = createDaemonClient();

    try {
      const session = await client.startSession(input.session_id, input.cwd);

      logger.info({
        event: 'SESSION_REGISTERED',
        threadTs: session.threadTs,
        channelId: session.channelId,
        duration_ms: Date.now() - startTime,
      });
    } catch (err) {
      // Log but don't block - session can still work without Slack
      if (err instanceof CircuitOpenError) {
        logger.warn({
          event: 'DAEMON_CIRCUIT_OPEN',
          message: 'Circuit breaker open, daemon unavailable',
        });
      } else if (err instanceof Error && err.message.includes('SESSION_EXISTS')) {
        // Session already exists - this is fine (reconnect scenario)
        logger.info({
          event: 'SESSION_RECONNECT',
          message: 'Session already registered',
        });
      } else {
        logger.warn({
          event: 'SESSION_REGISTER_FAILED',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({
      event: 'HOOK_END',
      action: 'allow',
      duration_ms: Date.now() - startTime,
    });

    // Always allow Claude to start
    exitAllow();
  } catch (err) {
    // Fatal error (stdin parse failed, etc.)
    baseLogger.error({
      event: 'HOOK_FATAL',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startTime,
    });

    // Fail open - don't block Claude
    exitWithError(err instanceof Error ? err.message : String(err));
  }
}

main();
