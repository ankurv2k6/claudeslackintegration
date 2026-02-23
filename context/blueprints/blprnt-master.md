# Master Blueprint: Slack-Claude Code Integration

> Generated: 2026-02-23 | Source: docs/slack-integration-plan.md (97/100 score)
> Status: READY | Modules: 8 | Est. Effort: 15d

---

## S1. Executive Summary

Bidirectional Slack-Claude Code integration using a **watcher daemon + hook architecture**. Node.js/TypeScript with @slack/bolt (Socket Mode), file-locked JSON registry, and Unix socket IPC. Sessions map to Slack threads; prompts queued via daemon; results summarized back. Key decision: Stop hook fires on idle, enabling prompt injection loop. Single deployable unit targeting MVP in 2-3 weeks.

---

## S2. Core Design Principles

| # | PRINCIPLE | RULE | EXAMPLE | VIOLATION |
|---|-----------|------|---------|-----------|
| 1 | **Single Source of Truth** | Registry is authoritative for session state | Check `registry.sessions[id].status` before operations | Caching session state in memory without sync |
| 2 | **Fail-Safe Hooks** | Hooks must exit cleanly within timeout; default to `allow` on error | `try { ... } catch { exitAllow() }` | Throwing unhandled exception from hook |
| 3 | **File Lock All Writes** | Every registry/task file write uses `proper-lockfile` | `await withFileLock(path, fn)` | Direct `fs.writeFile` without lock |
| 4 | **Timing-Safe Auth** | Token comparison uses `crypto.timingSafeEqual` | Bearer token middleware | String `===` comparison |
| 5 | **Structured Logging** | All logs are JSON with `sessionId`, `requestId`, `action` | `logger.info({ action: 'TASK_CLAIMED', sessionId })` | `console.log('claimed task')` |
| 6 | **Graceful Degradation** | Slack API failures don't crash daemon; retry with backoff | 429 triggers exponential backoff | Throwing on first rate limit |
| 7 | **No Shell Injection** | Hooks in Node.js, not bash; no `exec()` with user input | TypeScript hook files | Bash hooks with `jq` parsing |

---

## S3. Tech Stack Matrix

| Layer | Chosen | Alternatives | Rationale | Risks |
|-------|--------|--------------|-----------|-------|
| **Runtime** | Node.js 20 LTS | Deno, Bun | Ecosystem maturity, @slack/bolt support | None |
| **Language** | TypeScript 5.x | JavaScript | Type safety, better IDE support | Compile step |
| **Slack SDK** | @slack/bolt 3.x + Socket Mode | Webhooks, RTM | No public URL needed, real-time events | WebSocket stability |
| **HTTP Server** | Express 4.x | Fastify, Hono | Team familiarity, middleware ecosystem | Performance (acceptable) |
| **Validation** | Zod | Joi, Yup | TypeScript inference, composable | None |
| **Logging** | Pino | Winston, Bunyan | Fast, JSON-native, redaction support | None |
| **File Locking** | proper-lockfile | flock, lockfile | Cross-platform, stale lock detection | POSIX dependency |
| **Testing** | Vitest | Jest | Fast, ESM-native, coverage built-in | None |
| **IPC** | Unix Socket | TCP, Named Pipe | Secure (0600), no network exposure | macOS/Linux only |

---

## S4. System Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Slack App     │◄───►│  Watcher Daemon  │◄───►│  Claude Code    │
│  (Bolt SDK)     │     │   (Node.js)      │     │   (Hooks)       │
└────────┬────────┘     └────────┬─────────┘     └────────┬────────┘
         │ Socket Mode           │ Unix Socket             │ stdin/stdout
         │ (TLS)                 │ (0600 perms)            │ JSON
         ▼                       ▼                         ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ #claude-sessions│     │ Session Registry │     │ Task Files      │
│   (Channel)     │     │  registry.json   │     │ tasks/{id}.json │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

**Data Flow**: Slack message → Bolt handler → Task file (locked write) → Stop hook polls → Claim task → Inject prompt → Claude executes → Stop hook → Summary to Slack

---

## S5. Module Index

