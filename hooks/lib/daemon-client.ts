/**
 * M-07: Daemon Client
 *
 * HTTP client for communicating with the daemon from hooks.
 * Features: Bearer token auth, 10s timeout, circuit breaker protection.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import { withCircuitBreaker, CircuitOpenError } from './circuit-breaker.js';

// Daemon configuration
const BASE_DIR = path.join(os.homedir(), '.claude', 'slack_integration');
const DATA_DIR = path.join(BASE_DIR, 'data');
const SOCKET_PATH = path.join(DATA_DIR, 'daemon.sock');
const DEFAULT_PORT = 3847;
const TIMEOUT_MS = 10000; // 10 seconds

export interface SessionInfo {
  sessionId: string;
  threadTs: string;
  channelId: string;
  status: string;
  injectionCount: number;
}

export interface Task {
  id: string;
  sequence: number;
  prompt: string;
  slackUser: string;
  messageTs: string;
  receivedAt: string;
  status: string;
  claimedAt?: string;
  claimedBy?: string;
}

export interface DaemonClientOptions {
  secret?: string;
  socketPath?: string;
  port?: number;
  transportMode?: 'unix' | 'tcp';
}

/**
 * Load daemon secret from environment or .env file
 */
function loadSecret(): string {
  // Check environment first
  if (process.env.DAEMON_SECRET) {
    return process.env.DAEMON_SECRET;
  }

  // Try to load from .env file
  const envPath = path.join(BASE_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^DAEMON_SECRET=([a-f0-9]{64})$/m);
    if (match) {
      return match[1];
    }
  }

  throw new Error('DAEMON_SECRET not found in environment or .env file');
}

/**
 * Determine transport mode and get base URL
 */
function getTransportConfig(): { baseUrl: string; socketPath?: string } {
  const transportMode = process.env.TRANSPORT_MODE || 'unix';

  if (transportMode === 'tcp') {
    const port = parseInt(process.env.DAEMON_PORT || String(DEFAULT_PORT), 10);
    return { baseUrl: `http://127.0.0.1:${port}` };
  }

  // Unix socket mode
  if (fs.existsSync(SOCKET_PATH)) {
    return { baseUrl: 'http://localhost', socketPath: SOCKET_PATH };
  }

  // Fallback to TCP if socket doesn't exist
  const port = parseInt(process.env.DAEMON_PORT || String(DEFAULT_PORT), 10);
  return { baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * Daemon client for hook-to-daemon communication
 */
export class DaemonClient {
  private secret: string;
  private baseUrl: string;
  private socketPath?: string;

  constructor(options: DaemonClientOptions = {}) {
    this.secret = options.secret || loadSecret();
    const transport = getTransportConfig();
    this.baseUrl = options.port
      ? `http://127.0.0.1:${options.port}`
      : transport.baseUrl;
    this.socketPath = options.socketPath || transport.socketPath;
  }

  /**
   * Make an authenticated request to the daemon
   */
  private async request<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    return withCircuitBreaker(async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const url = `${this.baseUrl}${endpoint}`;
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.secret}`,
          'Content-Type': 'application/json',
          'X-Request-Id': `hook_${process.pid}_${Date.now()}`,
        };

        const fetchOptions: RequestInit = {
          method,
          headers,
          signal: controller.signal,
        };

        if (body) {
          fetchOptions.body = JSON.stringify(body);
        }

        // For Unix sockets, we need to use a custom agent
        // Node.js 20+ fetch doesn't natively support Unix sockets
        // We use TCP fallback when socket exists but can't be used directly
        let response: Response;

        if (this.socketPath && fs.existsSync(this.socketPath)) {
          // Use http module for Unix socket (Node.js native)
          response = await this.unixSocketRequest(
            method,
            endpoint,
            body,
            headers,
            controller.signal
          );
        } else {
          response = await fetch(url, fetchOptions);
        }

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(
            `DAEMON_REQUEST_FAILED: ${response.status} ${response.statusText} - ${errorBody}`
          );
        }

        return (await response.json()) as T;
      } catch (err) {
        clearTimeout(timeoutId);

        if (err instanceof Error) {
          if (err.name === 'AbortError') {
            throw new Error('DAEMON_TIMEOUT: Request timed out after 10s');
          }
          if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
            throw new Error('DAEMON_UNREACHABLE: Connection refused');
          }
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('DAEMON_UNREACHABLE: Socket not found');
          }
        }

        throw err;
      }
    });
  }

  /**
   * Make a request via Unix socket using Node.js http module
   */
  private unixSocketRequest(
    method: string,
    endpoint: string,
    body: Record<string, unknown> | undefined,
    headers: Record<string, string>,
    signal: AbortSignal
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        socketPath: this.socketPath,
        path: endpoint,
        method,
        headers,
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          // Create a Response-like object
          resolve({
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 500,
            statusText: res.statusMessage || 'Unknown',
            json: async () => JSON.parse(data),
            text: async () => data,
            headers: new Headers(res.headers as Record<string, string>),
          } as Response);
        });
      });

      req.on('error', reject);

      // Handle abort signal
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('AbortError'));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Start a new session
   */
  async startSession(
    sessionId: string,
    cwd: string
  ): Promise<SessionInfo> {
    return this.request<SessionInfo>('POST', '/session/start', {
      sessionId,
      cwd,
    });
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('POST', '/session/close', {
      sessionId,
    });
  }

  /**
   * Get session status
   */
  async getSession(sessionId: string): Promise<SessionInfo | null> {
    try {
      return await this.request<SessionInfo>(
        'GET',
        `/session/${sessionId}/status`
      );
    } catch (err) {
      // Return null for not found
      if (err instanceof Error && err.message.includes('404')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Send a message to the session's Slack thread
   */
  async sendMessage(
    sessionId: string,
    message: string
  ): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>('POST', '/session/message', {
      sessionId,
      message,
    });
  }

  /**
   * Claim the next pending task for a session
   */
  async claimTask(sessionId: string): Promise<Task | null> {
    const result = await this.request<Task | { task: null }>(
      'POST',
      `/session/${sessionId}/tasks/claim`,
      {}
    );

    if ('task' in result && result.task === null) {
      return null;
    }

    return result as Task;
  }

  /**
   * Get pending tasks for a session
   * Note: This uses claimTask since there's no separate GET endpoint
   * The claimed task should be executed or released
   */
  async getPendingTaskCount(sessionId: string): Promise<number> {
    const session = await this.getSession(sessionId);
    if (!session) {
      return 0;
    }
    // Session status endpoint includes pendingTasks
    const status = session as SessionInfo & { pendingTasks?: number };
    return status.pendingTasks || 0;
  }
}

/**
 * Create a daemon client with default configuration
 */
export function createDaemonClient(): DaemonClient {
  return new DaemonClient();
}

// Re-export circuit breaker error for consumers
export { CircuitOpenError };
