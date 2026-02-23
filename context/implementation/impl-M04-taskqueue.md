# Implementation Spec: M-04 -- TaskQueue

> Blueprint: blprnt-M04-taskqueue.md | Contracts: impl-contracts.md S2 | Patterns: impl-master.md S3

---

## 1. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| impl-contracts.md | S2 | ~400 | Task, TaskQueue |
| impl-master.md | S3 | ~200 | Locking patterns |
| impl-M03-registry.md | S4.1, S4.2 | ~200 | Import locking |

### Total Budget: ~800 tokens

---

## 2. File Map

| Order | Path | Purpose | Creates/Modifies |
|-------|------|---------|------------------|
| 1 | `src/task-queue.ts` | Task queue management | Creates |
| 2 | `tests/unit/task-queue.test.ts` | Unit tests | Creates |

---

## 3. Dependencies Setup

```typescript
// src/task-queue.ts
import fs from 'fs/promises';
import path from 'path';
import { config, DATA_DIR } from './config';
import { logger } from './logger';
import { withFileLock } from './lib/file-lock';
import { atomicWriteJSON } from './lib/atomic-write';
import { Task, TaskQueue, TaskStatus, TaskQueueSchema } from './schemas/api';
```

---

## 4. Core Implementation

### 4.1 src/task-queue.ts

**Exports**:
```typescript
export async function addTask(sessionId: string, input: CreateTaskInput): Promise<boolean>;
export async function claimNextTask(sessionId: string): Promise<Task | null>;
export async function completeTask(sessionId: string, taskId: string, success: boolean, error?: string): Promise<void>;
export async function getTasks(sessionId: string, status?: TaskStatus): Promise<Task[]>;
export async function clearTasks(sessionId: string): Promise<void>;
export async function removeTaskByMessageTs(sessionId: string, messageTs: string): Promise<boolean>;
```

**Logic**:
```typescript
const TASKS_DIR = path.join(DATA_DIR, 'tasks');
const TASK_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getTaskFilePath(sessionId: string): string {
  return path.join(TASKS_DIR, `${sessionId}.json`);
}

async function loadTaskQueue(sessionId: string): Promise<TaskQueue> {
  const filePath = getTaskFilePath(sessionId);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return TaskQueueSchema.parse(JSON.parse(data));
  } catch {
    return { version: 1, lastSequence: 0, tasks: [] };
  }
}

export async function addTask(sessionId: string, input: CreateTaskInput): Promise<boolean> {
  const filePath = getTaskFilePath(sessionId);

  return withFileLock(filePath, async () => {
    const queue = await loadTaskQueue(sessionId);

    // Duplicate check using messageTs as idempotency key
    if (queue.tasks.some(t => t.messageTs === input.messageTs)) {
      logger.info({ action: 'DUPLICATE_TASK_IGNORED', sessionId, messageTs: input.messageTs });
      return false;
    }

    // Assign sequence number
    queue.lastSequence += 1;

    const task: Task = {
      id: `task_${Date.now()}`,
      sequence: queue.lastSequence,
      prompt: input.prompt,
      slackUser: input.slackUser,
      messageTs: input.messageTs,
      receivedAt: new Date().toISOString(),
      status: 'PENDING',
    };

    queue.tasks.push(task);
    queue.tasks.sort((a, b) => a.sequence - b.sequence);

    await atomicWriteJSON(filePath, queue);
    logger.info({
      action: 'TASK_ADDED',
      sessionId,
      taskId: task.id,
      sequence: task.sequence,
      queueDepth: queue.tasks.filter(t => t.status === 'PENDING').length,
    });

    return true;
  });
}

export async function claimNextTask(sessionId: string): Promise<Task | null> {
  const filePath = getTaskFilePath(sessionId);

  return withFileLock(filePath, async () => {
    const queue = await loadTaskQueue(sessionId);
    const now = Date.now();

    // Reset stuck tasks (CLAIMED for > TTL)
    for (const task of queue.tasks) {
      if (task.status === 'CLAIMED' && task.claimedAt) {
        const claimedTime = new Date(task.claimedAt).getTime();
        if (now - claimedTime > TASK_TTL_MS) {
          logger.warn({ action: 'STUCK_TASK_RESET', sessionId, taskId: task.id });
          task.status = 'PENDING';
          delete task.claimedAt;
          delete task.claimedBy;
        }
      }
    }

    // Find first PENDING task by sequence
    const pendingTasks = queue.tasks
      .filter(t => t.status === 'PENDING')
      .sort((a, b) => a.sequence - b.sequence);

    if (pendingTasks.length === 0) {
      return null;
    }

    const task = pendingTasks[0];
    task.status = 'CLAIMED';
    task.claimedAt = new Date().toISOString();
    task.claimedBy = `hook_${process.pid}`;

    await atomicWriteJSON(filePath, queue);
    logger.info({ action: 'TASK_CLAIMED', sessionId, taskId: task.id });

    return task;
  });
}

export async function completeTask(
  sessionId: string,
  taskId: string,
  success: boolean,
  error?: string
): Promise<void> {
  const filePath = getTaskFilePath(sessionId);

  return withFileLock(filePath, async () => {
    const queue = await loadTaskQueue(sessionId);
    const task = queue.tasks.find(t => t.id === taskId);

    if (!task) {
      logger.warn({ action: 'TASK_NOT_FOUND', sessionId, taskId });
      return;
    }

    task.status = success ? 'COMPLETED' : 'FAILED';
    task.completedAt = new Date().toISOString();
    if (error) task.error = error;

    await atomicWriteJSON(filePath, queue);
    logger.info({ action: 'TASK_COMPLETED', sessionId, taskId, success });
  });
}
```

---

## 5. Data Structures

**Task Files**: `~/.claude/slack_integration/data/tasks/{sessionId}.json`
- One file per session
- Permissions: 0600

---

## 6. Test Guide

| File | Covers | Mocks | Fixtures |
|------|--------|-------|----------|
| `tests/unit/task-queue.test.ts` | All operations | fs | task-queue-sample.json |

**Key Test Cases**:
```typescript
describe('addTask', () => {
  it('adds task with sequence number');
  it('returns false for duplicate messageTs');
  it('sorts tasks by sequence');
});

describe('claimNextTask', () => {
  it('returns first PENDING task');
  it('resets stuck CLAIMED tasks');
  it('returns null when queue empty');
});

describe('concurrency', () => {
  it('handles 10 concurrent claims without duplicates');
});
```

---

## 7. Integration Points

| Ref | Contract | How |
|-----|----------|-----|
| impl-contracts.md S2 | Task | Stored/returned matches interface |

---

## 8. Parallel Notes

- Imports `withFileLock`, `atomicWriteJSON` from M-03/lib
- Can start when M-03 lib exports are available
