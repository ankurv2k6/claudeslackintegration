#!/usr/bin/env node
/**
 * M-07: Session End Hook
 *
 * Claude Code hook executed when a Claude Code session ends.
 * Closes the session in the daemon and notifies Slack.
 *
 * Exit behavior:
 * - Always exits with allow (session is ending anyway)
 * - Fails open on any error (logs error, exits cleanly)
 */

import { readStdin, exitAllow, exitWithError } from './lib/hook-helpers.js';
import { createHookLogger, withSessionId } from './lib/hook-logger.js';
import { createDaemonClient, CircuitOpenError } from './lib/daemon-client.js';

const baseLogger = createHookLogger('session-end');

async function main(): Promise<void> {
  const startTime = Date.now();

  try {
    // Parse stdin from Claude Code
    const input = await readStdin();
    const logger = withSessionId(baseLogger, input.session_id);

    logger.info({
      event: 'HOOK_START',
    });

    // Create daemon client and close session
    const client = createDaemonClient();

    try {
      await client.closeSession(input.session_id);

      logger.info({
        event: 'SESSION_CLOSED',
        duration_ms: Date.now() - startTime,
      });
    } catch (err) {
      // Log but don't block - session is ending anyway
      if (err instanceof CircuitOpenError) {
        logger.warn({
          event: 'DAEMON_CIRCUIT_OPEN',
          message: 'Circuit breaker open, daemon unavailable',
        });
      } else if (err instanceof Error && err.message.includes('SESSION_NOT_FOUND')) {
        // Session not found - already closed or never registered
        logger.info({
          event: 'SESSION_NOT_FOUND',
          message: 'Session already closed or not registered',
        });
      } else {
        logger.warn({
          event: 'SESSION_CLOSE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info({
      event: 'HOOK_END',
      action: 'allow',
      duration_ms: Date.now() - startTime,
    });

    // Always allow session to end
    exitAllow();
  } catch (err) {
    // Fatal error (stdin parse failed, etc.)
    baseLogger.error({
      event: 'HOOK_FATAL',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      duration_ms: Date.now() - startTime,
    });

    // Fail open - let session end
    exitWithError(err instanceof Error ? err.message : String(err));
  }
}

main();
