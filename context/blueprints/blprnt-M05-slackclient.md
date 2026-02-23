# Module Plan: M-05 -- SlackClient

> Master: blprnt-master.md S5 | Impl: impl-M05-slackclient.md | Phase: 3 | Effort: 2d | Deps: M-01, M-02, M-03, M-04

## 0. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| blprnt-master.md | S2, S7 | ~500 | Principles, contracts |
| impl-contracts.md | S1, S2 | ~600 | SessionEntry, Task |
| impl-M05-slackclient.md | All | ~900 | Implementation details |

### DO NOT LOAD
- Other module blueprints except M-03/M-04 interfaces

### Total Budget: ~2,000 tokens

---

## 1. Responsibility

Initialize @slack/bolt with Socket Mode, handle incoming thread messages, route to correct session task queue, send chunked messages with retry logic, and handle message edits/deletes.

---

## 2. Public Interface

**Contracts (ref S7)**: Consumes `SessionEntry`, `Task`

**Exports**:
- `createSlackClient(): Promise<App>` — Initialize Bolt app with Socket Mode
- `startSlackClient(app: App): Promise<void>` — Start Socket Mode connection
- `stopSlackClient(app: App): Promise<void>` — Graceful shutdown
- `sendSlackMessage(sessionId: string, text: string): Promise<void>` — Send with retry
- `sendSlackReaction(sessionId: string, messageTs: string, emoji: string): Promise<void>`

**Events Handled**:
- `message` — Thread replies → addTask
- `message_changed` — Log only
- `message_deleted` — removeTaskByMessageTs

**Rate Limiting**: Internal queue, 1 msg/sec, exponential backoff on 429

---

## 3. Dependencies

**Imports**: M-01 (tokens, channel), M-02 (logger), M-03 (registry), M-04 (taskQueue), `@slack/bolt`

**Exports to**: M-06 (message sending), M-08 (reconnection state)

---

## 4. Data Owned

None (stateless; state in registry/taskQueue).

---

## 5. Data Flow

```
[Inbound]: Slack event → Bolt handler → filter bot → lookup session → addTask
[Outbound]: sendSlackMessage → chunk if >3900 → queue → retry on 429 → post
Errors: THREAD_NOT_FOUND → session to ERROR | RATE_LIMITED → backoff + retry
```

---

## 6. Implementation Plan

**TASK 1**: Initialize Bolt with Socket Mode (0.5d, blocked by M-01)
- Files: `src/slack-client.ts`
- AC: Socket Mode connects; logs connection events
- Impl: see impl-M05 S4.1

**TASK 2**: Message event handler (0.5d, blocked by M-03, M-04)
- Files: `src/slack-client.ts`
- AC: Filters bots; routes thread replies to correct session; adds tasks
- Impl: see impl-M05 S4.2

**TASK 3**: Message sending with retry (0.5d, blocked by TASK 1)
- Files: `src/slack-client.ts`
- AC: Exponential backoff (1s-30s); respects Retry-After; chunks at 3900
- Impl: see impl-M05 S4.3

**TASK 4**: Edit/delete handlers (0.25d, blocked by TASK 2)
- Files: `src/slack-client.ts`
- AC: Deletes remove task; edits logged only
- Impl: see impl-M05 S4.4

**TASK 5**: Unit and integration tests (0.25d, blocked by TASK 4)
- Files: `tests/unit/slack-client.test.ts`, `tests/integration/slack-client.test.ts`
- AC: 85% coverage; mocked Slack API
- Impl: see impl-M05 S4.5

---

## 7. Verification Playbook

### 7A. Automated (exit 0)
| # | Check | Command | Timeout | Pass |
|---|-------|---------|---------|------|
| 1 | Unit tests | `npm test -- src/slack-client` | 60s | exit 0 |
| 2 | Integration | `npm test -- integration/slack` | 120s | exit 0 |
| 3 | Type check | `npx tsc --noEmit` | 60s | exit 0 |
| 4 | Coverage | `npm test -- --coverage src/slack-client` | 60s | >85% |

### 7B. Manual
- [ ] Verify Socket Mode connects with real Slack credentials
- [ ] Verify bot messages are ignored (no infinite loop)
- [ ] Verify long message (5000 chars) is chunked into 2 messages

### 7C. Integration
| Consumer | Verify | How |
|----------|--------|-----|
| M-06 HttpServer | sendSlackMessage callable | Session start posts to thread |
| M-07 Hooks | Summary reaches Slack | Stop hook summary appears in thread |

### 7D. Gate
ALL 7A exit 0 + 7B marked + 7C confirmed + registry updated

### 7E. Regression Commands
```bash
npm test -- src/slack-client integration/slack
```

---

## 8. Decisions

- **Socket Mode over Webhooks**: No public URL required. Reversibility: Medium
- **1 msg/sec queue**: Stays under Slack rate limits. Reversibility: Easy
- **3900 char chunks**: Buffer below 4000 limit for safety. Reversibility: Easy

---

## 9. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Socket Mode disconnects | Missed messages | Built-in reconnect; log disconnections |
| Rate limit storms | Delayed messages | Queue with backoff |

---

## 10. Open Questions

None.

---

## 11. Deviations

(Empty at generation)

---

## 14. Implementation Progress

**Status**: ✅ COMPLETE

**Tasks**:
- [x] TASK 1: Initialize Bolt with Socket Mode ✅
- [x] TASK 2: Message event handler ✅
- [x] TASK 3: Message sending with retry ✅
- [x] TASK 4: Edit/delete handlers ✅
- [x] TASK 5: Unit and integration tests ✅

**Verification**: /verify-implementation 2026-02-24
- Gaps: 29 discovered → 29 fixed (100%)
- Tests: PASS (145 tests)
- Coverage: 90.75% (slack-client.ts: 81.46%)
- Build: PASS
- Types: PASS

**Force Verification**: /verify-implementation --force 2026-02-24
- Gaps: 4 test gaps identified → 4 fixed
- Tests: PASS (228 tests)
- Coverage: 90.65% overall (slack-client.ts: 93.21%)
- Commit: 495f5bb

**Files Created**:
- `src/slack-client.ts` — Full implementation with all exports
- `tests/unit/slack-client.test.ts` — 32 unit tests (28 + 4 security)
- `tests/integration/slack-client.test.ts` — 7 integration tests

**Security Implementations**:
- SEC-001: Zod schema validation for Slack events
- SEC-002: Authorized user filtering
- SEC-003: Message text sanitization (prevent injection)
- SEC-005: Message deduplication cache
- SEC-006: Channel ID validation

**Logging Implementations**:
- Socket Mode lifecycle logging
- Message handler entry/exit logging
- Rate limit warning with context
- Error logging with structured error objects
- Session correlation via withSessionId()

---

## 12. Pre-Flight Checks

| Check | Verification |
|-------|--------------|
| M-04 complete | Registry shows M-04 COMPLETE |
| @slack/bolt installed | `npm ls @slack/bolt` returns version |
| Slack tokens valid | Manual test with Slack API |

ALL pass -> PROCEED

---

## 13. Session Guide

1. **LOAD**: This + impl-M05-slackclient.md + impl-contracts.md S1-S2 + blprnt-master.md S7
2. **PRE-FLIGHT**: Verify M-01-M-04 complete; Slack tokens available
3. **IMPLEMENT**: Follow impl spec tasks 1-5
4. **VERIFY**: Run S7A commands, check S7B manually with real Slack
5. **UPDATE**: Registry status, commit
