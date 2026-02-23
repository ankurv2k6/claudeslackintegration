# Slack-Claude Code Integration Plan

## Plan Analysis Summary

```
SCORE: 48/100 → Target: 85/100
GAPS ADDRESSED: 22 critical/high issues resolved in this revision
```

---

## Context

Build a bidirectional integration between Slack and Claude Code sessions where:
- Claude Code sessions are controllable via Slack threads
- Each session maps to a unique Slack thread
- Prompts sent to the thread are executed in the corresponding session
- Results are sent back to the thread
- Multiple concurrent sessions across different codebases are supported

## Configuration Choices

- **Language:** Node.js with @slack/bolt (hooks also in Node.js, not bash)
- **Location:** Global installation at `~/.claude/slack_integration/`
- **Slack Mode:** Single dedicated channel (all sessions as threads)
- **Daemon Mode:** Manual start (`npm start`)

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Slack App     │◄───►│  Watcher Daemon  │◄───►│  Claude Code    │
│  (Bolt SDK)     │     │   (Node.js)      │     │   (Hooks)       │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                     │
         │ Socket Mode         │ HTTP localhost:3847
         │ (TLS)               │ + Bearer Token Auth
         │                     │
         ▼                     ▼
┌─────────────────┐     ┌──────────────────┐
│ #claude-sessions│     │ Session Registry │
│   (Channel)     │     │  + Task Files    │
└─────────────────┘     │  (file-locked)   │
                        └──────────────────┘
```

---

## Security Design (Addresses SEC-001 through SEC-014)

### Authentication & Authorization

| Component | Auth Method | Details |
|-----------|-------------|---------|
| HTTP Endpoints | Bearer Token | `Authorization: Bearer <DAEMON_SECRET>` header required |
| DAEMON_SECRET | Env Variable | 32-byte random hex, generated on first run if not set |
| Session IDs | UUID v4 | Cryptographically random, non-enumerable |
| File Permissions | 0600 | Owner-only read/write for registry and task files |

### Input Validation (Zod Schemas)

```typescript
// All HTTP endpoints validate input with Zod
const SessionStartSchema = z.object({
  sessionId: z.string().uuid(),
  cwd: z.string().max(4096).refine(path => path.startsWith('/')),
});

const SessionMessageSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().max(4000), // Slack limit
});

const TaskClaimSchema = z.object({
  sessionId: z.string().uuid(),
});
```

### Security Middleware

```typescript
// Applied to all routes
app.use(helmet());                              // Security headers
app.use(rateLimit({ windowMs: 60000, max: 100 })); // Rate limiting
app.use(express.json({ limit: '100kb' }));      // Request size limit
app.use(bearerTokenAuth);                       // Auth middleware
```

---

## Logging Infrastructure (Addresses LOG-001 through LOG-010)

### Structured Log Format (pino)

```typescript
// Every log entry includes:
{
  "ts": "2026-02-23T10:05:00.000Z",
  "level": "info",
  "service": "slack-claude-daemon",
  "module": "slack-client",
  "function": "handleMessage",
  "requestId": "req_abc123",           // Correlation ID
  "sessionId": "sess_xyz789",          // Session correlation
  "action": "MESSAGE_RECEIVED",
  "input": { "channelId": "C***ACTED" }, // Sanitized
  "output": { "taskCreated": true },
  "duration_ms": 45,
  "tags": ["slack", "inbound"]
}
```

### Error Code Taxonomy

| Code | Module | Description | Fix Steps |
|------|--------|-------------|-----------|
| `SLACK_CONN_TIMEOUT` | slack-client | Connection to Slack timed out | Check network, retry |
| `SLACK_AUTH_INVALID` | slack-client | Invalid token | Verify SLACK_BOT_TOKEN |
| `REGISTRY_SESSION_404` | registry | Session not found | Re-register session |
| `REGISTRY_WRITE_FAILED` | registry | Failed to write registry | Check disk space/permissions |
| `TASK_QUEUE_LOCKED` | task-queue | File lock acquisition failed | Retry after backoff |
| `TASK_QUEUE_CORRUPT` | task-queue | Invalid JSON in task file | Auto-recover from backup |
| `HTTP_AUTH_FAILED` | http-server | Invalid bearer token | Check DAEMON_SECRET |
| `HTTP_VALIDATION_FAILED` | http-server | Request validation failed | Check request schema |
| `HOOK_DAEMON_UNREACHABLE` | hooks | Cannot connect to daemon | Start daemon first |

### Log Levels by Component

| Component | Debug | Info | Warn | Error |
|-----------|-------|------|------|-------|
| slack-client | Message details | Connect/disconnect | Rate limit hit | API errors |
| registry | CRUD details | Session created/closed | Stale cleanup | Write failures |
| task-queue | Lock acquire/release | Task added/claimed | Lock timeout | Corruption |
| http-server | Request/response | Endpoint calls | Auth failures | Validation errors |

---

## Session State Machine (Addresses COMP-001)

```
                    ┌─────────────┐
                    │   PENDING   │
                    └──────┬──────┘
                           │ SessionStart hook succeeds
                           ▼
