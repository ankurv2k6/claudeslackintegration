# Implementation Spec: M-07 -- Hooks

> Blueprint: blprnt-M07-hooks.md | Contracts: impl-contracts.md S3 | Patterns: impl-master.md S5

---

## 1. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| impl-contracts.md | S3 | ~400 | HookInput, HookOutput |
| impl-master.md | S5 | ~300 | Daemon client stub |

### Total Budget: ~700 tokens

---

## 2. File Map

| Order | Path | Purpose | Creates/Modifies |
|-------|------|---------|------------------|
| 1 | `hooks/lib/hook-helpers.ts` | stdin/stdout helpers | Creates |
| 2 | `hooks/lib/hook-logger.ts` | Hook logging | Creates |
| 3 | `hooks/lib/circuit-breaker.ts` | Circuit breaker | Creates |
| 4 | `hooks/lib/daemon-client.ts` | HTTP client | Creates |
| 5 | `hooks/lib/summary.ts` | Summary extraction | Creates |
| 6 | `hooks/session-start.ts` | Session start hook | Creates |
| 7 | `hooks/stop.ts` | Stop hook | Creates |
| 8 | `hooks/session-end.ts` | Session end hook | Creates |
| 9 | `tests/unit/hooks/*.test.ts` | Unit tests | Creates |

---

## 3. Dependencies Setup

```typescript
// hooks/lib/daemon-client.ts
import { config } from '../../src/config';
import { HookInput, HookOutput } from '../../src/schemas/api';
```

---

## 4. Core Implementation

### 4.1 hooks/lib/hook-helpers.ts

```typescript
import { HookInput, HookOutput, HookInputSchema } from '../../src/schemas/api';

export async function readStdin(): Promise<HookInput> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        resolve(HookInputSchema.parse(parsed));
      } catch (err) {
        reject(new Error(`HOOK_PARSE_FAILED: ${err.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

export function exitAllow(): never {
  const output: HookOutput = { decision: 'allow' };
  console.log(JSON.stringify(output));
  process.exit(0);
}

export function exitBlock(prompt: string): never {
  const output: HookOutput = { decision: 'block', reason: prompt };
  console.log(JSON.stringify(output));
  process.exit(0);
}
```

### 4.2 hooks/lib/circuit-breaker.ts

```typescript
const FAILURE_THRESHOLD = 3;
const RECOVERY_TIMEOUT_MS = 30000;
const SUCCESS_THRESHOLD = 2;

interface CircuitState {
  failures: number;
  lastFailure: number;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  halfOpenSuccesses: number;
}

const state: CircuitState = {
  failures: 0,
  lastFailure: 0,
  state: 'CLOSED',
  halfOpenSuccesses: 0,
};

export async function withCircuitBreaker<T>(fn: () => Promise<T>): Promise<T> {
  // Check for recovery
  if (state.state === 'OPEN') {
    if (Date.now() - state.lastFailure > RECOVERY_TIMEOUT_MS) {
      state.state = 'HALF_OPEN';
      state.halfOpenSuccesses = 0;
    } else {
      throw new Error('CIRCUIT_OPEN: Daemon unavailable');
    }
  }

  try {
    const result = await fn();

    // On success
    if (state.state === 'HALF_OPEN') {
      state.halfOpenSuccesses++;
      if (state.halfOpenSuccesses >= SUCCESS_THRESHOLD) {
        state.state = 'CLOSED';
        state.failures = 0;
      }
    } else {
      state.failures = 0;
    }

    return result;
  } catch (err) {
    // On failure
    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= FAILURE_THRESHOLD) {
      state.state = 'OPEN';
    }

    throw err;
  }
}
```

### 4.3 hooks/lib/summary.ts

```typescript
const CODE_BLOCK_REGEX = /```(\w+)?\n[\s\S]*?```/g;
const TRAILING_BLOCK_REGEX = /```(\w+)?\n[\s\S]*?```\s*$/;

