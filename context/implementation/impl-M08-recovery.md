# Implementation Spec: M-08 -- Recovery

> Blueprint: blprnt-M08-recovery.md | Contracts: impl-contracts.md S1-S2 | Patterns: impl-master.md S3

---

## 1. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| impl-contracts.md | S1, S2 | ~400 | SessionEntry, Task |
| impl-master.md | S3 | ~200 | Locking patterns |

### Total Budget: ~600 tokens

---

## 2. File Map

| Order | Path | Purpose | Creates/Modifies |
|-------|------|---------|------------------|
| 1 | `src/recovery.ts` | Recovery functions | Creates |
| 2 | `tests/unit/recovery.test.ts` | Unit tests | Creates |
| 3 | `tests/chaos/recovery.test.ts` | Chaos tests | Creates |

---

## 3. Dependencies Setup

```typescript
// src/recovery.ts
import fs from 'fs/promises';
import { statfs } from 'fs/promises';
import path from 'path';
import { config, DATA_DIR } from './config';
import { logger } from './logger';
import * as registry from './registry';
import * as taskQueue from './task-queue';
import { sendSlackMessage } from './slack-client';
import { withFileLock, atomicWriteJSON } from './lib/file-lock';
```

---

## 4. Core Implementation

### 4.1 Transaction Log

```typescript
interface Transaction {
  id: string;
  operation: 'CLAIM_TASK' | 'COMPLETE_TASK' | 'UPDATE_SESSION';
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
  committed: boolean;
}

const TX_LOG_PATH = path.join(DATA_DIR, 'transactions.json');

async function loadTransactionLog(): Promise<Transaction[]> {
  try {
    const data = await fs.readFile(TX_LOG_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function writeTransaction(tx: Omit<Transaction, 'id' | 'timestamp' | 'committed'>): Promise<string> {
  return withFileLock(TX_LOG_PATH, async () => {
    const log = await loadTransactionLog();
    const id = `tx_${Date.now()}`;

    log.push({
      ...tx,
      id,
      timestamp: new Date().toISOString(),
      committed: false,
    });

    await atomicWriteJSON(TX_LOG_PATH, log);
    return id;
  });
}

export async function commitTransaction(txId: string): Promise<void> {
  return withFileLock(TX_LOG_PATH, async () => {
    const log = await loadTransactionLog();
    const tx = log.find(t => t.id === txId);
    if (tx) {
      tx.committed = true;
      await atomicWriteJSON(TX_LOG_PATH, log);
    }
  });
}
```

### 4.2 Crash Recovery

```typescript
export async function recoverFromCrash(): Promise<void> {
  const log = await loadTransactionLog();
  const uncommitted = log.filter(t => !t.committed);

  logger.info({ action: 'RECOVERY_START', uncommittedCount: uncommitted.length });

  for (const tx of uncommitted) {
    try {
      switch (tx.operation) {
        case 'CLAIM_TASK':
          // Reset task to PENDING
          await taskQueue.resetTask(tx.sessionId, tx.data.taskId as string);
          break;
        case 'UPDATE_SESSION':
          // Re-apply session update
          await registry.updateSession(tx.sessionId, tx.data);
          break;
      }
      await commitTransaction(tx.id);
      logger.info({ action: 'TRANSACTION_RECOVERED', txId: tx.id });
    } catch (err) {
      logger.error({ action: 'RECOVERY_FAILED', txId: tx.id, error: err.message });
    }
  }

  logger.info({ action: 'RECOVERY_COMPLETE' });
}
```

### 4.3 Session Resume

```typescript
export async function resumeActiveSessions(): Promise<void> {
  const sessions = await registry.getSessions();
  const activeSessions = Object.values(sessions).filter(s => s.status === 'ACTIVE');

  for (const session of activeSessions) {
    try {
      // Verify thread exists (will throw if deleted)
      await slackClient.conversations.info({ channel: session.channelId });

      await sendSlackMessage(session.sessionId, 'Daemon restarted. Session resumed.');
      logger.info({ action: 'SESSION_RESUMED', sessionId: session.sessionId });
    } catch (err) {
      if (err.data?.error === 'channel_not_found') {
        await registry.updateStatus(session.sessionId, 'ERROR');
        logger.error({ action: 'SESSION_ORPHANED', sessionId: session.sessionId });
      }
    }
  }
}
```