┌──────────────┐    ┌─────────────┐    ┌─────────────┐
│    ERROR     │◄───│   ACTIVE    │───►│   CLOSING   │
└──────────────┘    └──────┬──────┘    └──────┬──────┘
       │                   │                   │
       │                   │ SessionEnd hook   │
       └───────────────────┴───────────────────┘
                           ▼
                    ┌─────────────┐
                    │   CLOSED    │
                    └─────────────┘
```

### State Transitions

| From | To | Trigger | Actions |
|------|----|---------|---------|
| - | PENDING | Session ID generated | Create registry entry |
| PENDING | ACTIVE | Thread created successfully | Update registry, log |
| PENDING | ERROR | Thread creation failed | Log error, cleanup |
| ACTIVE | CLOSING | SessionEnd hook called | Send closing message |
| ACTIVE | ERROR | Daemon crash / Slack error | Log, attempt recovery |
| CLOSING | CLOSED | Cleanup complete | Remove from registry |
| ERROR | ACTIVE | Manual recovery / retry | Re-register session |

---

## Concurrency & File Locking (Addresses COMP-002)

### File Locking Strategy

```typescript
// Use proper-lockfile for atomic operations
import lockfile from 'proper-lockfile';

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(filePath, {
    retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
    stale: 10000, // 10s stale lock detection
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
```

### Atomic Write Pattern

```typescript
// Write to temp file, then rename (atomic on POSIX)
async function atomicWriteJSON(filePath: string, data: object): Promise<void> {
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}
```

---

## Stop Hook Loop Prevention (Addresses COMP-003)

### Loop Detection Mechanism

```typescript
// In Stop hook
const input = JSON.parse(await readStdin());
const { session_id, stop_hook_active } = input;

// CRITICAL: Check if we're already in a stop hook loop
if (stop_hook_active) {
  // Already continuing from a previous stop hook - don't inject more
  // This prevents infinite loops
  process.exit(0); // Allow stop
}

// Additional safeguards
const MAX_CONSECUTIVE_INJECTIONS = 10;
const injectionCount = await getInjectionCount(session_id);
if (injectionCount >= MAX_CONSECUTIVE_INJECTIONS) {
  await sendToSlack(session_id, "Max task limit reached. Pausing.");
  process.exit(0); // Allow stop
}
```

---

## Slack Integration Details (Addresses COMP-005, COMP-009)

### Required Slack App Configuration

```yaml
# slack-app-manifest.yaml
display_information:
  name: Claude Code Integration
  description: Control Claude Code sessions via Slack
oauth_config:
  scopes:
    bot:
      - chat:write        # Post messages
      - channels:history  # Read channel messages
      - channels:read     # List channels
settings:
  event_subscriptions:
    bot_events:
      - message.channels  # Receive channel messages
  socket_mode_enabled: true
  org_deploy_enabled: false
```

### Message Handling

```typescript
// Rate limiting (Tier 3: 1 msg/sec sustained)
const messageQueue = new PQueue({
  concurrency: 1,
  interval: 1000,
  intervalCap: 1
});

// Message chunking for long responses (Slack 4000 char limit)
function chunkMessage(text: string, maxLength = 3900): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}

// Handle edited/deleted messages
app.event('message', async ({ event }) => {
  if (event.subtype === 'message_changed') {
    // Log but don't re-process - already queued
    logger.info('MESSAGE_EDITED', { ts: event.ts });
    return;
  }
  if (event.subtype === 'message_deleted') {
    // Remove from task queue if not yet processed
    await removeTaskByMessageTs(event.deleted_ts);
    return;
  }
});
```

---

## Multi-Codebase Session Tracking (Addresses COMP-006, OUT-2)

### Enhanced Registry Schema

```typescript
interface SessionEntry {
  sessionId: string;           // UUID v4
  threadTs: string;            // Slack thread timestamp
  channelId: string;           // Slack channel
  codebasePath: string;        // Absolute path to codebase
  status: SessionStatus;       // PENDING | ACTIVE | CLOSING | CLOSED | ERROR
  startedAt: string;           // ISO timestamp
  lastActivityAt: string;      // ISO timestamp (for stale detection)
  injectionCount: number;      // For loop prevention
  errorHistory: ErrorEntry[];  // Recent errors for debugging
}

interface Registry {
  version: 1;
  sessions: Record<string, SessionEntry>;
  threadToSession: Record<string, string>; // Reverse lookup: thread_ts -> session_id
}
```

### Thread-to-Session Routing

```typescript
// When Slack message arrives in thread
app.event('message', async ({ event }) => {
  if (!event.thread_ts) return; // Only process thread replies

  const sessionId = registry.threadToSession[event.thread_ts];
  if (!sessionId) {
    logger.warn('UNKNOWN_THREAD', { thread_ts: event.thread_ts });
    return;
  }

  // Route to correct session's task queue
  await taskQueue.addTask(sessionId, {
    id: `task_${Date.now()}`,
    prompt: event.text,
    slackUser: event.user,
    messageTs: event.ts,
    receivedAt: new Date().toISOString(),
  });
});
```

---

## Hooks in Node.js (Addresses SEC-004, FEAS-2)

### Why Node.js Instead of Bash

- **SEC-004**: Eliminates shell injection risk from JSON parsing
- **FEAS-2**: Removes jq dependency (not installed by default)
- **Consistency**: Same language as daemon, easier debugging
- **Type Safety**: TypeScript for hook logic

### Hook Structure

```
~/.claude/slack_integration/
├── hooks/
│   ├── session-start.js    # Compiled from TypeScript
│   ├── stop.js
│   ├── session-end.js
│   └── lib/
│       ├── daemon-client.ts  # HTTP client for daemon
│       └── input-parser.ts   # stdin JSON parser
```

### Example: Stop Hook (Node.js)

```typescript
#!/usr/bin/env node
// hooks/stop.js

import { readStdin, output, exitAllow, exitBlock } from './lib/hook-helpers';
import { DaemonClient } from './lib/daemon-client';

async function main() {
  const input = await readStdin();
  const { session_id, stop_hook_active, last_assistant_message } = input;

  // Loop prevention
  if (stop_hook_active) {
    exitAllow();
  }

  const client = new DaemonClient();

  // Check for pending tasks
  const tasks = await client.getTasks(session_id);

  if (tasks.length > 0) {
    const nextTask = tasks[0];
    await client.claimTask(session_id, nextTask.id);
    exitBlock(nextTask.prompt); // Inject as next prompt
  } else {
    // No tasks - send summary to Slack
    const summary = extractSummary(last_assistant_message);
    await client.sendMessage(session_id, summary);
    exitAllow();
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(0); // Fail gracefully
});
```

---

## Components

### 1. Session Registry (`data/registry.json`)

```json
{
  "version": 1,
  "sessions": {
    "550e8400-e29b-41d4-a716-446655440000": {
      "sessionId": "550e8400-e29b-41d4-a716-446655440000",
      "threadTs": "1234567890.123456",
      "channelId": "C0123456789",
      "codebasePath": "/Users/ankurv/project-a",
      "status": "active",
      "startedAt": "2026-02-23T10:00:00Z",
      "lastActivityAt": "2026-02-23T10:05:00Z",
      "injectionCount": 0,
      "errorHistory": []
    }
  },
  "threadToSession": {
    "1234567890.123456": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

### 2. Task Queue Files (`data/tasks/{session_id}.json`)

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "task_1708678500000",
      "prompt": "Add error handling to the API endpoint",
      "slackUser": "U0123456789",
      "messageTs": "1234567890.123457",
      "receivedAt": "2026-02-23T10:05:00Z",
      "status": "pending"
    }
  ]
}
```

### 3. Watcher Daemon

**Endpoints (all require Bearer auth):**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth required) |
| `POST` | `/session/start` | Create thread, register session |
| `POST` | `/session/message` | Post message to thread |
| `POST` | `/session/close` | Mark session as closed |
| `POST` | `/session/:id/tasks/claim` | Claim next task (changed from GET) |
| `GET` | `/session/:id/status` | Get session status |

### 4. Claude Code Hooks

| Hook | Trigger | Action |
|------|---------|--------|
| `session-start.js` | SessionStart (startup only) | Register session, create thread |
| `stop.js` | Stop | Check tasks, inject or summarize |
| `session-end.js` | SessionEnd | Close thread, cleanup |

---

## Detailed Implementation Plan

### Phase 1: Create Project Structure

```
~/.claude/slack_integration/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts              # Main daemon entry point
│   ├── config.ts             # Configuration with validation
│   ├── logger.ts             # Pino logger setup
│   ├── slack-client.ts       # Slack Bolt SDK wrapper
│   ├── registry.ts           # Session registry with file locking
│   ├── task-queue.ts         # Task file management
│   ├── http-server.ts        # Express server with auth
│   ├── middleware/
│   │   ├── auth.ts           # Bearer token auth
│   │   ├── validation.ts     # Zod validation
│   │   └── error-handler.ts  # Global error handler
│   └── schemas/
│       └── api.ts            # Zod schemas for all endpoints
├── hooks/
│   ├── session-start.ts
│   ├── stop.ts
│   ├── session-end.ts
│   └── lib/
│       ├── hook-helpers.ts
│       └── daemon-client.ts
├── data/                     # Created at runtime
│   ├── registry.json
│   └── tasks/
├── tests/
│   ├── unit/
│   │   ├── registry.test.ts
│   │   ├── task-queue.test.ts
│   │   └── schemas.test.ts
│   ├── integration/
│   │   ├── http-server.test.ts
│   │   └── slack-client.test.ts
│   └── e2e/
│       └── full-workflow.test.ts
└── scripts/
    └── generate-secret.js    # Generate DAEMON_SECRET
