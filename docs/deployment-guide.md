# Deployment and Testing Guide

> Slack-Claude Code Integration v0.1.0
> Last updated: 2026-02-24

This guide covers installation, configuration, deployment, and testing of the Slack-Claude Code Integration daemon.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Quick Start](#quick-start)
3. [Slack App Setup](#slack-app-setup)
4. [Configuration](#configuration)
5. [Building and Installing](#building-and-installing)
6. [Running the Daemon](#running-the-daemon)
7. [Claude Code Hook Setup](#claude-code-hook-setup)
8. [Testing](#testing)
9. [Monitoring and Logs](#monitoring-and-logs)
10. [Troubleshooting](#troubleshooting)
11. [Production Deployment](#production-deployment)

---

## Prerequisites

### System Requirements

| Component | Requirement |
|-----------|-------------|
| **OS** | macOS or Linux (Windows not supported - Unix sockets) |
| **Node.js** | v20.0.0 or higher (LTS recommended) |
| **Claude Code** | Latest version with hooks support |
| **Disk Space** | 100MB minimum (for logs and session data) |

### Verify Node.js Version

```bash
node --version  # Should be v20.0.0 or higher
npm --version   # Should be v10.0.0 or higher
```

---

## Quick Start

```bash
# 1. Clone and install
git clone <repository-url>
cd claudeslackintegration
npm install

# 2. Build
npm run build

# 3. Create integration directory
mkdir -p ~/.claude/slack_integration/data/logs
mkdir -p ~/.claude/slack_integration/hooks

# 4. Set up environment
cp .env.example ~/.claude/slack_integration/.env
# Edit .env with your Slack credentials

# 5. Install hooks
npm run install-hooks  # Or manually copy hooks (see Hook Setup)

# 6. Start daemon
npm start
```

---

## Slack App Setup

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** > **From scratch**
3. Enter app name: `Claude Code Integration`
4. Select your workspace
5. Click **Create App**

### Step 2: Configure OAuth & Permissions

Navigate to **OAuth & Permissions** and add these Bot Token Scopes:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send messages to channels |
| `channels:read` | Read channel info |
| `channels:history` | Read channel messages |
| `users:read` | Read user info |

### Step 3: Enable Socket Mode

1. Go to **Socket Mode** in the sidebar
2. Toggle **Enable Socket Mode** to ON
3. Create an App-Level Token:
   - Name: `socket-mode-token`
   - Scope: `connections:write`
4. Click **Generate**
5. Save the `xapp-...` token (this is your `SLACK_APP_TOKEN`)

### Step 4: Subscribe to Events

Navigate to **Event Subscriptions**:

1. Toggle **Enable Events** to ON
2. Under **Subscribe to bot events**, add:
   - `message.channels`
   - `message.groups` (for private channels)

### Step 5: Install to Workspace

1. Go to **Install App**
2. Click **Install to Workspace**
3. Authorize the permissions
4. Copy the **Bot User OAuth Token** (`xoxb-...`) - this is your `SLACK_BOT_TOKEN`

### Step 6: Get Channel ID

1. In Slack, create or choose a channel for Claude sessions (e.g., `#claude-sessions`)
2. Right-click the channel name > **View channel details**
3. Scroll to the bottom and copy the **Channel ID** (starts with `C`)

---

## Configuration

### Environment Variables

Create `~/.claude/slack_integration/.env`:

```bash
# Required: Slack credentials
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_CHANNEL_ID=C1234567890

# Required: Security
DAEMON_SECRET=<64-character-hex-string>

# Optional: Access control (comma-separated Slack user IDs)
AUTHORIZED_USERS=U1234567890,U0987654321

# Optional: Transport (unix or tcp)
TRANSPORT_MODE=unix
DAEMON_PORT=3847

# Optional: Logging
LOG_LEVEL=info  # debug, info, warn, error
```

### Generate DAEMON_SECRET

```bash
# Generate a secure 64-character hex secret
openssl rand -hex 32
```

### Directory Structure

The daemon uses these directories under `~/.claude/slack_integration/`:

```
~/.claude/slack_integration/
├── .env                    # Configuration
├── data/
│   ├── registry.json       # Session registry
│   ├── transactions.json   # Recovery log
│   ├── tasks/              # Task queue files
│   │   └── {sessionId}/
│   │       └── {taskId}.json
│   ├── logs/               # Application logs
│   │   └── daemon.log
│   └── registry.json.backup.*  # Auto-backups (last 5)
└── hooks/                  # Claude Code hooks
    ├── session-start.js
    ├── stop.js
    ├── session-end.js
    └── lib/
        └── *.js
```

---

## Building and Installing

### Install Dependencies

```bash
npm install
```

### Build TypeScript

```bash
npm run build
```

This compiles TypeScript to JavaScript in the `dist/` directory.

### Type Checking

```bash
npm run typecheck
```

### Linting

```bash
npm run lint
```

---

## Running the Daemon

### Development Mode

```bash
# Run with hot-reload (tsx)
npm run dev
```

### Production Mode

```bash
# Build first
npm run build

# Run compiled JavaScript
npm start
```

### Verify Daemon is Running

```bash
# Check if process is running
pgrep -f "slack-claude-integration"

# Check health endpoint (Unix socket)
curl --unix-socket /tmp/slack-claude-daemon.sock http://localhost/health

# Check health endpoint (TCP mode)
curl http://localhost:3847/health
```

Expected response:
```json
{
  "status": "healthy",
  "uptime": 123.45,
  "activeSessions": 0,
  "pendingTasks": 0
}
```

### Running as a Service (macOS)

Create `~/Library/LaunchAgents/com.claude.slack-integration.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.slack-integration</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/claudeslackintegration/dist/src/http-server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/you/.claude/slack_integration/data/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/.claude/slack_integration/data/logs/stderr.log</string>
    <key>WorkingDirectory</key>
    <string>/path/to/claudeslackintegration</string>
</dict>
</plist>
```

Load the service:
```bash
launchctl load ~/Library/LaunchAgents/com.claude.slack-integration.plist
```

### Running as a Service (Linux systemd)

Create `/etc/systemd/user/slack-claude-integration.service`:

```ini
[Unit]
Description=Slack-Claude Code Integration Daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/claudeslackintegration
ExecStart=/usr/bin/node dist/src/http-server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Enable and start:
```bash
systemctl --user daemon-reload
systemctl --user enable slack-claude-integration
systemctl --user start slack-claude-integration
```

---

## Claude Code Hook Setup

### Option 1: Manual Installation

Copy compiled hooks to Claude Code's hooks directory:

```bash
# Build hooks
npm run build

# Copy to Claude Code hooks directory
cp -r dist/hooks/* ~/.claude/hooks/
```

### Option 2: Configure Claude Code Settings

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "session-start": {
      "command": "node",
      "args": ["/path/to/claudeslackintegration/dist/hooks/session-start.js"]
    },
    "stop": {
      "command": "node",
      "args": ["/path/to/claudeslackintegration/dist/hooks/stop.js"]
    },
    "session-end": {
      "command": "node",
      "args": ["/path/to/claudeslackintegration/dist/hooks/session-end.js"]
    }
  }
}
```

### Verify Hooks Are Working

1. Start Claude Code in a terminal
2. Check daemon logs for `SESSION_REGISTERED` event
3. Check Slack channel for new session thread

---

## Testing

### Run All Tests

```bash
npm test
```

### Run Tests with Coverage

```bash
npm run test:coverage
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

### Run Specific Test Files

```bash
# Unit tests only
npm test -- tests/unit/

# Integration tests
npm test -- tests/integration/

# Security tests
npm test -- tests/security/

# Chaos tests (recovery scenarios)
npm test -- tests/chaos/
```

### Test Coverage Thresholds

| Module | Target | Current |
|--------|--------|---------|
| Config | 100% | 100% |
| Logger | 90%+ | 94.54% |
| Registry | 90%+ | 93.09% |
| TaskQueue | 90%+ | 95.53% |
| SlackClient | 90%+ | 93.21% |
| HttpServer | 90%+ | 94.65% |
| Hooks | 85%+ | 85%+ |
| Recovery | 75%+ | 78.79% |

### Manual Testing Checklist

#### 1. Session Lifecycle

- [ ] Start Claude Code - verify session appears in Slack
- [ ] Send message in Slack thread - verify task created
- [ ] Complete task in Claude - verify summary posted to Slack
- [ ] Exit Claude Code - verify session marked ended

#### 2. Task Queue

- [ ] Send multiple messages rapidly - verify queued in order
- [ ] Complete tasks - verify processed in sequence
- [ ] Check injection limit (10) - verify limit message sent

#### 3. Error Recovery

- [ ] Kill daemon while task pending - restart and verify recovery
- [ ] Simulate Slack API error - verify retry with backoff
- [ ] Simulate disk full - verify warning logged

#### 4. Security

- [ ] Send request without auth token - verify 401 response
- [ ] Send request from unauthorized user - verify rejection
- [ ] Check file permissions on registry - should be 0600

---

## Monitoring and Logs

### Log Locations

| Log | Location | Format |
|-----|----------|--------|
| Daemon | `~/.claude/slack_integration/data/logs/daemon.log` | JSON |
| Hooks | `~/.claude/slack_integration/data/logs/hooks/` | JSON |

### Log Format

All logs use structured JSON format:

```json
{
  "level": "info",
  "time": 1709251200000,
  "msg": "Session registered",
  "module": "http-server",
  "sessionId": "a1b2c3d4-...",
  "requestId": "req_abc123",
  "action": "SESSION_REGISTERED",
  "threadTs": "1709251200.000001"
}
```

### Key Log Events

| Event | Level | Description |
|-------|-------|-------------|
| `SESSION_REGISTERED` | info | New Claude session created |
| `TASK_ADDED` | info | New task queued from Slack |
| `TASK_CLAIMED` | info | Hook claimed a task |
| `TASK_COMPLETED` | info | Task finished |
| `SUMMARY_SENT` | info | Summary posted to Slack |
| `RATE_LIMITED` | warn | Slack API rate limit hit |
| `RECOVERY_COMPLETE` | info | Crash recovery finished |
| `AUTH_FAILED` | warn | Authentication failure |

### View Logs

```bash
# Tail daemon logs
tail -f ~/.claude/slack_integration/data/logs/daemon.log | jq .

# Search for errors
grep '"level":"error"' ~/.claude/slack_integration/data/logs/daemon.log | jq .

# Filter by session
grep 'a1b2c3d4' ~/.claude/slack_integration/data/logs/daemon.log | jq .
```

### Health Monitoring

```bash
# Periodic health check
watch -n 10 'curl -s --unix-socket /tmp/slack-claude-daemon.sock http://localhost/health | jq .'
```

---

## Troubleshooting

### Common Issues

#### Daemon Won't Start

```bash
# Check for existing socket file
ls -la /tmp/slack-claude-daemon.sock

# Remove stale socket
rm /tmp/slack-claude-daemon.sock

# Check port availability (TCP mode)
lsof -i :3847
```

#### Slack Connection Failed

```
Error: An API error occurred: invalid_auth
```

**Solution**: Verify your `SLACK_BOT_TOKEN` is correct and the app is installed to your workspace.

#### Socket Mode Disconnects

**Check**:
1. `SLACK_APP_TOKEN` is valid (starts with `xapp-`)
2. Socket Mode is enabled in Slack app settings
3. Network firewall allows outbound WebSocket connections

#### Hooks Not Firing

1. Verify hooks are in correct location
2. Check hook file permissions: `chmod +x ~/.claude/hooks/*.js`
3. Check Claude Code hook configuration
4. Review hook logs: `~/.claude/slack_integration/data/logs/hooks/`

#### Tasks Not Processing

1. Check session is registered: `GET /sessions/:sessionId`
2. Verify daemon is running and healthy
3. Check for file lock issues in logs
4. Verify DAEMON_SECRET matches between hooks and daemon

#### Permission Denied Errors

```bash
# Fix directory permissions
chmod 700 ~/.claude/slack_integration
chmod 700 ~/.claude/slack_integration/data
chmod 600 ~/.claude/slack_integration/.env
chmod 600 ~/.claude/slack_integration/data/registry.json
```

### Debug Mode

Enable debug logging:

```bash
LOG_LEVEL=debug npm run dev
```

### API Testing

```bash
# Get session (replace with your session ID and secret)
curl -s --unix-socket /tmp/slack-claude-daemon.sock \
  -H "Authorization: Bearer YOUR_DAEMON_SECRET" \
  http://localhost/sessions/a1b2c3d4-5678-90ab-cdef-123456789012 | jq .

# List all sessions
curl -s --unix-socket /tmp/slack-claude-daemon.sock \
  -H "Authorization: Bearer YOUR_DAEMON_SECRET" \
  http://localhost/sessions | jq .
```

---

## Production Deployment

### Pre-Deployment Checklist

- [ ] All tests pass: `npm test`
- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] Environment variables configured
- [ ] Slack app installed and configured
- [ ] File permissions secured
- [ ] Service configuration ready
- [ ] Log rotation configured
- [ ] Monitoring in place

### Security Hardening

1. **File Permissions**
   ```bash
   chmod 700 ~/.claude/slack_integration
   chmod 600 ~/.claude/slack_integration/.env
   chmod 600 ~/.claude/slack_integration/data/registry.json
   ```

2. **Restrict Authorized Users**
   ```bash
   AUTHORIZED_USERS=U123,U456  # Only allow specific Slack users
   ```

3. **Rotate DAEMON_SECRET**
   - Generate new secret: `openssl rand -hex 32`
   - Update `.env` file
   - Send `SIGHUP` to daemon for graceful rotation (60s grace period)

4. **Network Isolation**
   - Use Unix socket mode (default) for local-only communication
   - If using TCP, bind to localhost only

### Log Rotation

Add to `/etc/logrotate.d/slack-claude-integration`:

```
/Users/*/.claude/slack_integration/data/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
}
```

### Backup Strategy

The daemon automatically maintains 5 rotating backups of `registry.json`. For additional protection:

```bash
# Backup integration directory
tar -czvf backup-$(date +%Y%m%d).tar.gz ~/.claude/slack_integration/data/
```

### Graceful Shutdown

The daemon handles `SIGTERM` and `SIGINT` signals:
1. Stops accepting new requests
2. Notifies active sessions via Slack
3. Flushes logs
4. Exits cleanly

```bash
# Graceful stop
kill -TERM $(pgrep -f "slack-claude-integration")

# Force stop (only if graceful fails)
kill -9 $(pgrep -f "slack-claude-integration")
```

### Secret Rotation

```bash
# Generate new secret
NEW_SECRET=$(openssl rand -hex 32)

# Update .env
sed -i '' "s/DAEMON_SECRET=.*/DAEMON_SECRET=$NEW_SECRET/" ~/.claude/slack_integration/.env

# Signal daemon to reload (60s grace period for old tokens)
kill -HUP $(pgrep -f "slack-claude-integration")
```

---

## API Reference

### Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/health` | Health check | No |
| POST | `/sessions/start` | Register new session | Yes |
| GET | `/sessions/:id` | Get session details | Yes |
| POST | `/sessions/:id/message` | Send message to Slack | Yes |
| POST | `/tasks/claim` | Claim next pending task | Yes |
| POST | `/tasks/:id/complete` | Mark task complete | Yes |
| GET | `/sessions` | List all sessions | Yes |

### Authentication

All authenticated endpoints require:
```
Authorization: Bearer <DAEMON_SECRET>
```

### Rate Limits

| Scope | Limit |
|-------|-------|
| Global | 100 requests/minute |
| Per-session | 20 requests/minute |
| Slack API | 1 message/second (queued) |

---

## Support

For issues and feature requests, see the project repository.

### Log Collection for Bug Reports

```bash
# Collect recent logs
tail -1000 ~/.claude/slack_integration/data/logs/daemon.log > debug-logs.json

# Include system info
echo "Node: $(node --version)" >> debug-info.txt
echo "OS: $(uname -a)" >> debug-info.txt
echo "Disk: $(df -h ~/.claude)" >> debug-info.txt
```
