# Implementation Contracts

> Single source of truth for TypeScript interfaces, Zod schemas, and event types.
> Code-level companion to blprnt-master.md S7.

---

## 1. SessionEntry

**Stability**: LOCKED
**Producer**: M-03 Registry
**Consumers**: M-04, M-05, M-06, M-07

### TypeScript Interface

```typescript
type SessionStatus = 'PENDING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'ERROR';

interface ErrorEntry {
  code: string;
  message: string;
  timestamp: string;  // ISO 8601
}

interface SessionEntry {
  sessionId: string;           // UUID v4
  threadTs: string;            // Slack thread timestamp
  channelId: string;           // Slack channel ID
  codebasePath: string;        // Absolute path to codebase
  status: SessionStatus;
  startedAt: string;           // ISO 8601
  lastActivityAt: string;      // ISO 8601
  injectionCount: number;      // For loop prevention
  errorHistory: ErrorEntry[];  // Last N errors
}

interface CreateSessionInput {
  sessionId: string;
  threadTs: string;
  channelId: string;
  codebasePath: string;
}

interface Registry {
  version: 1;
  sessions: Record<string, SessionEntry>;
  threadToSession: Record<string, string>;  // thread_ts -> session_id
}
```

### Zod Schema

```typescript
import { z } from 'zod';

export const SessionStatusSchema = z.enum([
  'PENDING', 'ACTIVE', 'CLOSING', 'CLOSED', 'ERROR'
]);

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
  status: SessionStatusSchema,
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
```

---

## 2. Task

**Stability**: LOCKED
**Producer**: M-04 TaskQueue
**Consumers**: M-05, M-06, M-07

### TypeScript Interface

```typescript
type TaskStatus = 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'FAILED';

interface Task {
  id: string;              // task_{timestamp}
  sequence: number;        // Monotonic order
  prompt: string;          // User's message
  slackUser: string;       // U-prefixed Slack user ID
  messageTs: string;       // Slack message timestamp (dedup key)
  receivedAt: string;      // ISO 8601
  status: TaskStatus;
  claimedAt?: string;      // ISO 8601
  completedAt?: string;    // ISO 8601
  claimedBy?: string;      // hook_{pid}
  error?: string;          // Error message if FAILED
}

interface CreateTaskInput {
  prompt: string;
  slackUser: string;
  messageTs: string;
}

interface TaskQueue {
  version: 1;
  lastSequence: number;
  tasks: Task[];
}
```

### Zod Schema

```typescript
export const TaskStatusSchema = z.enum([
  'PENDING', 'CLAIMED', 'COMPLETED', 'FAILED'
]);

export const TaskSchema = z.object({
  id: z.string().regex(/^task_\d+$/),
  sequence: z.number().int().positive(),
  prompt: z.string().max(4000),
  slackUser: z.string().startsWith('U'),
  messageTs: z.string().regex(/^\d+\.\d+$/),
  receivedAt: z.string().datetime(),
  status: TaskStatusSchema,
  claimedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  claimedBy: z.string().optional(),
  error: z.string().optional(),
});

export const TaskQueueSchema = z.object({
  version: z.literal(1),
  lastSequence: z.number().int().min(0),
  tasks: z.array(TaskSchema),
});
```

---

## 3. Hook I/O

**Stability**: LOCKED
**Producer**: Claude Code (input), M-07 (output)
**Consumers**: M-07 Hooks

### TypeScript Interface

```typescript
// Claude Code provides this on stdin
interface HookInput {
  session_id: string;           // UUID
  cwd: string;                  // Current working directory
  stop_hook_active?: boolean;   // True if continuing from previous injection
  last_assistant_message?: string;  // For summary extraction
  request_id?: string;          // Correlation ID (added by daemon)
}

// Hook outputs this on stdout
interface HookOutput {
  decision: 'allow' | 'block';
  reason?: string;              // If blocking, becomes next prompt
}
```

### Zod Schema

```typescript
export const HookInputSchema = z.object({
  session_id: z.string().uuid(),
  cwd: z.string(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().optional(),
  request_id: z.string().optional(),
});

export const HookOutputSchema = z.object({
  decision: z.enum(['allow', 'block']),
  reason: z.string().optional(),
});
```

---

## 4. HTTP Request/Response Schemas