```

### Phase 2: Implement Core Infrastructure

1. **Configuration & Logging**
   - [ ] Create `config.ts` with Zod validation for all env vars
   - [ ] Create `logger.ts` with pino, structured format, correlation IDs
   - [ ] Create `.env.example` with all required variables

2. **Security Middleware**
   - [ ] Implement bearer token auth middleware
   - [ ] Implement Zod validation middleware
   - [ ] Implement global error handler with error codes
   - [ ] Add helmet and rate limiting

3. **Registry with File Locking**
   - [ ] Implement `withFileLock()` using proper-lockfile
   - [ ] Implement `atomicWriteJSON()` for safe writes
   - [ ] Implement CRUD operations with state machine validation
   - [ ] Add stale session cleanup on startup

4. **Task Queue with Concurrency Safety**
   - [ ] Implement file-locked task operations
   - [ ] Implement task claiming (not destructive GET)
   - [ ] Add backup/recovery for corrupt files

### Phase 3: Implement Slack Integration

1. **Slack Client**
   - [ ] Configure Bolt SDK with Socket Mode
   - [ ] Implement message event handler with thread routing
   - [ ] Implement rate-limited message sending
   - [ ] Implement message chunking for long responses
   - [ ] Handle message edits and deletes

2. **HTTP Server**
   - [ ] Create Express app with all middleware
   - [ ] Implement `/health` endpoint (no auth)
   - [ ] Implement `/session/start` with validation
   - [ ] Implement `/session/message` with chunking
   - [ ] Implement `/session/close` with cleanup
   - [ ] Implement `/session/:id/tasks/claim` (POST, not GET)
   - [ ] Implement `/session/:id/status`

### Phase 4: Implement Hooks (Node.js)

1. **Hook Infrastructure**
   - [ ] Create `hook-helpers.ts` (stdin parsing, output helpers)
   - [ ] Create `daemon-client.ts` (HTTP client with auth)
   - [ ] Compile hooks to JS for direct execution

2. **SessionStart Hook**
   - [ ] Read session_id and cwd from stdin
   - [ ] Call daemon to register session
   - [ ] Handle daemon unreachable gracefully

3. **Stop Hook**
   - [ ] Check `stop_hook_active` for loop prevention
   - [ ] Check injection count limit
   - [ ] Claim next task or send summary
   - [ ] Handle all error cases gracefully

4. **SessionEnd Hook**
   - [ ] Call daemon to close session
   - [ ] Handle cleanup errors gracefully

### Phase 5: Configure & Test

1. **Hook Configuration**
   - [ ] Add hooks to `~/.claude/settings.json`
   - [ ] Verify settings.json is valid (fix if corrupted)

2. **Testing**
   - [ ] Unit tests for registry, task-queue, schemas (90% coverage)
   - [ ] Integration tests for HTTP endpoints with mocked Slack
   - [ ] E2E test with real Slack (manual verification)

---

## Testing Strategy (Addresses TEST-*)

### Coverage Target: 90%

| Module | Unit Tests | Integration Tests | Target |
|--------|------------|-------------------|--------|
| registry.ts | CRUD ops, state machine, locking | - | 95% |
| task-queue.ts | Add/claim/remove, locking, recovery | - | 95% |
| schemas/*.ts | All Zod schemas, edge cases | - | 100% |
| http-server.ts | - | All endpoints, auth, validation | 90% |
| slack-client.ts | - | Message routing, chunking | 85% |
| hooks/*.ts | Input parsing, output formatting | Daemon communication | 90% |

### Test Infrastructure

```typescript
// vitest.config.ts
export default {
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      thresholds: {
        global: { lines: 90, functions: 90, branches: 85 },
      },
    },
  },
};
```

### Mock Strategy

| Component | Mock |
|-----------|------|
| Slack API | `@slack/bolt` test utilities |
| File system | `memfs` for isolated tests |
| HTTP | `msw` for hook tests |

---

## Error Recovery (Addresses COMP-007, COMP-010)

### Daemon Health Check

```typescript
// GET /health (no auth required)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    sessions: Object.keys(registry.sessions).length,
    version: pkg.version,
  });
});
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  logger.info('SHUTDOWN_INITIATED');

  // Stop accepting new connections
  server.close();

  // Notify all active sessions
  for (const session of Object.values(registry.sessions)) {
    if (session.status === 'active') {
      await sendToSlack(session.sessionId, 'Daemon shutting down. Session paused.');
    }
  }

  // Flush logs
  await logger.flush();

  process.exit(0);
});
```

### Registry Recovery

```typescript
// On startup
async function initializeRegistry() {
  const registryPath = path.join(DATA_DIR, 'registry.json');
  const backupPath = `${registryPath}.backup`;

  try {
    registry = await loadJSON(registryPath);
  } catch (err) {
    logger.warn('REGISTRY_CORRUPT', { error: err.message });

    // Try backup
    if (await exists(backupPath)) {
      registry = await loadJSON(backupPath);
      logger.info('REGISTRY_RECOVERED_FROM_BACKUP');
    } else {
      registry = { version: 1, sessions: {}, threadToSession: {} };
      logger.info('REGISTRY_CREATED_FRESH');
    }
  }

  // Cleanup stale sessions (no activity in 24h)
  await cleanupStaleSessions(24 * 60 * 60 * 1000);
}
```

---

## Environment Variables

```bash
# ~/.claude/slack_integration/.env

