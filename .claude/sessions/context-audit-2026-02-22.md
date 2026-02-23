# Context Optimization Audit - 2026-02-22

## Auto-Loaded Context Summary

| Component         | Lines | Est. Tokens | Status            |
|-------------------|-------|-------------|-------------------|
| CLAUDE.md         | 179   | ~487        | OK (under 500)    |
| Rules (0 files)   | 0     | 0           | No rules dir      |
| MEMORY.md         | 0     | 0           | Empty (no file)   |
| MCP servers (3)   | -     | ~1,500-6,000| firebase-tools, context7, cloud-logging |
| **TOTAL**         |       | **~2,000-6,500** |              |

**Recommended target**: ~3,000-4,000 tokens

## CLAUDE.md Analysis

**Current**: 179 lines (~487 tokens) — under 500-line target

### Redundancy Found (~33%, ~133 tokens)

| Section | Lines | Issue | Savings |
|---------|-------|-------|---------|
| Agent Routing Rules | 21 | Triple duplication (CLAUDE.md + agent YAML + Task tool) | ~52 tokens |
| Build Commands | 19 | Extractable bash blocks | ~40 tokens |
| Environment Variables | 13 | Template duplicates .env.example | ~20 tokens |
| Code Quality | 9 | Overlaps with Technology Stack table | ~15 tokens |
| Self-evident principles | 2 | "Deterministic output", "Hybrid intelligence" | ~6 tokens |

### Proposed Compression
- **Before**: 179 lines (~487 tokens)
- **After**: ~120 lines (~320 tokens)
- **Savings**: ~133 tokens (27% reduction)

## Project File Organization

| Location | Files | Lines | Status |
|----------|-------|-------|--------|
| CLAUDE.md (root) | 1 | 179 | Auto-loaded every session |
| .claude/agents/ | 15 | 1,578 | On-demand (per Task invocation) |
| .claude/commands/ | 10 | 5,385 | On-demand (per skill invocation) |
| .claude/_repo/ | 141 | - | Agent library (reference only) |
| docs/ | 2 | - | Active planning docs |
| **Total .md files** | **169** | | All properly organized |

## Actions Taken
- Compressed Agent Routing Rules table → 1-line summary (was 21 lines, saved ~52 tokens)
- Compressed Build Commands → 1-line summary (was 19 lines, saved ~40 tokens)
- Compressed Environment Variables → 1-line pointer to .env.example (was 13 lines, saved ~20 tokens)
- Merged Code Quality into compact 2-line summary (was 8 lines, saved ~15 tokens)
- Removed 2 self-evident design principles (saved ~6 tokens)
- Confirmed no .claude/rules/ directory exists (no unconditional rules overhead)
- Confirmed MEMORY.md is empty (zero overhead)
- Scanned all 169 .md files — no wayward files found
- Checked ~/.claude/plans/ (198 files, all current) — nothing to archive
- Checked docs/ (2 files, modified today) — nothing to archive

## Manual Review Needed
- MCP server tool definitions (run `/mcp` for per-server token costs)
- Consider if all 3 MCP servers (firebase-tools, context7, cloud-logging) are needed for this project
- Large command files (blueprint: 1,173 lines, design-wireframes: 998 lines) — consider if they can be trimmed

## Session Optimization Tips
- Use `/compact` at ~70% context capacity (don't wait for auto-compact at 95%)
- Use `/compact` with focus hints: `/compact focus on the API changes`
- Use subagents for verbose operations (test output, log tailing, codebase exploration)
- Use `/context` to monitor actual context usage during sessions
- Use `/clear` between unrelated tasks — single most effective way to reclaim context
- Start implementation in a fresh session after planning (plan in one, execute in another)
- Avoid reading large files repeatedly — use sub-agents for exploration to contain context cost
