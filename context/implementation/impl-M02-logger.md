# Implementation Spec: M-02 -- Logger

> Blueprint: blprnt-M02-logger.md | Contracts: impl-contracts.md S5 | Patterns: impl-master.md S3-S4

---

## 1. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| impl-contracts.md | S5 | ~300 | LogEntry interface |
| impl-master.md | S4 | ~200 | Naming conventions |
| impl-M01-config.md | S4.1 | ~100 | Config imports |

### Total Budget: ~600 tokens

---

## 2. File Map

| Order | Path | Purpose | Creates/Modifies |
|-------|------|---------|------------------|
| 1 | `src/logger.ts` | Pino logger setup | Creates |
| 2 | `tests/unit/logger.test.ts` | Unit tests | Creates |

---

## 3. Dependencies Setup

```typescript
// src/logger.ts
import pino, { Logger } from 'pino';
import rotating from 'pino-rotating-file-stream';
import path from 'path';
import { config, LOGS_DIR } from './config';
```

---

## 4. Core Implementation

### 4.1 src/logger.ts

**Path**: `src/logger.ts`

**Exports**:
```typescript
export function createLogger(module: string): Logger;
export function createHookLogger(hookType: string): Logger;
export function withRequestId(logger: Logger, requestId: string): Logger;
export const logger: Logger;  // Default daemon logger
```

**Logic**:
```typescript
// Redaction paths - NEVER log these
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
];

// Base pino config
const baseConfig: pino.LoggerOptions = {
  level: config.logLevel,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
};

// Rotating file stream for daemon logs
function createFileStream() {
  return rotating({
    path: path.join(LOGS_DIR, 'daemon-%Y-%m-%d.log'),
    size: '10M',
    maxFiles: 5,
    compress: true,
  });
}

// Create module-scoped logger
export function createLogger(module: string): Logger {
  return pino({
    ...baseConfig,
    base: { service: 'slack-claude-daemon', module },
  }, createFileStream());
}

// Create hook-specific logger (separate file)
export function createHookLogger(hookType: string): Logger {
  return pino({
    ...baseConfig,
    base: { service: 'slack-claude-hook', hookType, pid: process.pid },
  }, pino.destination(path.join(LOGS_DIR, 'hooks.log')));
}

// Add request correlation
export function withRequestId(logger: Logger, requestId: string): Logger {
  return logger.child({ requestId });
}

// Default logger
export const logger = createLogger('main');
```

**Error Handling**:
- File write fails → fallback to stdout (pino default)

**Logging**: N/A (this IS the logger)

---

## 5. Data Structures

Log files:
- `~/.claude/slack_integration/data/logs/daemon-YYYY-MM-DD.log`
- `~/.claude/slack_integration/data/logs/hooks.log`

---

## 6. Test Guide

| File | Covers | Mocks | Fixtures |
|------|--------|-------|----------|
| `tests/unit/logger.test.ts` | createLogger, redaction | pino-rotating-file-stream | - |

**Key Test Cases**:
```typescript
describe('logger', () => {
  it('creates module-scoped logger');
  it('redacts authorization header');
  it('redacts DAEMON_SECRET');
  it('redacts input.message');
  it('includes timestamp in ISO format');
  it('respects log level from config');
});

describe('createHookLogger', () => {
  it('includes hookType in base');
  it('writes to hooks.log');
});

describe('withRequestId', () => {
  it('adds requestId to child logger');
});
```

---

## 7. Integration Points

| Ref | Contract | How |
|-----|----------|-----|
| impl-contracts.md S5 | LogEntry | Output matches interface |

---

## 8. Parallel Notes

- Can start immediately after M-01 exports are available
- Other modules import `logger` for their logging needs
