# Claude Code Project Configuration

## Project Overview

Slack-Claude Code Integration: Bidirectional integration where Claude Code sessions are controllable via Slack threads.

## Tech Stack

- **Language**: Node.js with TypeScript
- **Framework**: @slack/bolt (Slack SDK)
- **Architecture**: Watcher daemon with Unix socket IPC, session registry
- **Communication**: Socket Mode (Slack), Unix socket (daemon-hooks)

## Agent Routing Rules

Subagent selection rules. Priority levels: MUST (always invoke), PROACTIVE (auto-invoke on trigger), ON-DEMAND (user-initiated).

| Trigger | Agent | Priority |
|---------|-------|----------|
| Slack API, @slack/bolt, events, Block Kit | slack-expert | MUST |
| TypeScript types, generics, strict mode | typescript-pro | PROACTIVE |
| API endpoints, daemon routes, HTTP/REST | backend-developer | PROACTIVE |
| API design, OpenAPI spec, endpoint schema | api-designer | PROACTIVE |
| Security, auth, tokens, permissions, HMAC | security-engineer | MUST |
| Tests, coverage, CI/CD test integration | test-automator | PROACTIVE |
| CLI hooks, terminal scripts, exit codes | cli-developer | PROACTIVE |
| WebSocket, Socket Mode, real-time events | websocket-engineer | PROACTIVE |
| Bugs, errors, stack traces, debugging | debugger | ON-DEMAND |

## Key Architecture Components

1. **Slack App** - @slack/bolt with Socket Mode
2. **Watcher Daemon** - Node.js daemon at `~/.claude/slack_integration/`
3. **Claude Code Hooks** - Stop hook for prompt injection
4. **Session Registry** - File-locked JSON for session state

## Security Requirements

- DAEMON_SECRET: 32-byte random hex for bearer token auth
- File permissions: 0600 for registry and task files
- Token rotation via SIGHUP with 60s grace period
- AUTHORIZED_USERS env var for Slack user filtering
- HMAC signatures for network deployments

## Plan Reference

See [docs/slack-integration-plan.md](docs/slack-integration-plan.md) for the complete implementation plan (97/100 score, production-ready).
