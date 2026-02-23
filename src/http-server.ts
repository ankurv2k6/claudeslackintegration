/**
 * M-06: HTTP Server Module
 *
 * Express HTTP server with Unix socket or TCP transport.
 * Provides daemon API endpoints for hooks and external integrations.
 *
 * Security: Bearer token auth, rate limiting, host validation, Zod validation
 * Logging: Request/response logging, correlation IDs, structured errors
 */

import express, { type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { getConfig, DATA_DIR } from './config.js';
import { createLogger, withRequestId, withSessionId } from './logger.js';
import * as registry from './registry.js';
import * as taskQueue from './task-queue.js';
import { sendSlackMessage } from './slack-client.js';
import { bearerTokenAuth, hostHeaderValidation, startGracePeriodCleanup } from './middleware/auth.js';
import {
  validateBody,
  validateParams,
  SessionStartRequestSchema,
  SessionMessageRequestSchema,
  TaskClaimRequestSchema,
  SessionIdParamSchema,
  type SessionStartRequest,
  type SessionMessageRequest,
} from './middleware/validation.js';
import {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  HttpError,
} from './middleware/error-handler.js';

const logger = createLogger('http-server');

// Server startup timestamp for uptime calculation
let serverStartTime: number;

// Per-session rate limiting state
const sessionRateLimits = new Map<
  string,
  { count: number; resetAt: number }
>();

// Cleanup interval for session rate limits
const RATE_LIMIT_CLEANUP_INTERVAL = 60000; // 1 minute

/**
 * Create and configure the Express application
 */
export function createApp(): Express {
  const app = express();

  // Trust proxy for correct client IP behind reverse proxies
  app.set('trust proxy', 1);

  // Security headers (Helmet)
  app.use(
    helmet({
      contentSecurityPolicy: false, // Not needed for API
      crossOriginEmbedderPolicy: false,
    })
  );

  // Global rate limiting: 100 requests per minute
  app.use(
    rateLimit({
      windowMs: 60000,
      max: 100,
      message: { error: 'Rate limit exceeded', code: 'RATE_LIMITED' },
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        logger.warn({
          action: 'GLOBAL_RATE_LIMITED',
          ip: req.ip,
          path: req.path,
        });
        res.status(429).json({
          error: 'Rate limit exceeded',
          code: 'RATE_LIMITED',
        });
      },
    })
  );

  // Host header validation (localhost only)
  app.use(hostHeaderValidation);

  // Request body parsing with size limit
  app.use(express.json({ limit: '100kb' }));

  // Request ID middleware for correlation
  app.use((req, res, next) => {
    const requestId =
      (req.headers['x-request-id'] as string) ||
      `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  });

  // Request logging
  app.use((req, res, next) => {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] as string;
    const log = withRequestId(logger, requestId);

    log.debug({
      action: 'HTTP_REQUEST_STARTED',
      method: req.method,
      path: req.path,
      ip: req.ip,
    });

    // Log response on finish
    res.on('finish', () => {
      log.info({
        action: 'HTTP_REQUEST_COMPLETED',
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration_ms: Date.now() - startTime,
      });
    });

    next();
  });

  // Per-session rate limiting middleware
  app.use((req, res, next) => {
    // Extract session ID from body or URL params
    const sessionId = req.body?.sessionId || req.params?.id;

    if (sessionId && typeof sessionId === 'string') {
      const now = Date.now();
      let limit = sessionRateLimits.get(sessionId);

      if (!limit || now > limit.resetAt) {
        limit = { count: 0, resetAt: now + 60000 };
      }

      limit.count++;

      if (limit.count > 30) {
        logger.warn({
          action: 'SESSION_RATE_LIMITED',
          sessionId: sessionId.slice(0, 8),
        });
        res.status(429).json({
          error: 'Session rate limit exceeded',
          code: 'RATE_LIMITED',
        });
        return;
      }

      sessionRateLimits.set(sessionId, limit);
    }

    next();
  });

  // Public endpoints (no auth required)
  registerPublicRoutes(app);

  // Bearer token authentication for protected routes
  app.use(bearerTokenAuth);

  // Protected endpoints
  registerProtectedRoutes(app);

  // 404 handler
  app.use(notFoundHandler);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}

/**
 * Register public endpoints (no authentication)
 */
function registerPublicRoutes(app: Express): void {
  // Health check endpoint
  app.get('/health', asyncHandler(async (_req: Request, res: Response) => {
    const sessions = await registry.getAllSessions();
    const sessionCount = sessions.length;

    res.json({
      status: 'healthy',
      uptime: process.uptime(),
      sessions: sessionCount,
      version: '0.1.0',
      timestamp: new Date().toISOString(),
    });
  }));

  // Prometheus metrics endpoint
  app.get('/metrics', asyncHandler(async (_req: Request, res: Response) => {
    const sessions = await registry.getAllSessions();
    const sessionCount = sessions.length;

    // Calculate total pending tasks across all sessions
    let totalPending = 0;
    for (const session of sessions) {
      totalPending += await taskQueue.getPendingCount(session.sessionId);
    }

    const metrics = [
      `# HELP daemon_uptime_seconds Daemon uptime in seconds`,
      `# TYPE daemon_uptime_seconds gauge`,
      `daemon_uptime_seconds ${process.uptime()}`,
      ``,
      `# HELP daemon_sessions_total Total number of sessions`,
      `# TYPE daemon_sessions_total gauge`,
      `daemon_sessions_total ${sessionCount}`,
      ``,
      `# HELP daemon_tasks_pending Pending tasks in queues`,
      `# TYPE daemon_tasks_pending gauge`,
      `daemon_tasks_pending ${totalPending}`,
      ``,
      `# HELP daemon_http_requests_total Total HTTP requests`,
      `# TYPE daemon_http_requests_total counter`,
      `daemon_http_requests_total{status="2xx"} 0`,
    ].join('\n');

    res.type('text/plain').send(metrics);
  }));
}

