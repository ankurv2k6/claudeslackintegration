import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Store original env
const originalEnv = process.env;

// Test the logger module exports and basic functionality
describe('logger module', () => {
  const testLogsDir = path.join(os.tmpdir(), 'logger-test-' + Date.now());

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Set valid config for tests
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_CHANNEL_ID = 'C1234567890';
    process.env.DAEMON_SECRET = 'a'.repeat(64);

    // Create test logs directory
    if (!fs.existsSync(testLogsDir)) {
      fs.mkdirSync(testLogsDir, { recursive: true });
    }
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();

    // Clean up test directory
    if (fs.existsSync(testLogsDir)) {
      fs.rmSync(testLogsDir, { recursive: true, force: true });
    }
  });

  describe('exports', () => {
    it('exports createLogger function', async () => {
      const mod = await import('../../src/logger.js');
      expect(typeof mod.createLogger).toBe('function');
    });

    it('exports createHookLogger function', async () => {
      const mod = await import('../../src/logger.js');
      expect(typeof mod.createHookLogger).toBe('function');
    });

    it('exports withRequestId function', async () => {
      const mod = await import('../../src/logger.js');
      expect(typeof mod.withRequestId).toBe('function');
    });

    it('exports withSessionId function', async () => {
      const mod = await import('../../src/logger.js');
      expect(typeof mod.withSessionId).toBe('function');
    });

    it('exports getLogger function', async () => {
      const mod = await import('../../src/logger.js');
      expect(typeof mod.getLogger).toBe('function');
    });

    it('exports resetLogger function', async () => {
      const mod = await import('../../src/logger.js');
      expect(typeof mod.resetLogger).toBe('function');
    });

    it('exports createStdoutLogger function', async () => {
      const mod = await import('../../src/logger.js');
      expect(typeof mod.createStdoutLogger).toBe('function');
    });

    it('exports logger object', async () => {
      const mod = await import('../../src/logger.js');
      expect(mod.logger).toBeDefined();
    });

    it('exports Logger type', async () => {
      const mod = await import('../../src/logger.js');
      // Type export test - just verify import doesn't throw
      expect(mod).toBeDefined();
    });
  });

  describe('createLogger', () => {
    it('creates a logger with standard pino methods', async () => {
      const { createLogger } = await import('../../src/logger.js');
      const logger = createLogger('test-module');

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.child).toBe('function');
    });

    it('creates different loggers for different modules', async () => {
      const { createLogger } = await import('../../src/logger.js');
      const logger1 = createLogger('module1');
      const logger2 = createLogger('module2');

      expect(logger1).not.toBe(logger2);
    });
  });

  describe('createHookLogger', () => {
    it('creates a logger with standard pino methods', async () => {
      const { createHookLogger } = await import('../../src/logger.js');
      const logger = createHookLogger('stop');

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.child).toBe('function');
    });

    it('creates different loggers for different hook types', async () => {
      const { createHookLogger } = await import('../../src/logger.js');
      const logger1 = createHookLogger('stop');
      const logger2 = createHookLogger('session-start');

      expect(logger1).not.toBe(logger2);
    });
  });

  describe('withRequestId', () => {
    it('creates a child logger with requestId binding', async () => {
      const { createLogger, withRequestId } = await import('../../src/logger.js');
      const parent = createLogger('test');
      const child = withRequestId(parent, 'msg_123.456');

      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
      expect(child).not.toBe(parent);
    });
  });

  describe('withSessionId', () => {
    it('creates a child logger with sessionId binding', async () => {
      const { createLogger, withSessionId } = await import('../../src/logger.js');
      const parent = createLogger('test');
      const child = withSessionId(parent, 'uuid-12345');

      expect(child).toBeDefined();
      expect(typeof child.info).toBe('function');
      expect(child).not.toBe(parent);
    });
  });

  describe('getLogger', () => {
    it('returns a logger instance', async () => {
      const { getLogger, resetLogger } = await import('../../src/logger.js');
      resetLogger();
      const logger = getLogger();

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('returns same instance on multiple calls', async () => {
      const { getLogger, resetLogger } = await import('../../src/logger.js');
      resetLogger();

      const logger1 = getLogger();
      const logger2 = getLogger();

      expect(logger1).toBe(logger2);
    });
  });

  describe('resetLogger', () => {
    it('allows getting a new logger instance', async () => {
      const { getLogger, resetLogger } = await import('../../src/logger.js');

      const logger1 = getLogger();
      resetLogger();
      const logger2 = getLogger();

      // Both should be valid loggers
      expect(typeof logger1.info).toBe('function');
      expect(typeof logger2.info).toBe('function');
    });
  });

  describe('createStdoutLogger', () => {
    it('creates a logger with standard pino methods', async () => {
      const { createStdoutLogger } = await import('../../src/logger.js');
      const logger = createStdoutLogger('test');

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });
  });

  describe('logger proxy', () => {
    it('exposes logger methods', async () => {
      const { logger } = await import('../../src/logger.js');

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });
  });

  describe('log level configuration', () => {
    it('respects LOG_LEVEL from environment', async () => {
      process.env.LOG_LEVEL = 'debug';
      vi.resetModules();

      const { createLogger } = await import('../../src/logger.js');
      const logger = createLogger('test');

      // Logger should be created without error at debug level
      expect(logger.level).toBe('debug');
    });

    it('defaults to info level', async () => {
      delete process.env.LOG_LEVEL;
      vi.resetModules();

      const { createLogger } = await import('../../src/logger.js');
      const logger = createLogger('test');

      expect(logger.level).toBe('info');
    });

    it('handles missing config gracefully', async () => {
      delete process.env.SLACK_BOT_TOKEN;
      vi.resetModules();

      // Should not throw even with invalid config
      const { createLogger } = await import('../../src/logger.js');
      const logger = createLogger('test');

      expect(logger).toBeDefined();
      expect(logger.level).toBe('info');
    });
  });
});

