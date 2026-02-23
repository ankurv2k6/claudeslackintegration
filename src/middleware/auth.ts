/**
 * M-06: Bearer Token Authentication Middleware
 *
 * Provides timing-safe bearer token authentication for daemon API endpoints.
 * Supports token rotation with grace period for zero-downtime rotation.
 *
 * Security: Timing-safe comparison, rate limiting, host header validation
 * Logging: Auth failures logged with redacted token info
 */

import { timingSafeEqual } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const logger = createLogger('auth');

/**
 * Grace period tokens for rotation support
 * Maps old token -> expiration timestamp
 * SIGHUP triggers rotation with 60s grace period
 */
const gracePeriodTokens = new Map<string, number>();

/**
 * Add a token to grace period (for rotation)
 * @param token - The old token to keep valid
 * @param durationMs - Grace period duration (default 60s)
 */
export function addGracePeriodToken(
  token: string,
  durationMs: number = 60000
): void {
  const expiresAt = Date.now() + durationMs;
  gracePeriodTokens.set(token, expiresAt);

  // Clean up expired tokens
  for (const [t, expires] of gracePeriodTokens) {
    if (Date.now() > expires) {
      gracePeriodTokens.delete(t);
    }
  }

  logger.info({
    action: 'GRACE_PERIOD_TOKEN_ADDED',
    expiresInMs: durationMs,
    activeTokens: gracePeriodTokens.size,
  });
}

/**
 * Timing-safe token comparison
 * Prevents timing attacks by ensuring constant-time comparison
 */
function safeTokenCompare(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  // Length check must happen before timingSafeEqual
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Bearer token authentication middleware
 *
 * Validates Authorization header against DAEMON_SECRET
 * Supports grace period tokens for rotation
 */
export function bearerTokenAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const auth = req.headers.authorization;

  // Missing authorization header
  if (!auth || !auth.startsWith('Bearer ')) {
    logger.warn({
      action: 'AUTH_MISSING_TOKEN',
      ip: req.ip,
      path: req.path,
    });
    res.status(401).json({ error: 'Missing bearer token' });
    return;
  }

  const token = auth.slice(7); // Remove 'Bearer ' prefix
  const config = getConfig();

  // Check current token (timing-safe)
  if (safeTokenCompare(token, config.daemonSecret)) {
    return next();
  }

  // Check grace period tokens
  for (const [oldToken, expiresAt] of gracePeriodTokens) {
    if (Date.now() < expiresAt && safeTokenCompare(token, oldToken)) {
      logger.debug({
        action: 'AUTH_GRACE_TOKEN_USED',
        expiresInMs: expiresAt - Date.now(),
      });
      return next();
    }
  }

  // Auth failed
  logger.warn({
    action: 'AUTH_FAILED',
    ip: req.ip,
    path: req.path,
    // Log only first 4 chars of token for debugging (SEC-009)
    tokenPrefix: token.slice(0, 4),
  });

  res.status(401).json({ error: 'Invalid token' });
}

/**
 * Host header validation middleware
 *
 * Restricts requests to localhost only (Unix socket or 127.0.0.1)
 * Prevents DNS rebinding attacks
 */
export function hostHeaderValidation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const host = req.headers.host;

  // Unix socket requests may not have host header
  if (!host) {
    return next();
  }

  // Allow localhost variants
  const hostWithoutPort = host.split(':')[0];
  const allowed = ['localhost', '127.0.0.1', '[::1]'];

  if (!allowed.includes(hostWithoutPort)) {
    logger.warn({
      action: 'INVALID_HOST_HEADER',
      host,
      allowed,
    });
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  next();
}

// Export for testing
export { gracePeriodTokens };
