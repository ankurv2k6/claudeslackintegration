/**
 * Chaos tests for M-08 Recovery module
 *
 * These tests simulate crash scenarios to verify recovery behavior:
 * - Interrupted writes
 * - Corrupted transaction logs
 * - Disk space edge cases
 * - Concurrent operations during shutdown
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Store original env
const originalEnv = process.env;

// Test directory
const TEST_DATA_DIR = path.join(os.tmpdir(), 'recovery-chaos-test-' + Date.now());
const TEST_LOGS_DIR = path.join(TEST_DATA_DIR, 'logs');

describe('recovery chaos tests', () => {
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

  describe('corrupted transaction log recovery', () => {
    it('handles empty transaction log file', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      // Create empty transaction log
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      await fs.writeFile(txLogPath, '');

      const { recoverFromCrash } = await import('../../src/recovery.js');

      // Should recover without throwing
      await expect(recoverFromCrash()).resolves.toBeUndefined();
    });

    it('handles malformed JSON in transaction log', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      // Create malformed transaction log
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      await fs.writeFile(txLogPath, '{invalid json content');

      const { recoverFromCrash } = await import('../../src/recovery.js');

      // Should throw on corrupted log
      await expect(recoverFromCrash()).rejects.toThrow();
    });

    it('handles transaction log with invalid entries', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      // Create transaction log with invalid entry
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      await fs.writeFile(
        txLogPath,
        JSON.stringify([
          { id: 'tx_1234567890_abc001', operation: 'UNKNOWN_OP', sessionId: 'a0000000-0000-0000-0000-000000000001', committed: false },
        ])
      );

      const { recoverFromCrash } = await import('../../src/recovery.js');

      // Should recover without throwing (unknown operations are skipped)
      await expect(recoverFromCrash()).resolves.toBeUndefined();
    });
  });

  describe('concurrent write scenarios', () => {
    it('handles concurrent transaction writes', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { writeTransaction } = await import('../../src/recovery.js');

      // Write 10 transactions concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        writeTransaction({
          operation: 'UPDATE_SESSION',
          sessionId: 'a0000000-0000-0000-0000-000000000001',
          data: { index: i },
        })
      );

      const txIds = await Promise.all(promises);

      // All should have unique IDs
      const uniqueIds = new Set(txIds);
      expect(uniqueIds.size).toBe(10);

      // Verify all transactions are in the log
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log).toHaveLength(10);
    });

    it('handles concurrent backup rotations', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { rotateBackups, MAX_BACKUPS } = await import('../../src/recovery.js');

      // Create a test file
      const testFile = path.join(TEST_DATA_DIR, 'concurrent-backup.json');
      await fs.writeFile(testFile, '{"test": true}');

      // Rotate backups concurrently
      const promises = Array.from({ length: 10 }, () => rotateBackups(testFile));

      await Promise.all(promises);

      // Should not exceed MAX_BACKUPS
      const files = await fs.readdir(TEST_DATA_DIR);
      const backups = files.filter((f) => f.startsWith('concurrent-backup.json.backup.'));

      expect(backups.length).toBeLessThanOrEqual(MAX_BACKUPS);
    });
  });

  describe('interrupted operations', () => {
    it('recovers from uncommitted CLAIM_TASK', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      // Create a pre-existing uncommitted transaction
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      await fs.writeFile(
        txLogPath,
        JSON.stringify([
          {
            id: 'tx_1234567890_claim1',
            operation: 'CLAIM_TASK',
            sessionId: 'a0000000-0000-0000-0000-000000000001',
            timestamp: new Date().toISOString(),
            data: { taskId: 'task_1234' },
            committed: false,
          },
        ])
      );

      const { recoverFromCrash } = await import('../../src/recovery.js');

      // Should recover and commit the transaction
      await recoverFromCrash();

      // Verify transaction is now committed
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log[0].committed).toBe(true);
    });

    it('recovers from uncommitted UPDATE_SESSION', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      // Create a pre-existing uncommitted transaction
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      await fs.writeFile(
        txLogPath,
        JSON.stringify([
          {
            id: 'tx_1234567890_upd001',
            operation: 'UPDATE_SESSION',
            sessionId: 'a0000000-0000-0000-0000-000000000001',
            timestamp: new Date().toISOString(),
            data: { status: 'ACTIVE' },
            committed: false,
          },
        ])
      );

      const { recoverFromCrash } = await import('../../src/recovery.js');

      // Should recover and commit the transaction
      await recoverFromCrash();

      // Verify transaction is now committed
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log[0].committed).toBe(true);
    });
  });

  describe('shutdown under load', () => {
    it('handles shutdown with pending transactions', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      vi.doMock('../../src/slack-client.js', () => ({
        sendSlackMessage: vi.fn().mockResolvedValue(undefined),
      }));

      const { writeTransaction, gracefulShutdown } = await import('../../src/recovery.js');

      // Start writing transactions
      const writePromises = Array.from({ length: 5 }, (_, i) =>
        writeTransaction({
          operation: 'UPDATE_SESSION',
          sessionId: 'a0000000-0000-0000-0000-000000000001',
          data: { index: i },
        })
      );

      // Initiate shutdown concurrently
      const shutdownPromise = gracefulShutdown();

      // Wait for both
      await Promise.all([...writePromises, shutdownPromise]);

      // Verify transactions were written
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('file permission edge cases', () => {
    it('handles read-only backup directory gracefully', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { rotateBackups } = await import('../../src/recovery.js');

      // Create a test file
      const testFile = path.join(TEST_DATA_DIR, 'readonly-test.json');
      await fs.writeFile(testFile, '{"test": true}');

      // Make directory read-only (skip on Windows)
      if (process.platform !== 'win32') {
        await fs.chmod(TEST_DATA_DIR, 0o444);

        try {
          // Should handle gracefully (may throw or not depending on OS)
          await rotateBackups(testFile);
        } catch {
          // Expected on some systems
        } finally {
          // Restore permissions for cleanup
          await fs.chmod(TEST_DATA_DIR, 0o755);
        }
      }
    });
  });

  describe('large transaction log handling', () => {
    it('handles large number of transactions', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { writeTransaction, commitTransaction, pruneTransactionLog } = await import(
        '../../src/recovery.js'
      );

      // Write 100 transactions
      for (let i = 0; i < 100; i++) {
        const txId = await writeTransaction({
          operation: 'UPDATE_SESSION',
          sessionId: 'a0000000-0000-0000-0000-000000000001',
          data: { index: i, largeData: 'x'.repeat(100) },
        });
        await commitTransaction(txId);
      }

      // Prune to a small number
      const prunedCount = await pruneTransactionLog(10);

      expect(prunedCount).toBe(90);

      // Verify file size is reasonable
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      const stats = await fs.stat(txLogPath);

      // Should be under 50KB after pruning
      expect(stats.size).toBeLessThan(50 * 1024);
    });
  });

  describe('race conditions in recovery', () => {
    it('handles concurrent recovery attempts', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_LOGS_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      // Create uncommitted transactions
      const txLogPath = path.join(TEST_DATA_DIR, 'transactions.json');
      await fs.writeFile(
        txLogPath,
        JSON.stringify([
          {
            id: 'tx_1234567890_race01',
            operation: 'UPDATE_SESSION',
            sessionId: 'a0000000-0000-0000-0000-000000000001',
            timestamp: new Date().toISOString(),
            data: { status: 'ACTIVE' },
            committed: false,
          },
          {
            id: 'tx_1234567890_race02',
            operation: 'CLAIM_TASK',
            sessionId: 'a0000000-0000-0000-0000-000000000002',
            timestamp: new Date().toISOString(),
            data: { taskId: 'task_2' },
            committed: false,
          },
        ])
      );

      const { recoverFromCrash } = await import('../../src/recovery.js');

      // Run recovery concurrently (should be safe due to file locking)
      await Promise.all([recoverFromCrash(), recoverFromCrash()]);

      // Verify all transactions are committed
      const content = await fs.readFile(txLogPath, 'utf-8');
      const log = JSON.parse(content);

      expect(log.every((tx: { committed: boolean }) => tx.committed)).toBe(true);
    });
  });
});
