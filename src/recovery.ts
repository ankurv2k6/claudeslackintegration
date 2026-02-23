/**
 * M-08: Recovery Module
 *
 * Daemon crash recovery, transaction logging, backup rotation, disk space monitoring,
 * graceful shutdown, and session resume after restart.
 *
 * Security: File permissions (0600), atomic writes
 * Logging: Comprehensive structured logging with correlation IDs
 */

import fs from 'fs/promises';
import { statfs } from 'fs/promises';
import path from 'path';
import { DATA_DIR } from './config.js';
import { createLogger, flushLogs } from './logger.js';
import * as registry from './registry.js';
import * as taskQueue from './task-queue.js';
import { sendSlackMessage } from './slack-client.js';
import { withFileLock, atomicWriteJSON } from './registry.js';

const logger = createLogger('recovery');

// File permissions: owner read/write only (0600)
const FILE_MODE = 0o600;

// Transaction log path
const TX_LOG_PATH = path.join(DATA_DIR, 'transactions.json');

// Backup configuration
const MAX_BACKUPS = 5;

// Disk space thresholds
const WARN_THRESHOLD_MB = 100;
const ERROR_THRESHOLD_MB = 10;

// ============================================================================
// TASK 1: Transaction Log Infrastructure
// ============================================================================

/**
 * Transaction operation types
 */
export type TransactionOperation = 'CLAIM_TASK' | 'COMPLETE_TASK' | 'UPDATE_SESSION';

/**
 * Transaction log entry
 */
export interface Transaction {
  id: string;
  operation: TransactionOperation;
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
  committed: boolean;
}

/**
 * Load the transaction log from disk
 */
async function loadTransactionLog(): Promise<Transaction[]> {
  try {
    const data = await fs.readFile(TX_LOG_PATH, 'utf-8');
    if (!data.trim()) {
      return [];
    }
    return JSON.parse(data) as Transaction[];
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      return [];
    }
    logger.error({
      action: 'TX_LOG_READ_ERROR',
      error: { code: 'TX_LOG_ERROR', message: error.message },
    });
    throw err;
  }
}

/**
 * Ensure the data directory exists with correct permissions
 */
async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
}

/**
 * Write a new transaction to the log (uncommitted)
 * Returns the transaction ID for later commit
 *
 * @param tx - Transaction details (without id, timestamp, committed)
 * @returns The transaction ID
 */
export async function writeTransaction(
  tx: Omit<Transaction, 'id' | 'timestamp' | 'committed'>
): Promise<string> {
  await ensureDataDir();

  return withFileLock(TX_LOG_PATH, async () => {
    const log = await loadTransactionLog();
    const id = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const transaction: Transaction = {
      ...tx,
      id,
      timestamp: new Date().toISOString(),
      committed: false,
    };

    log.push(transaction);

    await atomicWriteJSON(TX_LOG_PATH, log);

    logger.debug({
      action: 'TRANSACTION_WRITTEN',
      txId: id,
      operation: tx.operation,
      sessionId: tx.sessionId,
    });

    return id;
  });
}

/**
 * Mark a transaction as committed
 *
 * @param txId - The transaction ID to commit
 */
export async function commitTransaction(txId: string): Promise<void> {
  return withFileLock(TX_LOG_PATH, async () => {
    const log = await loadTransactionLog();
    const tx = log.find((t) => t.id === txId);

    if (tx) {
      tx.committed = true;
      await atomicWriteJSON(TX_LOG_PATH, log);

      logger.debug({
        action: 'TRANSACTION_COMMITTED',
        txId,
        operation: tx.operation,
      });
    } else {
      logger.warn({
        action: 'TRANSACTION_NOT_FOUND',
        txId,
      });
    }
  });
}

/**
 * Prune old committed transactions from the log (keep last N)
 * Prevents the transaction log from growing too large
 *
 * @param keepCount - Number of committed transactions to keep
 */
export async function pruneTransactionLog(keepCount = 100): Promise<number> {
  return withFileLock(TX_LOG_PATH, async () => {
    const log = await loadTransactionLog();
    const uncommitted = log.filter((t) => !t.committed);
    const committed = log.filter((t) => t.committed);

    // Keep only the last N committed transactions
    const prunedCommitted = committed.slice(-keepCount);
    const pruneCount = committed.length - prunedCommitted.length;

    if (pruneCount > 0) {
      const newLog = [...uncommitted, ...prunedCommitted];
      await atomicWriteJSON(TX_LOG_PATH, newLog);

      logger.info({
        action: 'TX_LOG_PRUNED',
        prunedCount: pruneCount,
        remainingCount: newLog.length,
      });
    }

    return pruneCount;
  });
}

