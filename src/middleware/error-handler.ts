/**
 * M-06: Error Handler Middleware
 *
 * Centralized error handling for all API endpoints.
 * Provides structured error responses with appropriate status codes.
 *
 * Security: Sanitized error messages, no stack traces in production
 * Logging: All errors logged with context and correlation IDs
 */

import type { Request, Response, NextFunction } from 'express';
import { createLogger, withRequestId } from '../logger.js';

const logger = createLogger('error-handler');

/**
 * Known error codes with HTTP status mappings
 */
const ERROR_STATUS_MAP: Record<string, number> = {
  // Auth errors (401)
  AUTH_FAILED: 401,
  INVALID_TOKEN: 401,
  MISSING_TOKEN: 401,

  // Forbidden (403)
  FORBIDDEN: 403,
  UNAUTHORIZED_USER: 403,

  // Not found (404)
  SESSION_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  NOT_FOUND: 404,

  // Validation errors (400)
  VALIDATION_FAILED: 400,
  INVALID_INPUT: 400,
  INVALID_SESSION_ID: 400,

  // Conflict (409)
  SESSION_EXISTS: 409,
  DUPLICATE_MESSAGE: 409,

  // Rate limit (429)
  RATE_LIMITED: 429,

  // Internal errors (500)
  INTERNAL_ERROR: 500,
  REGISTRY_ERROR: 500,
  SLACK_ERROR: 500,
};

/**
 * Custom error class with code and optional details
 */
export class HttpError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.statusCode = ERROR_STATUS_MAP[code] || 500;
    this.details = details;
  }
}

/**
 * Structured error response format
 */
interface ErrorResponse {
  error: string;
  code: string;
  details?: Record<string, unknown>;
  requestId?: string;
}

/**
 * Express error handler middleware
 *
 * Must be registered after all routes
 * Handles HttpError and unknown errors uniformly
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  const requestId = req.headers['x-request-id'] as string | undefined;
  const log = requestId ? withRequestId(logger, requestId) : logger;

  // Build response
  const response: ErrorResponse = {
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
    requestId,
  };

  let statusCode = 500;

  if (err instanceof HttpError) {
    // Known error with code
    statusCode = err.statusCode;
    response.error = err.message;
    response.code = err.code;
    if (err.details) {
      response.details = err.details;
    }

    log.warn({
      action: 'HTTP_ERROR',
      code: err.code,
      statusCode,
      message: err.message,
      path: req.path,
      method: req.method,
    });
  } else {
    // Unknown error - log full details but return generic message
    log.error({
      action: 'UNHANDLED_ERROR',
      error: {
        code: 'INTERNAL_ERROR',
        message: err.message,
        stack: err.stack,
        name: err.name,
      },
      path: req.path,
      method: req.method,
    });

    // Don't expose internal error details to client
    if (process.env.NODE_ENV === 'development') {
      response.details = { message: err.message };
    }
  }

  res.status(statusCode).json(response);
}

/**
 * 404 handler for unknown routes
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void {
  logger.debug({
    action: 'ROUTE_NOT_FOUND',
    path: req.path,
    method: req.method,
  });

  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND',
    path: req.path,
  });
}

/**
 * Async handler wrapper to catch promise rejections
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
