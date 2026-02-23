/**
 * M-04: TaskQueue Module
 *
 * Manage per-session task queues with file locking.
 * Handle task lifecycle (PENDING → CLAIMED → COMPLETED/FAILED),
 * enforce TTL for stuck tasks, provide deduplication via messageTs,
 * and maintain strict ordering via sequence numbers.
 */

import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { DATA_DIR } from './config.js';
import { createLogger } from './logger.js';
import { withFileLock, atomicWriteJSON } from './registry.js';

const logger = createLogger('task-queue');

// Task directory path
const TASKS_DIR = path.join(DATA_DIR, 'tasks');

// TTL for CLAIMED tasks: 30 minutes
const CLAIMED_TTL_MS = 30 * 60 * 1000;

// Task status enum
export type TaskStatus = 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'FAILED';

// Zod schemas (from impl-contracts.md S2)
export const TaskStatusSchema = z.enum(['PENDING', 'CLAIMED', 'COMPLETED', 'FAILED']);

export const TaskSchema = z.object({
  id: z.string().regex(/^task_\d+$/),
  sequence: z.number().int().positive(),
  prompt: z.string().max(4000),
  slackUser: z.string().startsWith('U'),
  messageTs: z.string().regex(/^\d+\.\d+$/),
  receivedAt: z.string().datetime(),
  status: TaskStatusSchema,
  claimedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  claimedBy: z.string().optional(),
  error: z.string().optional(),
});

export const TaskQueueSchema = z.object({
  version: z.literal(1),
  lastSequence: z.number().int().min(0),
  tasks: z.array(TaskSchema),
});

// Input validation schemas (SEC-001, SEC-002, SEC-003)
const SessionIdSchema = z.string().uuid();

export const CreateTaskInputSchema = z.object({
  prompt: z.string().max(4000),
  slackUser: z.string().startsWith('U'),
  messageTs: z.string().regex(/^\d+\.\d+$/),
});

/**
 * Validate sessionId to prevent path traversal attacks (SEC-001)
 */
function validateSessionId(sessionId: string): string {
  return SessionIdSchema.parse(sessionId);
}

// TypeScript types
export interface Task {
  id: string;
  sequence: number;
  prompt: string;
  slackUser: string;
  messageTs: string;
  receivedAt: string;
  status: TaskStatus;
  claimedAt?: string;
  completedAt?: string;
  claimedBy?: string;
  error?: string;
}

export interface CreateTaskInput {
  prompt: string;
  slackUser: string;
  messageTs: string;
}

export interface TaskQueue {
  version: 1;
  lastSequence: number;
  tasks: Task[];
}

// Error class
export class TaskQueueError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskQueueError';
  }
}

/**
 * Get the task file path for a session
 */
function getTaskFilePath(sessionId: string): string {
  return path.join(TASKS_DIR, `${sessionId}.json`);
}

/**
 * Ensure the tasks directory exists with correct permissions
 */
async function ensureTasksDir(): Promise<void> {
  try {
    await fs.mkdir(TASKS_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
}

/**
 * Read the task queue for a session, creating an empty one if it doesn't exist.
 */
async function readTaskQueue(sessionId: string): Promise<TaskQueue> {
  const filePath = getTaskFilePath(sessionId);
  const emptyQueue: TaskQueue = { version: 1, lastSequence: 0, tasks: [] };

  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // Handle empty file
    if (!content.trim()) {
      return emptyQueue;
    }

    const data = JSON.parse(content);

    const result = TaskQueueSchema.safeParse(data);
    if (!result.success) {
      logger.error({
        action: 'TASK_QUEUE_CORRUPT',
        sessionId,
        errors: result.error.issues,
      });
      throw new TaskQueueError('CORRUPT_JSON', 'Task queue file is corrupted');
    }

    return result.data;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return emptyQueue;
    }
    if (err instanceof SyntaxError) {
      logger.error({ action: 'TASK_QUEUE_PARSE_ERROR', sessionId, error: err.message });
      throw new TaskQueueError('CORRUPT_JSON', 'Task queue file contains invalid JSON');
    }
    // LOG-004: Log generic errors before throwing
    logger.error({
      action: 'TASK_QUEUE_READ_ERROR',
      sessionId,
      error: (err as Error).message,
    });
    throw err;
  }
}

/**
 * Write the task queue to file
 */
async function writeTaskQueue(sessionId: string, queue: TaskQueue): Promise<void> {
  await ensureTasksDir();
  const filePath = getTaskFilePath(sessionId);
  await atomicWriteJSON(filePath, queue);
}

