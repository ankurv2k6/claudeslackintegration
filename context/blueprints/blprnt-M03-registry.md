# Module Plan: M-03 -- Registry

> Master: blprnt-master.md S5 | Impl: impl-M03-registry.md | Phase: 2 | Effort: 2d | Deps: M-01, M-02

## 0. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| blprnt-master.md | S2, S7 | ~500 | Principles, contracts |
| impl-contracts.md | S1 | ~400 | SessionEntry interface |
| impl-M03-registry.md | All | ~800 | Implementation details |

### DO NOT LOAD
- Other module blueprints, full master, M-04+ blueprints

### Total Budget: ~1,700 tokens

---

## 1. Responsibility

Manage session lifecycle with file-locked JSON storage. Enforce state machine transitions, provide CRUD operations, maintain thread-to-session reverse lookup, and handle stale session cleanup.

---

## 2. Public Interface

**Contracts (ref S7)**: `SessionEntry` — produced

**Exports**:
- `createSession(entry: CreateSessionInput): Promise<SessionEntry>`
- `getSession(sessionId: string): Promise<SessionEntry | null>`
- `updateSession(sessionId: string, updates: Partial<SessionEntry>): Promise<SessionEntry>`
- `updateStatus(sessionId: string, status: SessionStatus): Promise<void>`
- `removeSession(sessionId: string): Promise<void>`
- `getSessionByThread(threadTs: string): Promise<SessionEntry | null>`
- `cleanupStaleSessions(maxAgeMs: number): Promise<number>`
- `withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T>`
- `atomicWriteJSON(path: string, data: object): Promise<void>`

**State Machine**:
```
PENDING → ACTIVE → CLOSING → CLOSED
    ↓        ↓
  ERROR ← ───┘
```

Valid transitions enforced; invalid throws `INVALID_STATE_TRANSITION`.

---

## 3. Dependencies

**Imports**: M-01 (DATA_DIR), M-02 (logger), `proper-lockfile`, `crypto`

**Exports to**: M-04 (session lookup), M-05 (thread routing), M-06 (endpoints), M-07 (hooks)

---

## 4. Data Owned

**File**: `~/.claude/slack_integration/data/registry.json`

```typescript
interface Registry {
  version: 1;
  sessions: Record<string, SessionEntry>;
  threadToSession: Record<string, string>;
}
```

**Permissions**: 0600 (owner read/write only)

---

## 5. Data Flow

```
[Create]: validate → lock file → read → add session → atomic write → unlock
[Update]: lock → read → validate transition → update → atomic write → unlock
[Cleanup]: lock → filter stale → notify Slack → remove → atomic write → unlock
Errors: LOCK_TIMEOUT → retry 5x | CORRUPT_JSON → restore from backup
```

---

## 6. Implementation Plan

**TASK 1**: File locking utilities (0.5d, blocked by M-01)
- Files: `src/registry.ts`
- AC: `withFileLock` retries 5x, detects stale locks (10s)
- Impl: see impl-M03 S4.1

**TASK 2**: Atomic write with crypto temp names (0.25d, blocked by TASK 1)
- Files: `src/registry.ts`
- AC: Uses `crypto.randomUUID()` for temp files; 0600 perms
- Impl: see impl-M03 S4.2

**TASK 3**: CRUD operations (0.5d, blocked by TASK 2)
- Files: `src/registry.ts`
- AC: All CRUD functions use locking; maintain threadToSession index
- Impl: see impl-M03 S4.3

**TASK 4**: State machine validation (0.25d, blocked by TASK 3)
- Files: `src/registry.ts`
- AC: Invalid transitions throw; valid transitions logged
- Impl: see impl-M03 S4.4

**TASK 5**: Stale cleanup (0.25d, blocked by TASK 3)
- Files: `src/registry.ts`
- AC: Removes sessions inactive > maxAgeMs; returns count
- Impl: see impl-M03 S4.5

**TASK 6**: Unit tests (0.25d, blocked by TASK 5)
- Files: `tests/unit/registry.test.ts`
- AC: 95% coverage; tests locking, state machine, cleanup
- Impl: see impl-M03 S4.6

---

## 7. Verification Playbook

### 7A. Automated (exit 0)
| # | Check | Command | Timeout | Pass |
|---|-------|---------|---------|------|
| 1 | Unit tests | `npm test -- src/registry` | 60s | exit 0 |
| 2 | Type check | `npx tsc --noEmit` | 60s | exit 0 |
| 3 | Coverage | `npm test -- --coverage src/registry` | 60s | >95% |
| 4 | Concurrency | `npm test -- registry.concurrency` | 120s | exit 0 |

### 7B. Manual
- [ ] Verify registry.json has 0600 permissions after write
- [ ] Verify PENDING→CLOSED throws INVALID_STATE_TRANSITION

### 7C. Integration
| Consumer | Verify | How |
|----------|--------|-----|
| M-04 TaskQueue | Session lookup | Task claim finds session |
| M-05 SlackClient | Thread routing | getSessionByThread returns correct session |

### 7D. Gate
ALL 7A exit 0 + 7B marked + 7C confirmed + registry updated

### 7E. Regression Commands
```bash
npm test -- src/registry
ls -la ~/.claude/slack_integration/data/registry.json | grep "rw-------"
```

---

## 8. Decisions

- **proper-lockfile**: Cross-platform, stale detection built-in. Reversibility: Medium
- **Single JSON file**: Simple, atomic rename. Reversibility: Easy (migrate to DB later)
- **Embedded index**: threadToSession in same file for atomicity. Reversibility: Easy

---

## 9. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Lock contention | Slow operations | Tune retry timing; benchmark |
| File corruption | Data loss | Backup before write |

---

## 10. Open Questions

None.

---

## 11. Deviations

(Empty at generation)

---

## 12. Pre-Flight Checks

| Check | Verification |
|-------|--------------|
| M-01 complete | Registry shows M-01 COMPLETE |
| M-02 complete | Registry shows M-02 COMPLETE |
| proper-lockfile | `npm ls proper-lockfile` returns version |

ALL pass -> PROCEED

---

## 13. Session Guide

1. **LOAD**: This + impl-M03-registry.md + impl-contracts.md S1 + blprnt-master.md S7
2. **PRE-FLIGHT**: Verify M-01, M-02 complete
3. **IMPLEMENT**: Follow impl spec tasks 1-6
4. **VERIFY**: Run S7A commands, check S7B manually, confirm S7C
5. **UPDATE**: Registry status, commit
