import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('hook-helpers', () => {
  // Store original process methods
  const originalExit = process.exit;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    vi.restoreAllMocks();
  });

  describe('HookInputSchema', () => {
    it('validates valid input', async () => {
      const { HookInputSchema } = await import('../../../hooks/lib/hook-helpers.js');

      const validInput = {
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        cwd: '/home/user/project',
      };

      const result = HookInputSchema.safeParse(validInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.session_id).toBe(validInput.session_id);
        expect(result.data.cwd).toBe(validInput.cwd);
      }
    });

    it('validates input with optional fields', async () => {
      const { HookInputSchema } = await import('../../../hooks/lib/hook-helpers.js');

      const fullInput = {
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        cwd: '/home/user/project',
        stop_hook_active: true,
        last_assistant_message: 'Some message',
        request_id: 'req_123',
      };

      const result = HookInputSchema.safeParse(fullInput);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.stop_hook_active).toBe(true);
        expect(result.data.last_assistant_message).toBe('Some message');
        expect(result.data.request_id).toBe('req_123');
      }
    });

    it('rejects invalid session_id', async () => {
      const { HookInputSchema } = await import('../../../hooks/lib/hook-helpers.js');

      const invalidInput = {
        session_id: 'not-a-uuid',
        cwd: '/home/user/project',
      };

      const result = HookInputSchema.safeParse(invalidInput);
      expect(result.success).toBe(false);
    });

    it('rejects missing required fields', async () => {
      const { HookInputSchema } = await import('../../../hooks/lib/hook-helpers.js');

      const missingCwd = { session_id: '550e8400-e29b-41d4-a716-446655440000' };
      const missingSid = { cwd: '/home/user/project' };

      expect(HookInputSchema.safeParse(missingCwd).success).toBe(false);
      expect(HookInputSchema.safeParse(missingSid).success).toBe(false);
    });
  });

  describe('HookOutputSchema', () => {
    it('validates allow decision', async () => {
      const { HookOutputSchema } = await import('../../../hooks/lib/hook-helpers.js');

      const allowOutput = { decision: 'allow' };
      const result = HookOutputSchema.safeParse(allowOutput);
      expect(result.success).toBe(true);
    });

    it('validates block decision with reason', async () => {
      const { HookOutputSchema } = await import('../../../hooks/lib/hook-helpers.js');

      const blockOutput = { decision: 'block', reason: 'Complete this task' };
      const result = HookOutputSchema.safeParse(blockOutput);
      expect(result.success).toBe(true);
    });

    it('rejects invalid decision', async () => {
      const { HookOutputSchema } = await import('../../../hooks/lib/hook-helpers.js');

      const invalidOutput = { decision: 'invalid' };
      const result = HookOutputSchema.safeParse(invalidOutput);
      expect(result.success).toBe(false);
    });
  });

  describe('exitAllow', () => {
    it('outputs allow decision and exits with 0', async () => {
      const { exitAllow } = await import('../../../hooks/lib/hook-helpers.js');

      let capturedOutput = '';
      let capturedExitCode: number | undefined;

      console.log = vi.fn((msg: string) => {
        capturedOutput = msg;
      });
      process.exit = vi.fn((code?: number) => {
        capturedExitCode = code;
        throw new Error('process.exit');
      }) as never;

      expect(() => exitAllow()).toThrow('process.exit');
      expect(capturedOutput).toBe('{"decision":"allow"}');
      expect(capturedExitCode).toBe(0);
    });
  });

  describe('exitBlock', () => {
    it('outputs block decision with prompt and exits with 0', async () => {
      const { exitBlock } = await import('../../../hooks/lib/hook-helpers.js');

      let capturedOutput = '';
      let capturedExitCode: number | undefined;

      console.log = vi.fn((msg: string) => {
        capturedOutput = msg;
      });
      process.exit = vi.fn((code?: number) => {
        capturedExitCode = code;
        throw new Error('process.exit');
      }) as never;

      const prompt = 'Complete this task';
      expect(() => exitBlock(prompt)).toThrow('process.exit');

      const parsed = JSON.parse(capturedOutput);
      expect(parsed.decision).toBe('block');
      expect(parsed.reason).toBe(prompt);
      expect(capturedExitCode).toBe(0);
    });
  });

  describe('exitWithError', () => {
    it('logs error to stderr and exits with allow', async () => {
      const { exitWithError } = await import('../../../hooks/lib/hook-helpers.js');

      let capturedStderr = '';
      let capturedStdout = '';

      console.error = vi.fn((msg: string) => {
        capturedStderr = msg;
      });
      console.log = vi.fn((msg: string) => {
        capturedStdout = msg;
      });
      process.exit = vi.fn(() => {
        throw new Error('process.exit');
      }) as never;

      expect(() => exitWithError('Test error')).toThrow('process.exit');
      expect(capturedStderr).toContain('HOOK_ERROR');
      expect(capturedStderr).toContain('Test error');
      expect(capturedStdout).toBe('{"decision":"allow"}');
    });
  });
});
