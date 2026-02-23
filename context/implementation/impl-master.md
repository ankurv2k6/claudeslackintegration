# Implementation Master

> Coordination layer for parallel implementation.
> Code-level companion to blprnt-master.md.

---

## S1. Parallel Workstream Map

| Workstream | Modules | Start Condition | Blockers | Merge Point |
|------------|---------|-----------------|----------|-------------|
| WS-A Foundation | M-01, M-02 | Immediate | None | Phase 1 gate |
| WS-B Core Data | M-03, M-04 | WS-A complete | M-01, M-02 exports | Phase 2 gate |
| WS-C Slack | M-05 | WS-B complete | M-03, M-04 exports | Phase 3 gate |
| WS-D HTTP | M-06 | WS-B complete | M-03, M-04, M-05 exports | Phase 3 gate |
| WS-E Hooks | M-07 | WS-A complete (partial) | M-01, M-02 exports; stub daemon | Phase 4 gate |
| WS-F Hardening | M-08 | WS-B complete | M-03, M-04 exports | Phase 5 gate |

**Parallel Opportunities**:
- WS-A: M-01 and M-02 can start simultaneously (M-02 imports M-01 at end)
- WS-B: M-03 and M-04 can start simultaneously (M-04 imports M-03 locking)
- WS-C/WS-D: Can run in parallel after WS-B
- WS-E: Can start after WS-A with stubbed daemon client

---

## S2. Contract Index

| Contract | Section | Producer | Consumers | Status |
|----------|---------|----------|-----------|--------|
| SessionEntry | impl-contracts.md S1 | M-03 | M-04, M-05, M-06, M-07 | LOCKED |
| Task | impl-contracts.md S2 | M-04 | M-05, M-06, M-07 | LOCKED |
| HookInput | impl-contracts.md S3 | Claude Code | M-07 | LOCKED |
| HookOutput | impl-contracts.md S3 | M-07 | Claude Code | LOCKED |
| SessionStartRequest | impl-contracts.md S4 | M-07 | M-06 | LOCKED |
| SessionMessageRequest | impl-contracts.md S4 | M-05, M-07 | M-06 | LOCKED |
| TaskClaimRequest | impl-contracts.md S4 | M-07 | M-06 | LOCKED |
| LogEntry | impl-contracts.md S5 | M-02 | All | DRAFT |
| Config | impl-contracts.md S6 | M-01 | All | LOCKED |

---

## S3. Shared Infrastructure Patterns

### File Locking (defined in M-03, used by M-03, M-04, M-08)

```typescript
// src/lib/file-lock.ts
import lockfile from 'proper-lockfile';
import { logger } from './logger';

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options = { retries: 5, stale: 10000 }
): Promise<T> {
  const release = await lockfile.lock(filePath, {
    retries: { retries: options.retries, minTimeout: 100, maxTimeout: 1000 },
    stale: options.stale,
  });

  try {
    return await fn();
  } finally {
    await release();
  }
}
```

### Atomic Write (defined in M-03, used by M-03, M-04, M-08)

```typescript
// src/lib/atomic-write.ts
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export async function atomicWriteJSON(
  filePath: string,
  data: object
): Promise<void> {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
```

### Request Correlation (used by all modules)

```typescript
// src/lib/context.ts
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  requestId: string;
  sessionId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function withContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return requestContext.getStore();
}
```

---

## S4. Cross-Cutting Decisions

### Error Handling

```typescript
// All errors extend BaseError
class BaseError extends Error {
  constructor(
    public code: string,
    message: string,
    public recoveryHint?: string
  ) {
    super(message);
    this.name = code;
  }
}

// Usage: throw new BaseError('REGISTRY_WRITE_FAILED', 'Disk full', 'Free space');
```

### Naming Conventions

| Entity | Convention | Example |
|--------|------------|---------|
| Files | kebab-case | `slack-client.ts` |
| Classes | PascalCase | `TaskQueue` |
| Functions | camelCase | `claimNextTask` |
| Constants | SCREAMING_SNAKE | `DATA_DIR` |
| Interfaces | PascalCase, no I-prefix | `SessionEntry` |
| Zod schemas | PascalCase + Schema | `SessionEntrySchema` |

### File Organization