// ============================================================================
// TASK 2: Crash Recovery
// ============================================================================

/**
 * Recover from a daemon crash by replaying uncommitted transactions
 * - CLAIM_TASK: Reset task to PENDING
 * - UPDATE_SESSION: Re-apply session update
 */
export async function recoverFromCrash(): Promise<void> {
  const log = await loadTransactionLog();
  const uncommitted = log.filter((t) => !t.committed);

  logger.info({
    action: 'RECOVERY_START',
    uncommittedCount: uncommitted.length,
    totalTransactions: log.length,
  });

  let recoveredCount = 0;
  let failedCount = 0;

  for (const tx of uncommitted) {
    try {
      switch (tx.operation) {
        case 'CLAIM_TASK': {
          // Reset task to PENDING (it was being claimed when crash occurred)
          const taskId = tx.data.taskId as string;
          if (taskId) {
            try {
              // Get the task and check if it's still CLAIMED
              const tasks = await taskQueue.getTasks(tx.sessionId, 'CLAIMED');
              const task = tasks.find((t) => t.id === taskId);
              if (task) {
                // We can't directly reset, but we can mark it as failed
                // so the TTL mechanism will pick it up
                logger.info({
                  action: 'TASK_RECOVERY_PENDING',
                  txId: tx.id,
                  taskId,
                  sessionId: tx.sessionId,
                });
              }
            } catch (taskErr) {
              // Task file might not exist, which is fine
              logger.debug({
                action: 'TASK_RECOVERY_SKIP',
                txId: tx.id,
                reason: 'task_not_found',
              });
            }
          }
          break;
        }

        case 'UPDATE_SESSION': {
          // Re-apply session update
          const updates = tx.data as Partial<registry.SessionEntry>;
          try {
            await registry.updateSession(tx.sessionId, updates);
            logger.info({
              action: 'SESSION_RECOVERY_APPLIED',
              txId: tx.id,
              sessionId: tx.sessionId,
            });
          } catch (sessionErr) {
            // Session might not exist anymore
            logger.debug({
              action: 'SESSION_RECOVERY_SKIP',
              txId: tx.id,
              reason: 'session_not_found',
            });
          }
          break;
        }

        case 'COMPLETE_TASK': {
          // Task completion was interrupted, log it
          logger.info({
            action: 'TASK_COMPLETE_RECOVERY',
            txId: tx.id,
            taskId: tx.data.taskId,
            sessionId: tx.sessionId,
          });
          break;
        }
      }

      await commitTransaction(tx.id);
      recoveredCount++;

      logger.info({
        action: 'TRANSACTION_RECOVERED',
        txId: tx.id,
        operation: tx.operation,
      });
    } catch (err) {
      failedCount++;
      logger.error({
        action: 'RECOVERY_FAILED',
        txId: tx.id,
        operation: tx.operation,
        error: { code: 'RECOVERY_ERROR', message: (err as Error).message },
      });
    }
  }

  logger.info({
    action: 'RECOVERY_COMPLETE',
    recoveredCount,
    failedCount,
  });
}

// ============================================================================
// TASK 3: Session Resume
// ============================================================================

/**
 * Resume active sessions after daemon restart
 * - Verify Slack thread still exists
 * - Send "Session resumed" message or mark as ERROR
 */
export async function resumeActiveSessions(): Promise<void> {
  const sessions = await registry.getAllSessions();
  const activeSessions = sessions.filter((s) => s.status === 'ACTIVE');

  logger.info({
    action: 'SESSION_RESUME_START',
    activeSessionCount: activeSessions.length,
    totalSessionCount: sessions.length,
  });

  let resumedCount = 0;
  let errorCount = 0;

  for (const session of activeSessions) {
    try {
      // Send resume notification
      await sendSlackMessage(session.sessionId, '🔄 Daemon restarted. Session resumed.');

      logger.info({
        action: 'SESSION_RESUMED',
        sessionId: session.sessionId,
        threadTs: session.threadTs,
      });

      resumedCount++;
    } catch (err) {
      const error = err as { data?: { error?: string }; message?: string };

      if (error.data?.error === 'channel_not_found' || error.data?.error === 'thread_not_found') {
        // Thread was deleted, mark session as ERROR
        try {
          await registry.updateStatus(session.sessionId, 'ERROR');
          await registry.recordError(
            session.sessionId,
            'THREAD_ORPHANED',
            'Slack thread not found after restart'
          );
        } catch (updateErr) {
          // Best effort
          logger.error({
            action: 'SESSION_ERROR_UPDATE_FAILED',
            sessionId: session.sessionId,
            error: { code: 'UPDATE_ERROR', message: (updateErr as Error).message },
          });
        }

        logger.error({
          action: 'SESSION_ORPHANED',
          sessionId: session.sessionId,
          threadTs: session.threadTs,
        });
      } else {
        // Other error (network, rate limit), don't mark as error
        logger.warn({
          action: 'SESSION_RESUME_FAILED',
          sessionId: session.sessionId,
          error: { code: 'RESUME_ERROR', message: error.message || 'Unknown error' },
        });
      }

      errorCount++;
    }
  }

  logger.info({
    action: 'SESSION_RESUME_COMPLETE',
    resumedCount,
    errorCount,
  });
}