/**
 * Register protected endpoints (require authentication)
 */
function registerProtectedRoutes(app: Express): void {
  // POST /session/start - Create a new session and Slack thread
  app.post(
    '/session/start',
    validateBody(SessionStartRequestSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { sessionId, cwd } = req.body as SessionStartRequest;
      const requestId = req.headers['x-request-id'] as string;
      const log = withSessionId(withRequestId(logger, requestId), sessionId);

      log.info({
        action: 'SESSION_START_REQUESTED',
        cwd: cwd.slice(0, 50), // Log truncated path
      });

      // Check if session already exists
      const existing = await registry.getSession(sessionId);
      if (existing) {
        throw new HttpError('SESSION_EXISTS', 'Session already exists', {
          sessionId,
        });
      }

      const config = getConfig();

      // Create placeholder session first (PENDING state)
      // The actual Slack thread will be created when the SlackClient is ready
      // For now, we create a session with a placeholder thread
      const session = await registry.createSession({
        sessionId,
        threadTs: `pending_${Date.now()}`, // Will be updated by Slack
        channelId: config.slackChannelId,
        codebasePath: cwd,
      });

      // Note: In a full implementation, we'd call Slack API here
      // For now, we just create the session and the hook will handle messaging

      // Transition to ACTIVE
      await registry.updateStatus(sessionId, 'ACTIVE');

      log.info({
        action: 'SESSION_CREATED',
        threadTs: session.threadTs,
      });

      res.status(201).json({
        sessionId,
        threadTs: session.threadTs,
        channelId: config.slackChannelId,
        status: 'ACTIVE',
      });
    })
  );

  // POST /session/message - Post a message to session thread
  app.post(
    '/session/message',
    validateBody(SessionMessageRequestSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const { sessionId, message } = req.body as SessionMessageRequest;
      const requestId = req.headers['x-request-id'] as string;
      const log = withSessionId(withRequestId(logger, requestId), sessionId);

      log.info({
        action: 'SESSION_MESSAGE_REQUESTED',
        messageLength: message.length,
      });

      // Verify session exists and is active
      const session = await registry.getSession(sessionId);
      if (!session) {
        throw new HttpError('SESSION_NOT_FOUND', 'Session not found', {
          sessionId,
        });
      }

      if (session.status !== 'ACTIVE' && session.status !== 'PENDING') {
        throw new HttpError(
          'INVALID_INPUT',
          `Cannot send message to session with status ${session.status}`,
          { status: session.status }
        );
      }

      // Send message to Slack thread
      await sendSlackMessage(sessionId, message);

      // Update last activity
      await registry.updateSession(sessionId, {
        lastActivityAt: new Date().toISOString(),
      });

      log.info({
        action: 'SESSION_MESSAGE_SENT',
      });

      res.json({
        success: true,
        sessionId,
      });
    })
  );

  // POST /session/close - Close a session
  app.post(
    '/session/close',
    validateBody(z.object({ sessionId: z.string().uuid() })),
    asyncHandler(async (req: Request, res: Response) => {
      const { sessionId } = req.body;
      const requestId = req.headers['x-request-id'] as string;
      const log = withSessionId(withRequestId(logger, requestId), sessionId);

      log.info({ action: 'SESSION_CLOSE_REQUESTED' });

      // Verify session exists
      const session = await registry.getSession(sessionId);
      if (!session) {
        throw new HttpError('SESSION_NOT_FOUND', 'Session not found', {
          sessionId,
        });
      }

      // Transition through CLOSING to CLOSED
      await registry.updateStatus(sessionId, 'CLOSING');
      await registry.updateStatus(sessionId, 'CLOSED');

      log.info({ action: 'SESSION_CLOSED' });

      res.json({
        success: true,
        sessionId,
        status: 'CLOSED',
      });
    })
  );

  // POST /session/:id/tasks/claim - Claim next pending task
  app.post(
    '/session/:id/tasks/claim',
    validateParams(SessionIdParamSchema),
    validateBody(TaskClaimRequestSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = req.params.id as string;
      const requestId = req.headers['x-request-id'] as string;
      const log = withSessionId(withRequestId(logger, requestId), sessionId);

      log.debug({ action: 'TASK_CLAIM_REQUESTED' });

      // Verify session exists
      const session = await registry.getSession(sessionId);
      if (!session) {
        throw new HttpError('SESSION_NOT_FOUND', 'Session not found', {
          sessionId,
        });
      }

      // Claim next task
      const task = await taskQueue.claimNextTask(sessionId);

      if (task) {
        log.info({
          action: 'TASK_CLAIMED',
          taskId: task.id,
          sequence: task.sequence,
        });
      } else {
        log.debug({ action: 'NO_TASKS_AVAILABLE' });
      }

      res.json(task || { task: null });
    })
  );

  // GET /session/:id/status - Get session status
  app.get(
    '/session/:id/status',
    validateParams(SessionIdParamSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = req.params.id as string;
      const requestId = req.headers['x-request-id'] as string;
      const log = withSessionId(withRequestId(logger, requestId), sessionId);

      log.debug({ action: 'SESSION_STATUS_REQUESTED' });

      const session = await registry.getSession(sessionId);
      if (!session) {
        throw new HttpError('SESSION_NOT_FOUND', 'Session not found', {
          sessionId,
        });
      }

      // Get pending task count for session
      const taskCount = await taskQueue.getPendingCount(sessionId);

      res.json({
        sessionId: session.sessionId,
        status: session.status,
        threadTs: session.threadTs,
        channelId: session.channelId,
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        pendingTasks: taskCount,
      });
    })
  );
}

