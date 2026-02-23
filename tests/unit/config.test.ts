import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

// Store original env
const originalEnv = process.env;

describe('config', () => {
  beforeEach(() => {
    // Reset modules to allow fresh import
    vi.resetModules();
    // Create fresh env copy
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('loadConfig', () => {
    it('loads valid config from env', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config.slackBotToken).toBe('xoxb-test-token');
      expect(config.slackAppToken).toBe('xapp-test-token');
      expect(config.slackChannelId).toBe('C1234567890');
      expect(config.daemonSecret).toBe('a'.repeat(64));
    });

    it('generates DAEMON_SECRET if missing', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      delete process.env.DAEMON_SECRET;

      // Suppress console.warn
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config.daemonSecret).toHaveLength(64);
      expect(config.daemonSecret).toMatch(/^[a-f0-9]+$/);
      expect(console.warn).toHaveBeenCalled();
    });

    it('throws on missing SLACK_BOT_TOKEN', async () => {
      delete process.env.SLACK_BOT_TOKEN;
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);

      const { loadConfig } = await import('../../src/config.js');

      expect(() => loadConfig()).toThrow('CONFIG_VALIDATION_FAILED');
      expect(() => loadConfig()).toThrow('slackBotToken');
    });

    it('throws on invalid SLACK_BOT_TOKEN format', async () => {
      process.env.SLACK_BOT_TOKEN = 'invalid-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);

      const { loadConfig } = await import('../../src/config.js');

      expect(() => loadConfig()).toThrow('CONFIG_VALIDATION_FAILED');
      expect(() => loadConfig()).toThrow('xoxb-');
    });

    it('throws on invalid SLACK_APP_TOKEN format', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'invalid-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);

      const { loadConfig } = await import('../../src/config.js');

      expect(() => loadConfig()).toThrow('CONFIG_VALIDATION_FAILED');
      expect(() => loadConfig()).toThrow('xapp-');
    });

    it('throws on invalid SLACK_CHANNEL_ID format', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'invalid-channel';
      process.env.DAEMON_SECRET = 'a'.repeat(64);

      const { loadConfig } = await import('../../src/config.js');

      expect(() => loadConfig()).toThrow('CONFIG_VALIDATION_FAILED');
      expect(() => loadConfig()).toThrow('slackChannelId');
    });

    it('parses AUTHORIZED_USERS correctly', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);
      process.env.AUTHORIZED_USERS = 'U123456789,U987654321,invalid';

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config.authorizedUsers).toEqual(['U123456789', 'U987654321']);
    });

    it('handles empty AUTHORIZED_USERS', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);
      process.env.AUTHORIZED_USERS = '';

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config.authorizedUsers).toEqual([]);
    });

    it('uses default values for optional fields', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);
      delete process.env.TRANSPORT_MODE;
      delete process.env.DAEMON_PORT;
      delete process.env.LOG_LEVEL;

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config.transportMode).toBe('unix');
      expect(config.daemonPort).toBe(3847);
      expect(config.logLevel).toBe('info');
    });

    it('validates transportMode enum', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);
      process.env.TRANSPORT_MODE = 'tcp';

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config.transportMode).toBe('tcp');
    });

    it('validates logLevel enum', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);
      process.env.LOG_LEVEL = 'debug';

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config.logLevel).toBe('debug');
    });

    it('parses DAEMON_PORT as integer', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);
      process.env.DAEMON_PORT = '8080';

      const { loadConfig } = await import('../../src/config.js');
      const config = loadConfig();

      expect(config.daemonPort).toBe(8080);
      expect(typeof config.daemonPort).toBe('number');
    });

    it('throws on invalid DAEMON_SECRET format', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'not-valid-hex';

      const { loadConfig } = await import('../../src/config.js');

      expect(() => loadConfig()).toThrow('CONFIG_VALIDATION_FAILED');
    });
  });

  describe('path resolution', () => {
    it('resolves DATA_DIR to ~/.claude/slack_integration/data', async () => {
      const { DATA_DIR } = await import('../../src/config.js');
      const expected = path.join(os.homedir(), '.claude', 'slack_integration', 'data');
      expect(DATA_DIR).toBe(expected);
    });

    it('resolves HOOKS_DIR to ~/.claude/slack_integration/hooks', async () => {
      const { HOOKS_DIR } = await import('../../src/config.js');
      const expected = path.join(os.homedir(), '.claude', 'slack_integration', 'hooks');
      expect(HOOKS_DIR).toBe(expected);
    });

    it('resolves LOGS_DIR to ~/.claude/slack_integration/data/logs', async () => {
      const { LOGS_DIR } = await import('../../src/config.js');
      const expected = path.join(os.homedir(), '.claude', 'slack_integration', 'data', 'logs');
      expect(LOGS_DIR).toBe(expected);
    });

    it('resolves BASE_INTEGRATION_DIR to ~/.claude/slack_integration', async () => {
      const { BASE_INTEGRATION_DIR } = await import('../../src/config.js');
      const expected = path.join(os.homedir(), '.claude', 'slack_integration');
      expect(BASE_INTEGRATION_DIR).toBe(expected);
    });
  });

  describe('getConfig', () => {
    it('returns singleton instance', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);

      const { getConfig, resetConfig } = await import('../../src/config.js');
      resetConfig();

      const config1 = getConfig();
      const config2 = getConfig();

      expect(config1).toBe(config2);
    });

    it('resetConfig clears singleton', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
      process.env.SLACK_APP_TOKEN = 'xapp-test-token';
      process.env.SLACK_CHANNEL_ID = 'C1234567890';
      process.env.DAEMON_SECRET = 'a'.repeat(64);

      const { getConfig, resetConfig } = await import('../../src/config.js');

      const config1 = getConfig();
      resetConfig();
      const config2 = getConfig();

      // Both should be valid but different instances
      expect(config1.slackBotToken).toBe(config2.slackBotToken);
    });
  });

  describe('ConfigSchema', () => {
    it('exports ConfigSchema for external validation', async () => {
      const { ConfigSchema } = await import('../../src/config.js');

      const validData = {
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
        slackChannelId: 'C123',
        authorizedUsers: [],
        daemonSecret: 'a'.repeat(64),
        transportMode: 'unix',
        daemonPort: 3847,
        dataDir: '/path/to/data',
        hooksDir: '/path/to/hooks',
        logsDir: '/path/to/logs',
        logLevel: 'info',
      };

      const result = ConfigSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });
});