// Test redaction configuration separately without file I/O
describe('logger redaction config', () => {
  const EXPECTED_REDACT_PATHS = [
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

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_CHANNEL_ID = 'C1234567890';
    process.env.DAEMON_SECRET = 'a'.repeat(64);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('defines expected redaction paths in source code', async () => {
    // Read the source file and verify REDACT_PATHS contains expected values
    const sourceCode = fs.readFileSync(
      path.join(process.cwd(), 'src', 'logger.ts'),
      'utf-8'
    );

    for (const redactPath of EXPECTED_REDACT_PATHS) {
      expect(sourceCode).toContain(`'${redactPath}'`);
    }
  });

  it('uses [REDACTED] as censor value', async () => {
    const sourceCode = fs.readFileSync(
      path.join(process.cwd(), 'src', 'logger.ts'),
      'utf-8'
    );

    expect(sourceCode).toContain("censor: '[REDACTED]'");
  });
});

// Test log format configuration
describe('logger format config', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_CHANNEL_ID = 'C1234567890';
    process.env.DAEMON_SECRET = 'a'.repeat(64);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('configures ISO timestamp format in source code', async () => {
    const sourceCode = fs.readFileSync(
      path.join(process.cwd(), 'src', 'logger.ts'),
      'utf-8'
    );

    // Check for ISO timestamp configuration
    expect(sourceCode).toContain('toISOString()');
    expect(sourceCode).toContain('"ts"');
  });

  it('configures level formatter in source code', async () => {
    const sourceCode = fs.readFileSync(
      path.join(process.cwd(), 'src', 'logger.ts'),
      'utf-8'
    );

    // Check for level formatter
    expect(sourceCode).toContain('formatters');
    expect(sourceCode).toContain('level:');
  });

  it('uses slack-claude-daemon as service name for daemon loggers', async () => {
    const sourceCode = fs.readFileSync(
      path.join(process.cwd(), 'src', 'logger.ts'),
      'utf-8'
    );

    expect(sourceCode).toContain("service: 'slack-claude-daemon'");
  });

  it('uses slack-claude-hook as service name for hook loggers', async () => {
    const sourceCode = fs.readFileSync(
      path.join(process.cwd(), 'src', 'logger.ts'),
      'utf-8'
    );

    expect(sourceCode).toContain("service: 'slack-claude-hook'");
  });
});