/**
 * Create and start the HTTP server
 *
 * Supports Unix socket (default) or TCP transport
 * Returns the server instance for graceful shutdown
 */
export function createServer(): net.Server {
  const app = createApp();
  const config = getConfig();

  serverStartTime = Date.now();

  // SEC-003: Start grace period token cleanup
  startGracePeriodCleanup();

  // Start rate limit cleanup interval (LOG-007: wrap in try/catch)
  setInterval(() => {
    try {
      const now = Date.now();
      for (const [sessionId, limit] of sessionRateLimits) {
        if (now > limit.resetAt + 60000) {
          sessionRateLimits.delete(sessionId);
        }
      }
    } catch (err) {
      logger.error({
        action: 'RATE_LIMIT_CLEANUP_FAILED',
        error: (err as Error).message,
      });
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL);

  if (config.transportMode === 'unix') {
    const socketPath = path.join(DATA_DIR, 'daemon.sock');

    // Remove stale socket file
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
        logger.debug({
          action: 'STALE_SOCKET_REMOVED',
          path: socketPath,
        });
      } catch (err) {
        logger.warn({
          action: 'STALE_SOCKET_REMOVE_FAILED',
          path: socketPath,
          error: (err as Error).message,
        });
      }
    }

    const server = app.listen(socketPath, () => {
      // Set socket permissions to 0600 (owner read/write only)
      try {
        fs.chmodSync(socketPath, 0o600);
        logger.info({
          action: 'DAEMON_STARTED',
          transport: 'unix',
          path: socketPath,
          permissions: '0600',
        });
      } catch (err) {
        logger.error({
          action: 'SOCKET_CHMOD_FAILED',
          path: socketPath,
          error: (err as Error).message,
        });
      }
    });

    // LOG-003: Add error handler for server errors
    server.on('error', (err: NodeJS.ErrnoException) => {
      logger.error({
        action: 'SERVER_ERROR',
        transport: 'unix',
        error: {
          code: err.code || 'UNKNOWN',
          message: err.message,
          syscall: err.syscall,
        },
      });
    });

    return server;
  } else {
    // TCP mode
    const server = app.listen(config.daemonPort, '127.0.0.1', () => {
      logger.info({
        action: 'DAEMON_STARTED',
        transport: 'tcp',
        port: config.daemonPort,
        host: '127.0.0.1',
      });
    });

    // LOG-003: Add error handler for server errors
    server.on('error', (err: NodeJS.ErrnoException) => {
      logger.error({
        action: 'SERVER_ERROR',
        transport: 'tcp',
        error: {
          code: err.code || 'UNKNOWN',
          message: err.message,
          syscall: err.syscall,
        },
      });
    });

    return server;
  }
}

/**
 * Gracefully stop the HTTP server
 */
export async function stopServer(server: net.Server): Promise<void> {
  logger.info({ action: 'DAEMON_STOPPING' });

  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        logger.error({
          action: 'DAEMON_STOP_FAILED',
          error: err.message,
        });
        reject(err);
      } else {
        logger.info({
          action: 'DAEMON_STOPPED',
          uptime_s: Math.round((Date.now() - serverStartTime) / 1000),
        });
        resolve();
      }
    });
  });
}

/**
 * Get server metrics for monitoring
 */
export function getServerMetrics(): {
  uptime: number;
  startTime: number;
  rateLimitSessions: number;
} {
  return {
    uptime: process.uptime(),
    startTime: serverStartTime,
    rateLimitSessions: sessionRateLimits.size,
  };
}

// Export for testing
export { sessionRateLimits };
