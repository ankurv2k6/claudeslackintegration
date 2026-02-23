/**
 * M-06: Request Validation Middleware
 *
 * Zod-based request body validation for all API endpoints.
 * Provides type-safe request parsing with structured error responses.
 *
 * Security: Input validation, path traversal prevention
 * Logging: Validation failures logged with sanitized details
 */

import type { Request, Response, NextFunction } from 'express';
import { z, type ZodSchema } from 'zod';
import path from 'path';
import fs from 'fs';
import { createLogger } from '../logger.js';

const logger = createLogger('validation');

/**
 * Denied paths for cwd validation (security)
 * Prevents sessions from accessing system directories
 */
const DENIED_PATHS = [
  '/etc',
  '/var',
  '/root',
  '/System',
  '/bin',
  '/sbin',
  '/usr',
  '/lib',
  '/lib64',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/private/etc',
  '/private/var',
];

/**
 * Validate path doesn't contain traversal or denied directories
 * SEC-002: Resolves symlinks to prevent bypass via symlinked paths
 */
function isValidPath(inputPath: string): boolean {
  // Must be absolute
  if (!inputPath.startsWith('/')) {
    return false;
  }

  // No traversal sequences
  if (inputPath.includes('/../') || inputPath.endsWith('/..')) {
    return false;
  }

  // Normalize the string path first
  const normalized = path.normalize(inputPath);

  // SEC-002: Try to resolve symlinks if the path exists
  // This prevents attackers from using symlinks to bypass DENIED_PATHS
  let resolvedPath = normalized;
  try {
    // realpathSync resolves symlinks and returns the actual filesystem path
    resolvedPath = fs.realpathSync(normalized);
  } catch {
    // Path doesn't exist yet - use normalized string path
    // This is acceptable for new directories that will be created
    resolvedPath = normalized;
  }

  // Check both normalized and resolved paths against denied list
  const isDenied = (p: string): boolean =>
    DENIED_PATHS.some((denied) => p === denied || p.startsWith(denied + '/'));

  return !isDenied(normalized) && !isDenied(resolvedPath);
}

/**
 * Session start request schema (from impl-contracts.md S4)
 */
export const SessionStartRequestSchema = z.object({
  sessionId: z.string().uuid({ message: 'sessionId must be a valid UUID' }),
  cwd: z
    .string()
    .max(4096, { message: 'cwd must be at most 4096 characters' })
    .refine(isValidPath, { message: 'Invalid or denied path' }),
});

/**
 * Session message request schema
 */
export const SessionMessageRequestSchema = z.object({
  sessionId: z.string().uuid({ message: 'sessionId must be a valid UUID' }),
  message: z
    .string()
    .max(10000, { message: 'message must be at most 10000 characters' }),
});

/**
 * Session close request schema
 */
export const SessionCloseRequestSchema = z.object({
  sessionId: z.string().uuid({ message: 'sessionId must be a valid UUID' }),
});

/**
 * Task claim request schema (sessionId from URL param)
 */
export const TaskClaimRequestSchema = z.object({
  claimedBy: z.string().optional(),
});

/**
 * Export types for use in handlers
 */
export type SessionStartRequest = z.infer<typeof SessionStartRequestSchema>;
export type SessionMessageRequest = z.infer<typeof SessionMessageRequestSchema>;
export type SessionCloseRequest = z.infer<typeof SessionCloseRequestSchema>;
export type TaskClaimRequest = z.infer<typeof TaskClaimRequestSchema>;

/**
 * Create validation middleware for a Zod schema
 *
 * @param schema - Zod schema to validate request body against
 * @returns Express middleware that validates and types req.body
 */
export function validateBody<T>(
  schema: ZodSchema<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));

      logger.warn({
        action: 'VALIDATION_FAILED',
        path: req.path,
        errors,
      });

      res.status(400).json({
        error: 'Validation failed',
        details: errors,
      });
      return;
    }

    // Replace body with validated/typed data
    req.body = result.data;
    next();
  };
}

/**
 * Validate URL parameters
 */
export function validateParams<T>(
  schema: ZodSchema<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));

      logger.warn({
        action: 'PARAM_VALIDATION_FAILED',
        path: req.path,
        errors,
      });

      res.status(400).json({
        error: 'Invalid parameters',
        details: errors,
      });
      return;
    }

    next();
  };
}

/**
 * Session ID parameter schema
 */
export const SessionIdParamSchema = z.object({
  id: z.string().uuid({ message: 'Session ID must be a valid UUID' }),
});

// Export for testing
export { isValidPath, DENIED_PATHS };
