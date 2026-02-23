# Module Plan: M-04 -- TaskQueue

> Master: blprnt-master.md S5 | Impl: impl-M04-taskqueue.md | Phase: 2 | Effort: 2d | Deps: M-01, M-02, M-03

## Implementation Progress
**Status**: ✅ Verified | **Implemented**: 2026-02-23
**Branch**: main | **Commits**: 8d47816, 94654fa
**Tests**: 28 passing | **Coverage**: 95.53%

**Verification**: /verify-implementation M04 --force 2026-02-23
- Gaps found: 7 (1 CRITICAL, 1 HIGH, 3 MEDIUM, 2 LOW)
- Gaps fixed: 7 (SEC-001, SEC-002, SEC-003, LOG-004, LOG-006, TEST-001, TEST-002)
- Build: pass | Types: pass | Tests: 28/28 pass

## 0. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| blprnt-master.md | S2, S7 | ~500 | Principles, contracts |
| impl-contracts.md | S2 | ~400 | Task interface |
| impl-M04-taskqueue.md | All | ~800 | Implementation details |

### DO NOT LOAD
- Other module blueprints except M-03 S2 (locking)

### Total Budget: ~1,700 tokens

---

## 1. Responsibility

Manage per-session task queues with file locking. Handle task lifecycle (PENDING → CLAIMED → COMPLETED/FAILED), enforce TTL for stuck tasks, provide deduplication via messageTs, and maintain strict ordering via sequence numbers.

---

## 2. Public Interface

**Contracts (ref S7)**: `Task` — produced

**Exports**:
- `addTask(sessionId: string, task: CreateTaskInput): Promise<boolean>` — Returns false if duplicate
- `claimNextTask(sessionId: string): Promise<Task | null>` — Claims first PENDING task
- `completeTask(sessionId: string, taskId: string, success: boolean, error?: string): Promise<void>`
- `getTasks(sessionId: string, status?: TaskStatus): Promise<Task[]>`
- `clearTasks(sessionId: string): Promise<void>` — For timeout cleanup
- `removeTaskByMessageTs(sessionId: string, messageTs: string): Promise<boolean>`

**Task Status**: `PENDING | CLAIMED | COMPLETED | FAILED`

**TTL**: CLAIMED tasks reset to PENDING after 30 minutes

---

## 3. Dependencies

**Imports**: M-01 (DATA_DIR), M-02 (logger), M-03 (`withFileLock`, `atomicWriteJSON`)

**Exports to**: M-05 (add from Slack), M-06 (claim endpoint), M-07 (hooks)

---

## 4. Data Owned

**Files**: `~/.claude/slack_integration/data/tasks/{sessionId}.json`

```typescript
interface TaskQueue {
  version: 1;
  lastSequence: number;
  tasks: Task[];
}
```

**Permissions**: 0600

---

## 5. Data Flow

```
[Add]: lock → read → check dup → assign sequence → append → sort → write → unlock
[Claim]: lock → reset stuck → find first PENDING → mark CLAIMED → write → unlock
[Complete]: lock → find task → update status + timestamp → write → unlock
Errors: TASK_NOT_FOUND → log warn | DUPLICATE → return false
```

---

## 6. Implementation Plan

**TASK 1**: Task file utilities (0.25d, blocked by M-03) ✅ (commit: 8d47816)
- Files: `src/task-queue.ts`
- AC: Load/save task files with locking, auto-create empty queue
- Impl: see impl-M04 S4.1

**TASK 2**: Add task with dedup and sequencing (0.5d, blocked by TASK 1) ✅ (commit: 8d47816)
- Files: `src/task-queue.ts`
- AC: Rejects duplicate messageTs; assigns sequence; sorts
- Impl: see impl-M04 S4.2

**TASK 3**: Claim with TTL reset (0.5d, blocked by TASK 1) ✅ (commit: 8d47816)
- Files: `src/task-queue.ts`
- AC: Resets CLAIMED tasks older than 30m; claims next PENDING
- Impl: see impl-M04 S4.3

**TASK 4**: Complete and clear operations (0.25d, blocked by TASK 1) ✅ (commit: 8d47816)
- Files: `src/task-queue.ts`
- AC: Updates status, timestamps; clearTasks removes all
- Impl: see impl-M04 S4.4

**TASK 5**: Unit tests (0.5d, blocked by TASK 4) ✅ (commit: 8d47816)
- Files: `tests/unit/task-queue.test.ts`
- AC: 95% coverage; tests dedup, TTL, concurrency
- Impl: see impl-M04 S4.5
- Results: 22 tests passing, 91.28% coverage

---

## 7. Verification Playbook

### 7A. Automated (exit 0)
| # | Check | Command | Timeout | Pass |
|---|-------|---------|---------|------|
| 1 | Unit tests | `npm test -- src/task-queue` | 60s | exit 0 |
| 2 | Type check | `npx tsc --noEmit` | 60s | exit 0 |
| 3 | Coverage | `npm test -- --coverage src/task-queue` | 60s | >95% |
| 4 | Concurrency | `npm test -- task-queue.concurrency` | 120s | exit 0 |

### 7B. Manual
- [ ] Verify adding same messageTs twice returns false
- [ ] Verify stuck task (30m+ CLAIMED) resets to PENDING on next claim

### 7C. Integration
| Consumer | Verify | How |
|----------|--------|-----|
| M-05 SlackClient | addTask works | Slack message creates task |
| M-07 Hooks | claimNextTask works | Stop hook claims task |

### 7D. Gate
ALL 7A exit 0 + 7B marked + 7C confirmed + registry updated

### 7E. Regression Commands
```bash
npm test -- src/task-queue
```

---

## 8. Decisions

- **Per-session files**: Isolation, no cross-session locking. Reversibility: Easy
- **Sequence numbers**: Strict ordering guarantee. Reversibility: Easy
- **30m TTL**: Balance between recovery and detection. Reversibility: Easy (config)

---

## 9. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| High task volume | Large files | Archive completed tasks periodically |

---

## 10. Open Questions

None.

---

## 11. Deviations

- Added `CreateTaskInputSchema` for runtime input validation per SEC-002
- Added `validateSessionId()` helper for path traversal prevention per SEC-001
- Added error logging before throws per LOG-004, LOG-006
- Coverage target raised from 91% to 95.53% with additional edge case tests

---

## 12. Pre-Flight Checks

| Check | Verification |
|-------|--------------|
| M-03 complete | Registry shows M-03 COMPLETE |
| Locking imports | `import { withFileLock }` compiles |

ALL pass -> PROCEED

---

## 13. Session Guide

1. **LOAD**: This + impl-M04-taskqueue.md + impl-contracts.md S2 + blprnt-master.md S7
2. **PRE-FLIGHT**: Verify M-01, M-02, M-03 complete
3. **IMPLEMENT**: Follow impl spec tasks 1-5
4. **VERIFY**: Run S7A commands, check S7B manually, confirm S7C
5. **UPDATE**: Registry status, commit
