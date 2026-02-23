import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

describe('daemon-client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.DAEMON_SECRET = 'a'.repeat(64);
    process.env.TRANSPORT_MODE = 'tcp';
    process.env.DAEMON_PORT = '3847';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('DaemonClient', () => {
    it('creates client with env config', async () => {
      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = new DaemonClient();
      expect(client).toBeDefined();
    });

    it('creates client with custom options', async () => {
      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = new DaemonClient({
        secret: 'b'.repeat(64),
        port: 9999,
      });
      expect(client).toBeDefined();
    });

    it('throws error when secret not found and no .env file', async () => {
      delete process.env.DAEMON_SECRET;
      // This will throw because there's no .env file in the test environment

      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      expect(() => new DaemonClient()).toThrow('DAEMON_SECRET not found');
    });

    it('accepts secret via options', async () => {
      delete process.env.DAEMON_SECRET;

      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      // Providing secret via options should work even without env
      const client = new DaemonClient({ secret: 'd'.repeat(64) });
      expect(client).toBeDefined();
    });
  });

  describe('createDaemonClient', () => {
    it('creates a daemon client with defaults', async () => {
      const { createDaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = createDaemonClient();
      expect(client).toBeDefined();
    });
  });

  describe('CircuitOpenError export', () => {
    it('exports CircuitOpenError', async () => {
      const { CircuitOpenError } = await import('../../../hooks/lib/daemon-client.js');
      expect(CircuitOpenError).toBeDefined();
      const error = new CircuitOpenError();
      expect(error.message).toContain('CIRCUIT_OPEN');
    });
  });

  describe('request methods', () => {
    let server: http.Server;
    let serverPort: number;

    beforeEach(async () => {
      // Create a test server
      server = http.createServer((req, res) => {
        const secret = 'a'.repeat(64);
        const authHeader = req.headers.authorization;

        if (authHeader !== `Bearer ${secret}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        if (req.url === '/session/start' && req.method === 'POST') {
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              sessionId: 'test-session',
              threadTs: '123.456',
              channelId: 'C123',
              status: 'ACTIVE',
            })
          );
        } else if (req.url === '/session/close' && req.method === 'POST') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true }));
        } else if (req.url?.startsWith('/session/') && req.url.endsWith('/status')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              sessionId: 'test-session',
              status: 'ACTIVE',
              threadTs: '123.456',
              channelId: 'C123',
              injectionCount: 0,
            })
          );
        } else if (req.url?.endsWith('/tasks/claim')) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ task: null }));
        } else if (req.url === '/session/message' && req.method === 'POST') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            serverPort = addr.port;
          }
          resolve();
        });
      });

      process.env.DAEMON_PORT = String(serverPort);
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('starts a session', async () => {
      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = new DaemonClient({ port: serverPort });

      const result = await client.startSession(
        '550e8400-e29b-41d4-a716-446655440000',
        '/tmp/test'
      );

      expect(result.sessionId).toBe('test-session');
      expect(result.status).toBe('ACTIVE');
    });

    it('closes a session', async () => {
      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = new DaemonClient({ port: serverPort });

      const result = await client.closeSession('test-session');
      expect(result.success).toBe(true);
    });

    it('gets session status', async () => {
      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = new DaemonClient({ port: serverPort });

      const result = await client.getSession('test-session');
      expect(result?.status).toBe('ACTIVE');
      expect(result?.injectionCount).toBe(0);
    });

    it('sends a message', async () => {
      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = new DaemonClient({ port: serverPort });

      const result = await client.sendMessage('test-session', 'Hello world');
      expect(result.success).toBe(true);
    });

    it('claims a task (returns null when none)', async () => {
      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = new DaemonClient({ port: serverPort });

      const result = await client.claimTask('test-session');
      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('handles connection refused', async () => {
      process.env.DAEMON_PORT = '59999'; // Unlikely to be in use

      const { DaemonClient } = await import('../../../hooks/lib/daemon-client.js');
      const client = new DaemonClient({ port: 59999 });

      await expect(
        client.startSession('test', '/tmp')
      ).rejects.toThrow();
    });
  });
});
