# Module Plan: M-01 -- Config

> Master: blprnt-master.md S5 | Impl: impl-M01-config.md | Phase: 1 | Effort: 1d | Deps: -

## 0. Context Manifest

### MUST LOAD
| File | Sections | Tokens | Why |
|------|----------|--------|-----|
| blprnt-master.md | S2, S7 | ~500 | Principles, contracts |
| impl-contracts.md | S6 | ~200 | ConfigSchema |
| impl-M01-config.md | All | ~400 | Implementation details |

### DO NOT LOAD
- Other module blueprints, full master, source plan

### Total Budget: ~1,100 tokens

---

## 1. Responsibility

Load and validate all environment variables at startup. Export typed configuration object and Zod schemas for runtime validation. Fail fast with descriptive errors if required config is missing or invalid.

---

## 2. Public Interface

**Contracts (ref S7)**: `ConfigSchema` — produced

**Exports**:
- `loadConfig(): Config` — Parse .env, validate, return typed config
- `Config` — TypeScript type for validated config
- `ConfigSchema` — Zod schema for config validation
- `DATA_DIR: string` — Resolved data directory path
- `HOOKS_DIR: string` — Resolved hooks directory path

**Environment Variables**:
| Name | Required | Default | Validation |
|------|----------|---------|------------|
| `SLACK_BOT_TOKEN` | Yes | - | starts with `xoxb-` |
| `SLACK_APP_TOKEN` | Yes | - | starts with `xapp-` |
| `SLACK_CHANNEL_ID` | Yes | - | starts with `C` |
| `DAEMON_SECRET` | No | generated | 64 hex chars |
| `TRANSPORT_MODE` | No | `unix` | `unix` or `tcp` |
| `DAEMON_PORT` | No | `3847` | 1024-65535 |
| `LOG_LEVEL` | No | `info` | pino levels |
| `AUTHORIZED_USERS` | No | - | comma-separated Slack IDs |

---

## 3. Dependencies

**Imports**: `dotenv`, `zod`, `crypto`, `path`, `os`

**Exports to**: M-02 (logger config), M-03-M08 (all config values)

---

## 4. Data Owned

None (stateless module).

---

## 5. Data Flow

```
[Startup]: process.env → dotenv.config() → Zod parse → Config object
Errors: MISSING_ENV → fail fast with list | INVALID_VALUE → fail with details
```

---

## 6. Implementation Plan

**TASK 1**: Create config schema (0.25d, blocked by -) ✅
- Files: `src/config.ts`
- AC: All env vars have Zod validators; DAEMON_SECRET auto-generated if missing
- Impl: see impl-M01 S4.1
- **Complete**: commit 27f8b30

**TASK 2**: Implement loadConfig function (0.25d, blocked by TASK 1) ✅
- Files: `src/config.ts`
- AC: Returns typed Config; throws descriptive error on failure
- Impl: see impl-M01 S4.2
- **Complete**: commit 27f8b30

**TASK 3**: Add path resolution (0.25d, blocked by TASK 1) ✅
- Files: `src/config.ts`
- AC: DATA_DIR and HOOKS_DIR resolve to `~/.claude/slack_integration/`
- Impl: see impl-M01 S4.3
- **Complete**: commit 27f8b30

**TASK 4**: Unit tests (0.25d, blocked by TASK 2) ✅
- Files: `tests/unit/config.test.ts`
- AC: 100% coverage; tests valid, invalid, missing, defaults
- Impl: see impl-M01 S4.4
- **Complete**: commit 27f8b30

---

## Implementation Progress

**Status**: ✅ Complete | **Branch**: main
**Started**: 2026-02-23 | **Completed**: 2026-02-23

| Phase | Status | Commits |
|-------|--------|---------|
| TASK 1 | ✅ Complete | 27f8b30 |
| TASK 2 | ✅ Complete | 27f8b30 |
| TASK 3 | ✅ Complete | 27f8b30 |
| TASK 4 | ✅ Complete | 27f8b30 |

**Verification**: /verify-implementation 2026-02-23
- Gaps: 1 LOW (deferred - partial secret logging acceptable per design)
- Tests: PASS (20/20) | Coverage: 100% | Build: PASS | Types: PASS
- §7A Playbook: 3/3 PASS
- Contract compliance: PASS (all LOCKED interfaces match)

**Force Verification**: /verify-implementation --force 2026-02-23
- Re-verified: All 4 agents confirmed PASS
- Gaps: 1 LOW + 1 INFO (both acceptable, no remediation needed)
- Validation: Tests PASS | Types PASS

---

## 7. Verification Playbook

### 7A. Automated (exit 0)
| # | Check | Command | Timeout | Pass |
|---|-------|---------|---------|------|
| 1 | Unit tests | `npm test -- src/config` | 30s | exit 0 |
| 2 | Type check | `npx tsc --noEmit` | 60s | exit 0 |
| 3 | Coverage | `npm test -- --coverage src/config` | 30s | >95% |

### 7B. Manual
- [ ] Verify DAEMON_SECRET generation creates valid 64-char hex
- [ ] Verify startup fails with clear message when SLACK_BOT_TOKEN missing

### 7C. Integration
| Consumer | Verify | How |
|----------|--------|-----|
| M-02 Logger | Receives LOG_LEVEL | Logger outputs at configured level |
| M-06 HttpServer | Receives DAEMON_SECRET | Auth middleware works |

### 7D. Gate
ALL 7A exit 0 + 7B marked + 7C confirmed + registry updated

### 7E. Regression Commands
```bash
npm test -- src/config
```

---

## 8. Decisions

- **Zod over Joi**: Better TypeScript inference, smaller bundle. Reversibility: Easy
- **Auto-generate secret**: UX improvement, secure default. Reversibility: Easy
- **Fail-fast validation**: Prevents runtime surprises. Reversibility: Easy

---

## 9. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| .env not loaded in production | Config fails | Document deployment requirements |

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
| No dependencies | N/A |
| Node.js installed | `node --version` returns v20+ |
| npm installed | `npm --version` returns 9+ |

ALL pass -> PROCEED

---

## 13. Session Guide

1. **LOAD**: This + impl-M01-config.md + impl-contracts.md S6
2. **PRE-FLIGHT**: Run S12 checks
3. **IMPLEMENT**: Follow impl spec tasks 1-4
4. **VERIFY**: Run S7A commands, check S7B manually, confirm S7C
5. **UPDATE**: Registry status, commit
