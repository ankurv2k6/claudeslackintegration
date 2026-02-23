/**
 * Integration tests for M-06 HTTP Server
 *
 * Tests full request/response flows with Express app.
 * Uses supertest for HTTP testing without starting server.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// Mock external dependencies before importing
vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn(() => ({
    daemonSecret: 'a'.repeat(64),
    slackChannelId: 'C12345678',
    transportMode: 'unix',
    daemonPort: 3847,
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    authorizedUsers: [],
    dataDir: '/tmp/test',
    hooksDir: '/tmp/test/hooks',
    logsDir: '/tmp/test/logs',
    logLevel: 'info',
  })),
  DATA_DIR: '/tmp/test-daemon',
}));

vi.mock('../../src/logger.js', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    createLogger: vi.fn(() => mockLogger),
    withRequestId: vi.fn(() => mockLogger),
    withSessionId: vi.fn(() => mockLogger),
  };
});

const mockSessions: Record<string, any> = {};

vi.mock('../../src/registry.js', () => ({
  getAllSessions: vi.fn(async () => Object.values(mockSessions)),
  getSession: vi.fn(async (id: string) => mockSessions[id] || null),
  createSession: vi.fn(async (input: any) => {
    const session = {
      ...input,
      status: 'PENDING',
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      injectionCount: 0,
      errorHistory: [],
    };
    mockSessions[input.sessionId] = session;
    return session;
  }),
  updateStatus: vi.fn(async (id: string, status: string) => {
    if (mockSessions[id]) {
      mockSessions[id].status = status;
    }
  }),
  updateSession: vi.fn(async (id: string, updates: any) => {
    if (mockSessions[id]) {
      Object.assign(mockSessions[id], updates);
    }
  }),
}));

const mockTasks: Record<string, any[]> = {};

vi.mock('../../src/task-queue.js', () => ({
  getPendingCount: vi.fn(async (sessionId: string) => {
    return (mockTasks[sessionId] || []).filter((t) => t.status === 'PENDING').length;
  }),
  claimNextTask: vi.fn(async (sessionId: string) => {
    const tasks = mockTasks[sessionId] || [];
    const pending = tasks.find((t) => t.status === 'PENDING');
    if (pending) {
      pending.status = 'CLAIMED';
      return pending;
    }
    return null;
  }),
}));

vi.mock('../../src/slack-client.js', () => ({
  sendSlackMessage: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import { createApp } from '../../src/http-server.js';
import * as registry from '../../src/registry.js';
import { sendSlackMessage } from '../../src/slack-client.js';

describe('http-server integration', () => {
  let app: Express;
  const validToken = 'a'.repeat(64);
  const authHeader = { Authorization: `Bearer ${validToken}` };

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    // Clear mock sessions and tasks
    Object.keys(mockSessions).forEach((key) => delete mockSessions[key]);
    Object.keys(mockTasks).forEach((key) => delete mockTasks[key]);
    vi.clearAllMocks();
  });

  describe('public endpoints', () => {
    it('GET /health returns healthy status', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'healthy',
        version: '0.1.0',
      });
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      expect(res.body.sessions).toBe(0);
    });

    it('GET /health includes session count', async () => {
      mockSessions['test-id'] = { sessionId: 'test-id', status: 'ACTIVE' };

      const res = await request(app).get('/health');

      expect(res.body.sessions).toBe(1);
    });

    it('GET /metrics returns Prometheus format', async () => {
      const res = await request(app).get('/metrics');

      expect(res.status).toBe(200);
      expect(res.type).toBe('text/plain');
      expect(res.text).toContain('daemon_uptime_seconds');
      expect(res.text).toContain('daemon_sessions_total');
      expect(res.text).toContain('daemon_tasks_pending');
    });
  });

  describe('protected endpoints - authentication', () => {
    it('rejects requests without auth', async () => {
      const res = await request(app)
        .post('/session/start')
        .send({ sessionId: '550e8400-e29b-41d4-a716-446655440000', cwd: '/home/test' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Missing bearer token');
    });

    it('rejects requests with invalid token', async () => {
      const res = await request(app)
        .post('/session/start')
        .set('Authorization', 'Bearer invalid')
        .send({ sessionId: '550e8400-e29b-41d4-a716-446655440000', cwd: '/home/test' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid token');
    });
  });

  describe('POST /session/start', () => {
    it('creates a new session', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';

      const res = await request(app)
        .post('/session/start')
        .set(authHeader)
        .send({ sessionId, cwd: '/home/user/project' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        sessionId,
        channelId: 'C12345678',
        status: 'ACTIVE',
      });
      expect(registry.createSession).toHaveBeenCalled();
      expect(registry.updateStatus).toHaveBeenCalledWith(sessionId, 'ACTIVE');
    });

    it('rejects duplicate session', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      mockSessions[sessionId] = { sessionId, status: 'ACTIVE' };

      const res = await request(app)
        .post('/session/start')
        .set(authHeader)
        .send({ sessionId, cwd: '/home/user/project' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SESSION_EXISTS');
    });

    it('validates request body', async () => {
      const res = await request(app)
        .post('/session/start')
        .set(authHeader)
        .send({ sessionId: 'not-uuid', cwd: '/home/user' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('rejects denied paths', async () => {
      const res = await request(app)
        .post('/session/start')
        .set(authHeader)
        .send({ sessionId: '550e8400-e29b-41d4-a716-446655440000', cwd: '/etc' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /session/message', () => {
    it('sends message to session thread', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      mockSessions[sessionId] = {
        sessionId,
        status: 'ACTIVE',
        threadTs: '1234567890.123456',
        channelId: 'C12345678',
      };

      const res = await request(app)
        .post('/session/message')
        .set(authHeader)
        .send({ sessionId, message: 'Hello from test' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(sendSlackMessage).toHaveBeenCalledWith(sessionId, 'Hello from test');
    });

    it('rejects message to non-existent session', async () => {
      const res = await request(app)
        .post('/session/message')
        .set(authHeader)
        .send({
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          message: 'Hello',
        });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SESSION_NOT_FOUND');
    });

    it('rejects message to closed session', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      mockSessions[sessionId] = { sessionId, status: 'CLOSED' };

      const res = await request(app)
        .post('/session/message')
        .set(authHeader)
        .send({ sessionId, message: 'Hello' });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /session/close', () => {
    it('closes an active session', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      mockSessions[sessionId] = { sessionId, status: 'ACTIVE' };

      const res = await request(app)
        .post('/session/close')
        .set(authHeader)
        .send({ sessionId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        sessionId,
        status: 'CLOSED',
      });
    });

    it('returns 404 for non-existent session', async () => {
      const res = await request(app)
        .post('/session/close')
        .set(authHeader)
        .send({ sessionId: '550e8400-e29b-41d4-a716-446655440000' });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /session/:id/tasks/claim', () => {
    it('claims next pending task', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      mockSessions[sessionId] = { sessionId, status: 'ACTIVE' };
      mockTasks[sessionId] = [
        { id: 'task_1', sequence: 1, prompt: 'Do something', status: 'PENDING' },
      ];

      const res = await request(app)
        .post(`/session/${sessionId}/tasks/claim`)
        .set(authHeader)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('task_1');
      expect(res.body.status).toBe('CLAIMED');
    });

    it('returns null when no tasks', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      mockSessions[sessionId] = { sessionId, status: 'ACTIVE' };
      mockTasks[sessionId] = [];

      const res = await request(app)
        .post(`/session/${sessionId}/tasks/claim`)
        .set(authHeader)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ task: null });
    });

    it('returns 404 for non-existent session', async () => {
      const res = await request(app)
        .post('/session/550e8400-e29b-41d4-a716-446655440000/tasks/claim')
        .set(authHeader)
        .send({});

      expect(res.status).toBe(404);
    });
  });

  describe('GET /session/:id/status', () => {
    it('returns session status', async () => {
      const sessionId = '550e8400-e29b-41d4-a716-446655440000';
      mockSessions[sessionId] = {
        sessionId,
        status: 'ACTIVE',
        threadTs: '1234567890.123456',
        channelId: 'C12345678',
        startedAt: '2024-01-01T00:00:00.000Z',
        lastActivityAt: '2024-01-01T00:01:00.000Z',
      };

      const res = await request(app)
        .get(`/session/${sessionId}/status`)
        .set(authHeader);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        sessionId,
        status: 'ACTIVE',
        threadTs: '1234567890.123456',
        channelId: 'C12345678',
        pendingTasks: 0,
      });
    });

    it('returns 404 for non-existent session', async () => {
      const res = await request(app)
        .get('/session/550e8400-e29b-41d4-a716-446655440000/status')
        .set(authHeader);

      expect(res.status).toBe(404);
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes with auth', async () => {
      const res = await request(app)
        .get('/unknown/route')
        .set(authHeader);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: 'Not found',
        code: 'NOT_FOUND',
      });
    });

    it('returns 401 for unknown routes without auth', async () => {
      const res = await request(app).get('/unknown/route');

      expect(res.status).toBe(401);
    });
  });

  describe('request correlation', () => {
    it('returns x-request-id header', async () => {
      const res = await request(app).get('/health');

      expect(res.headers['x-request-id']).toBeDefined();
      expect(res.headers['x-request-id']).toMatch(/^req_\d+_\w+$/);
    });

    it('preserves provided x-request-id', async () => {
      const customId = 'custom-request-123';

      const res = await request(app)
        .get('/health')
        .set('x-request-id', customId);

      expect(res.headers['x-request-id']).toBe(customId);
    });
  });
});
