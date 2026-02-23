/**
 * M-01: Configuration Module
 *
 * Loads and validates all environment variables at startup.
 * Exports typed configuration object and Zod schemas for runtime validation.
 * Fails fast with descriptive errors if required config is missing or invalid.
 */

import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

// Base directory for all slack integration files
const BASE_DIR = path.join(os.homedir(), '.claude', 'slack_integration');

// Load .env from integration directory (if exists)
dotenvConfig({ path: path.join(BASE_DIR, '.env') });

/**
 * Zod schema for Config validation (LOCKED contract from impl-contracts.md S6)
 */
export const ConfigSchema = z.object({
  slackBotToken: z.string().startsWith('xoxb-', {
    message: 'SLACK_BOT_TOKEN must start with xoxb-',
  }),
  slackAppToken: z.string().startsWith('xapp-', {
    message: 'SLACK_APP_TOKEN must start with xapp-',
  }),
  slackChannelId: z.string().startsWith('C', {
    message: 'SLACK_CHANNEL_ID must start with C',
  }),
  authorizedUsers: z.array(z.string().startsWith('U')),

  daemonSecret: z.string().length(64).regex(/^[a-f0-9]+$/, {
    message: 'DAEMON_SECRET must be a 64-character hex string',
  }),
  transportMode: z.enum(['unix', 'tcp']).default('unix'),
  daemonPort: z.number().int().min(1024).max(65535).default(3847),

  dataDir: z.string(),
  hooksDir: z.string(),
  logsDir: z.string(),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/**
 * TypeScript type for validated configuration
 */
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Generate a cryptographically secure 64-character hex secret
 */
function generateSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Get DAEMON_SECRET from environment or generate a new one
 */
function getOrGenerateSecret(): string {
  const existing = process.env.DAEMON_SECRET;
  if (existing) {
    return existing;
  }
  const secret = generateSecret();
  console.warn(
    `DAEMON_SECRET not set, generated: ${secret.slice(0, 8)}...`
  );
  return secret;
}

/**
 * Parse AUTHORIZED_USERS comma-separated string into array
 */
function parseAuthorizedUsers(): string[] {
  const raw = process.env.AUTHORIZED_USERS || '';
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.startsWith('U'));
}

/**
 * Load and validate configuration from environment variables.
 * Throws a descriptive error if validation fails.
 */
export function loadConfig(): Config {
  const rawConfig = {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackAppToken: process.env.SLACK_APP_TOKEN,
    slackChannelId: process.env.SLACK_CHANNEL_ID,
    authorizedUsers: parseAuthorizedUsers(),
    daemonSecret: getOrGenerateSecret(),
    transportMode: process.env.TRANSPORT_MODE || 'unix',
    daemonPort: parseInt(process.env.DAEMON_PORT || '3847', 10),
    dataDir: path.join(BASE_DIR, 'data'),
    hooksDir: path.join(BASE_DIR, 'hooks'),
    logsDir: path.join(BASE_DIR, 'data', 'logs'),
    logLevel: process.env.LOG_LEVEL || 'info',
  };

  const result = ConfigSchema.safeParse(rawConfig);

  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`
    );
    throw new Error(
      `CONFIG_VALIDATION_FAILED:\n${errors.join('\n')}`
    );
  }

  return result.data;
}

// Singleton config instance - loaded on import
// Note: We wrap in a function to allow tests to reset env vars
let _config: Config | null = null;

/**
 * Get the singleton config instance.
 * Throws on first call if config validation fails.
 */
export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Reset the config singleton (for testing only)
 */
export function resetConfig(): void {
  _config = null;
}

// Export resolved paths as constants
export const DATA_DIR = path.join(BASE_DIR, 'data');
export const HOOKS_DIR = path.join(BASE_DIR, 'hooks');
export const LOGS_DIR = path.join(BASE_DIR, 'data', 'logs');
export const BASE_INTEGRATION_DIR = BASE_DIR;
