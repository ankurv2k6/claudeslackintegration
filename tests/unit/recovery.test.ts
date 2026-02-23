import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Store original env
const originalEnv = process.env;

// Test directory
const TEST_DATA_DIR = path.join(os.tmpdir(), 'recovery-test-' + Date.now());
const TEST_LOGS_DIR = path.join(TEST_DATA_DIR, 'logs');

describe('recovery', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };

    // Set up test environment
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_CHANNEL_ID = 'C1234567890';
    process.env.DAEMON_SECRET = 'a'.repeat(64);

    // Create test directories
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
    await fs.mkdir(TEST_LOGS_DIR, { recursive: true });
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

  describe('writeTransaction', () => {
    it('writes a new transaction to the log', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { writeTransaction } = await import('../../src/recovery.js');

      const txId = await writeTransaction({
        operation: 'CLAIM_TASK',
        sessionId: 'a0000000-0000-0000-0000-000000000001',
        data: { taskId: 'task_1234567890' },
      });

      expect(txId).toMatch(/^tx_\d+_[a-z0-9]+$/);

      // Verify file was created
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log).toHaveLength(1);
      expect(log[0].id).toBe(txId);
      expect(log[0].operation).toBe('CLAIM_TASK');
      expect(log[0].committed).toBe(false);
    });

    it('appends multiple transactions to the log', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { writeTransaction } = await import('../../src/recovery.js');

      const tx1 = await writeTransaction({
        operation: 'CLAIM_TASK',
        sessionId: 'a0000000-0000-0000-0000-000000000001',
        data: { taskId: 'task_1' },
      });

      const tx2 = await writeTransaction({
        operation: 'UPDATE_SESSION',
        sessionId: 'a0000000-0000-0000-0000-000000000001',
        data: { status: 'ACTIVE' },
      });

      expect(tx1).not.toBe(tx2);

      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log).toHaveLength(2);
    });
  });

  describe('commitTransaction', () => {
    it('marks a transaction as committed', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { writeTransaction, commitTransaction } = await import('../../src/recovery.js');

      const txId = await writeTransaction({
        operation: 'CLAIM_TASK',
        sessionId: 'a0000000-0000-0000-0000-000000000001',
        data: { taskId: 'task_1234567890' },
      });

      await commitTransaction(txId);

      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log[0].committed).toBe(true);
    });

    it('handles non-existent transaction gracefully', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { commitTransaction } = await import('../../src/recovery.js');

      // Should not throw (tx doesn't exist but valid format)
      await expect(commitTransaction('tx_1234567890_abc123')).resolves.toBeUndefined();
    });
  });

  describe('pruneTransactionLog', () => {
    it('removes old committed transactions', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { writeTransaction, commitTransaction, pruneTransactionLog } = await import(
        '../../src/recovery.js'
      );

      // Write and commit multiple transactions
      for (let i = 0; i < 10; i++) {
        const txId = await writeTransaction({
          operation: 'UPDATE_SESSION',
          sessionId: 'a0000000-0000-0000-0000-000000000001',
          data: { i },
        });
        await commitTransaction(txId);
      }

      // Prune to keep only 5
      const prunedCount = await pruneTransactionLog(5);

      expect(prunedCount).toBe(5);

      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log).toHaveLength(5);
    });

    it('keeps uncommitted transactions during prune', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { writeTransaction, commitTransaction, pruneTransactionLog } = await import(
        '../../src/recovery.js'
      );

      // Write committed transactions
      for (let i = 0; i < 5; i++) {
        const txId = await writeTransaction({
          operation: 'UPDATE_SESSION',
          sessionId: 'a0000000-0000-0000-0000-000000000001',
          data: { i },
        });
        await commitTransaction(txId);
      }

      // Write uncommitted transaction
      await writeTransaction({
        operation: 'CLAIM_TASK',
        sessionId: 'a0000000-0000-0000-0000-000000000001',
        data: { taskId: 'pending_task' },
      });

      // Prune to keep only 2 committed
      await pruneTransactionLog(2);

      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      // Should have 1 uncommitted + 2 committed = 3
      expect(log).toHaveLength(3);
      expect(log.filter((t: { committed: boolean }) => !t.committed)).toHaveLength(1);
    });
  });

  describe('recoverFromCrash', () => {
    it('handles empty transaction log', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { recoverFromCrash } = await import('../../src/recovery.js');

      // Should not throw
      await expect(recoverFromCrash()).resolves.toBeUndefined();
    });

    it('commits uncommitted transactions during recovery', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { writeTransaction, recoverFromCrash } = await import('../../src/recovery.js');

      // Write an uncommitted transaction
      await writeTransaction({
        operation: 'CLAIM_TASK',
        sessionId: 'a0000000-0000-0000-0000-000000000001',
        data: { taskId: 'task_1' },
      });

      // Run recovery
      await recoverFromCrash();

      // Transaction should now be committed
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log[0].committed).toBe(true);
    });
  });

  describe('rotateBackups', () => {
    it('creates a backup of the file', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { rotateBackups } = await import('../../src/recovery.js');

      // Create a test file
      const testFile = path.join(TEST_DATA_DIR, 'test.json');
      await fs.writeFile(testFile, '{"test": true}');

      await rotateBackups(testFile);

      // Check backup was created
      const files = await fs.readdir(TEST_DATA_DIR);
      const backups = files.filter((f) => f.startsWith('test.json.backup.'));

      expect(backups).toHaveLength(1);
    });

    it('keeps only MAX_BACKUPS backups', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { rotateBackups, MAX_BACKUPS } = await import('../../src/recovery.js');

      // Create a test file
      const testFile = path.join(TEST_DATA_DIR, 'registry.json');
      await fs.writeFile(testFile, '{"test": true}');

      // Create more backups than allowed
      for (let i = 0; i < MAX_BACKUPS + 3; i++) {
        await rotateBackups(testFile);
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Check backup count
      const files = await fs.readdir(TEST_DATA_DIR);
      const backups = files.filter((f) => f.startsWith('registry.json.backup.'));

      expect(backups.length).toBeLessThanOrEqual(MAX_BACKUPS);
    });

    it('handles non-existent source file gracefully', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { rotateBackups } = await import('../../src/recovery.js');

      const nonexistentFile = path.join(TEST_DATA_DIR, 'nonexistent.json');

      // Should not throw
      await expect(rotateBackups(nonexistentFile)).resolves.toBeUndefined();
    });
  });

  describe('getBackupCount', () => {
    it('returns correct backup count', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { rotateBackups, getBackupCount } = await import('../../src/recovery.js');

      // Create a test file
      const testFile = path.join(TEST_DATA_DIR, 'registry.json');
      await fs.writeFile(testFile, '{"test": true}');

      // Create 3 backups
      for (let i = 0; i < 3; i++) {
        await rotateBackups(testFile);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const count = await getBackupCount(testFile);
      expect(count).toBe(3);
    });

    it('returns 0 for non-existent directory', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { getBackupCount } = await import('../../src/recovery.js');

      const nonexistentFile = path.join(TEST_DATA_DIR, 'nonexistent-dir', 'file.json');
      const count = await getBackupCount(nonexistentFile);

      expect(count).toBe(0);
    });
  });

  describe('checkDiskSpace', () => {
    it('does not throw for directories with sufficient space', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { checkDiskSpace } = await import('../../src/recovery.js');

      // Should not throw for the temp directory (should have space)
      await expect(checkDiskSpace(TEST_DATA_DIR)).resolves.toBeUndefined();
    });

    it('handles non-existent directory gracefully', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { checkDiskSpace } = await import('../../src/recovery.js');

      const nonexistentDir = path.join(TEST_DATA_DIR, 'nonexistent-subdir');

      // Should not throw
      await expect(checkDiskSpace(nonexistentDir)).resolves.toBeUndefined();
    });
  });

  describe('DiskSpaceError', () => {
    it('creates error with correct properties', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { DiskSpaceError } = await import('../../src/recovery.js');

      const error = new DiskSpaceError(5.5, 10);

      expect(error.name).toBe('DiskSpaceError');
      expect(error.availableMB).toBe(5.5);
      expect(error.thresholdMB).toBe(10);
      expect(error.message).toContain('5.5');
      expect(error.message).toContain('10');
    });
  });

  describe('safeWrite', () => {
    it('writes data after checking space and rotating backups', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { safeWrite, getBackupCount } = await import('../../src/recovery.js');

      const testFile = path.join(TEST_DATA_DIR, 'safewrite-test.json');

      // Initial write
      await safeWrite(testFile, { version: 1 });

      // Verify file was created
      const content1 = await fs.readFile(testFile, 'utf-8');
      expect(JSON.parse(content1)).toEqual({ version: 1 });

      // Second write should create backup
      await safeWrite(testFile, { version: 2 });

      const content2 = await fs.readFile(testFile, 'utf-8');
      expect(JSON.parse(content2)).toEqual({ version: 2 });

      const backupCount = await getBackupCount(testFile);
      expect(backupCount).toBe(1);
    });
  });

  describe('gracefulShutdown', () => {
    it('completes shutdown without errors', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      // Mock the slack-client to avoid errors
      vi.doMock('../../src/slack-client.js', () => ({
        sendSlackMessage: vi.fn().mockResolvedValue(undefined),
      }));

      const { gracefulShutdown, isShuttingDown } = await import('../../src/recovery.js');

      expect(isShuttingDown()).toBe(false);

      await gracefulShutdown();

      expect(isShuttingDown()).toBe(true);
    });

    it('only runs once even when called multiple times', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      vi.doMock('../../src/slack-client.js', () => ({
        sendSlackMessage: vi.fn().mockResolvedValue(undefined),
      }));

      const { gracefulShutdown } = await import('../../src/recovery.js');

      // Call multiple times concurrently
      const results = await Promise.all([
        gracefulShutdown(),
        gracefulShutdown(),
        gracefulShutdown(),
      ]);

      // All should resolve
      expect(results).toHaveLength(3);
    });
  });

  describe('registerShutdownHandlers', () => {
    it('registers SIGTERM and SIGINT handlers', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const processSpy = vi.spyOn(process, 'on');

      const { registerShutdownHandlers } = await import('../../src/recovery.js');

      registerShutdownHandlers();

      expect(processSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(processSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));

      processSpy.mockRestore();
    });
  });

  describe('initializeRecovery', () => {
    it('runs recovery steps in order', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      vi.doMock('../../src/slack-client.js', () => ({
        sendSlackMessage: vi.fn().mockResolvedValue(undefined),
      }));

      const { initializeRecovery } = await import('../../src/recovery.js');

      // Should not throw
      await expect(initializeRecovery()).resolves.toBeUndefined();
    });
  });

  describe('resumeActiveSessions', () => {
    it('sends resume messages to active sessions', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const sendSlackMessageMock = vi.fn().mockResolvedValue(undefined);
      vi.doMock('../../src/slack-client.js', () => ({
        sendSlackMessage: sendSlackMessageMock,
      }));

      // Create a session in the registry
      const registryPath = path.join(TEST_DATA_DIR, 'registry.json');
      await fs.writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          sessions: {
            'a0000000-0000-0000-0000-000000000001': {
              sessionId: 'a0000000-0000-0000-0000-000000000001',
              threadTs: '1234567890.123456',
              channelId: 'C1234567890',
              codebasePath: '/test/path',
              status: 'ACTIVE',
              startedAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              injectionCount: 0,
              errorHistory: [],
            },
          },
          threadToSession: {
            '1234567890.123456': 'a0000000-0000-0000-0000-000000000001',
          },
        })
      );

      const { resumeActiveSessions } = await import('../../src/recovery.js');

      await resumeActiveSessions();

      expect(sendSlackMessageMock).toHaveBeenCalledWith(
        'a0000000-0000-0000-0000-000000000001',
        expect.stringContaining('resumed')
      );
    });

    it('handles channel_not_found error by marking session as ERROR', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const sendSlackMessageMock = vi.fn().mockRejectedValue({
        data: { error: 'channel_not_found' },
        message: 'Channel not found',
      });
      vi.doMock('../../src/slack-client.js', () => ({
        sendSlackMessage: sendSlackMessageMock,
      }));

      // Create a session in the registry
      const registryPath = path.join(TEST_DATA_DIR, 'registry.json');
      await fs.writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          sessions: {
            'a0000000-0000-0000-0000-000000000002': {
              sessionId: 'a0000000-0000-0000-0000-000000000002',
              threadTs: '1234567890.654321',
              channelId: 'C1234567890',
              codebasePath: '/test/path',
              status: 'ACTIVE',
              startedAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              injectionCount: 0,
              errorHistory: [],
            },
          },
          threadToSession: {
            '1234567890.654321': 'a0000000-0000-0000-0000-000000000002',
          },
        })
      );

      const { resumeActiveSessions } = await import('../../src/recovery.js');

      await resumeActiveSessions();

      // Verify session status was updated to ERROR
      const content = await fs.readFile(registryPath, 'utf-8');
      const registry = JSON.parse(content);
      expect(registry.sessions['a0000000-0000-0000-0000-000000000002'].status).toBe('ERROR');
    });

    it('handles generic errors without marking as ERROR', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const sendSlackMessageMock = vi.fn().mockRejectedValue({
        data: { error: 'network_error' },
        message: 'Network error',
      });
      vi.doMock('../../src/slack-client.js', () => ({
        sendSlackMessage: sendSlackMessageMock,
      }));

      // Create a session in the registry
      const registryPath = path.join(TEST_DATA_DIR, 'registry.json');
      await fs.writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          sessions: {
            'a0000000-0000-0000-0000-000000000003': {
              sessionId: 'a0000000-0000-0000-0000-000000000003',
              threadTs: '1234567890.999999',
              channelId: 'C1234567890',
              codebasePath: '/test/path',
              status: 'ACTIVE',
              startedAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              injectionCount: 0,
              errorHistory: [],
            },
          },
          threadToSession: {
            '1234567890.999999': 'a0000000-0000-0000-0000-000000000003',
          },
        })
      );

      const { resumeActiveSessions } = await import('../../src/recovery.js');

      await resumeActiveSessions();

      // Verify session status was NOT changed (still ACTIVE)
      const content = await fs.readFile(registryPath, 'utf-8');
      const registry = JSON.parse(content);
      expect(registry.sessions['a0000000-0000-0000-0000-000000000003'].status).toBe('ACTIVE');
    });

    it('handles thread_not_found error', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const sendSlackMessageMock = vi.fn().mockRejectedValue({
        data: { error: 'thread_not_found' },
        message: 'Thread not found',
      });
      vi.doMock('../../src/slack-client.js', () => ({
        sendSlackMessage: sendSlackMessageMock,
      }));

      // Create a session in the registry
      const registryPath = path.join(TEST_DATA_DIR, 'registry.json');
      await fs.writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          sessions: {
            'a0000000-0000-0000-0000-000000000004': {
              sessionId: 'a0000000-0000-0000-0000-000000000004',
              threadTs: '1234567890.111111',
              channelId: 'C1234567890',
              codebasePath: '/test/path',
              status: 'ACTIVE',
              startedAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
              injectionCount: 0,
              errorHistory: [],
            },
          },
          threadToSession: {
            '1234567890.111111': 'a0000000-0000-0000-0000-000000000004',
          },
        })
      );

      const { resumeActiveSessions } = await import('../../src/recovery.js');

      await resumeActiveSessions();

      // Verify session status was updated to ERROR
      const content = await fs.readFile(registryPath, 'utf-8');
      const registry = JSON.parse(content);
      expect(registry.sessions['a0000000-0000-0000-0000-000000000004'].status).toBe('ERROR');
    });
  });

  describe('recoverFromCrash edge cases', () => {
    it('recovers COMPLETE_TASK transactions', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      // Create transaction log with COMPLETE_TASK
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      await fs.writeFile(
        txLogPath,
        JSON.stringify([
          {
            id: 'tx_1234567890_abc123',
            operation: 'COMPLETE_TASK',
            sessionId: 'a0000000-0000-0000-0000-000000000001',
            timestamp: new Date().toISOString(),
            data: { taskId: 'task_123', success: true },
            committed: false,
          },
        ])
      );

      const { recoverFromCrash } = await import('../../src/recovery.js');

      await recoverFromCrash();

      // Verify transaction was committed
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);
      expect(log[0].committed).toBe(true);
    });
  });

  describe('exports', () => {
    it('exports all required constants', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const recovery = await import('../../src/recovery.js');

      expect(recovery.TX_LOG_PATH).toBeDefined();
      expect(recovery.MAX_BACKUPS).toBe(5);
      expect(recovery.WARN_THRESHOLD_MB).toBe(100);
      expect(recovery.ERROR_THRESHOLD_MB).toBe(10);
    });
  });
});
