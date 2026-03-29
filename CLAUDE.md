# CLAUDE.md

## Project: Alpha Loop

Agent-agnostic automated development loop that implements The Loop methodology:
**Plan (GitHub Issues) -> Build (AI Agent) -> Test -> Review -> Ship (PR)**

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js, TypeScript, ESM |
| **Server** | Express (minimal -- monitoring + config only) |
| **Loop Engine** | Bash script + TypeScript orchestrator |
| **AI Agents** | Any CLI agent (Claude, Codex, OpenCode) |
| **Source of Truth** | GitHub (Issues = kanban, PRs = reviews, Actions = CI) |
| **Database** | SQLite (run history + learnings only) |
| **Package Manager** | pnpm |

## Commands

```bash
pnpm loop          # Run the loop continuously
pnpm loop:once     # Process one issue and exit
pnpm loop:dry      # Dry run (preview, no changes)
pnpm dev           # Start server (4000) + dashboard (4001)
pnpm dev:server    # Server only (4000)
pnpm dev:client    # Dashboard only (4001)
pnpm test          # Run all tests
pnpm build         # Build server + client
```

## Ports

| Port | Service |
|------|---------|
| 4000 | Express API server |
| 4001 | Vite dev server (React dashboard) |

## Directory Structure

```
alpha-loop/
├── src/
│   ├── engine/          # The Loop Engine
│   │   ├── runner.ts    # Agent-agnostic CLI runner
│   │   ├── worktree.ts  # Git worktree isolation
│   │   └── github.ts    # GitHub Issues + PRs
│   ├── server/          # Minimal Express (monitoring)
│   │   └── routes/      # status, config, runs, agents
│   └── learning/        # Self-improvement system
├── agents/              # Agent definitions (YAML+Markdown)
├── scripts/
│   ├── loop.sh          # Main loop script
│   └── prompts/         # Prompt templates
└── config.yaml          # Loop configuration
```

## Architecture Principles

1. **GitHub is the database** -- Issues are the kanban, labels are the state machine, PRs are reviews
2. **Agent-agnostic** -- Support any CLI agent (Claude, Codex, OpenCode)
3. **The Loop is the product** -- Plan -> Build -> Test -> Review -> Ship
4. **Self-improving** -- Extract learnings, update agent prompts automatically
5. **Simple enough to understand** -- A course graduate should be able to read this codebase

## Reference Code

The `reference/` directory contains battle-tested implementations from a previous version of this project. **Always check these files before writing new engine code.** They contain edge-case handling and patterns that were debugged over many iterations:

- `reference/cli-runner.reference.ts` -- JSONL stream parsing, OAuth, process lifecycle
- `reference/github-client.reference.ts` -- PR status tracking, rate limit handling
- `reference/worktree-manager.reference.ts` -- Retry logic for git locks, cleanup on error
- `reference/logger.reference.ts` -- Structured logging

When improving existing `src/engine/` modules, adopt patterns from these reference files rather than reinventing solutions.

## Protected Files -- DO NOT MODIFY OR DELETE

- `reference/` -- Battle-tested code from previous project. Read-only reference.
- `CLAUDE.md` -- This file. Do not modify unless explicitly asked.
- `.claude/agents/` -- Agent definitions. Do not modify unless explicitly asked.
- `.claude/skills/` -- Skill definitions. Do not modify unless explicitly asked.
- `scripts/loop.sh` -- The loop script. Do not modify unless explicitly asked.

## Code Style

- TypeScript strict mode, ESM with .js extensions in imports
- Functional style, no classes (except where wrapping external APIs)
- pnpm only (not npm or yarn)
- Use `node:` prefix for built-in modules (e.g., `node:path`, `node:child_process`)
- Jest for tests, `.test.ts` suffix, co-located in `tests/` directory

## Testing Rules

- Jest with `forceExit: true` and `testTimeout: 30000` (see jest.config.cjs)
- Tests MUST close all HTTP connections and servers in afterEach/afterAll
- Tests MUST NOT leave open connections that prevent Jest from exiting
- Use `jest.useFakeTimers()` for any timer-based testing (SSE heartbeats, polling)
- Do NOT use real `setTimeout`/`setInterval` in tests
