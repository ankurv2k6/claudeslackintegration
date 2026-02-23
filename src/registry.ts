/**
 * M-03: Registry Module
 *
 * Manage session lifecycle with file-locked JSON storage.
 * Enforce state machine transitions, provide CRUD operations,
 * maintain thread-to-session reverse lookup, and handle stale session cleanup.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { DATA_DIR } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('registry');

// Registry file path
const REGISTRY_PATH = path.join(DATA_DIR, 'registry.json');

// File permissions: owner read/write only (0600)
const FILE_MODE = 0o600;

// Lock configuration
const LOCK_OPTIONS = {
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    randomize: true,
  },
  stale: 10000, // 10 seconds stale lock detection
};

// Session status enum and transitions
export type SessionStatus = 'PENDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'ERROR';

// Valid state transitions (from blprnt-M03-registry.md S2)
const VALID_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  PENDING: ['ACTIVE', 'ERROR'],
  ACTIVE: ['CLOSING', 'ERROR', 'CLOSED'],
  CLOSING: ['CLOSED'],
  CLOSED: [],
  ERROR: ['ACTIVE'],  // Allow recovery from ERROR
};

// Zod schemas (from impl-contracts.md S1)
export const ErrorEntrySchema = z.object({
  code: z.string(),
  message: z.string(),
  timestamp: z.string().datetime(),
});

export const SessionEntrySchema = z.object({
  sessionId: z.string().uuid(),
  threadTs: z.string().regex(/^\d+\.\d+$/),
  channelId: z.string().startsWith('C'),
  codebasePath: z.string().startsWith('/'),
  status: z.enum(['PENDING', 'ACTIVE', 'CLOSING', 'CLOSED', 'ERROR']),
  startedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  injectionCount: z.number().int().min(0),
  errorHistory: z.array(ErrorEntrySchema),
});

export const RegistrySchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string().uuid(), SessionEntrySchema),
  threadToSession: z.record(z.string(), z.string().uuid()),
});

// Input validation schema with path traversal prevention (SEC-001, SEC-002)
export const CreateSessionInputSchema = z.object({
  sessionId: z.string().uuid(),
  threadTs: z.string().regex(/^\d+\.\d+$/),
  channelId: z.string().startsWith('C'),
  codebasePath: z.string()
    .startsWith('/')
    .refine(
      (p) => !p.includes('..') && path.normalize(p) === p,
      { message: 'codebasePath must be normalized absolute path without traversal' }
    ),
});

// TypeScript types
export interface ErrorEntry {
  code: string;
  message: string;
  timestamp: string;
}

export interface SessionEntry {
  sessionId: string;
  threadTs: string;
  channelId: string;
  codebasePath: string;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  injectionCount: number;
  errorHistory: ErrorEntry[];
}

export interface CreateSessionInput {
  sessionId: string;
  threadTs: string;
  channelId: string;
  codebasePath: string;
}

export interface Registry {
  version: 1;
  sessions: Record<string, SessionEntry>;
  threadToSession: Record<string, string>;
}

// Error codes
export class RegistryError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

/**
 * Ensure the data directory exists with correct permissions
 */
async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch (err) {
    // Directory may already exist
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }
}

/**
 * Execute a function with file locking.
 * Retries up to 5 times with exponential backoff.
 *
 * @param filePath - The file to lock
 * @param fn - The function to execute while holding the lock
 * @returns The result of the function
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureDataDir();

  // Ensure the file exists for locking
  try {
    await fs.access(filePath);
  } catch {
    // Create empty file if it doesn't exist
    await fs.writeFile(filePath, '', { mode: FILE_MODE });
  }

  let release: (() => Promise<void>) | undefined;

  try {
    release = await lockfile.lock(filePath, LOCK_OPTIONS);
    logger.debug({ action: 'LOCK_ACQUIRED', filePath });
    return await fn();
  } catch (err) {
    const error = err as Error;
    if (error.message?.includes('ELOCKED')) {
      logger.warn({ action: 'LOCK_TIMEOUT', filePath, error: error.message });
      throw new RegistryError('LOCK_TIMEOUT', `Failed to acquire lock on ${filePath}`);
    }
    throw err;
  } finally {
    if (release) {
      await release();
      logger.debug({ action: 'LOCK_RELEASED', filePath });
    }
  }
}

/**
 * Atomic JSON write using a temp file and rename.
 * Uses crypto.randomUUID() for temp file names.
 *
 * @param filePath - The target file path
 * @param data - The data to write
 */
