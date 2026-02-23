import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Store original env
const originalEnv = process.env;

// Test directory
const TEST_DATA_DIR = path.join(os.tmpdir(), 'registry-test-' + Date.now());

describe('registry', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };

    // Set up test environment
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.SLACK_APP_TOKEN = 'xapp-test-token';
    process.env.SLACK_CHANNEL_ID = 'C1234567890';
    process.env.DAEMON_SECRET = 'a'.repeat(64);

    // Create test directory
    await fs.mkdir(TEST_DATA_DIR, { recursive: true });
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

  describe('withFileLock', () => {
    it('executes function with lock', async () => {
      // Mock DATA_DIR to use test directory
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { withFileLock } = await import('../../src/registry.js');
      const testFile = path.join(TEST_DATA_DIR, 'test.lock');

      let executed = false;
      await withFileLock(testFile, async () => {
        executed = true;
        return 'result';
      });

      expect(executed).toBe(true);
    });

    it('returns function result', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { withFileLock } = await import('../../src/registry.js');
      const testFile = path.join(TEST_DATA_DIR, 'test.lock');

      const result = await withFileLock(testFile, async () => {
        return { key: 'value' };
      });

      expect(result).toEqual({ key: 'value' });
    });

    it('creates file if it does not exist', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { withFileLock } = await import('../../src/registry.js');
      const testFile = path.join(TEST_DATA_DIR, 'nonexistent.lock');

      await withFileLock(testFile, async () => {
        return;
      });

      const exists = await fs.access(testFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('releases lock after function completes', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { withFileLock } = await import('../../src/registry.js');
      const testFile = path.join(TEST_DATA_DIR, 'release.lock');

      await withFileLock(testFile, async () => {
        return;
      });

      // Should be able to acquire lock again immediately
      let secondLockAcquired = false;
      await withFileLock(testFile, async () => {
        secondLockAcquired = true;
        return;
      });

      expect(secondLockAcquired).toBe(true);
    });
  });

  describe('atomicWriteJSON', () => {
    it('writes JSON data to file', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { atomicWriteJSON } = await import('../../src/registry.js');
      const testFile = path.join(TEST_DATA_DIR, 'atomic.json');

      await atomicWriteJSON(testFile, { test: 'data', count: 42 });

      const content = await fs.readFile(testFile, 'utf-8');
      expect(JSON.parse(content)).toEqual({ test: 'data', count: 42 });
    });

    it('writes with correct permissions (0600)', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { atomicWriteJSON } = await import('../../src/registry.js');
      const testFile = path.join(TEST_DATA_DIR, 'perms.json');

      await atomicWriteJSON(testFile, { test: true });

      const stats = await fs.stat(testFile);
      // Check for 0600 permissions (owner read/write only)
      expect(stats.mode & 0o777).toBe(0o600);
    });

    it('cleans up temp file on error', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { atomicWriteJSON } = await import('../../src/registry.js');

      // Try to write to a path where rename would fail (non-existent parent)
      const badPath = path.join(TEST_DATA_DIR, 'nonexistent', 'file.json');

      await expect(atomicWriteJSON(badPath, { test: true })).rejects.toThrow();

      // Check no temp files left
      const files = await fs.readdir(TEST_DATA_DIR);
      const tempFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tempFiles).toHaveLength(0);
    });
  });

  describe('createSession', () => {
    it('creates a new session', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000001';
      const session = await createSession({
        sessionId,
        threadTs: '1234567890.123456',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      expect(session.sessionId).toBe(sessionId);
      expect(session.status).toBe('PENDING');
      expect(session.injectionCount).toBe(0);
      expect(session.errorHistory).toEqual([]);
    });

    it('throws on duplicate session ID', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000002';
      await createSession({
        sessionId,
        threadTs: '1234567890.123457',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      await expect(createSession({
        sessionId,
        threadTs: '1234567890.123458',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      })).rejects.toThrow('already exists');
    });

    it('throws on duplicate thread', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession } = await import('../../src/registry.js');

      await createSession({
        sessionId: 'a0000000-0000-0000-0000-000000000003',
        threadTs: '1234567890.123459',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      await expect(createSession({
        sessionId: 'a0000000-0000-0000-0000-000000000004',
        threadTs: '1234567890.123459',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      })).rejects.toThrow('already has a session');
    });
  });

  describe('getSession', () => {
    it('returns session by ID', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, getSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000005';
      await createSession({
        sessionId,
        threadTs: '1234567890.123460',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      const session = await getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe(sessionId);
    });

    it('returns null for non-existent session', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { getSession } = await import('../../src/registry.js');

      const session = await getSession('a0000000-0000-0000-0000-000000000099');
      expect(session).toBeNull();
    });
  });

  describe('getSessionByThread', () => {
    it('returns session by thread timestamp', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, getSessionByThread } = await import('../../src/registry.js');

      const threadTs = '1234567890.123461';
      await createSession({
        sessionId: 'a0000000-0000-0000-0000-000000000006',
        threadTs,
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      const session = await getSessionByThread(threadTs);
      expect(session).not.toBeNull();
      expect(session?.threadTs).toBe(threadTs);
    });

    it('returns null for non-existent thread', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { getSessionByThread } = await import('../../src/registry.js');

      const session = await getSessionByThread('9999999999.999999');
      expect(session).toBeNull();
    });
  });

  describe('updateSession', () => {
    it('updates session fields', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, updateSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000007';
      await createSession({
        sessionId,
        threadTs: '1234567890.123462',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      const updated = await updateSession(sessionId, {
        status: 'ACTIVE',
        injectionCount: 5,
      });

      expect(updated.status).toBe('ACTIVE');
      expect(updated.injectionCount).toBe(5);
    });

    it('throws on invalid state transition', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, updateSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000008';
      await createSession({
        sessionId,
        threadTs: '1234567890.123463',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      // PENDING -> CLOSED is not allowed
      await expect(updateSession(sessionId, { status: 'CLOSED' }))
        .rejects.toThrow('Cannot transition from PENDING to CLOSED');
    });

    it('throws on non-existent session', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { updateSession } = await import('../../src/registry.js');

      await expect(updateSession('a0000000-0000-0000-0000-000000000099', { status: 'ACTIVE' }))
        .rejects.toThrow('not found');
    });
  });

  describe('updateStatus', () => {
    it('updates status through valid transitions', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, updateStatus, getSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000009';
      await createSession({
        sessionId,
        threadTs: '1234567890.123464',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      // Valid: PENDING -> ACTIVE
      await updateStatus(sessionId, 'ACTIVE');
      let session = await getSession(sessionId);
      expect(session?.status).toBe('ACTIVE');

      // Valid: ACTIVE -> CLOSING
      await updateStatus(sessionId, 'CLOSING');
      session = await getSession(sessionId);
      expect(session?.status).toBe('CLOSING');

      // Valid: CLOSING -> CLOSED
      await updateStatus(sessionId, 'CLOSED');
      session = await getSession(sessionId);
      expect(session?.status).toBe('CLOSED');
    });

    it('allows ERROR transition from any state', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, updateStatus, getSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000010';
      await createSession({
        sessionId,
        threadTs: '1234567890.123465',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      await updateStatus(sessionId, 'ERROR');
      const session = await getSession(sessionId);
      expect(session?.status).toBe('ERROR');
    });

    it('allows ERROR -> ACTIVE recovery', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, updateStatus, getSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000017';
      await createSession({
        sessionId,
        threadTs: '1234567890.123472',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      // PENDING -> ERROR
      await updateStatus(sessionId, 'ERROR');
      let session = await getSession(sessionId);
      expect(session?.status).toBe('ERROR');

      // ERROR -> ACTIVE (recovery)
      await updateStatus(sessionId, 'ACTIVE');
      session = await getSession(sessionId);
      expect(session?.status).toBe('ACTIVE');
    });

    it('allows ACTIVE -> CLOSED directly', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, updateStatus, getSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000018';
      await createSession({
        sessionId,
        threadTs: '1234567890.123473',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      await updateStatus(sessionId, 'ACTIVE');
      await updateStatus(sessionId, 'CLOSED');

      const session = await getSession(sessionId);
      expect(session?.status).toBe('CLOSED');
    });
  });

  describe('removeSession', () => {
    it('removes session and thread mapping', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, removeSession, getSession, getSessionByThread } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000011';
      const threadTs = '1234567890.123466';
      await createSession({
        sessionId,
        threadTs,
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      await removeSession(sessionId);

      expect(await getSession(sessionId)).toBeNull();
      expect(await getSessionByThread(threadTs)).toBeNull();
    });

    it('handles removal of non-existent session gracefully', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { removeSession } = await import('../../src/registry.js');

      // Should not throw
      await expect(removeSession('a0000000-0000-0000-0000-000000000099')).resolves.toBeUndefined();
    });
  });

  describe('cleanupStaleSessions', () => {
    it('removes sessions older than maxAgeMs', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, cleanupStaleSessions, getAllSessions } = await import('../../src/registry.js');

      // Create a session
      await createSession({
        sessionId: 'a0000000-0000-0000-0000-000000000012',
        threadTs: '1234567890.123467',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      // Clean up with 0ms age (everything is stale)
      const removed = await cleanupStaleSessions(0);
      expect(removed).toBe(1);

      const sessions = await getAllSessions();
      expect(sessions).toHaveLength(0);
    });

    it('keeps active sessions within maxAgeMs', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, cleanupStaleSessions, getAllSessions } = await import('../../src/registry.js');

      await createSession({
        sessionId: 'a0000000-0000-0000-0000-000000000013',
        threadTs: '1234567890.123468',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      // Clean up with 1 hour age (nothing is stale)
      const removed = await cleanupStaleSessions(60 * 60 * 1000);
      expect(removed).toBe(0);

      const sessions = await getAllSessions();
      expect(sessions).toHaveLength(1);
    });
  });

  describe('recordError', () => {
    it('adds error to session history', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, recordError, getSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000014';
      await createSession({
        sessionId,
        threadTs: '1234567890.123469',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      await recordError(sessionId, 'TEST_ERROR', 'Test error message');

      const session = await getSession(sessionId);
      expect(session?.errorHistory).toHaveLength(1);
      expect(session?.errorHistory[0].code).toBe('TEST_ERROR');
    });

    it('keeps only last 10 errors', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, recordError, getSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000015';
      await createSession({
        sessionId,
        threadTs: '1234567890.123470',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      // Add 15 errors
      for (let i = 0; i < 15; i++) {
        await recordError(sessionId, `ERROR_${i}`, `Error ${i}`);
      }

      const session = await getSession(sessionId);
      expect(session?.errorHistory).toHaveLength(10);
      // Should have errors 5-14 (last 10)
      expect(session?.errorHistory[0].code).toBe('ERROR_5');
      expect(session?.errorHistory[9].code).toBe('ERROR_14');
    });
  });

  describe('incrementInjectionCount', () => {
    it('increments injection count', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, incrementInjectionCount, getSession } = await import('../../src/registry.js');

      const sessionId = 'a0000000-0000-0000-0000-000000000016';
      await createSession({
        sessionId,
        threadTs: '1234567890.123471',
        channelId: 'C1234567890',
        codebasePath: '/home/user/project',
      });

      const count1 = await incrementInjectionCount(sessionId);
      expect(count1).toBe(1);

      const count2 = await incrementInjectionCount(sessionId);
      expect(count2).toBe(2);

      const session = await getSession(sessionId);
      expect(session?.injectionCount).toBe(2);
    });
  });

  describe('concurrent access', () => {
    it('handles concurrent session creation safely', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession, getAllSessions } = await import('../../src/registry.js');

      // Create 10 sessions concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        createSession({
          sessionId: `b0000000-0000-0000-0000-00000000000${i}`,
          threadTs: `123456789${i}.123456`,
          channelId: 'C1234567890',
          codebasePath: '/home/user/project',
        }).catch(() => null) // Ignore errors from duplicate threads
      );

      await Promise.all(promises);

      const sessions = await getAllSessions();
      // All 10 should have been created (different IDs and threads)
      expect(sessions.length).toBe(10);
    });
  });

  describe('error handling edge cases', () => {
    it('throws when recording error on non-existent session', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { recordError } = await import('../../src/registry.js');

      await expect(
        recordError('a0000000-0000-0000-0000-000000000099', 'TEST', 'test')
      ).rejects.toThrow('not found');
    });

    it('throws when incrementing injection count on non-existent session', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { incrementInjectionCount } = await import('../../src/registry.js');

      await expect(
        incrementInjectionCount('a0000000-0000-0000-0000-000000000099')
      ).rejects.toThrow('not found');
    });

    it('rejects path traversal in codebasePath', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession } = await import('../../src/registry.js');

      await expect(
        createSession({
          sessionId: 'a0000000-0000-0000-0000-000000000020',
          threadTs: '1234567890.123480',
          channelId: 'C1234567890',
          codebasePath: '/home/../etc/passwd',
        })
      ).rejects.toThrow('codebasePath must be normalized');
    });

    it('rejects invalid session ID format', async () => {
      vi.doMock('../../src/config.js', () => ({
        DATA_DIR: TEST_DATA_DIR,
        LOGS_DIR: TEST_DATA_DIR,
        getConfig: () => ({ logLevel: 'error' }),
      }));

      const { createSession } = await import('../../src/registry.js');

      await expect(
        createSession({
          sessionId: 'not-a-uuid',
          threadTs: '1234567890.123481',
          channelId: 'C1234567890',
          codebasePath: '/home/user/project',
        })
      ).rejects.toThrow();
    });
  });
});