/**
 * Reset stuck CLAIMED tasks back to PENDING.
 * Tasks claimed more than TTL ago are considered stuck.
 */
function resetStuckTasks(queue: TaskQueue): number {
  const now = Date.now();
  let resetCount = 0;

  for (const task of queue.tasks) {
    if (task.status === 'CLAIMED' && task.claimedAt) {
      const claimedTime = new Date(task.claimedAt).getTime();
      if (now - claimedTime > CLAIMED_TTL_MS) {
        task.status = 'PENDING';
        task.claimedAt = undefined;
        task.claimedBy = undefined;
        resetCount++;

        logger.warn({
          action: 'TASK_RESET_FROM_STUCK',
          taskId: task.id,
          claimedAt: task.claimedAt,
        });
      }
    }
  }

  return resetCount;
}

/**
 * Add a new task to the session's queue.
 * Returns false if a task with the same messageTs already exists (duplicate).
 *
 * @param sessionId - The session UUID
 * @param input - The task creation input
 * @returns true if task was added, false if duplicate
 */
export async function addTask(sessionId: string, input: CreateTaskInput): Promise<boolean> {
  // SEC-001: Validate sessionId to prevent path traversal
  const validSessionId = validateSessionId(sessionId);
  // SEC-002, SEC-003: Validate input
  const validInput = CreateTaskInputSchema.parse(input);

  await ensureTasksDir();
  const filePath = getTaskFilePath(validSessionId);

  return withFileLock(filePath, async () => {
    const queue = await readTaskQueue(validSessionId);

    // Check for duplicate messageTs
    const existing = queue.tasks.find((t) => t.messageTs === validInput.messageTs);
    if (existing) {
      logger.info({
        action: 'TASK_DUPLICATE_REJECTED',
        sessionId: validSessionId,
        messageTs: validInput.messageTs,
      });
      return false;
    }

    // Assign new sequence number
    queue.lastSequence += 1;

    const task: Task = {
      id: `task_${Date.now()}`,
      sequence: queue.lastSequence,
      prompt: validInput.prompt,
      slackUser: validInput.slackUser,
      messageTs: validInput.messageTs,
      receivedAt: new Date().toISOString(),
      status: 'PENDING',
    };

    queue.tasks.push(task);

    // Sort by sequence number (maintain order)
    queue.tasks.sort((a, b) => a.sequence - b.sequence);

    await writeTaskQueue(validSessionId, queue);

    logger.info({
      action: 'TASK_ADDED',
      sessionId: validSessionId,
      taskId: task.id,
      sequence: task.sequence,
    });

    return true;
  });
}

/**
 * Claim the next PENDING task from the session's queue.
 * First resets any stuck CLAIMED tasks (older than TTL) back to PENDING.
 *
 * @param sessionId - The session UUID
 * @returns The claimed task or null if no pending tasks
 */
export async function claimNextTask(sessionId: string): Promise<Task | null> {
  // SEC-001: Validate sessionId to prevent path traversal
  const validSessionId = validateSessionId(sessionId);

  await ensureTasksDir();
  const filePath = getTaskFilePath(validSessionId);

  return withFileLock(filePath, async () => {
    const queue = await readTaskQueue(validSessionId);

    // Reset stuck tasks
    const resetCount = resetStuckTasks(queue);
    if (resetCount > 0) {
      logger.info({
        action: 'STUCK_TASKS_RESET',
        sessionId: validSessionId,
        count: resetCount,
      });
    }

    // Find first PENDING task (sorted by sequence)
    const pendingTask = queue.tasks.find((t) => t.status === 'PENDING');
    if (!pendingTask) {
      return null;
    }

    // Claim the task
    pendingTask.status = 'CLAIMED';
    pendingTask.claimedAt = new Date().toISOString();
    pendingTask.claimedBy = `hook_${process.pid}`;

    await writeTaskQueue(validSessionId, queue);

    logger.info({
      action: 'TASK_CLAIMED',
      sessionId: validSessionId,
      taskId: pendingTask.id,
      claimedBy: pendingTask.claimedBy,
    });

    return pendingTask;
  });
}

/**
 * Complete a task (success or failure).
 *
 * @param sessionId - The session UUID
 * @param taskId - The task ID
 * @param success - Whether the task completed successfully
 * @param error - Error message if failed
 */
