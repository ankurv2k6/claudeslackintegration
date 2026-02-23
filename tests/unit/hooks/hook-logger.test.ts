import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('hook-logger', () => {
  const originalStderrWrite = process.stderr.write;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    vi.restoreAllMocks();
  });

  describe('createHookLogger', () => {
    it('creates logger with correct context', async () => {
      const { createHookLogger } = await import('../../../hooks/lib/hook-logger.js');

      let capturedOutput = '';
      process.stderr.write = vi.fn((chunk: string | Uint8Array) => {
        capturedOutput = chunk.toString();
        return true;
      });

      const logger = createHookLogger('test-hook');
      logger.info({ event: 'TEST_EVENT' });

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed.service).toBe('slack-claude-hook');
      expect(parsed.hookType).toBe('test-hook');
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.level).toBe('info');
      expect(parsed.event).toBe('TEST_EVENT');
      expect(parsed.ts).toBeDefined();
    });

    it('logs debug level', async () => {
      const { createHookLogger } = await import('../../../hooks/lib/hook-logger.js');

      let capturedOutput = '';
      process.stderr.write = vi.fn((chunk: string | Uint8Array) => {
        capturedOutput = chunk.toString();
        return true;
      });

      const logger = createHookLogger('test');
      logger.debug({ action: 'DEBUG_ACTION' });

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed.level).toBe('debug');
      expect(parsed.action).toBe('DEBUG_ACTION');
    });

    it('logs warn level', async () => {
      const { createHookLogger } = await import('../../../hooks/lib/hook-logger.js');

      let capturedOutput = '';
      process.stderr.write = vi.fn((chunk: string | Uint8Array) => {
        capturedOutput = chunk.toString();
        return true;
      });

      const logger = createHookLogger('test');
      logger.warn({ warning: 'something' });

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed.level).toBe('warn');
    });

    it('logs error level', async () => {
      const { createHookLogger } = await import('../../../hooks/lib/hook-logger.js');

      let capturedOutput = '';
      process.stderr.write = vi.fn((chunk: string | Uint8Array) => {
        capturedOutput = chunk.toString();
        return true;
      });

      const logger = createHookLogger('test');
      logger.error({ error: 'test error' });

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed.level).toBe('error');
      expect(parsed.error).toBe('test error');
    });

    it('includes custom fields in log entry', async () => {
      const { createHookLogger } = await import('../../../hooks/lib/hook-logger.js');

      let capturedOutput = '';
      process.stderr.write = vi.fn((chunk: string | Uint8Array) => {
        capturedOutput = chunk.toString();
        return true;
      });

      const logger = createHookLogger('test');
      logger.info({ event: 'TEST', duration_ms: 123, custom: 'value' });

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed.duration_ms).toBe(123);
      expect(parsed.custom).toBe('value');
    });
  });

  describe('withSessionId', () => {
    it('adds sessionId to all log entries', async () => {
      const { createHookLogger, withSessionId } = await import(
        '../../../hooks/lib/hook-logger.js'
      );

      const outputs: string[] = [];
      process.stderr.write = vi.fn((chunk: string | Uint8Array) => {
        outputs.push(chunk.toString());
        return true;
      });

      const baseLogger = createHookLogger('test');
      const sessionLogger = withSessionId(baseLogger, 'test-session-id');

      sessionLogger.info({ event: 'EVENT1' });
      sessionLogger.debug({ event: 'EVENT2' });
      sessionLogger.warn({ event: 'EVENT3' });
      sessionLogger.error({ event: 'EVENT4' });

      expect(outputs).toHaveLength(4);
      outputs.forEach((output) => {
        const parsed = JSON.parse(output.trim());
        expect(parsed.sessionId).toBe('test-session-id');
      });
    });
  });
});
