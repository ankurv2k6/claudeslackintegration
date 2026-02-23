# Module Plan: M-06 -- HttpServer

> Master: blprnt-master.md S5 | Impl: impl-M06-httpserver.md | Phase: 3 | Effort: 2d | Deps: M-01, M-02, M-03, M-04, M-05

## 0. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| blprnt-master.md | S2, S7 | ~500 | Principles, contracts |
| impl-contracts.md | S4 | ~500 | Request/response schemas |
| impl-M06-httpserver.md | All | ~1000 | Implementation details |

### DO NOT LOAD
- Other module blueprints except interfaces

### Total Budget: ~2,000 tokens

---

## 1. Responsibility

Express HTTP server with Unix socket or TCP transport, bearer token authentication, Zod validation, rate limiting (global + per-session), and all daemon API endpoints.

---

## 2. Public Interface

**Contracts (ref S7)**: `SessionStartRequest`, `SessionMessageRequest`, `TaskClaimRequest` — consumed

**Endpoints**:
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/metrics` | No | Prometheus metrics |
| POST | `/session/start` | Bearer | Create session + thread |
| POST | `/session/message` | Bearer | Post to thread |
| POST | `/session/close` | Bearer | Close session |
| POST | `/session/:id/tasks/claim` | Bearer | Claim next task |
| GET | `/session/:id/status` | Bearer | Get session status |

**Middleware Stack**:
1. Helmet (security headers)
2. Rate limit (100 req/min global, 30 req/min per-session)
3. Host header validation (localhost only)
4. JSON body parser (100kb limit)
5. Bearer token auth (timing-safe)
6. Zod validation per route
7. Error handler (structured errors)

---

## 3. Dependencies

**Imports**: M-01 (DAEMON_SECRET, transport), M-02 (logger), M-03 (registry), M-04 (taskQueue), M-05 (sendSlackMessage), `express`, `helmet`, `express-rate-limit`

**Exports to**: M-07 (hooks call these endpoints)

---

## 4. Data Owned

**Unix Socket**: `~/.claude/slack_integration/daemon.sock` (0600 permissions)

---

## 5. Data Flow

```
[Request]: socket → middleware stack → route handler → response
[/session/start]: validate → create session → create Slack thread → respond
[/tasks/claim]: validate → claimNextTask → respond with task or null
Errors: AUTH_FAILED → 401 | VALIDATION_FAILED → 400 | NOT_FOUND → 404
```

---

## 6. Implementation Plan

**TASK 1**: Server setup with transport selection (0.5d, blocked by M-01)
- Files: `src/http-server.ts`
- AC: Unix socket (default) or TCP; stale socket cleanup; 0600 perms
- Impl: see impl-M06 S4.1

**TASK 2**: Security middleware (0.5d, blocked by TASK 1)
- Files: `src/middleware/auth.ts`, `src/middleware/validation.ts`
- AC: Timing-safe auth; host validation; rate limits
- Impl: see impl-M06 S4.2

**TASK 3**: Session endpoints (0.5d, blocked by M-03, M-05)
- Files: `src/http-server.ts`
- AC: /session/start creates thread; /session/close cleans up
- Impl: see impl-M06 S4.3

**TASK 4**: Task claim endpoint (0.25d, blocked by M-04)
- Files: `src/http-server.ts`
- AC: POST /session/:id/tasks/claim returns task or null
- Impl: see impl-M06 S4.4

**TASK 5**: Unit and integration tests (0.25d, blocked by TASK 4)
- Files: `tests/unit/http-server.test.ts`, `tests/integration/http-server.test.ts`
- AC: 90% coverage; auth tests; validation tests
- Impl: see impl-M06 S4.5

---

## 7. Verification Playbook

### 7A. Automated (exit 0)
| # | Check | Command | Timeout | Pass |
|---|-------|---------|---------|------|
| 1 | Unit tests | `npm test -- src/http-server` | 60s | exit 0 |
| 2 | Integration | `npm test -- integration/http` | 120s | exit 0 |
| 3 | Security tests | `npm test -- security/` | 60s | exit 0 |
| 4 | Type check | `npx tsc --noEmit` | 60s | exit 0 |
| 5 | Coverage | `npm test -- --coverage src/http-server` | 60s | >90% |

### 7B. Manual
- [ ] Verify Unix socket has 0600 permissions
- [ ] Verify request without Bearer token returns 401
- [ ] Verify timing attack test shows <20% variance

### 7C. Integration
| Consumer | Verify | How |
|----------|--------|-----|
| M-07 Hooks | Hooks can call endpoints | session-start hook creates session |

### 7D. Gate
ALL 7A exit 0 + 7B marked + 7C confirmed + registry updated

### 7E. Regression Commands
```bash
npm test -- src/http-server integration/http security/
ls -la ~/.claude/slack_integration/daemon.sock | grep "srw-------"
```

---

## 8. Decisions

- **Unix socket default**: No network exposure; secure by default. Reversibility: Easy
- **POST for claim**: Idempotent-ish; side effects justify POST. Reversibility: Easy
- **Per-session rate limit**: Prevent one session DoS-ing others. Reversibility: Easy

---

## 9. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Socket permissions wrong | Security hole | Verify in tests; log on startup |

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
| M-05 complete | Registry shows M-05 COMPLETE |
| Express installed | `npm ls express` returns version |

ALL pass -> PROCEED

---

## 13. Session Guide

1. **LOAD**: This + impl-M06-httpserver.md + impl-contracts.md S4 + blprnt-master.md S7
2. **PRE-FLIGHT**: Verify M-01-M-05 complete
3. **IMPLEMENT**: Follow impl spec tasks 1-5
4. **VERIFY**: Run S7A commands, check S7B manually
5. **UPDATE**: Registry status, commit
