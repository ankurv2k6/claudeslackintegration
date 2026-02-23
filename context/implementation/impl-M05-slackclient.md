# Implementation Spec: M-05 -- SlackClient

> Blueprint: blprnt-M05-slackclient.md | Contracts: impl-contracts.md S1-S2 | Patterns: impl-master.md S4

---

## 1. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| impl-contracts.md | S1, S2 | ~400 | SessionEntry, Task |
| impl-master.md | S4 | ~200 | Naming, imports |

### Total Budget: ~600 tokens

---

## 2. File Map

| Order | Path | Purpose | Creates/Modifies |
|-------|------|---------|------------------|
| 1 | `src/slack-client.ts` | Bolt SDK integration | Creates |
| 2 | `tests/unit/slack-client.test.ts` | Unit tests | Creates |
| 3 | `tests/integration/slack-client.test.ts` | Integration tests | Creates |

---

## 3. Dependencies Setup

```typescript
// src/slack-client.ts
import { App, LogLevel } from '@slack/bolt';
import PQueue from 'p-queue';
import { config } from './config';
import { logger, withRequestId } from './logger';
import * as registry from './registry';
import * as taskQueue from './task-queue';
```

---

## 4. Core Implementation

### 4.1 src/slack-client.ts

**Exports**:
```typescript
export function createSlackClient(): App;
export async function startSlackClient(app: App): Promise<void>;
export async function stopSlackClient(app: App): Promise<void>;
export async function sendSlackMessage(sessionId: string, text: string): Promise<void>;
export async function sendSlackReaction(sessionId: string, messageTs: string, emoji: string): Promise<void>;
```

**Logic**:
```typescript
// Message queue for rate limiting (1 msg/sec)
const messageQueue = new PQueue({
  concurrency: 1,
  interval: 1000,
  intervalCap: 1,
});

export function createSlackClient(): App {
  return new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });
}

export async function startSlackClient(app: App): Promise<void> {
  // Message event handler
  app.event('message', async ({ event, client }) => {
    const log = withRequestId(logger, `msg_${event.ts}`);

    // Filter bot messages
    if ('bot_id' in event && event.bot_id) {
      return;
    }

    // Only process thread replies
    if (!event.thread_ts) {
      return;
    }

    // Check authorization
    if (config.authorizedUsers.length > 0) {
      if (!config.authorizedUsers.includes(event.user)) {
        log.warn({ action: 'UNAUTHORIZED_USER', slackUser: event.user });
        return;
      }
    }

    // Route to session
    const session = await registry.getSessionByThread(event.thread_ts);
    if (!session) {
      log.warn({ action: 'UNKNOWN_THREAD', threadTs: event.thread_ts });
      return;
    }

    // Handle message types
    if ('subtype' in event) {
      if (event.subtype === 'message_changed') {
        log.info({ action: 'MESSAGE_EDITED', messageTs: event.ts });
        return;
      }
      if (event.subtype === 'message_deleted') {
        await taskQueue.removeTaskByMessageTs(session.sessionId, event.deleted_ts);
        return;
      }
    }

    // Add task
    await taskQueue.addTask(session.sessionId, {
      prompt: event.text || '',
      slackUser: event.user,
      messageTs: event.ts,
    });

    log.info({ action: 'TASK_ADDED_FROM_SLACK', sessionId: session.sessionId });
  });

  await app.start();
  logger.info({ action: 'SLACK_CLIENT_STARTED' });
}

// Exponential backoff retry
async function sendWithRetry(
  fn: () => Promise<void>,
  maxRetries = 5
): Promise<void> {
  let delay = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fn();
      return;
    } catch (err: any) {
      const isRateLimited = err.data?.error === 'ratelimited';
      const isRetryable = isRateLimited || err.data?.error === 'service_unavailable';

      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }

      const retryAfter = err.headers?.['retry-after'];
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.min(delay, 30000);

      logger.warn({ action: 'SLACK_RATE_LIMITED', attempt, waitMs });
      await new Promise(r => setTimeout(r, waitMs));
      delay *= 2;
    }
  }
}

// Chunk long messages
function chunkMessage(text: string, maxLength = 3900): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  return chunks;
}

export async function sendSlackMessage(sessionId: string, text: string): Promise<void> {
  const session = await registry.getSession(sessionId);
  if (!session || session.status !== 'ACTIVE') {
    logger.warn({ action: 'SEND_TO_INACTIVE_SESSION', sessionId });
    return;
  }

  const chunks = chunkMessage(text);

  for (const chunk of chunks) {
    await messageQueue.add(async () => {
      await sendWithRetry(async () => {
        await app.client.chat.postMessage({
          channel: session.channelId,
          thread_ts: session.threadTs,
          text: chunk,
        });
      });
    });
  }
}
```

---

## 5. Data Structures

None (stateless).

---

## 6. Test Guide

| File | Covers | Mocks | Fixtures |
|------|--------|-------|----------|
| `tests/unit/slack-client.test.ts` | Message handling, chunking | @slack/bolt | slack-events.json |
| `tests/integration/slack-client.test.ts` | Full flow | msw | - |

**Key Test Cases**:
```typescript
describe('message handler', () => {
  it('ignores bot messages');
  it('ignores non-thread messages');
  it('routes thread to correct session');
  it('adds task from message');
});

describe('sendSlackMessage', () => {
  it('chunks long messages');
  it('retries on rate limit');
  it('respects Retry-After header');
});
```

---

## 7. Integration Points

| Ref | Contract | How |
|-----|----------|-----|
| impl-contracts.md S1 | SessionEntry | Uses for thread routing |
| impl-contracts.md S2 | Task | Creates tasks from messages |

---

## 8. Parallel Notes

- Can start after M-04 complete
- Runs in parallel with M-06
