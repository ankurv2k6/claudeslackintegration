/**
 * M-02: Logger Module
 *
 * Configure Pino logger with structured JSON output, automatic redaction of
 * sensitive fields, correlation ID support, and rotating file transport.
 * Export factory functions for daemon and hook loggers.
 */

import pino, { Logger, LoggerOptions } from 'pino';
import path from 'path';
import fs from 'fs';
import { getConfig, LOGS_DIR } from './config.js';

// Redaction paths - NEVER log these sensitive fields
const REDACT_PATHS = [
  'input.message',
  'input.text',
  'input.slackUser',
  'headers.authorization',
  'headers.Authorization',
  'env.DAEMON_SECRET',
  'env.SLACK_BOT_TOKEN',
  'env.SLACK_APP_TOKEN',
  'body.message',
  'body.text',
  'secret',
  'token',
  'password',
  'apiKey',
  'api_key',
];

/**
 * Ensure the logs directory exists
 */
function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Get the base pino configuration with redaction
 */
function getBaseConfig(): LoggerOptions {
  let logLevel: string;
  try {
    const config = getConfig();
    logLevel = config.logLevel;
  } catch {
    // Config not available (missing env vars), default to info
    logLevel = 'info';
  }

  return {
    level: logLevel,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  };
}

/**
 * Create a rotating file stream for daemon logs
 * Falls back to stdout if file creation fails
 */
function createDaemonDestination(): pino.DestinationStream {
  try {
    ensureLogsDir();
    const today = new Date().toISOString().split('T')[0];
    const logPath = path.join(LOGS_DIR, `daemon-${today}.log`);
    return pino.destination({ dest: logPath, sync: false });
  } catch {
    // Fallback to stdout if file creation fails
    return pino.destination(1);
  }
}

/**
 * Create a destination for hook logs
 */
function createHookDestination(): pino.DestinationStream {
  try {
    ensureLogsDir();
    const logPath = path.join(LOGS_DIR, 'hooks.log');
    return pino.destination({ dest: logPath, sync: false });
  } catch {
    // Fallback to stdout if file creation fails
    return pino.destination(1);
  }
}

/**
 * Create a module-scoped logger for daemon components
 *
 * @param module - The module name (e.g., 'registry', 'slack-client')
 * @returns A pino Logger instance with module context
 */
export function createLogger(module: string): Logger {
  return pino(
    {
      ...getBaseConfig(),
      base: { service: 'slack-claude-daemon', module },
    },
    createDaemonDestination()
  );
}

/**
 * Create a hook-specific logger
 * Writes to a separate hooks.log file with hook context
 *
 * @param hookType - The hook type (e.g., 'session-start', 'stop')
 * @returns A pino Logger instance with hook context
 */
export function createHookLogger(hookType: string): Logger {
  return pino(
    {
      ...getBaseConfig(),
      base: { service: 'slack-claude-hook', hookType, pid: process.pid },
    },
    createHookDestination()
  );
}

/**
 * Add request correlation ID to an existing logger
 *
 * @param logger - The parent logger
 * @param requestId - The correlation ID (typically Slack message_ts)
 * @returns A child logger with requestId in context
 */
export function withRequestId(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}

/**
 * Add session context to an existing logger
 *
 * @param logger - The parent logger
 * @param sessionId - The session UUID
 * @returns A child logger with sessionId in context
 */
export function withSessionId(logger: Logger, sessionId: string): Logger {
  return logger.child({ sessionId });
}

/**
 * Create a stdout-only logger for testing or when file access fails
 */
export function createStdoutLogger(module: string): Logger {
  return pino(
    {
      ...getBaseConfig(),
      base: { service: 'slack-claude-daemon', module },
    },
    pino.destination(1)
  );
}

// Default daemon logger instance
let _logger: Logger | null = null;

/**
 * Get the default daemon logger (singleton)
 * Lazy initialization to avoid file operations at import time
 */
export function getLogger(): Logger {
  if (!_logger) {
    _logger = createLogger('main');
  }
  return _logger;
}

/**
 * Reset the default logger (for testing only)
 */
export function resetLogger(): void {
  _logger = null;
}

// Export logger as a getter that creates on first access
// This avoids file operations during module import
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop: string | symbol) {
    return Reflect.get(getLogger(), prop);
  },
});

// Re-export Logger type for consumers
export type { Logger };
