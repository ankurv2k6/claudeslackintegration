# Implementation Spec: M-01 -- Config

> Blueprint: blprnt-M01-config.md | Contracts: impl-contracts.md S6 | Patterns: impl-master.md S3-S4

---

## 1. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| impl-contracts.md | S6 | ~200 | Config interface & schema |
| impl-master.md | S4 | ~300 | Naming, file org |

### DO NOT LOAD
- Other impl specs, full blueprints

### Total Budget: ~500 tokens

---

## 2. File Map

| Order | Path | Purpose | Creates/Modifies |
|-------|------|---------|------------------|
| 1 | `src/config.ts` | Config loading and validation | Creates |
| 2 | `.env.example` | Environment template | Creates |
| 3 | `tests/unit/config.test.ts` | Unit tests | Creates |

---

## 3. Dependencies Setup

```typescript
// src/config.ts
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import crypto from 'crypto';
import path from 'path';
import os from 'os';
```

---

## 4. Core Implementation

### 4.1 src/config.ts

**Path**: `src/config.ts`

**Exports**:
```typescript
export interface Config { ... }  // From impl-contracts.md S6
export const ConfigSchema: z.ZodType<Config>;
export function loadConfig(): Config;
export const config: Config;  // Singleton
export const DATA_DIR: string;
export const HOOKS_DIR: string;
export const LOGS_DIR: string;
```

**Logic**:
```typescript
// 1. Load .env from integration directory
const BASE_DIR = path.join(os.homedir(), '.claude', 'slack_integration');
dotenvConfig({ path: path.join(BASE_DIR, '.env') });

// 2. Generate DAEMON_SECRET if not provided
function getOrGenerateSecret(): string {
  if (process.env.DAEMON_SECRET) {
    return process.env.DAEMON_SECRET;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  console.warn('DAEMON_SECRET not set, generated:', secret.slice(0, 8) + '...');
  return secret;
}

// 3. Parse AUTHORIZED_USERS
function parseAuthorizedUsers(): string[] {
  const raw = process.env.AUTHORIZED_USERS || '';
  return raw.split(',').filter(u => u.startsWith('U'));
}

// 4. Build and validate config
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
    const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`CONFIG_VALIDATION_FAILED:\n${errors.join('\n')}`);
  }

  return result.data;
}

// 5. Singleton export
export const config = loadConfig();
export const DATA_DIR = config.dataDir;
export const HOOKS_DIR = config.hooksDir;
export const LOGS_DIR = config.logsDir;
```

**Error Handling**:
- Missing required env → throw with clear message listing missing vars
- Invalid format → throw with Zod error details

**Logging**: None (logger not yet available at this stage)

### 4.2 .env.example

```bash
# Slack Configuration (Required)
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_CHANNEL_ID=C0123456789

# Security (Optional - auto-generated if not set)
DAEMON_SECRET=your-64-char-hex-string

# Transport (Optional)
TRANSPORT_MODE=unix
DAEMON_PORT=3847

# Authorization (Optional - empty = all users allowed)
AUTHORIZED_USERS=U0123456789,U9876543210

# Logging (Optional)
LOG_LEVEL=info
```

---

## 5. Data Structures

None (stateless).

---

## 6. Test Guide

| File | Covers | Mocks | Fixtures |
|------|--------|-------|----------|
| `tests/unit/config.test.ts` | loadConfig, validation | process.env | env-valid.json, env-invalid.json |

**Key Test Cases**:
```typescript
describe('loadConfig', () => {
  it('loads valid config from env');
  it('generates DAEMON_SECRET if missing');
  it('throws on missing SLACK_BOT_TOKEN');
  it('throws on invalid SLACK_BOT_TOKEN format');
  it('parses AUTHORIZED_USERS correctly');
  it('uses default values for optional fields');
  it('validates path formats');
});
```

---

## 7. Integration Points

| Ref | Contract | How |
|-----|----------|-----|
| impl-contracts.md S6 | Config | Export matches interface |

---

## 8. Parallel Notes

None (M-01 has no dependencies, can start immediately).