# Slack credentials (required)
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...        # App-Level Token (for Socket Mode)
SLACK_CHANNEL_ID=C0123456789    # Your #claude-sessions channel ID

# Daemon configuration
DAEMON_PORT=3847                # HTTP port (default: 3847)
DAEMON_SECRET=                  # Auto-generated 32-byte hex if empty

# Logging
LOG_LEVEL=info                  # debug | info | warn | error
LOG_FORMAT=json                 # json | pretty

# Operational
STALE_SESSION_HOURS=24          # Cleanup sessions older than this
MAX_INJECTION_COUNT=10          # Max consecutive task injections
MESSAGE_RATE_LIMIT_MS=1000      # Min ms between Slack messages
```

---

## Hook Configuration

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node $HOME/.claude/slack_integration/hooks/session-start.js",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $HOME/.claude/slack_integration/hooks/stop.js",
            "timeout": 15
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node $HOME/.claude/slack_integration/hooks/session-end.js",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

---

## Prerequisites

### 1. System Requirements

- Node.js 18+ (for native fetch, modern ES features)
- npm 9+

### 2. Create Slack App

1. Go to https://api.slack.com/apps → Create New App → From manifest
2. Paste the manifest from `slack-app-manifest.yaml`
3. Install to workspace
4. Copy Bot Token and App Token to `.env`

### 3. Initial Setup

```bash
# Clone/create the integration
mkdir -p ~/.claude/slack_integration
cd ~/.claude/slack_integration

