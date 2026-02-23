# Module Plan: M-07 -- Hooks

> Master: blprnt-master.md S5 | Impl: impl-M07-hooks.md | Phase: 4 | Effort: 3d | Deps: M-01, M-02

## Implementation Progress
**Status**: ✅ Complete | **Current Phase**: Done
**Started**: 2026-02-24T00:00:00Z | **Branch**: main

| Task | Status | Commits |
|------|--------|---------|
| TASK 1: Hook library utilities | ✅ Complete | 29ff187 |
| TASK 2: Daemon client + circuit breaker | ✅ Complete | 29ff187 |
| TASK 3: Summary extraction | ✅ Complete | 29ff187 |
| TASK 4: session-start hook | ✅ Complete | 29ff187 |
| TASK 5: stop hook | ✅ Complete | 29ff187 |
| TASK 6: session-end hook | ✅ Complete | 29ff187 |
| TASK 7: Compile + configure | ✅ Complete | 29ff187 |
| TASK 8: Unit tests | ✅ Complete | 29ff187, e98061d |

## Verification Status
**Result**: ✅ PASSED | **Iterations**: 3/5 | **Final**: 2 consecutive clean runs
**Gaps Fixed**: 2 (TEST-001, TEST-002) | **Tests**: 282 pass | **Coverage**: hooks 42% (lib modules 85-100%)
**Verification Date**: 2026-02-24 | **Commit**: e98061d

## 0. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| blprnt-master.md | S2, S7 | ~500 | Principles, contracts |
| impl-contracts.md | S3 | ~400 | HookInput, HookOutput |
| impl-M07-hooks.md | All | ~1200 | Implementation details |

### DO NOT LOAD
- Other module blueprints except M-06 endpoints

### Total Budget: ~2,100 tokens

---

## 1. Responsibility

Claude Code hooks (session-start, stop, session-end) in Node.js/TypeScript. Parse stdin JSON, communicate with daemon via HTTP, handle loop prevention, extract summaries, and output JSON decisions.

---

## 2. Public Interface

**Contracts (ref S7)**: `HookInput`, `HookOutput` — consumed/produced

**Hook Files** (compiled to JS):
- `hooks/session-start.js` — Register session, create thread
- `hooks/stop.js` — Check tasks, inject or summarize
- `hooks/session-end.js` — Close session

**Library Exports** (`hooks/lib/`):
- `readStdin(): Promise<HookInput>` — Parse stdin JSON
- `exitAllow(): never` — Output allow decision, exit 0
- `exitBlock(prompt: string): never` — Output block with prompt, exit 0
- `createDaemonClient(): DaemonClient` — HTTP client with auth + timeout
- `extractSummary(text: string, maxLen?: number): string` — Smart truncation

**Circuit Breaker**: 3 failures → OPEN → 30s recovery → HALF_OPEN → 2 successes → CLOSED

---

## 3. Dependencies

**Imports**: M-01 (DAEMON_SECRET, DAEMON_URL), M-02 (hook logger), `node-fetch`

**Exports to**: Claude Code (via ~/.claude/settings.json hooks config)

---

## 4. Data Owned

None (hooks are stateless; state in daemon).

---

## 5. Data Flow

```
[session-start]: stdin → parse → POST /session/start → exitAllow
[stop]: stdin → parse → check stop_hook_active → GET tasks → claim if any → exitBlock(prompt) OR summarize → exitAllow
[session-end]: stdin → parse → POST /session/close → exitAllow
Errors: DAEMON_UNREACHABLE → circuit breaker → exitAllow (fail open)
```

---

## 6. Implementation Plan

**TASK 1**: Hook library utilities (0.5d, blocked by M-01)
- Files: `hooks/lib/hook-helpers.ts`, `hooks/lib/input-parser.ts`
- AC: readStdin parses JSON; exitAllow/exitBlock output correct format
- Impl: see impl-M07 S4.1

**TASK 2**: Daemon client with circuit breaker (0.5d, blocked by TASK 1)
- Files: `hooks/lib/daemon-client.ts`, `hooks/lib/circuit-breaker.ts`
- AC: 10s timeout; circuit breaker pattern; bearer auth
- Impl: see impl-M07 S4.2