```
~/.claude/slack_integration/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # M-01
│   ├── logger.ts             # M-02
│   ├── registry.ts           # M-03
│   ├── task-queue.ts         # M-04
│   ├── slack-client.ts       # M-05
│   ├── http-server.ts        # M-06
│   ├── recovery.ts           # M-08
│   ├── lib/                  # Shared utilities
│   │   ├── file-lock.ts
│   │   ├── atomic-write.ts
│   │   ├── context.ts
│   │   └── errors.ts
│   ├── middleware/           # Express middleware
│   │   ├── auth.ts
│   │   ├── validation.ts
│   │   └── error-handler.ts
│   └── schemas/              # Zod schemas
│       └── api.ts
├── hooks/                    # M-07
│   ├── session-start.ts
│   ├── stop.ts
│   ├── session-end.ts
│   └── lib/
│       ├── daemon-client.ts
│       ├── hook-helpers.ts
│       ├── hook-logger.ts
│       ├── circuit-breaker.ts
│       └── summary.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   ├── security/
│   └── chaos/
└── data/                     # Runtime data
    ├── registry.json
    ├── tasks/
    ├── logs/
    └── transactions.json
```

### Import Order

```typescript
// 1. Node.js built-ins
import path from 'path';
import crypto from 'crypto';

// 2. External packages
import express from 'express';
import { z } from 'zod';

// 3. Internal shared
import { config } from './config';
import { logger } from './logger';

// 4. Internal local
import { SessionEntrySchema } from './schemas/api';
```

---

## S5. Stub Definitions

### Daemon Client Stub (for M-07 parallel development)

```typescript
// hooks/lib/daemon-client.stub.ts
// Replace with real implementation after M-06 complete

export class DaemonClientStub {
  async sessionStart(input: { sessionId: string; cwd: string }): Promise<{
    threadTs: string;
    channelId: string;
  }> {
    console.log('[STUB] sessionStart called', input);
    return { threadTs: '123.456', channelId: 'C123' };
  }

  async getTasks(sessionId: string): Promise<Task[]> {
    console.log('[STUB] getTasks called', sessionId);
    return [];
  }

  async claimTask(sessionId: string, taskId: string): Promise<Task> {
    console.log('[STUB] claimTask called', sessionId, taskId);
    throw new Error('STUB: No tasks');
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    console.log('[STUB] sendMessage called', sessionId, text);
  }

  async sessionClose(sessionId: string): Promise<void> {
    console.log('[STUB] sessionClose called', sessionId);
  }
}

// Usage: import { DaemonClientStub as DaemonClient } from './daemon-client.stub';
// Replace with: import { DaemonClient } from './daemon-client';
```

**Replace Instructions**:
1. After M-06 complete, delete `daemon-client.stub.ts`
2. Update imports in `session-start.ts`, `stop.ts`, `session-end.ts`
3. Run integration tests

---

## S6. Integration Checklist (Merge Points)

### Phase 1 → Phase 2

- [ ] M-01 `loadConfig()` returns valid `Config`
- [ ] M-02 `createLogger()` returns working `Logger`
- [ ] Both modules have 95%+ coverage

### Phase 2 → Phase 3

- [ ] M-03 `withFileLock` and `atomicWriteJSON` exported
- [ ] M-03 all CRUD operations working
- [ ] M-04 `addTask` and `claimNextTask` working
- [ ] Concurrency tests pass (10+ parallel operations)

### Phase 3 → Phase 4

- [ ] M-05 Socket Mode connects to Slack
- [ ] M-05 message handler routes to task queue
- [ ] M-06 all endpoints return valid responses
- [ ] M-06 auth middleware rejects invalid tokens
- [ ] E2E: Slack message → task → claim → response

### Phase 4 → Phase 5

- [ ] M-07 all hooks compile and execute
- [ ] M-07 stop hook injects prompts correctly
- [ ] M-07 circuit breaker tested
- [ ] Real Claude Code test: session lifecycle

### Phase 5 → Complete

- [ ] M-08 crash recovery tested
- [ ] M-08 backup rotation working
- [ ] Full E2E suite passes
- [ ] 90%+ total coverage

---

## S7. Module Implementation Order

| Order | Module | Can Parallel With | Critical Path |
|-------|--------|-------------------|---------------|
| 1 | M-01 Config | M-02 (end) | Yes |
| 2 | M-02 Logger | M-01 (start) | Yes |
| 3 | M-03 Registry | M-04 | Yes |
| 4 | M-04 TaskQueue | M-03 | Yes |
| 5 | M-05 SlackClient | M-06 | Yes |
| 6 | M-06 HttpServer | M-05 | Yes |
| 7 | M-07 Hooks | - | Yes |
| 8 | M-08 Recovery | - | No |

---

## Cross-References

- Blueprint Master: [blprnt-master.md](../blueprints/blprnt-master.md)
- Contracts: [impl-contracts.md](impl-contracts.md)