**Stability**: LOCKED
**Producer**: M-07 Hooks, M-05 SlackClient
**Consumers**: M-06 HttpServer

### Session Start

```typescript
// POST /session/start
export const SessionStartRequestSchema = z.object({
  sessionId: z.string().uuid(),
  cwd: z.string().max(4096).refine(path => {
    const denied = ['/etc', '/var', '/root', '/System', '/bin', '/sbin',
                    '/usr', '/lib', '/lib64', '/boot', '/proc', '/sys', '/dev'];
    const resolved = require('path').resolve(path);
    return path.startsWith('/') &&
           !denied.some(d => resolved.startsWith(d)) &&
           !path.includes('/../');
  }, { message: 'Invalid or denied path' }),
});

export const SessionStartResponseSchema = z.object({
  sessionId: z.string().uuid(),
  threadTs: z.string(),
  channelId: z.string(),
  status: z.literal('ACTIVE'),
});
```

### Session Message

```typescript
// POST /session/message
export const SessionMessageRequestSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().max(10000),  // Allow longer for summaries
});

export const SessionMessageResponseSchema = z.object({
  success: z.boolean(),
  messageTs: z.string().optional(),
});
```

### Task Claim

```typescript
// POST /session/:id/tasks/claim
export const TaskClaimRequestSchema = z.object({
  // sessionId comes from URL param
});

export const TaskClaimResponseSchema = z.union([
  TaskSchema,
  z.object({ task: z.null() }),
]);
```

### Health & Metrics

```typescript
// GET /health
export const HealthResponseSchema = z.object({
  status: z.literal('healthy'),
  uptime: z.number(),
  sessions: z.number(),
  version: z.string(),
});

// GET /metrics - plain text Prometheus format
```

---

## 5. LogEntry

**Stability**: DRAFT
**Producer**: M-02 Logger
**Consumers**: All modules

### TypeScript Interface

```typescript
interface LogEntry {
  ts: string;              // ISO 8601
  level: 'debug' | 'info' | 'warn' | 'error';
  service: string;         // 'slack-claude-daemon' or 'slack-claude-hook'
  module: string;          // e.g., 'registry', 'slack-client'
  function?: string;       // Function name
  requestId?: string;      // Correlation ID from Slack message_ts
  sessionId?: string;      // Session UUID
  action: string;          // e.g., 'SESSION_CREATED', 'TASK_CLAIMED'
  input?: object;          // Redacted input
  output?: object;         // Output summary
  duration_ms?: number;    // Operation duration
  tags?: string[];         // Categorization

  // Error-specific
  error?: {
    code: string;          // From error code taxonomy
    message: string;
    stack?: string;
    cause?: string;
    codeLocation?: string; // file:line
    recoveryHint?: string;
  };

  // System state snapshot (on error)
  systemState?: {
    activeSessionCount: number;
    queueDepth: number;
    lockHolder?: string;
  };
}
```

---

## 6. Config

**Stability**: LOCKED
**Producer**: M-01 Config
**Consumers**: All modules

### TypeScript Interface

```typescript
interface Config {
  // Slack
  slackBotToken: string;
  slackAppToken: string;
  slackChannelId: string;
  authorizedUsers: string[];  // Empty = all allowed

  // Daemon
  daemonSecret: string;
  transportMode: 'unix' | 'tcp';
  daemonPort: number;

  // Paths
  dataDir: string;
  hooksDir: string;
  logsDir: string;

  // Logging
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}
```

### Zod Schema

```typescript
export const ConfigSchema = z.object({
  slackBotToken: z.string().startsWith('xoxb-'),
  slackAppToken: z.string().startsWith('xapp-'),
  slackChannelId: z.string().startsWith('C'),
  authorizedUsers: z.array(z.string().startsWith('U')),

  daemonSecret: z.string().length(64).regex(/^[a-f0-9]+$/),
  transportMode: z.enum(['unix', 'tcp']).default('unix'),
  daemonPort: z.number().int().min(1024).max(65535).default(3847),

  dataDir: z.string(),
  hooksDir: z.string(),
  logsDir: z.string(),

  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});
```

---

## Cross-References

- Blueprint: [blprnt-master.md](../blueprints/blprnt-master.md) S7
- Implementation Master: [impl-master.md](impl-master.md)
