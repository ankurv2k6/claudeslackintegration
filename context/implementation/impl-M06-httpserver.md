# Implementation Spec: M-06 -- HttpServer

> Blueprint: blprnt-M06-httpserver.md | Contracts: impl-contracts.md S4 | Patterns: impl-master.md S4

---

## 1. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| impl-contracts.md | S4 | ~500 | Request/response schemas |
| impl-master.md | S4 | ~200 | File org, error handling |

### Total Budget: ~700 tokens

---

## 2. File Map

| Order | Path | Purpose | Creates/Modifies |
|-------|------|---------|------------------|
| 1 | `src/middleware/auth.ts` | Bearer token auth | Creates |
| 2 | `src/middleware/validation.ts` | Zod validation | Creates |
| 3 | `src/middleware/error-handler.ts` | Error handling | Creates |
| 4 | `src/http-server.ts` | Express server | Creates |
| 5 | `tests/unit/http-server.test.ts` | Unit tests | Creates |
| 6 | `tests/integration/http-server.test.ts` | Integration tests | Creates |
| 7 | `tests/security/http-server.test.ts` | Security tests | Creates |

---

## 3. Dependencies Setup

```typescript
// src/http-server.ts
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { config, DATA_DIR } from './config';
import { logger, withRequestId } from './logger';
import * as registry from './registry';
import * as taskQueue from './task-queue';
import { sendSlackMessage } from './slack-client';
import { bearerTokenAuth } from './middleware/auth';
import { validateBody } from './middleware/validation';
import { errorHandler } from './middleware/error-handler';
```

---

## 4. Core Implementation

### 4.1 src/middleware/auth.ts

```typescript
import { timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { logger } from '../logger';

// Grace period tokens for rotation
const gracePeriodTokens = new Map<string, number>();

export function bearerTokenAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;

  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  const token = auth.slice(7);
  const tokenBuffer = Buffer.from(token);
  const secretBuffer = Buffer.from(config.daemonSecret);

  // Check current token (timing-safe)
  if (tokenBuffer.length === secretBuffer.length &&
      timingSafeEqual(tokenBuffer, secretBuffer)) {
    return next();
  }

  // Check grace period tokens
  for (const [oldToken, expiresAt] of gracePeriodTokens) {
    if (Date.now() < expiresAt) {
      const oldBuffer = Buffer.from(oldToken);
      if (tokenBuffer.length === oldBuffer.length &&
          timingSafeEqual(tokenBuffer, oldBuffer)) {
        return next();
      }
    }
  }

  logger.warn({ action: 'HTTP_AUTH_FAILED', ip: req.ip });
  return res.status(401).json({ error: 'Invalid token' });
}

export function hostHeaderValidation(req: Request, res: Response, next: NextFunction) {
  const host = req.headers.host;
  if (!host || (!host.startsWith('localhost:') && !host.startsWith('127.0.0.1:'))) {
    logger.warn({ action: 'INVALID_HOST_HEADER', host });
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}
```

### 4.2 src/http-server.ts

```typescript
const app = express();

// Middleware stack
app.use(helmet());
app.use(rateLimit({ windowMs: 60000, max: 100 }));
app.use(hostHeaderValidation);
app.use(express.json({ limit: '100kb' }));

// Per-session rate limiting
const sessionRateLimits = new Map<string, { count: number; resetAt: number }>();
app.use((req, res, next) => {
  const sessionId = req.body?.sessionId || req.params?.id;
  if (sessionId) {
    const limit = sessionRateLimits.get(sessionId) || { count: 0, resetAt: Date.now() + 60000 };
    if (Date.now() > limit.resetAt) {
      limit.count = 0;
      limit.resetAt = Date.now() + 60000;
    }
    if (limit.count++ > 30) {
      return res.status(429).json({ error: 'Session rate limit exceeded' });
    }
    sessionRateLimits.set(sessionId, limit);
  }
  next();
});

// Public endpoints (no auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    sessions: Object.keys(await registry.getSessions()).length,
    version: require('../package.json').version,
  });
});

// Protected endpoints
app.use(bearerTokenAuth);

app.post('/session/start',
  validateBody(SessionStartRequestSchema),
  async (req, res) => {
    const { sessionId, cwd } = req.body;

    // Create Slack thread
    const thread = await slackClient.chat.postMessage({
      channel: config.slackChannelId,
      text: `Session started in \`${cwd}\``,
    });

    // Register session
    const session = await registry.createSession({
      sessionId,
      threadTs: thread.ts,
      channelId: config.slackChannelId,
      codebasePath: cwd,
    });

    // Transition to ACTIVE
    await registry.updateStatus(sessionId, 'ACTIVE');

    res.json({
      sessionId,
      threadTs: thread.ts,
      channelId: config.slackChannelId,
      status: 'ACTIVE',
    });
  }
);

app.post('/session/:id/tasks/claim', async (req, res) => {
  const task = await taskQueue.claimNextTask(req.params.id);
  res.json(task || { task: null });
});

// Start server
export function createServer(): net.Server | ReturnType<typeof app.listen> {
  if (config.transportMode === 'unix') {
    const socketPath = path.join(DATA_DIR, 'daemon.sock');

    // Remove stale socket
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    const server = app.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      logger.info({ action: 'DAEMON_STARTED', transport: 'unix', path: socketPath });
    });

    return server;
  } else {
    return app.listen(config.daemonPort, '127.0.0.1', () => {
      logger.info({ action: 'DAEMON_STARTED', transport: 'tcp', port: config.daemonPort });
    });
  }
}
```

---

## 5. Data Structures

**Unix Socket**: `~/.claude/slack_integration/daemon.sock` (0600)

---

## 6. Test Guide

| File | Covers | Mocks | Fixtures |
|------|--------|-------|----------|
| `tests/unit/http-server.test.ts` | Middleware, routes | express | - |
| `tests/integration/http-server.test.ts` | Full flow | supertest | - |
| `tests/security/http-server.test.ts` | Auth, timing | - | - |

**Key Test Cases**:
```typescript
describe('auth middleware', () => {
  it('rejects missing token');
  it('rejects invalid token');
  it('accepts valid token');
  it('timing-safe comparison');
});

describe('endpoints', () => {
  it('POST /session/start creates session');
  it('POST /session/:id/tasks/claim returns task');
});
```

---

## 7. Integration Points

| Ref | Contract | How |
|-----|----------|-----|
| impl-contracts.md S4 | Request schemas | Validates all inputs |

---

## 8. Parallel Notes

- Can run in parallel with M-05 after M-04 complete
- M-07 hooks will call these endpoints
