#!/usr/bin/env node
/**
 * M-07: Stop Hook
 *
 * Claude Code hook executed when Claude is about to complete a task.
 * Checks for pending Slack tasks and injects them as the next prompt,
 * or sends a summary to Slack if no tasks are pending.
 *
 * Key behaviors:
 * - Loop prevention: exits immediately if stop_hook_active is true
 * - Injection limit: max 10 consecutive injections per session
 * - Claims task atomically to prevent race conditions
 * - Sends summary to Slack when no tasks available
 */

import { readStdin, exitAllow, exitBlock, exitWithError } from './lib/hook-helpers.js';
import { createHookLogger, withSessionId } from './lib/hook-logger.js';
import { createDaemonClient, CircuitOpenError } from './lib/daemon-client.js';
import { extractSummary } from './lib/summary.js';

const baseLogger = createHookLogger('stop');

// Maximum consecutive task injections to prevent infinite loops
const MAX_INJECTIONS = 10;

async function main(): Promise<void> {
  const startTime = Date.now();

  try {
    // Parse stdin from Claude Code
    const input = await readStdin();
    const logger = withSessionId(baseLogger, input.session_id);

    logger.info({
      event: 'HOOK_START',
    });

    // Loop prevention: if we're already in a stop hook cycle, exit immediately
    if (input.stop_hook_active) {
      logger.info({
        event: 'HOOK_END',
        action: 'allow',
        reason: 'stop_hook_active',
        duration_ms: Date.now() - startTime,
      });
      exitAllow();
    }

    // Create daemon client
    const client = createDaemonClient();

    try {
      // Check session status and injection count
      const session = await client.getSession(input.session_id);

      if (!session) {
        // Session not registered - just allow exit
        logger.info({
          event: 'HOOK_END',
          action: 'allow',
          reason: 'session_not_found',
          duration_ms: Date.now() - startTime,
        });
        exitAllow();
      }

      // Check injection limit
      if (session.injectionCount >= MAX_INJECTIONS) {
        logger.warn({
          event: 'INJECTION_LIMIT_REACHED',
          injectionCount: session.injectionCount,
          max: MAX_INJECTIONS,
        });

        // Notify Slack that we've hit the limit
        try {
          await client.sendMessage(
            input.session_id,
            '⚠️ Task limit reached (10 consecutive tasks). Taking a break. Reply to continue.'
          );
        } catch {
          // Ignore - best effort notification
        }

        logger.info({
          event: 'HOOK_END',
          action: 'allow',
          reason: 'injection_limit',
          duration_ms: Date.now() - startTime,
        });
        exitAllow();
      }

      // Try to claim the next pending task
      const task = await client.claimTask(input.session_id);

      if (task) {
        // Task claimed - inject it as the next prompt
        logger.info({
          event: 'TASK_CLAIMED',
          taskId: task.id,
          sequence: task.sequence,
          promptLength: task.prompt.length,
        });

        logger.info({
          event: 'HOOK_END',
          action: 'block',
          reason: 'task_injected',
          taskId: task.id,
          duration_ms: Date.now() - startTime,
        });

        // Block with the task prompt
        exitBlock(task.prompt);
      } else {
        // No pending tasks - send summary to Slack
        const summary = extractSummary(input.last_assistant_message || '', 500);

        try {
          await client.sendMessage(input.session_id, summary);
          logger.info({
            event: 'SUMMARY_SENT',
            summaryLength: summary.length,
          });
        } catch (err) {
          logger.warn({
            event: 'SUMMARY_SEND_FAILED',
            error: err instanceof Error ? err.message : String(err),
          });
          // Continue anyway
        }

        logger.info({
          event: 'HOOK_END',
          action: 'allow',
          reason: 'no_tasks',
          duration_ms: Date.now() - startTime,
        });
        exitAllow();
      }
    } catch (err) {
      // Daemon communication failed - fail open
      if (err instanceof CircuitOpenError) {
        logger.warn({
          event: 'DAEMON_CIRCUIT_OPEN',
          message: 'Circuit breaker open, daemon unavailable',
        });
      } else {
        logger.warn({
          event: 'DAEMON_ERROR',
          error: err instanceof Error ? err.message : String(err),
        });
      }

      logger.info({
        event: 'HOOK_END',
        action: 'allow',
        reason: 'daemon_error',
        duration_ms: Date.now() - startTime,
      });
      exitAllow();
    }
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