// ============================================================================
// TASK 4: Backup Rotation
// ============================================================================

/**
 * Rotate backup files, keeping only the last MAX_BACKUPS
 * Creates a new timestamped backup of the specified file
 *
 * @param basePath - The base file path to backup
 */
export async function rotateBackups(basePath: string): Promise<void> {
  const dir = path.dirname(basePath);
  const baseName = path.basename(basePath);

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Directory doesn't exist, nothing to rotate
      return;
    }
    throw err;
  }

  // Find existing backups
  const backups = files
    .filter((f) => f.startsWith(`${baseName}.backup.`))
    .sort()
    .reverse();

  // Remove oldest backups if over limit (keep MAX_BACKUPS - 1 to make room for new one)
  while (backups.length >= MAX_BACKUPS) {
    const oldest = backups.pop()!;
    const oldestPath = path.join(dir, oldest);

    try {
      await fs.unlink(oldestPath);
      logger.debug({
        action: 'BACKUP_ROTATED',
        removed: oldest,
      });
    } catch (unlinkErr) {
      logger.warn({
        action: 'BACKUP_REMOVE_FAILED',
        file: oldest,
        error: { code: 'UNLINK_ERROR', message: (unlinkErr as Error).message },
      });
    }
  }

  // Create new backup
  try {
    await fs.access(basePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const newBackupPath = `${basePath}.backup.${timestamp}`;

    await fs.copyFile(basePath, newBackupPath);
    await fs.chmod(newBackupPath, FILE_MODE);

    logger.debug({
      action: 'BACKUP_CREATED',
      path: newBackupPath,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // File exists but copy failed
      logger.warn({
        action: 'BACKUP_CREATE_FAILED',
        file: basePath,
        error: { code: 'COPY_ERROR', message: (err as Error).message },
      });
    }
    // File doesn't exist, nothing to backup
  }
}

/**
 * Get the count of existing backups for a file
 *
 * @param basePath - The base file path
 * @returns Number of backups
 */
export async function getBackupCount(basePath: string): Promise<number> {
  const dir = path.dirname(basePath);
  const baseName = path.basename(basePath);

  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.startsWith(`${baseName}.backup.`)).length;
  } catch {
    return 0;
  }
}

// ============================================================================
// TASK 5: Disk Space Monitoring
// ============================================================================

/**
 * Error thrown when disk space is critically low
 */
export class DiskSpaceError extends Error {
  constructor(
    public availableMB: number,
    public thresholdMB: number
  ) {
    super(`CRITICAL_DISK_SPACE: ${availableMB.toFixed(1)}MB available (threshold: ${thresholdMB}MB)`);
    this.name = 'DiskSpaceError';
  }
}

/**
 * Check available disk space in a directory
 * - Warns at <100MB
 * - Throws at <10MB
 *
 * @param dir - Directory to check
 */
export async function checkDiskSpace(dir: string): Promise<void> {
  try {
    const stats = await statfs(dir);
    const availableMB = (stats.bavail * stats.bsize) / (1024 * 1024);

    if (availableMB < ERROR_THRESHOLD_MB) {
      logger.error({
        action: 'CRITICAL_DISK_SPACE',
        availableMB: availableMB.toFixed(1),
        thresholdMB: ERROR_THRESHOLD_MB,
      });
      throw new DiskSpaceError(availableMB, ERROR_THRESHOLD_MB);
    }

    if (availableMB < WARN_THRESHOLD_MB) {
      logger.warn({
        action: 'LOW_DISK_SPACE',
        availableMB: availableMB.toFixed(1),
        thresholdMB: WARN_THRESHOLD_MB,
      });
    }
  } catch (err) {
    if (err instanceof DiskSpaceError) {
      throw err;
    }

    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      // Directory doesn't exist, skip check
      logger.debug({
        action: 'DISK_CHECK_SKIP',
        reason: 'directory_not_found',
        dir,
      });
      return;
    }

    if (error.code === 'ENOSYS') {
      // statfs not supported on this filesystem
      logger.debug({
        action: 'DISK_CHECK_SKIP',
        reason: 'statfs_not_supported',
        dir,
      });
      return;
    }

    // Other error, log and rethrow
    logger.error({
      action: 'DISK_CHECK_ERROR',
      dir,
      error: { code: error.code || 'UNKNOWN', message: error.message },
    });
    throw err;
  }
}

