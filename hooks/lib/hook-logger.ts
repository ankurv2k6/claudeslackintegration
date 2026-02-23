/**
 * M-07: Hook Logger
 *
 * Lightweight hook-specific logger that writes to stderr.
 * Hooks must output only JSON to stdout (HookOutput), so all logging goes to stderr.
 * Uses structured JSON format compatible with M-02 logger patterns.
 */

export interface HookLogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  service: 'slack-claude-hook';
  hookType: string;
  pid: number;
  sessionId?: string;
  requestId?: string;
  action?: string;
  event?: string;
  [key: string]: unknown;
}

export interface HookLogger {
  debug: (entry: Record<string, unknown>) => void;
  info: (entry: Record<string, unknown>) => void;
  warn: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
}

/**
 * Create a hook-specific logger
 * All output goes to stderr to avoid interfering with JSON stdout
 *
 * @param hookType - The hook type (e.g., 'session-start', 'stop', 'session-end')
 * @returns HookLogger instance
 */
export function createHookLogger(hookType: string): HookLogger {
  const baseContext = {
    service: 'slack-claude-hook' as const,
    hookType,
    pid: process.pid,
  };

  const log = (level: HookLogEntry['level'], entry: Record<string, unknown>): void => {
    const logEntry: HookLogEntry = {
      ts: new Date().toISOString(),
      level,
      ...baseContext,
      ...entry,
    };

    // Write to stderr as JSON (newline-delimited)
    process.stderr.write(JSON.stringify(logEntry) + '\n');
  };

  return {
    debug: (entry) => log('debug', entry),
    info: (entry) => log('info', entry),
    warn: (entry) => log('warn', entry),
    error: (entry) => log('error', entry),
  };
}

/**
 * Add session context to log entries
 *
 * @param logger - The parent logger
 * @param sessionId - The session UUID
 * @returns A wrapped logger with sessionId in all entries
 */
export function withSessionId(logger: HookLogger, sessionId: string): HookLogger {
  const wrap = (method: keyof HookLogger) => (entry: Record<string, unknown>): void => {
    logger[method]({ sessionId, ...entry });
  };

  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  };
}
