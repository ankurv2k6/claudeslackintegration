import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Store original env
const originalEnv = process.env;

// Test directory
const TEST_DATA_DIR = path.join(os.tmpdir(), 'task-queue-test-' + Date.now());
const TEST_TASKS_DIR = path.join(TEST_DATA_DIR, 'tasks');

describe('task-queue', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };

    // Set up test environment
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_CHANNEL_ID = 'C1234567890';
    process.env.DAEMON_SECRET = 'a'.repeat(64);

    // Create test directories
    await fs.mkdir(TEST_TASKS_DIR, { recursive: true });
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.restoreAllMocks();

    // Clean up test directory
    try {
      await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('addTask', () => {
    it('adds a new task to the queue', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000001';
      const result = await addTask(sessionId, {
        prompt: 'Test prompt',
        slackUser: 'U1234567890',
        messageTs: '1234567890.123456',
      });

      expect(result).toBe(true);

      const tasks = await getTasks(sessionId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe('Test prompt');
      expect(tasks[0].status).toBe('PENDING');
      expect(tasks[0].sequence).toBe(1);
    });

    it('returns false for duplicate messageTs', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000002';
      const messageTs = '1234567890.123457';

      // First add should succeed
      const result1 = await addTask(sessionId, {
        prompt: 'First task',
        slackUser: 'U1234567890',
        messageTs,
      });
      expect(result1).toBe(true);

      // Second add with same messageTs should fail
      const result2 = await addTask(sessionId, {
        prompt: 'Duplicate task',
        slackUser: 'U1234567890',
        messageTs,
      });
      expect(result2).toBe(false);

      // Should still only have one task
      const tasks = await getTasks(sessionId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe('First task');
    });

    it('assigns sequential sequence numbers', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000003';

      await addTask(sessionId, {
        prompt: 'Task 1',
        slackUser: 'U1234567890',
        messageTs: '1234567890.100001',
      });

      await addTask(sessionId, {
        prompt: 'Task 2',
        slackUser: 'U1234567890',
        messageTs: '1234567890.100002',
      });

      await addTask(sessionId, {
        prompt: 'Task 3',
        slackUser: 'U1234567890',
        messageTs: '1234567890.100003',
      });

      const tasks = await getTasks(sessionId);
      expect(tasks).toHaveLength(3);
      expect(tasks[0].sequence).toBe(1);
      expect(tasks[1].sequence).toBe(2);
      expect(tasks[2].sequence).toBe(3);
    });

    it('maintains sort order by sequence', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000004';

      // Add tasks in order
      await addTask(sessionId, {
        prompt: 'First',
        slackUser: 'U1234567890',
        messageTs: '1234567890.200001',
      });

      await addTask(sessionId, {
        prompt: 'Second',
        slackUser: 'U1234567890',
        messageTs: '1234567890.200002',
      });

      const tasks = await getTasks(sessionId);
      expect(tasks[0].prompt).toBe('First');
      expect(tasks[1].prompt).toBe('Second');
    });
  });

  describe('claimNextTask', () => {
    it('claims the first PENDING task', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, claimNextTask } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000005';

      await addTask(sessionId, {
        prompt: 'Task to claim',
        slackUser: 'U1234567890',
        messageTs: '1234567890.300001',
      });

      const claimed = await claimNextTask(sessionId);

      expect(claimed).not.toBeNull();
      expect(claimed?.prompt).toBe('Task to claim');
      expect(claimed?.status).toBe('CLAIMED');
      expect(claimed?.claimedAt).toBeDefined();
      expect(claimed?.claimedBy).toMatch(/^hook_\d+$/);
    });

    it('returns null when no PENDING tasks', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { claimNextTask } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000006';
      const claimed = await claimNextTask(sessionId);

      expect(claimed).toBeNull();
    });

    it('claims tasks in sequence order', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, claimNextTask } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000007';

      await addTask(sessionId, {
        prompt: 'First task',
        slackUser: 'U1234567890',
        messageTs: '1234567890.400001',
      });

      await addTask(sessionId, {
        prompt: 'Second task',
        slackUser: 'U1234567890',
        messageTs: '1234567890.400002',
      });

      const claimed1 = await claimNextTask(sessionId);
      expect(claimed1?.prompt).toBe('First task');

      const claimed2 = await claimNextTask(sessionId);
      expect(claimed2?.prompt).toBe('Second task');

      const claimed3 = await claimNextTask(sessionId);
      expect(claimed3).toBeNull();
    });

    it('skips already CLAIMED tasks', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, claimNextTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000008';

      await addTask(sessionId, {
        prompt: 'Task 1',
        slackUser: 'U1234567890',
        messageTs: '1234567890.500001',
      });

      await addTask(sessionId, {
        prompt: 'Task 2',
        slackUser: 'U1234567890',
        messageTs: '1234567890.500002',
      });

      // Claim first task
      await claimNextTask(sessionId);

      // Get all tasks and verify states
      const tasks = await getTasks(sessionId);
      expect(tasks[0].status).toBe('CLAIMED');
      expect(tasks[1].status).toBe('PENDING');
    });
  });

  describe('TTL reset for stuck tasks', () => {
    it('resets CLAIMED tasks older than TTL', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000009';

      // Add a task
      await addTask(sessionId, {
        prompt: 'Stuck task',
        slackUser: 'U1234567890',
        messageTs: '1234567890.600001',
      });

      // Manually manipulate the task file to simulate a stuck task
      const taskFilePath = path.join(TEST_TASKS_DIR, `${sessionId}.json`);
      const content = await fs.readFile(taskFilePath, 'utf-8');
      const queue = JSON.parse(content);

      // Set task to CLAIMED with old timestamp (31 minutes ago)
      queue.tasks[0].status = 'CLAIMED';
      queue.tasks[0].claimedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      queue.tasks[0].claimedBy = 'hook_old';

      await fs.writeFile(taskFilePath, JSON.stringify(queue, null, 2));

      // Import fresh and claim - should reset the stuck task first
      vi.resetModules();
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { claimNextTask: claimNextTask2 } = await import('../../src/task-queue.js');

      const claimed = await claimNextTask2(sessionId);

      // The stuck task should have been reset and claimed again
      expect(claimed).not.toBeNull();
      expect(claimed?.prompt).toBe('Stuck task');
      expect(claimed?.status).toBe('CLAIMED');
    });
  });

  describe('completeTask', () => {
    it('marks task as COMPLETED', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, claimNextTask, completeTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000010';

      await addTask(sessionId, {
        prompt: 'Complete me',
        slackUser: 'U1234567890',
        messageTs: '1234567890.700001',
      });

      const claimed = await claimNextTask(sessionId);
      await completeTask(sessionId, claimed!.id, true);

      const tasks = await getTasks(sessionId);
      expect(tasks[0].status).toBe('COMPLETED');
      expect(tasks[0].completedAt).toBeDefined();
    });

    it('marks task as FAILED with error message', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, claimNextTask, completeTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000011';

      await addTask(sessionId, {
        prompt: 'Fail me',
        slackUser: 'U1234567890',
        messageTs: '1234567890.800001',
      });

      const claimed = await claimNextTask(sessionId);
      await completeTask(sessionId, claimed!.id, false, 'Something went wrong');

      const tasks = await getTasks(sessionId);
      expect(tasks[0].status).toBe('FAILED');
      expect(tasks[0].error).toBe('Something went wrong');
      expect(tasks[0].completedAt).toBeDefined();
    });

    it('throws on non-existent task', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { completeTask } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000012';

      await expect(completeTask(sessionId, 'task_nonexistent', true))
        .rejects.toThrow('not found');
    });
  });

  describe('getTasks', () => {
    it('returns all tasks when no status filter', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, claimNextTask, completeTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000013';

      await addTask(sessionId, {
        prompt: 'Task 1',
        slackUser: 'U1234567890',
        messageTs: '1234567890.900001',
      });

      await addTask(sessionId, {
        prompt: 'Task 2',
        slackUser: 'U1234567890',
        messageTs: '1234567890.900002',
      });

      const claimed = await claimNextTask(sessionId);
      await completeTask(sessionId, claimed!.id, true);

      const allTasks = await getTasks(sessionId);
      expect(allTasks).toHaveLength(2);
    });

    it('filters tasks by status', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, claimNextTask, completeTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000014';

      await addTask(sessionId, {
        prompt: 'Completed',
        slackUser: 'U1234567890',
        messageTs: '1234567891.000001',
      });

      await addTask(sessionId, {
        prompt: 'Pending',
        slackUser: 'U1234567890',
        messageTs: '1234567891.000002',
      });

      const claimed = await claimNextTask(sessionId);
      await completeTask(sessionId, claimed!.id, true);

      const pendingTasks = await getTasks(sessionId, 'PENDING');
      expect(pendingTasks).toHaveLength(1);
      expect(pendingTasks[0].prompt).toBe('Pending');

      const completedTasks = await getTasks(sessionId, 'COMPLETED');
      expect(completedTasks).toHaveLength(1);
      expect(completedTasks[0].prompt).toBe('Completed');
    });

    it('returns empty array for non-existent session', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { getTasks } = await import('../../src/task-queue.js');

      const tasks = await getTasks('a0000000-0000-0000-0000-000000000099');
      expect(tasks).toEqual([]);
    });
  });

  describe('clearTasks', () => {
    it('removes all tasks from a session', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, clearTasks, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000015';

      await addTask(sessionId, {
        prompt: 'Task 1',
        slackUser: 'U1234567890',
        messageTs: '1234567891.100001',
      });

      await addTask(sessionId, {
        prompt: 'Task 2',
        slackUser: 'U1234567890',
        messageTs: '1234567891.100002',
      });

      let tasks = await getTasks(sessionId);
      expect(tasks).toHaveLength(2);

      await clearTasks(sessionId);

      tasks = await getTasks(sessionId);
      expect(tasks).toHaveLength(0);
    });
  });

  describe('removeTaskByMessageTs', () => {
    it('removes task by messageTs', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, removeTaskByMessageTs, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000016';
      const messageTs = '1234567891.200001';

      await addTask(sessionId, {
        prompt: 'Remove me',
        slackUser: 'U1234567890',
        messageTs,
      });

      await addTask(sessionId, {
        prompt: 'Keep me',
        slackUser: 'U1234567890',
        messageTs: '1234567891.200002',
      });

      const removed = await removeTaskByMessageTs(sessionId, messageTs);
      expect(removed).toBe(true);

      const tasks = await getTasks(sessionId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].prompt).toBe('Keep me');
    });

    it('returns false for non-existent messageTs', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { removeTaskByMessageTs } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000017';
      const removed = await removeTaskByMessageTs(sessionId, '9999999999.999999');

      expect(removed).toBe(false);
    });
  });

  describe('getPendingCount', () => {
    it('returns count of PENDING tasks', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, claimNextTask, getPendingCount } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000018';

      await addTask(sessionId, {
        prompt: 'Task 1',
        slackUser: 'U1234567890',
        messageTs: '1234567891.300001',
      });

      await addTask(sessionId, {
        prompt: 'Task 2',
        slackUser: 'U1234567890',
        messageTs: '1234567891.300002',
      });

      let count = await getPendingCount(sessionId);
      expect(count).toBe(2);

      await claimNextTask(sessionId);

      count = await getPendingCount(sessionId);
      expect(count).toBe(1);
    });
  });

  describe('deleteTaskFile', () => {
    it('deletes the task file', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, deleteTaskFile } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000019';

      await addTask(sessionId, {
        prompt: 'Task',
        slackUser: 'U1234567890',
        messageTs: '1234567891.400001',
      });

      const taskFilePath = path.join(TEST_TASKS_DIR, `${sessionId}.json`);
      let exists = await fs.access(taskFilePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);

      await deleteTaskFile(sessionId);

      exists = await fs.access(taskFilePath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it('handles non-existent file gracefully', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { deleteTaskFile } = await import('../../src/task-queue.js');

      // Should not throw
      await expect(deleteTaskFile('a0000000-0000-0000-0000-000000000099')).resolves.toBeUndefined();
    });
  });

  describe('concurrent access', () => {
    it('handles concurrent task additions safely', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask, getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000020';

      // Add 10 tasks concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        addTask(sessionId, {
          prompt: `Task ${i}`,
          slackUser: 'U1234567890',
          messageTs: `1234567891.50000${i}`,
        })
      );

      const results = await Promise.all(promises);

      // All should succeed (no duplicates)
      expect(results.every((r) => r === true)).toBe(true);

      const tasks = await getTasks(sessionId);
      expect(tasks).toHaveLength(10);

      // Sequence numbers should be unique
      const sequences = tasks.map((t) => t.sequence);
      const uniqueSequences = new Set(sequences);
      expect(uniqueSequences.size).toBe(10);
    });
  });

  describe('input validation (SEC-001, SEC-002)', () => {
    it('rejects invalid sessionId format', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask } = await import('../../src/task-queue.js');

      await expect(
        addTask('not-a-uuid', {
          prompt: 'Test',
          slackUser: 'U1234567890',
          messageTs: '1234567890.123456',
        })
      ).rejects.toThrow();
    });

    it('rejects path traversal in sessionId', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask } = await import('../../src/task-queue.js');

      await expect(
        addTask('../etc/passwd', {
          prompt: 'Test',
          slackUser: 'U1234567890',
          messageTs: '1234567890.123456',
        })
      ).rejects.toThrow();
    });

    it('rejects invalid slackUser format', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask } = await import('../../src/task-queue.js');

      await expect(
        addTask('a0000000-0000-0000-0000-000000000021', {
          prompt: 'Test',
          slackUser: 'invalid-user',
          messageTs: '1234567890.123456',
        })
      ).rejects.toThrow();
    });

    it('rejects invalid messageTs format', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { addTask } = await import('../../src/task-queue.js');

      await expect(
        addTask('a0000000-0000-0000-0000-000000000022', {
          prompt: 'Test',
          slackUser: 'U1234567890',
          messageTs: 'invalid-ts',
        })
      ).rejects.toThrow();
    });
  });

  describe('error handling (TEST-001, TEST-002)', () => {
    it('handles corrupted task queue schema', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000023';

      // Write invalid JSON structure (wrong version)
      const taskFilePath = path.join(TEST_TASKS_DIR, `${sessionId}.json`);
      await fs.mkdir(TEST_TASKS_DIR, { recursive: true });
      await fs.writeFile(taskFilePath, JSON.stringify({
        version: 999,
        lastSequence: 0,
        tasks: [],
      }));

      await expect(getTasks(sessionId)).rejects.toThrow('corrupted');
    });

    it('handles malformed JSON in task file', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { getTasks } = await import('../../src/task-queue.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000024';

      // Write syntactically invalid JSON
      const taskFilePath = path.join(TEST_TASKS_DIR, `${sessionId}.json`);
      await fs.mkdir(TEST_TASKS_DIR, { recursive: true });
      await fs.writeFile(taskFilePath, '{ invalid json syntax');

      await expect(getTasks(sessionId)).rejects.toThrow('invalid JSON');
    });
  });
});