export async function atomicWriteJSON(filePath: string, data: object): Promise<void> {
  await ensureDataDir();

  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${crypto.randomUUID()}.tmp`);

  try {
    // Write to temp file with proper permissions
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), {
      mode: FILE_MODE,
      encoding: 'utf-8',
    });

    // Atomic rename
    await fs.rename(tempPath, filePath);

    // Ensure correct permissions (rename may inherit directory permissions)
    await fs.chmod(filePath, FILE_MODE);

    logger.debug({ action: 'ATOMIC_WRITE', filePath });
  } catch (err) {
    // Clean up temp file on error
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Read the registry file, creating an empty one if it doesn't exist.
 */
async function readRegistry(): Promise<Registry> {
  const emptyRegistry: Registry = { version: 1, sessions: {}, threadToSession: {} };

  try {
    const content = await fs.readFile(REGISTRY_PATH, 'utf-8');

    // Handle empty file (created by withFileLock)
    if (!content.trim()) {
      return emptyRegistry;
    }

    const data = JSON.parse(content);

    const result = RegistrySchema.safeParse(data);
    if (!result.success) {
      logger.error({
        action: 'REGISTRY_CORRUPT',
        errors: result.error.issues,
      });
      throw new RegistryError('CORRUPT_JSON', 'Registry file is corrupted');
    }

    return result.data;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      // Return empty registry
      return emptyRegistry;
    }
    if (err instanceof SyntaxError) {
      logger.error({ action: 'REGISTRY_PARSE_ERROR', error: err.message });
      throw new RegistryError('CORRUPT_JSON', 'Registry file contains invalid JSON');
    }
    throw err;
  }
}

/**
 * Validate a state transition
 */
function validateTransition(from: SessionStatus, to: SessionStatus): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new RegistryError(
      'INVALID_STATE_TRANSITION',
      `Cannot transition from ${from} to ${to}`,
    );
  }
}

/**
 * Create a new session in the registry.
 *
 * @param input - The session creation input
 * @returns The created session entry
 */
export async function createSession(input: CreateSessionInput): Promise<SessionEntry> {
  // Validate input at runtime (SEC-001)
  const validatedInput = CreateSessionInputSchema.parse(input);

  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    const now = new Date().toISOString();

    // Check for duplicate session ID
    if (registry.sessions[validatedInput.sessionId]) {
      throw new RegistryError(
        'SESSION_EXISTS',
        `Session ${validatedInput.sessionId} already exists`,
      );
    }

    // Check for duplicate thread
    if (registry.threadToSession[validatedInput.threadTs]) {
      throw new RegistryError(
        'THREAD_EXISTS',
        `Thread ${validatedInput.threadTs} already has a session`,
      );
    }

    const session: SessionEntry = {
      sessionId: validatedInput.sessionId,
      threadTs: validatedInput.threadTs,
      channelId: validatedInput.channelId,
      codebasePath: validatedInput.codebasePath,
      status: 'PENDING',
      startedAt: now,
      lastActivityAt: now,
      injectionCount: 0,
      errorHistory: [],
    };

    // Add to registry
    registry.sessions[validatedInput.sessionId] = session;
    registry.threadToSession[validatedInput.threadTs] = validatedInput.sessionId;

    await atomicWriteJSON(REGISTRY_PATH, registry);

    logger.info({
      action: 'SESSION_CREATED',
      sessionId: validatedInput.sessionId,
      threadTs: validatedInput.threadTs,
    });

    return session;
  });
}

/**
 * Get a session by ID.
 *
 * @param sessionId - The session UUID
 * @returns The session entry or null if not found
 */
export async function getSession(sessionId: string): Promise<SessionEntry | null> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    return registry.sessions[sessionId] || null;
  });
}

/**
 * Get a session by Slack thread timestamp.
 *
 * @param threadTs - The Slack thread timestamp
 * @returns The session entry or null if not found
 */
export async function getSessionByThread(threadTs: string): Promise<SessionEntry | null> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    const sessionId = registry.threadToSession[threadTs];
    if (!sessionId) {
      return null;
    }
    return registry.sessions[sessionId] || null;
  });
}

/**
 * Update a session with partial updates.
 *
 * @param sessionId - The session UUID
 * @param updates - Partial session updates
 * @returns The updated session entry
 */
export async function updateSession(
  sessionId: string,
  updates: Partial<Omit<SessionEntry, 'sessionId' | 'threadTs' | 'channelId' | 'startedAt'>>,
): Promise<SessionEntry> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    const session = registry.sessions[sessionId];

    if (!session) {
      throw new RegistryError('SESSION_NOT_FOUND', `Session ${sessionId} not found`);
    }

    // Validate status transition if updating status
    if (updates.status && updates.status !== session.status) {
      validateTransition(session.status, updates.status);
    }

    // Apply updates
    const updated: SessionEntry = {
      ...session,
      ...updates,
      lastActivityAt: new Date().toISOString(),
    };

    registry.sessions[sessionId] = updated;
    await atomicWriteJSON(REGISTRY_PATH, registry);

    logger.info({
      action: 'SESSION_UPDATED',
      sessionId,
      updates: Object.keys(updates),
    });

    return updated;
  });
}

/**
 * Update only the session status with validation.
 *
 * @param sessionId - The session UUID
 * @param status - The new status
 */
export async function updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
  await updateSession(sessionId, { status });
}

/**
 * Remove a session from the registry.
 *
 * @param sessionId - The session UUID
 */
export async function removeSession(sessionId: string): Promise<void> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    const session = registry.sessions[sessionId];

    if (!session) {
      logger.warn({ action: 'SESSION_NOT_FOUND', sessionId });
      return;
    }

    // Remove from both indexes
    delete registry.sessions[sessionId];
    delete registry.threadToSession[session.threadTs];

    await atomicWriteJSON(REGISTRY_PATH, registry);

    logger.info({ action: 'SESSION_REMOVED', sessionId });
  });
}

/**
 * Clean up sessions that have been inactive for longer than maxAgeMs.
 *
 * @param maxAgeMs - Maximum age in milliseconds
 * @returns The number of sessions removed
 */
export async function cleanupStaleSessions(maxAgeMs: number): Promise<number> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    const now = Date.now();
    let removedCount = 0;

    const sessionsToRemove: string[] = [];

    for (const [sessionId, session] of Object.entries(registry.sessions)) {
      const lastActivity = new Date(session.lastActivityAt).getTime();
      if (now - lastActivity > maxAgeMs) {
        sessionsToRemove.push(sessionId);
      }
    }

    for (const sessionId of sessionsToRemove) {
      const session = registry.sessions[sessionId];
      delete registry.sessions[sessionId];
      delete registry.threadToSession[session.threadTs];
      removedCount++;

      logger.info({
        action: 'STALE_SESSION_CLEANED',
        sessionId,
        lastActivityAt: session.lastActivityAt,
      });
    }

    if (removedCount > 0) {
      await atomicWriteJSON(REGISTRY_PATH, registry);
    }

    return removedCount;
  });
}

/**
 * Get all sessions (for debugging/monitoring).
 */
export async function getAllSessions(): Promise<SessionEntry[]> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    return Object.values(registry.sessions);
  });
}

/**
 * Record an error in a session's error history.
 *
 * @param sessionId - The session UUID
 * @param code - Error code
 * @param message - Error message
 */
export async function recordError(
  sessionId: string,
  code: string,
  message: string,
): Promise<void> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    const session = registry.sessions[sessionId];

    if (!session) {
      throw new RegistryError('SESSION_NOT_FOUND', `Session ${sessionId} not found`);
    }

    const errorEntry: ErrorEntry = {
      code,
      message,
      timestamp: new Date().toISOString(),
    };

    // Keep last 10 errors
    session.errorHistory = [...session.errorHistory.slice(-9), errorEntry];
    session.lastActivityAt = new Date().toISOString();

    registry.sessions[sessionId] = session;
    await atomicWriteJSON(REGISTRY_PATH, registry);

    logger.warn({
      action: 'ERROR_RECORDED',
      sessionId,
      errorCode: code,
    });
  });
}

/**
 * Increment the injection count for a session.
 *
 * @param sessionId - The session UUID
 * @returns The new injection count
 */
export async function incrementInjectionCount(sessionId: string): Promise<number> {
  return withFileLock(REGISTRY_PATH, async () => {
    const registry = await readRegistry();
    const session = registry.sessions[sessionId];

    if (!session) {
      throw new RegistryError('SESSION_NOT_FOUND', `Session ${sessionId} not found`);
    }

    session.injectionCount += 1;
    session.lastActivityAt = new Date().toISOString();

    registry.sessions[sessionId] = session;
    await atomicWriteJSON(REGISTRY_PATH, registry);

    return session.injectionCount;
  });
}

// Export error class and registry path for testing
export { REGISTRY_PATH };