# Install dependencies
npm install

# Generate daemon secret (if not set)
npm run generate-secret

# Copy and configure environment
cp .env.example .env
# Edit .env with your Slack tokens

# Build TypeScript
npm run build

# Run tests
npm test

# Start daemon
npm start
```

---

## Usage

```bash
# Terminal 1: Start the daemon
cd ~/.claude/slack_integration && npm start

# Terminal 2: Start Claude Code
claude

# In Slack:
# - A new thread appears in #claude-sessions
# - Reply to the thread with prompts
# - Claude executes and posts summaries back

# To stop:
# - Exit Claude Code (thread will be marked closed)
# - Ctrl+C the daemon
```

---

## Critical Files Summary

| # | File | Purpose |
|---|------|---------|
| 1 | `package.json` | Dependencies (bolt, express, pino, zod, proper-lockfile) |
| 2 | `src/index.ts` | Main daemon entry |
| 3 | `src/config.ts` | Validated configuration |
| 4 | `src/logger.ts` | Structured logging with pino |
| 5 | `src/slack-client.ts` | Slack Bolt wrapper |
| 6 | `src/registry.ts` | File-locked session registry |
| 7 | `src/task-queue.ts` | File-locked task queue |
| 8 | `src/http-server.ts` | Express server with auth |
| 9 | `src/middleware/auth.ts` | Bearer token authentication |
| 10 | `src/schemas/api.ts` | Zod validation schemas |
| 11 | `hooks/session-start.ts` | SessionStart hook (Node.js) |
| 12 | `hooks/stop.ts` | Stop hook with loop prevention |
| 13 | `hooks/session-end.ts` | SessionEnd hook |
| 14 | `hooks/lib/daemon-client.ts` | Hook HTTP client |
| 15 | `tests/**/*.test.ts` | Test suite (90% coverage target) |

---

## Gaps Addressed in This Revision

| Gap ID | Severity | Status | Resolution |
|--------|----------|--------|------------|
| SEC-001 | CRITICAL | FIXED | Added bearer token auth to all endpoints |
| SEC-008 | CRITICAL | FIXED | Explicit auth required, no localhost trust |
| SEC-012 | CRITICAL | FIXED | Zod schemas for all inputs |
| COMP-001 | CRITICAL | FIXED | Full session state machine defined |
| COMP-002 | CRITICAL | FIXED | proper-lockfile + atomic writes |
| LOG-001 | CRITICAL | FIXED | Structured pino logging format |
| LOG-002 | CRITICAL | FIXED | Error code taxonomy defined |
| LOG-003 | CRITICAL | FIXED | requestId + sessionId correlation |
| COMP-003 | HIGH | FIXED | stop_hook_active + injection count limit |
| COMP-005 | HIGH | FIXED | Rate limiting + message chunking |
| SEC-004 | HIGH | FIXED | Node.js hooks instead of bash |
| SEC-007 | HIGH | FIXED | UUID v4 for session IDs |
| FEAS-2 | HIGH | FIXED | Node.js hooks, no jq dependency |
| OUT-2 | HIGH | FIXED | threadToSession reverse lookup |
| COMP-006 | HIGH | FIXED | codebasePath tracking in registry |
| COMP-007 | HIGH | FIXED | Health check + graceful shutdown |
| SEC-002 | HIGH | FIXED | File permissions 0600 |
| SEC-006 | MEDIUM | FIXED | Changed GET tasks to POST claim |
| SEC-013 | HIGH | FIXED | helmet + rate limiting |
| LOG-004 | HIGH | FIXED | Log levels defined per component |
| LOG-005 | HIGH | FIXED | Component-level logging requirements |
| TEST-* | HIGH | FIXED | 90% coverage target with test strategy |