export function extractSummary(text: string, maxLength = 500): string {
  if (!text) return 'No output available.';

  // Try to preserve trailing code block
  const trailingMatch = text.match(TRAILING_BLOCK_REGEX);
  if (trailingMatch && trailingMatch[0].length < maxLength) {
    const beforeBlock = text.slice(0, text.lastIndexOf('```'));
    const lastLine = beforeBlock.split('\n').filter(l => l.trim()).pop() || '';
    if (lastLine.length + trailingMatch[0].length < maxLength) {
      return lastLine + '\n' + trailingMatch[0];
    }
    return trailingMatch[0];
  }

  // If fits, return as-is
  if (text.length <= maxLength) {
    return text;
  }

  // Smart truncation
  const truncated = text.slice(0, maxLength);

  // Check if inside code block
  const openBlocks = (truncated.match(/```/g) || []).length;
  if (openBlocks % 2 !== 0) {
    const lastBlockStart = truncated.lastIndexOf('```');
    if (lastBlockStart > maxLength * 0.3) {
      return truncated.slice(0, lastBlockStart).trim() + '\n\n[Code truncated...]';
    }
  }

  // Find good break point
  const breaks = [
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('.\n'),
    truncated.lastIndexOf('\n\n'),
  ];
  const lastBreak = Math.max(...breaks);

  if (lastBreak > maxLength * 0.5) {
    return truncated.slice(0, lastBreak + 1).trim() + '...';
  }

  return truncated.trim() + '...';
}
```

### 4.4 hooks/session-start.ts and hooks/session-end.ts

See blueprint blprnt-M07-hooks.md TASK 4 and TASK 6. Implementation follows same pattern as stop.ts with simpler logic:
- `session-start.ts`: Call `POST /session/start`, exitAllow on success/failure
- `session-end.ts`: Call `POST /session/close`, exitAllow on success/failure

### 4.5 hooks/stop.ts

```typescript
#!/usr/bin/env node
import { readStdin, exitAllow, exitBlock } from './lib/hook-helpers';
import { createHookLogger } from './lib/hook-logger';
import { DaemonClient } from './lib/daemon-client';
import { extractSummary } from './lib/summary';

const logger = createHookLogger('stop');
const MAX_INJECTIONS = 10;

async function main() {
  const startTime = Date.now();

  try {
    const input = await readStdin();
    const { session_id, stop_hook_active, last_assistant_message } = input;

    logger.info({ event: 'HOOK_START', sessionId: session_id });

    // Loop prevention: already in stop hook cycle
    if (stop_hook_active) {
      logger.info({ event: 'HOOK_END', action: 'allow', reason: 'stop_hook_active' });
      exitAllow();
    }

    const client = new DaemonClient();

    // Check injection count (from registry)
    const session = await client.getSession(session_id);
    if (session && session.injectionCount >= MAX_INJECTIONS) {
      await client.sendMessage(session_id, 'Max task limit reached. Pausing.');
      exitAllow();
    }

    // Check for pending tasks
    const tasks = await client.getTasks(session_id);

    if (tasks.length > 0) {
      const task = tasks[0];
      await client.claimTask(session_id, task.id);

      logger.info({
        event: 'HOOK_END',
        action: 'block',
        taskId: task.id,
        duration_ms: Date.now() - startTime,
      });

      exitBlock(task.prompt);
    } else {
      // No tasks - send summary
      const summary = extractSummary(last_assistant_message || '');
      await client.sendMessage(session_id, summary);

      logger.info({
        event: 'HOOK_END',
        action: 'allow',
        reason: 'no_tasks',
        duration_ms: Date.now() - startTime,
      });

      exitAllow();
    }
  } catch (err) {
    logger.error({ event: 'HOOK_ERROR', error: err.message, stack: err.stack });
    // Fail open
    exitAllow();
  }
}

main();
```

---

## 5. Data Structures

None (hooks are stateless).

---

## 6. Test Guide

| File | Covers | Mocks | Fixtures |
|------|--------|-------|----------|
| `tests/unit/hooks/helpers.test.ts` | stdin parsing, output | - | hook-input.json |
| `tests/unit/hooks/summary.test.ts` | Summary extraction | - | messages.json |
| `tests/unit/hooks/circuit-breaker.test.ts` | Circuit breaker | - | - |

**Key Test Cases**:
```typescript
describe('stop hook', () => {
  it('exits allow when stop_hook_active=true');
  it('claims and injects task when available');
  it('sends summary when no tasks');
  it('fails open on daemon error');
});

describe('extractSummary', () => {
  it('preserves trailing code block');
  it('truncates at sentence boundary');
  it('handles empty input');
});
```

---

## 7. Integration Points

| Ref | Contract | How |
|-----|----------|-----|
| impl-contracts.md S3 | HookInput/Output | Parses/outputs JSON |

---

## 8. Parallel Notes

- Can start with stub daemon client after M-01, M-02 complete
- Replace stub after M-06 complete (see impl-master.md S5)
