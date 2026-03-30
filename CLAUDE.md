# CLAUDE.md

## Project: Alpha Loop

Agent-agnostic automated development loop that implements The Loop methodology:
**Plan (GitHub Issues) -> Build (AI Agent) -> Test -> Review -> Ship (PR)**

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js, TypeScript, ESM |
| **CLI Framework** | Commander.js |
| **AI Agents** | Any CLI agent (Claude, Codex, OpenCode) |
| **Source of Truth** | GitHub (Issues = kanban, PRs = reviews, Actions = CI) |
| **Package Manager** | pnpm |

## Commands

```bash
alpha-loop init          # Create .alpha-loop.yaml config template
alpha-loop run           # Run the loop continuously
alpha-loop run --once    # Process one issue and exit
alpha-loop run --dry-run # Dry run (preview, no changes)
alpha-loop scan          # Generate/refresh project context
alpha-loop vision        # Interactive project vision setup
alpha-loop auth          # Save authenticated browser state
alpha-loop history       # View session history
alpha-loop history <name> --qa    # Show QA checklist for session
alpha-loop history --clean        # Remove old session data
pnpm test               # Run all tests
pnpm build              # Build TypeScript to dist/
```

## Directory Structure

```
alpha-loop/
├── src/
│   ├── cli.ts                  # CLI entry point (Commander setup)
│   ├── commands/               # Subcommand handlers
│   │   ├── auth.ts             # Browser auth state management
│   │   ├── history.ts          # Session history viewer
│   │   ├── init.ts             # Config template creation
│   │   ├── run.ts              # Main loop execution
│   │   ├── scan.ts             # Project context generation
│   │   └── vision.ts           # Vision document setup
│   ├── engine/                 # Multi-agent engine
│   │   ├── agents.ts           # Agent registry and selection
│   │   ├── config.ts           # Engine configuration with Zod
│   │   └── prerequisites.ts    # System requirement checks
│   └── lib/                    # Shared libraries
│       ├── agent.ts            # Agent runner abstraction
│       ├── config.ts           # YAML config loading
│       ├── context.ts          # Project context management
│       ├── github.ts           # GitHub API (issues, PRs, labels)
│       ├── learning.ts         # Learning extraction/application
│       ├── logger.ts           # Structured logging
│       ├── pipeline.ts         # Issue processing pipeline
│       ├── preflight.ts        # Pre-run test validation
│       ├── prerequisites.ts    # Tool availability checks
│       ├── prompts.ts          # Agent prompt generation
│       ├── session.ts          # Session management
│       ├── shell.ts            # Shell execution helpers
│       ├── testing.ts          # Test runner integration
│       ├── vision.ts           # Vision document helpers
│       └── worktree.ts         # Git worktree management
├── tests/                      # Test suite (mirrors src/ structure)
├── agents/                     # Agent definitions (YAML+Markdown)
├── learnings/                  # Self-improvement data
│   └── proposed-updates/       # Proposed agent prompt updates
├── .claude/
│   ├── agents/                 # Agent definitions for Claude
│   └── skills/                 # Reusable skill definitions
└── .alpha-loop.yaml            # Loop configuration
```

## Architecture Principles

1. **GitHub is the database** -- Issues are the kanban, labels are the state machine, PRs are reviews
2. **Agent-agnostic** -- Support any CLI agent (Claude, Codex, OpenCode)
3. **The Loop is the product** -- Plan -> Build -> Test -> Review -> Ship
4. **Self-improving** -- Extract learnings, update agent prompts automatically
5. **Simple enough to understand** -- A course graduate should be able to read this codebase

## Protected Files -- DO NOT MODIFY OR DELETE

- `CLAUDE.md` -- This file. Do not modify unless explicitly asked.
- `.claude/agents/` -- Agent definitions. Do not modify unless explicitly asked.
- `.claude/skills/` -- Skill definitions. Do not modify unless explicitly asked.

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