| M-ID | Module | Responsibility | Priority | Effort | Deps | Plan File |
|------|--------|----------------|----------|--------|------|-----------|
| M-01 | Config | Env validation, Zod schemas, constants | P0 | 1d | - | blprnt-M01-config.md |
| M-02 | Logger | Pino setup, redaction, correlation | P0 | 1d | M-01 | blprnt-M02-logger.md |
| M-03 | Registry | Session CRUD, state machine, locking | P0 | 2d | M-01, M-02 | blprnt-M03-registry.md |
| M-04 | TaskQueue | Task lifecycle, claiming, TTL | P0 | 2d | M-01, M-02, M-03 | blprnt-M04-taskqueue.md |
| M-05 | SlackClient | Bolt SDK, message handling, retry | P1 | 2d | M-01, M-02, M-03, M-04 | blprnt-M05-slackclient.md |
| M-06 | HttpServer | Express, auth, validation, endpoints | P1 | 2d | M-01-M05 | blprnt-M06-httpserver.md |
| M-07 | Hooks | session-start, stop, session-end | P1 | 3d | M-01, M-02 | blprnt-M07-hooks.md |
| M-08 | Recovery | Crash recovery, backup, monitoring | P2 | 2d | M-01-M04 | blprnt-M08-recovery.md |

---

## S6. Implementation Order

### S6A. Layered Diagram

```
Layer 0 (Foundation):  M-01 Config  →  M-02 Logger
                           ↓              ↓
Layer 1 (Core):        M-03 Registry  ←→  M-04 TaskQueue
                           ↓              ↓
Layer 2 (Integration): M-05 SlackClient → M-06 HttpServer
                                ↓              ↓
Layer 3 (Extension):        M-07 Hooks  ←  M-08 Recovery
```

### S6B. Dependency Matrix

| Module | M-01 | M-02 | M-03 | M-04 | M-05 | M-06 | M-07 | M-08 |
|--------|------|------|------|------|------|------|------|------|
| M-01 | - | | | | | | | |
| M-02 | X | - | | | | | | |
| M-03 | X | X | - | | | | | |
| M-04 | X | X | X | - | | | | |
| M-05 | X | X | X | X | - | | | |
| M-06 | X | X | X | X | X | - | | |
| M-07 | X | X | | | | | - | |
| M-08 | X | X | X | X | | | | - |

### S6C. Phase Table

| Phase | Modules | Parallel? | Duration | Gate |
|-------|---------|-----------|----------|------|
| Phase 1 | M-01, M-02 | Yes | 1d | Config loads, logger outputs |
| Phase 2 | M-03, M-04 | Yes | 2d | Registry CRUD, task claim works |
| Phase 3 | M-05, M-06 | Yes | 2d | Slack connects, HTTP responds |
| Phase 4 | M-07 | No | 3d | Hooks inject prompts |
| Phase 5 | M-08 | No | 2d | Recovery tested |

---

## S7. Shared Contracts Registry

| Contract | Defined In | Stability | Producer | Consumers | Shape |
|----------|------------|-----------|----------|-----------|-------|
| `SessionEntry` | impl-contracts.md S1 | LOCKED | M-03 | M-04, M-05, M-06, M-07 | Interface |
| `Task` | impl-contracts.md S2 | LOCKED | M-04 | M-05, M-06, M-07 | Interface |
| `HookInput` | impl-contracts.md S3 | LOCKED | Claude Code | M-07 | Interface |
| `HookOutput` | impl-contracts.md S3 | LOCKED | M-07 | Claude Code | Interface |
| `SessionStartRequest` | impl-contracts.md S4 | LOCKED | M-07 | M-06 | Zod |
| `SessionMessageRequest` | impl-contracts.md S4 | LOCKED | M-05 | M-06 | Zod |
| `TaskClaimRequest` | impl-contracts.md S4 | LOCKED | M-07 | M-06 | Zod |
| `LogEntry` | impl-contracts.md S5 | DRAFT | M-02 | All | Interface |
| `ConfigSchema` | impl-contracts.md S6 | LOCKED | M-01 | All | Zod |

---

## S8. Parallel Implementation Plan