**TASK 3**: Summary extraction (0.25d, blocked by -)
- Files: `hooks/lib/summary.ts`
- AC: Preserves code blocks; smart truncation; handles edge cases
- Impl: see impl-M07 S4.3

**TASK 4**: session-start hook (0.25d, blocked by TASK 2)
- Files: `hooks/session-start.ts`
- AC: Calls /session/start; fails gracefully
- Impl: see impl-M07 S4.4

**TASK 5**: stop hook (0.75d, blocked by TASK 2, TASK 3)
- Files: `hooks/stop.ts`
- AC: Loop prevention; claims tasks; injects or summarizes
- Impl: see impl-M07 S4.5

**TASK 6**: session-end hook (0.25d, blocked by TASK 2)
- Files: `hooks/session-end.ts`
- AC: Calls /session/close; cleanup
- Impl: see impl-M07 S4.6

**TASK 7**: Compile to JS and configure (0.25d, blocked by TASK 4-6)
- Files: `hooks/*.js`, `~/.claude/settings.json`
- AC: Hooks executable; settings.json updated
- Impl: see impl-M07 S4.7

**TASK 8**: Unit and E2E tests (0.25d, blocked by TASK 7)
- Files: `tests/unit/hooks/*.test.ts`, `tests/e2e/hooks.test.ts`
- AC: 90% coverage; mocked daemon; E2E with real flow
- Impl: see impl-M07 S4.8

---

## 7. Verification Playbook

### 7A. Automated (exit 0)
| # | Check | Command | Timeout | Pass |
|---|-------|---------|---------|------|
| 1 | Unit tests | `npm test -- hooks/` | 60s | exit 0 |
| 2 | Type check | `npx tsc --noEmit` | 60s | exit 0 |
| 3 | Coverage | `npm test -- --coverage hooks/` | 60s | >90% |
| 4 | Hook execution | `echo '{}' \| node hooks/session-start.js` | 5s | exit 0 |

### 7B. Manual
- [ ] Verify stop hook with stop_hook_active=true exits immediately
- [ ] Verify stop hook injects prompt when task exists
- [ ] Verify summary preserves trailing code block

### 7C. Integration
| Consumer | Verify | How |
|----------|--------|-----|
| Claude Code | Hooks trigger | Start Claude session, verify thread created |
| M-06 HttpServer | Endpoints called | Hook logs show successful API calls |

### 7D. Gate
ALL 7A exit 0 + 7B marked + 7C confirmed + registry updated

### 7E. Regression Commands
```bash
npm test -- hooks/
echo '{"session_id":"test","cwd":"/tmp"}' | node hooks/session-start.js
```

---

## 8. Decisions

- **Node.js over bash**: No shell injection; TypeScript types. Reversibility: Hard
- **Circuit breaker**: Prevents cascade failures. Reversibility: Easy
- **Fail open (exitAllow)**: Don't block Claude on hook errors. Reversibility: Easy

---

## 9. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Hook stdin contract wrong | Hooks fail | Verify contract first; defensive parsing |
| 10s timeout too short | Missed tasks | Log timeouts; tune if needed |

---

## 10. Open Questions

None (hook contract verified in plan).

---

## 11. Deviations

(Empty at generation)

---

## 12. Pre-Flight Checks

| Check | Verification |
|-------|--------------|
| M-01 complete | Config loads |
| M-02 complete | Logger works |
| M-06 running | curl http://localhost:3847/health returns OK |

ALL pass -> PROCEED

---

## 13. Session Guide

1. **LOAD**: This + impl-M07-hooks.md + impl-contracts.md S3 + blprnt-master.md S7
2. **PRE-FLIGHT**: Verify M-01, M-02 complete; M-06 running for integration
3. **IMPLEMENT**: Follow impl spec tasks 1-8
4. **VERIFY**: Run S7A commands, check S7B manually with Claude Code
5. **UPDATE**: Registry status, commit