export async function completeTask(
  sessionId: string,
  taskId: string,
  success: boolean,
  error?: string,
): Promise<void> {
  // SEC-001: Validate sessionId to prevent path traversal
  const validSessionId = validateSessionId(sessionId);

  await ensureTasksDir();
  const filePath = getTaskFilePath(validSessionId);

  return withFileLock(filePath, async () => {
    const queue = await readTaskQueue(validSessionId);

    const task = queue.tasks.find((t) => t.id === taskId);
    if (!task) {
      logger.warn({
        action: 'TASK_NOT_FOUND',
        sessionId: validSessionId,
        taskId,
      });
      throw new TaskQueueError('TASK_NOT_FOUND', `Task ${taskId} not found`);
    }

    task.status = success ? 'COMPLETED' : 'FAILED';
    task.completedAt = new Date().toISOString();
    if (error) {
      task.error = error;
    }

    await writeTaskQueue(validSessionId, queue);

    logger.info({
      action: success ? 'TASK_COMPLETED' : 'TASK_FAILED',
      sessionId: validSessionId,
      taskId,
      error: error || undefined,
    });
  });
}

/**
 * Get all tasks for a session, optionally filtered by status.
 *
 * @param sessionId - The session UUID
 * @param status - Optional status filter
 * @returns Array of tasks
 */
export async function getTasks(sessionId: string, status?: TaskStatus): Promise<Task[]> {
  // SEC-001: Validate sessionId to prevent path traversal
  const validSessionId = validateSessionId(sessionId);

  await ensureTasksDir();
  const filePath = getTaskFilePath(validSessionId);

  return withFileLock(filePath, async () => {
    const queue = await readTaskQueue(validSessionId);

    if (status) {
      return queue.tasks.filter((t) => t.status === status);
    }

    return queue.tasks;
  });
}

/**
 * Clear all tasks for a session.
 * Used for timeout cleanup.
 *
 * @param sessionId - The session UUID
 */
export async function clearTasks(sessionId: string): Promise<void> {
  // SEC-001: Validate sessionId to prevent path traversal
  const validSessionId = validateSessionId(sessionId);

  await ensureTasksDir();
  const filePath = getTaskFilePath(validSessionId);

  return withFileLock(filePath, async () => {
    const queue: TaskQueue = { version: 1, lastSequence: 0, tasks: [] };
    await writeTaskQueue(validSessionId, queue);

    logger.info({
      action: 'TASKS_CLEARED',
      sessionId: validSessionId,
    });
  });
}

/**
 * Remove a task by its Slack messageTs.
 * Returns true if task was found and removed, false otherwise.
 *
 * @param sessionId - The session UUID
 * @param messageTs - The Slack message timestamp
 * @returns true if task was removed
 */
export async function removeTaskByMessageTs(
  sessionId: string,
  messageTs: string,
): Promise<boolean> {
  // SEC-001: Validate sessionId to prevent path traversal
  const validSessionId = validateSessionId(sessionId);

  await ensureTasksDir();
  const filePath = getTaskFilePath(validSessionId);

  return withFileLock(filePath, async () => {
    const queue = await readTaskQueue(validSessionId);

    const index = queue.tasks.findIndex((t) => t.messageTs === messageTs);
    if (index === -1) {
      return false;
    }

    const removed = queue.tasks.splice(index, 1)[0];
    await writeTaskQueue(validSessionId, queue);

    logger.info({
      action: 'TASK_REMOVED',
      sessionId: validSessionId,
      taskId: removed.id,
      messageTs,
    });

    return true;
  });
}

/**
 * Get the count of pending tasks for a session.
 *
 * @param sessionId - The session UUID
 * @returns Number of pending tasks
 */
export async function getPendingCount(sessionId: string): Promise<number> {
  const tasks = await getTasks(sessionId, 'PENDING');
  return tasks.length;
}

/**
 * Delete the task file for a session (cleanup).
 *
 * @param sessionId - The session UUID
 */
export async function deleteTaskFile(sessionId: string): Promise<void> {
  // SEC-001: Validate sessionId to prevent path traversal
  const validSessionId = validateSessionId(sessionId);

  const filePath = getTaskFilePath(validSessionId);
  try {
    await fs.unlink(filePath);
    logger.info({
      action: 'TASK_FILE_DELETED',
      sessionId: validSessionId,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // LOG-006: Log error before throwing
      logger.error({
        action: 'TASK_FILE_DELETE_ERROR',
        sessionId: validSessionId,
        error: (err as Error).message,
      });
      throw err;
    }
    // File doesn't exist, that's fine
  }
}

// Export constants for testing
export { TASKS_DIR, CLAIMED_TTL_MS };