| Workstream | Tasks | Blocked By | Produces | Merge Point |
|------------|-------|------------|----------|-------------|
| **WS-A: Foundation** | M-01, M-02 | - | Config, Logger exports | Phase 1 complete |
| **WS-B: Core Data** | M-03, M-04 | WS-A | Registry, TaskQueue exports | Phase 2 complete |
| **WS-C: Slack** | M-05 | WS-B | SlackClient export | Phase 3 merge |
| **WS-D: HTTP** | M-06 | WS-B | HttpServer export | Phase 3 merge |
| **WS-E: Hooks** | M-07 | WS-A (partial) | Hook executables | Phase 4 complete |
| **WS-F: Hardening** | M-08 | WS-B | Recovery functions | Phase 5 complete |

**Stub Strategy**: M-07 (Hooks) can start with stubbed daemon-client after WS-A; replace with real client after WS-D.

---

## S9. Critical Path

```
M-01 → M-02 → M-03 → M-04 → M-05 → M-06 → M-07 (Stop hook)
```

| Bottleneck | Impact | Mitigation | Non-Critical Float |
|------------|--------|------------|-------------------|
| M-03 Registry | Blocks M-04, M-05, M-06 | Prioritize, no scope creep | M-08 has 2d float |
| M-07 Stop hook | Core functionality | Start stdin contract early | - |
| Slack API unknowns | Rate limits, Socket Mode quirks | Mock early, test with real Slack daily | - |

---

## S10. Milestone Plan

| Week | Goal | Modules | Deliverables | Done When |
|------|------|---------|--------------|-----------|
| W1 | Foundation + Core | M-01, M-02, M-03, M-04 | Config, Logger, Registry, TaskQueue | Unit tests pass, 90% coverage |
| W2 | Integration | M-05, M-06, M-07 | Slack connects, HTTP endpoints, hooks compile | Manual Slack test succeeds |
| W3 | Hardening | M-08, E2E tests | Recovery, full E2E suite | All tests green, 90% total coverage |

---

## S11. Risks

| # | Risk | Severity | Probability | Impact | Mitigation | Trigger |
|---|------|----------|-------------|--------|------------|---------|
| R1 | Stop hook fires only on exit, not idle | HIGH | Low | Architecture broken | Verify hook semantics first; have PreToolUse fallback | Hook test fails |
| R2 | Socket Mode disconnects frequently | MEDIUM | Medium | Missed messages | Built-in reconnect; queue persistence | >3 disconnects/hour |
| R3 | File lock contention under load | MEDIUM | Low | Slow task claims | Lock timeout tuning; benchmarks | P95 > 500ms |
| R4 | Slack rate limits (429) | LOW | Medium | Delayed summaries | Exponential backoff; queue | >10 429s/hour |
| R5 | Claude Code hook contract changes | LOW | Low | Hooks fail | Version check; defensive parsing | Parse error rate >5% |

---

## S12. Post-MVP

| Category | Item | Trigger Condition |
|----------|------|-------------------|
| **Scaling** | Redis-backed registry | >100 concurrent sessions |
| **Scaling** | Separate task worker process | CPU >80% on daemon |
| **Features** | Multi-channel support | User request |
| **Features** | Block Kit rich messages | User request |
| **Out-of-Scope** | Web dashboard | Not planned |
| **Rejected** | Postgres for registry | Overkill for file-based MVP |
| **Rejected** | gRPC for IPC | HTTP simpler, adequate perf |

---

## S13. Regression Matrix

| Policy | Suite | Frequency | Owner |
|--------|-------|-----------|-------|
| Pre-commit | Unit tests (vitest) | Every commit | Developer |
| Pre-push | Unit + Integration | Every push | CI |
| Nightly | E2E + Load tests | Daily | CI |

### Cumulative Test Suite

| Phase | Tests Added | Total | Cross-Package Risks |
|-------|-------------|-------|---------------------|
| Phase 1 | Config, Logger unit | 20 | None |
| Phase 2 | Registry, TaskQueue unit | 60 | Lock contention |
| Phase 3 | Slack, HTTP integration | 100 | Auth + routing |
| Phase 4 | Hook E2E | 120 | stdin contract |
| Phase 5 | Recovery, chaos | 140 | State corruption |

---

## Cross-References

- Implementation Contracts: [impl-contracts.md](../implementation/impl-contracts.md)
- Implementation Master: [impl-master.md](../implementation/impl-master.md)
- Source Plan: [docs/slack-integration-plan.md](../../docs/slack-integration-plan.md)