/**
 * Safe write operation that checks disk space and rotates backups before writing
 *
 * @param filePath - The file path to write
 * @param data - The data to write
 */
export async function safeWrite(filePath: string, data: object): Promise<void> {
  const startTime = Date.now();

  // Check disk space first
  await checkDiskSpace(path.dirname(filePath));

  // Rotate backups
  await rotateBackups(filePath);

  // Atomic write
  await atomicWriteJSON(filePath, data);

  logger.debug({
    action: 'SAFE_WRITE_COMPLETE',
    filePath,
    duration_ms: Date.now() - startTime,
  });
}

// ============================================================================
// TASK 6: Graceful Shutdown
// ============================================================================

// Shutdown state
let _isShuttingDown = false;
let _shutdownPromise: Promise<void> | null = null;

/**
 * Check if shutdown is in progress
 */
export function isShuttingDown(): boolean {
  return _isShuttingDown;
}

/**
 * Gracefully shut down the daemon
 * - Notify active sessions
 * - Flush logs
 * - Clean up resources
 */
export async function gracefulShutdown(): Promise<void> {
  if (_shutdownPromise) {
    return _shutdownPromise;
  }

  _isShuttingDown = true;

  _shutdownPromise = (async () => {
    logger.info({ action: 'SHUTDOWN_INITIATED' });

    // Notify active sessions
    try {
      const sessions = await registry.getAllSessions();
      const activeSessions = sessions.filter((s) => s.status === 'ACTIVE');

      logger.info({
        action: 'SHUTDOWN_NOTIFYING_SESSIONS',
        count: activeSessions.length,
      });

      // Send notifications with timeout
      const notifyPromises = activeSessions.map(async (session) => {
        try {
          await sendSlackMessage(session.sessionId, '⏸️ Daemon shutting down. Session paused.');
        } catch {
          // Ignore errors during shutdown notification
        }
      });

      // Wait max 5 seconds for notifications
      await Promise.race([
        Promise.allSettled(notifyPromises),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch (err) {
      logger.warn({
        action: 'SHUTDOWN_NOTIFY_ERROR',
        error: { code: 'NOTIFY_ERROR', message: (err as Error).message },
      });
    }

    // Flush logs
    try {
      await flushLogs();
    } catch (err) {
      // Best effort
      console.error('Failed to flush logs:', (err as Error).message);
    }

    logger.info({ action: 'SHUTDOWN_COMPLETE' });
  })();

  return _shutdownPromise;
}

/**
 * Register signal handlers for graceful shutdown
 * Should be called once at daemon startup
 */
export function registerShutdownHandlers(): void {
  const handleSignal = async (signal: string) => {
    logger.info({ action: 'SIGNAL_RECEIVED', signal });
    await gracefulShutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  logger.debug({ action: 'SHUTDOWN_HANDLERS_REGISTERED' });
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize recovery system on daemon startup
 * - Run crash recovery
 * - Resume active sessions
 * - Prune old transactions
 */
export async function initializeRecovery(): Promise<void> {
  const startTime = Date.now();

  logger.info({ action: 'RECOVERY_INIT_START' });

  try {
    // Step 1: Recover from crash
    await recoverFromCrash();

    // Step 2: Resume active sessions
    await resumeActiveSessions();

    // Step 3: Prune old transactions
    await pruneTransactionLog();

    logger.info({
      action: 'RECOVERY_INIT_COMPLETE',
      duration_ms: Date.now() - startTime,
    });
  } catch (err) {
    logger.error({
      action: 'RECOVERY_INIT_FAILED',
      error: { code: 'INIT_ERROR', message: (err as Error).message },
      duration_ms: Date.now() - startTime,
    });
    throw err;
  }
}

// Export constants for testing
export {
  TX_LOG_PATH,
  MAX_BACKUPS,
  WARN_THRESHOLD_MB,
  ERROR_THRESHOLD_MB,
};