### 4.4 Backup Rotation

```typescript
const MAX_BACKUPS = 5;

export async function rotateBackups(basePath: string): Promise<void> {
  const dir = path.dirname(basePath);
  const baseName = path.basename(basePath);

  const files = await fs.readdir(dir);
  const backups = files
    .filter(f => f.startsWith(`${baseName}.backup.`))
    .sort()
    .reverse();

  // Remove oldest if over limit
  while (backups.length >= MAX_BACKUPS) {
    const oldest = backups.pop()!;
    await fs.unlink(path.join(dir, oldest));
    logger.debug({ action: 'BACKUP_ROTATED', removed: oldest });
  }

  // Create new backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const newBackup = `${basePath}.backup.${timestamp}`;
  await fs.copyFile(basePath, newBackup);
}
```

### 4.5 Disk Space Monitoring

```typescript
const WARN_THRESHOLD_MB = 100;
const ERROR_THRESHOLD_MB = 10;

export async function checkDiskSpace(dir: string): Promise<void> {
  try {
    const stats = await statfs(dir);
    const availableMB = (stats.bavail * stats.bsize) / (1024 * 1024);

    if (availableMB < ERROR_THRESHOLD_MB) {
      throw new Error(`CRITICAL_DISK_SPACE: ${availableMB.toFixed(1)}MB available`);
    }

    if (availableMB < WARN_THRESHOLD_MB) {
      logger.warn({ action: 'LOW_DISK_SPACE', availableMB: availableMB.toFixed(1) });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

export async function safeWrite(filePath: string, data: object): Promise<void> {
  await checkDiskSpace(path.dirname(filePath));
  await rotateBackups(filePath);
  await atomicWriteJSON(filePath, data);
}
```

### 4.6 Graceful Shutdown

```typescript
export async function gracefulShutdown(): Promise<void> {
  logger.info({ action: 'SHUTDOWN_INITIATED' });

  // Notify active sessions
  const sessions = await registry.getSessions();
  for (const session of Object.values(sessions)) {
    if (session.status === 'ACTIVE') {
      try {
        await sendSlackMessage(session.sessionId, 'Daemon shutting down. Session paused.');
      } catch {
        // Ignore errors during shutdown
      }
    }
  }

  // Flush logs
  logger.flush?.();

  logger.info({ action: 'SHUTDOWN_COMPLETE' });
}

// Register signal handlers
export function registerShutdownHandlers(): void {
  process.on('SIGTERM', async () => {
    await gracefulShutdown();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await gracefulShutdown();
    process.exit(0);
  });
}
```

---

## 5. Data Structures

**Transaction Log**: `~/.claude/slack_integration/data/transactions.json`
**Backups**: `~/.claude/slack_integration/data/registry.json.backup.{timestamp}`

---

## 6. Test Guide

| File | Covers | Mocks | Fixtures |
|------|--------|-------|----------|
| `tests/unit/recovery.test.ts` | All functions | fs | transactions.json |
| `tests/chaos/recovery.test.ts` | Crash scenarios | - | - |

**Key Test Cases**:
```typescript
describe('recoverFromCrash', () => {
  it('replays uncommitted CLAIM_TASK');
  it('marks transactions as committed');
});

describe('rotateBackups', () => {
  it('keeps exactly 5 backups');
  it('removes oldest first');
});

describe('checkDiskSpace', () => {
  it('warns at 100MB');
  it('throws at 10MB');
});
```

---

## 7. Integration Points

| Ref | Contract | How |
|-----|----------|-----|
| impl-contracts.md S1 | SessionEntry | Recovers session state |
| impl-contracts.md S2 | Task | Resets stuck tasks |

---

## 8. Parallel Notes

- Can start after M-04 complete
- Not on critical path
