# Module Plan: M-08 -- Recovery

> Master: blprnt-master.md S5 | Impl: impl-M08-recovery.md | Phase: 5 | Effort: 2d | Deps: M-01, M-02, M-03, M-04

## 0. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| blprnt-master.md | S2, S11 | ~500 | Principles, risks |
| impl-contracts.md | S1, S2 | ~400 | SessionEntry, Task |
| impl-M08-recovery.md | All | ~800 | Implementation details |

### DO NOT LOAD
- Other module blueprints except M-03/M-04 interfaces

### Total Budget: ~1,700 tokens

---

## 1. Responsibility

Daemon crash recovery, transaction logging, backup rotation, disk space monitoring, graceful shutdown, and session resume after restart.

---

## 2. Public Interface

**Contracts (ref S7)**: Consumes `SessionEntry`, `Task`

**Exports**:
- `recoverFromCrash(): Promise<void>` — Replay uncommitted transactions
- `resumeActiveSessions(): Promise<void>` — Verify + notify active sessions
- `rotateBackups(basePath: string): Promise<void>` — Keep last 5 backups
- `checkDiskSpace(dir: string): Promise<void>` — Warn <100MB, error <10MB
- `safeWrite(path: string, data: object): Promise<void>` — Check space + atomic write
- `initializeRecovery(): Promise<void>` — Run all recovery on startup
- `gracefulShutdown(): Promise<void>` — Notify sessions, flush logs

**Transaction Log**: `data/transactions.json`
- Operations: `CLAIM_TASK`, `COMPLETE_TASK`, `UPDATE_SESSION`
- Uncommitted transactions replayed on startup

---

## 3. Dependencies

**Imports**: M-01 (DATA_DIR), M-02 (logger), M-03 (registry, locking), M-04 (taskQueue), `fs/promises`

**Exports to**: Main daemon entry point (startup/shutdown hooks)

---

## 4. Data Owned

**Files**:
- `data/transactions.json` — In-flight operations
- `data/registry.json.backup.*` — Last 5 registry backups

---

## 5. Data Flow

```
[Startup]: recoverFromCrash → resumeActiveSessions → cleanupStaleSessions
[Pre-write]: checkDiskSpace → rotateBackups → atomicWrite
[Shutdown]: SIGTERM → notify sessions → flush logs → exit 0
Errors: LOW_DISK → warn | CRITICAL_DISK → error + abort write
```

---

## 6. Implementation Plan

**TASK 1**: Transaction log infrastructure (0.5d, blocked by M-03)
- Files: `src/recovery.ts`
- AC: Write transaction before operation; mark committed after; replay uncommitted
- Impl: see impl-M08 S4.1

**TASK 2**: Crash recovery (0.5d, blocked by TASK 1)
- Files: `src/recovery.ts`
- AC: Replays CLAIM_TASK (reset to PENDING), UPDATE_SESSION (re-apply)
- Impl: see impl-M08 S4.2

**TASK 3**: Session resume (0.25d, blocked by M-03, M-05)
- Files: `src/recovery.ts`
- AC: Verifies Slack thread exists; sends "Session resumed" or marks ERROR
- Impl: see impl-M08 S4.3

**TASK 4**: Backup rotation (0.25d, blocked by M-03)
- Files: `src/recovery.ts`
- AC: Keeps 5 timestamped backups; removes oldest
- Impl: see impl-M08 S4.4

**TASK 5**: Disk space monitoring (0.25d, blocked by -)
- Files: `src/recovery.ts`
- AC: Uses statfs; warns <100MB; errors <10MB
- Impl: see impl-M08 S4.5

**TASK 6**: Graceful shutdown (0.25d, blocked by M-02, M-05)
- Files: `src/recovery.ts`
- AC: SIGTERM handler; notifies sessions; flushes logs
- Impl: see impl-M08 S4.6

---

## 7. Verification Playbook

### 7A. Automated (exit 0)
| # | Check | Command | Timeout | Pass |
|---|-------|---------|---------|------|
| 1 | Unit tests | `npm test -- src/recovery` | 60s | exit 0 |
| 2 | Chaos tests | `npm test -- chaos/` | 180s | exit 0 |
| 3 | Type check | `npx tsc --noEmit` | 60s | exit 0 |
| 4 | Coverage | `npm test -- --coverage src/recovery` | 60s | >90% |

### 7B. Manual
- [ ] Verify crash mid-operation recovers state correctly
- [ ] Verify backup rotation keeps exactly 5 files
- [ ] Verify SIGTERM sends "shutting down" message to Slack

### 7C. Integration
| Consumer | Verify | How |
|----------|--------|-----|
| Main daemon | Recovery runs on startup | Logs show RECOVERY_COMPLETE |
| M-03 Registry | Backups created | Backup files exist after write |

### 7D. Gate
ALL 7A exit 0 + 7B marked + 7C confirmed + registry updated

### 7E. Regression Commands
```bash
npm test -- src/recovery chaos/
ls ~/.claude/slack_integration/data/registry.json.backup.* | wc -l # Should be <= 5
```

---

## 8. Decisions

- **Transaction log**: Enables recovery without DB. Reversibility: Easy
- **5 backup limit**: Balance between safety and disk usage. Reversibility: Easy (config)
- **Fail-open on low disk**: Warn but don't crash existing operations. Reversibility: Easy

---

## 9. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Transaction log grows large | Slow startup | Prune committed entries |
| statfs not available | No monitoring | Fallback to skip check |

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
| M-04 complete | Registry shows M-04 COMPLETE |
| FS access | `df ~/.claude/slack_integration` works |

ALL pass -> PROCEED

---

## 13. Session Guide

1. **LOAD**: This + impl-M08-recovery.md + impl-contracts.md S1-S2 + blprnt-master.md S11
2. **PRE-FLIGHT**: Verify M-01-M-04 complete
3. **IMPLEMENT**: Follow impl spec tasks 1-6
4. **VERIFY**: Run S7A commands, test chaos scenarios
5. **UPDATE**: Registry status, commit
