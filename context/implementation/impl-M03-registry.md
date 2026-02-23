# Implementation Spec: M-03 -- Registry

> Blueprint: blprnt-M03-registry.md | Contracts: impl-contracts.md S1 | Patterns: impl-master.md S3

---

## 1. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| impl-contracts.md | S1 | ~400 | SessionEntry, Registry |
| impl-master.md | S3 | ~300 | File locking, atomic write |

### Total Budget: ~700 tokens

---

## 2. File Map

| Order | Path | Purpose | Creates/Modifies |
|-------|------|---------|------------------|
| 1 | `src/lib/file-lock.ts` | File locking utility | Creates |
| 2 | `src/lib/atomic-write.ts` | Atomic JSON write | Creates |
| 3 | `src/registry.ts` | Session registry | Creates |
| 4 | `tests/unit/registry.test.ts` | Unit tests | Creates |

---

## 3. Dependencies Setup

```typescript
// src/registry.ts
import lockfile from 'proper-lockfile';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config, DATA_DIR } from './config';
import { logger } from './logger';
import { withFileLock } from './lib/file-lock';
import { atomicWriteJSON } from './lib/atomic-write';
import { Registry, SessionEntry, SessionStatus, RegistrySchema } from './schemas/api';
```

---

## 4. Core Implementation

### 4.1 src/lib/file-lock.ts

**Logic**:
```typescript
import lockfile from 'proper-lockfile';

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options = { retries: 5, stale: 10000 }
): Promise<T> {
  // Ensure file exists for locking
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, '{}', { mode: 0o600 });
  }

  const release = await lockfile.lock(filePath, {
    retries: {
      retries: options.retries,
      minTimeout: 100,
      maxTimeout: 1000,
    },
    stale: options.stale,
  });

  try {
    return await fn();
  } finally {
    await release();
  }
}
```

### 4.2 src/lib/atomic-write.ts

**Logic**:
```typescript
import crypto from 'crypto';
import fs from 'fs/promises';

export async function atomicWriteJSON(
  filePath: string,
  data: object
): Promise<void> {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
```

### 4.3 src/registry.ts

**Exports**:
```typescript
export async function createSession(input: CreateSessionInput): Promise<SessionEntry>;
export async function getSession(sessionId: string): Promise<SessionEntry | null>;
export async function updateSession(sessionId: string, updates: Partial<SessionEntry>): Promise<SessionEntry>;
export async function updateStatus(sessionId: string, status: SessionStatus): Promise<void>;
export async function removeSession(sessionId: string): Promise<void>;
export async function getSessionByThread(threadTs: string): Promise<SessionEntry | null>;
export async function cleanupStaleSessions(maxAgeMs: number): Promise<number>;
```

**Logic**:
```typescript
const REGISTRY_PATH = path.join(DATA_DIR, 'registry.json');

// Valid state transitions
const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  PENDING: ['ACTIVE', 'ERROR'],
  ACTIVE: ['CLOSING', 'ERROR', 'CLOSED'],
  CLOSING: ['CLOSED'],
  CLOSED: [],
  ERROR: ['ACTIVE'],
};

async function loadRegistry(): Promise<Registry> {
  try {
    const data = await fs.readFile(REGISTRY_PATH, 'utf-8');
    return RegistrySchema.parse(JSON.parse(data));
  } catch {
    return { version: 1, sessions: {}, threadToSession: {} };
  }
}

export async function createSession(input: CreateSessionInput): Promise<SessionEntry> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await loadRegistry();

    const entry: SessionEntry = {
      ...input,
      status: 'PENDING',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      injectionCount: 0,
      errorHistory: [],
    };

    registry.sessions[input.sessionId] = entry;
    registry.threadToSession[input.threadTs] = input.sessionId;

    await atomicWriteJSON(REGISTRY_PATH, registry);
    logger.info({ action: 'SESSION_CREATED', sessionId: input.sessionId });

    return entry;
  });
}

export async function updateStatus(sessionId: string, newStatus: SessionStatus): Promise<void> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await loadRegistry();
    const session = registry.sessions[sessionId];

    if (!session) {
      throw new Error(`REGISTRY_SESSION_404: ${sessionId}`);
    }

    const validNext = VALID_TRANSITIONS[session.status];
    if (!validNext.includes(newStatus)) {
      throw new Error(
        `INVALID_STATE_TRANSITION: ${session.status} -> ${newStatus}`
      );
    }

    session.status = newStatus;
    session.lastActivityAt = new Date().toISOString();

    await atomicWriteJSON(REGISTRY_PATH, registry);
    logger.info({ action: 'SESSION_STATUS_UPDATED', sessionId, status: newStatus });
  });
}

// ... other functions follow similar pattern
```

---

## 5. Data Structures

**Registry File**: `~/.claude/slack_integration/data/registry.json`
- Permissions: 0600
- Backup: `registry.json.backup.{timestamp}`

---

## 6. Test Guide

| File | Covers | Mocks | Fixtures |
|------|--------|-------|----------|
| `tests/unit/registry.test.ts` | All CRUD, state machine | fs, proper-lockfile | registry-sample.json |

**Key Test Cases**:
```typescript
describe('createSession', () => {
  it('creates session with PENDING status');
  it('updates threadToSession index');
  it('sets timestamps');
});

describe('updateStatus', () => {
  it('allows PENDING -> ACTIVE');
  it('rejects PENDING -> CLOSED');
  it('updates lastActivityAt');
});

describe('concurrency', () => {
  it('handles 10 concurrent creates');
  it('handles lock contention gracefully');
});
```

---

## 7. Integration Points

| Ref | Contract | How |
|-----|----------|-----|
| impl-contracts.md S1 | SessionEntry | Stored/returned matches interface |

---

## 8. Parallel Notes

- Export `withFileLock` and `atomicWriteJSON` for M-04 to use
- Can start in parallel with M-04 (M-04 imports locking utilities)
