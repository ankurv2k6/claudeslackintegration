/**
 * Unit tests for M-06 HTTP Server
 *
 * Tests middleware functions, route handlers, and server configuration.
 * Uses mocked dependencies for isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// Mock dependencies
vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    daemonSecret: 'a'.repeat(64),
    slackChannelId: 'C12345678',
    transportMode: 'unix',
    daemonPort: 3847,
  })),
  DATA_DIR: '/tmp/test-daemon',
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  withRequestId: vi.fn((logger) => logger),
  withSessionId: vi.fn((logger) => logger),
}));

vi.mock('../../src/registry.js', () => ({
  getAllSessions: vi.fn().mockResolvedValue([]),
  getSession: vi.fn().mockResolvedValue(null),
  createSession: vi.fn().mockResolvedValue({
    sessionId: 'test-session-id',
    threadTs: '1234567890.123456',
    channelId: 'C12345678',
    codebasePath: '/home/user/project',
    status: 'PENDING',
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    injectionCount: 0,
    errorHistory: [],
  }),
  updateStatus: vi.fn().mockResolvedValue(undefined),
  updateSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/task-queue.js', () => ({
  getPendingCount: vi.fn().mockResolvedValue(0),
  claimNextTask: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/slack-client.js', () => ({
  sendSlackMessage: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import {
  bearerTokenAuth,
  hostHeaderValidation,
  addGracePeriodToken,
  gracePeriodTokens,
  startGracePeriodCleanup,
  stopGracePeriodCleanup,
} from '../../src/middleware/auth.js';
import {
  validateBody,
  validateParams,
  SessionStartRequestSchema,
  SessionIdParamSchema,
  isValidPath,
  DENIED_PATHS,
} from '../../src/middleware/validation.js';
import { HttpError, errorHandler, asyncHandler } from '../../src/middleware/error-handler.js';

describe('http-server', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      headers: {},
      body: {},
      params: {},
      path: '/test',
      method: 'GET',
      ip: '127.0.0.1',
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
    mockNext = vi.fn();
    gracePeriodTokens.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('bearerTokenAuth middleware', () => {
    it('rejects missing authorization header', () => {
      bearerTokenAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Missing bearer token' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('rejects non-Bearer authorization', () => {
      mockReq.headers = { authorization: 'Basic dXNlcjpwYXNz' };

      bearerTokenAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Missing bearer token' });
    });

    it('rejects invalid token', () => {
      mockReq.headers = { authorization: 'Bearer invalid-token' };

      bearerTokenAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    });

    it('accepts valid token', () => {
      const validToken = 'a'.repeat(64);
      mockReq.headers = { authorization: `Bearer ${validToken}` };

      bearerTokenAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('accepts grace period token', () => {
      const oldToken = 'b'.repeat(64);
      addGracePeriodToken(oldToken, 60000);
      mockReq.headers = { authorization: `Bearer ${oldToken}` };

      bearerTokenAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('rejects expired grace period token', async () => {
      const oldToken = 'c'.repeat(64);
      addGracePeriodToken(oldToken, 1); // 1ms expiry
      await new Promise((r) => setTimeout(r, 10)); // Wait for expiry
      mockReq.headers = { authorization: `Bearer ${oldToken}` };

      bearerTokenAuth(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
    });
  });

  describe('gracePeriodCleanup', () => {
    afterEach(() => {
      stopGracePeriodCleanup();
      gracePeriodTokens.clear();
    });

    it('starts and stops cleanup interval', () => {
      startGracePeriodCleanup();
      // Second call should be idempotent
      startGracePeriodCleanup();

      stopGracePeriodCleanup();
      // Second call should be idempotent
      stopGracePeriodCleanup();
    });

    it('cleans up expired tokens on addGracePeriodToken call', async () => {
      // Add a token with 1ms expiry
      const expiredToken = 'e'.repeat(64);
      addGracePeriodToken(expiredToken, 1);

      // Wait for it to expire
      await new Promise((r) => setTimeout(r, 10));

      // Add another token - this should trigger cleanup of expired ones
      const newToken = 'f'.repeat(64);
      addGracePeriodToken(newToken, 60000);

      // Expired token should be cleaned up
      expect(gracePeriodTokens.has(expiredToken)).toBe(false);
      expect(gracePeriodTokens.has(newToken)).toBe(true);
    });

    it('addGracePeriodToken logs token addition', () => {
      const token = 'g'.repeat(64);
      addGracePeriodToken(token, 60000);

      expect(gracePeriodTokens.size).toBe(1);
      expect(gracePeriodTokens.has(token)).toBe(true);
    });
  });

  describe('hostHeaderValidation middleware', () => {
    it('allows localhost host header', () => {
      mockReq.headers = { host: 'localhost:3847' };

      hostHeaderValidation(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('allows 127.0.0.1 host header', () => {
      mockReq.headers = { host: '127.0.0.1:3847' };

      hostHeaderValidation(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('allows missing host header (Unix socket)', () => {
      mockReq.headers = {};

      hostHeaderValidation(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('rejects external host header', () => {
      mockReq.headers = { host: 'evil.com:3847' };

      hostHeaderValidation(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    });
  });

  describe('validateBody middleware', () => {
    it('validates valid request body', () => {
      mockReq.body = {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        cwd: '/home/user/project',
      };
      const middleware = validateBody(SessionStartRequestSchema);

      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('rejects invalid UUID', () => {
      mockReq.body = {
        sessionId: 'not-a-uuid',
        cwd: '/home/user/project',
      };
      const middleware = validateBody(SessionStartRequestSchema);

      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('rejects denied paths', () => {
      mockReq.body = {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        cwd: '/etc/passwd',
      };
      const middleware = validateBody(SessionStartRequestSchema);

      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('validateParams middleware', () => {
    it('validates valid params', () => {
      mockReq.params = { id: '550e8400-e29b-41d4-a716-446655440000' };
      const middleware = validateParams(SessionIdParamSchema);

      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('rejects invalid params', () => {
      mockReq.params = { id: 'not-a-uuid' };
      const middleware = validateParams(SessionIdParamSchema);

      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('path validation', () => {
    it('rejects relative paths', () => {
      expect(isValidPath('relative/path')).toBe(false);
    });

    it('rejects path traversal', () => {
      expect(isValidPath('/home/user/../../../etc/passwd')).toBe(false);
      expect(isValidPath('/home/user/project/..')).toBe(false);
    });

    it('accepts valid absolute paths', () => {
      expect(isValidPath('/home/user/project')).toBe(true);
      expect(isValidPath('/Users/dev/code')).toBe(true);
    });

    it('rejects all denied paths', () => {
      for (const denied of DENIED_PATHS) {
        expect(isValidPath(denied)).toBe(false);
        expect(isValidPath(`${denied}/subdir`)).toBe(false);
      }
    });
  });

  describe('HttpError', () => {
    it('creates error with correct status code', () => {
      const error = new HttpError('SESSION_NOT_FOUND', 'Session not found');

      expect(error.code).toBe('SESSION_NOT_FOUND');
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Session not found');
    });

    it('defaults to 500 for unknown codes', () => {
      const error = new HttpError('UNKNOWN_CODE', 'Unknown error');

      expect(error.statusCode).toBe(500);
    });

    it('includes details', () => {
      const error = new HttpError('VALIDATION_FAILED', 'Bad input', {
        field: 'sessionId',
      });

      expect(error.details).toEqual({ field: 'sessionId' });
    });
  });

  describe('errorHandler middleware', () => {
    it('handles HttpError', () => {
      const error = new HttpError('SESSION_NOT_FOUND', 'Session not found');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Session not found',
          code: 'SESSION_NOT_FOUND',
        })
      );
    });

    it('handles unknown errors', () => {
      const error = new Error('Something went wrong');

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Internal server error',
          code: 'INTERNAL_ERROR',
        })
      );
    });
  });

  describe('asyncHandler', () => {
    it('passes successful result', async () => {
      const handler = asyncHandler(async (_req, res) => {
        res.json({ success: true });
      });

      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({ success: true });
    });

    it('catches and forwards errors', async () => {
      const error = new Error('Async error');
      const handler = asyncHandler(async () => {
        throw error;
      });

      await handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
