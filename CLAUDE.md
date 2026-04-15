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
alpha-loop init          # Full onboarding: config, templates, vision, scan, sync
alpha-loop run           # Run the loop continuously
alpha-loop run --once    # Process one issue and exit
alpha-loop run --dry-run # Dry run (preview, no changes)
alpha-loop scan          # Generate/refresh project context
alpha-loop plan          # Generate project scope (milestones + issues) from seed inputs
alpha-loop add           # Create a new issue from a free-form description using AI
alpha-loop triage        # Analyze and improve existing issues
alpha-loop roadmap       # Organize open issues into milestones
alpha-loop vision        # (deprecated) Use "alpha-loop plan" instead
alpha-loop auth          # Save authenticated browser state
alpha-loop resume        # Resume stranded work from crashed sessions
alpha-loop resume --issue 34     # Resume a specific issue
alpha-loop review        # Analyze learnings, propose agent/skill improvements
alpha-loop review --apply        # Apply improvements and create draft PR
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
│   │   ├── resume.ts           # Resume stranded work from crashed sessions
│   │   ├── review.ts           # Self-improvement loop (learnings → proposals)
│   │   ├── run.ts              # Main loop execution
│   │   ├── scan.ts             # Project context generation
│   │   └── vision.ts           # Vision document setup
│   ├── engine/                 # Multi-agent engine
│   │   ├── agents.ts           # Agent CLI map and arg builder (claude, codex, opencode)
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
├── templates/                  # DISTRIBUTION: starter files shipped with npm package
│   ├── skills/                 # Default skills installed by `alpha-loop init`
│   └── agents/                 # Default agent prompts installed by `alpha-loop init`
├── .alpha-loop.yaml            # Loop configuration (agent, model, harnesses, etc.)
├── .alpha-loop/
│   ├── templates/              # THIS REPO'S OWN skills and sub-agent definitions
│   │   ├── skills/             # Skill definitions (synced to harness-specific paths)
│   │   └── agents/             # Sub-agent prompts (implementer.md, reviewer.md)
│   ├── learnings/              # Tracked in git — team-shared knowledge
│   │   └── proposed-updates/   # Proposed improvements from `alpha-loop review`
│   └── sessions/               # Gitignored — local logs, screenshots
├── .claude/                    # Auto-synced from .alpha-loop/templates/ (Claude Code)
├── .agents/                    # Auto-synced from .alpha-loop/templates/ (Codex, Cursor, etc.)
└── .codex/                     # Auto-synced from .alpha-loop/templates/ (Codex agents)
```

## Two templates/ directories — don't confuse them

This repo has TWO `templates/` directories with different purposes:

- **`templates/`** (root) — **Distribution templates** shipped with the npm package. When a user runs `alpha-loop init` in their project, these files are copied to their `.alpha-loop/templates/`. This is product code — changes here affect all new alpha-loop users.
- **`.alpha-loop/templates/`** — **This repo's own** dev config for running alpha-loop against itself. Same as any other project using alpha-loop. Changes here only affect this repo's development workflow.

When editing skills or agent prompts, make sure you're editing the right one:
- Improving the **default starter skills** for new users → edit `templates/`
- Improving **this repo's own** loop behavior → edit `.alpha-loop/templates/`

## Architecture Principles

1. **GitHub is the database** -- Issues are the kanban, labels are the state machine, PRs are reviews
2. **Agent-agnostic** -- Support 40+ coding harnesses via configurable sync
3. **The Loop is the product** -- Plan -> Build -> Test -> Review -> Ship
4. **Self-improving** -- Extract learnings, update agent prompts automatically
5. **Simple enough to understand** -- A course graduate should be able to read this codebase

## Protected Files -- DO NOT MODIFY OR DELETE

- `CLAUDE.md` -- This file. Do not modify unless explicitly asked.
- `.alpha-loop/templates/` -- Source of truth for skills, agents, and instructions. Modify via `alpha-loop review --apply`, not directly.
- `.claude/`, `.agents/`, `.codex/` -- Auto-synced from templates. Do not edit directly.

## Code Style

- TypeScript strict mode, ESM with .js extensions in imports
- Functional style, no classes (except where wrapping external APIs)
- pnpm only (not npm or yarn)
- Use `node:` prefix for built-in modules (e.g., `node:path`, `node:child_process`)
- Jest for tests, `.test.ts` suffix, co-located in `tests/` directory

## Release Process -- DO NOT manually publish or bump versions

Releases are fully automated via `.github/workflows/release.yml`:
- **Trigger**: Any push to `master` (excluding docs-only changes)
- **Versioning**: Automatic from commit messages — `feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major
- **Publishing**: CI publishes to npm, creates git tag, and GitHub Release
- **To release**: Just merge the PR to master. That's it.
- **DO NOT** run `pnpm publish`, `npm publish`, or manually edit `package.json` version

## Testing Rules

- Jest with `forceExit: true` and `testTimeout: 30000` (see jest.config.cjs)
- Tests MUST close all HTTP connections and servers in afterEach/afterAll
- Tests MUST NOT leave open connections that prevent Jest from exiting
- Use `jest.useFakeTimers()` for any timer-based testing (SSE heartbeats, polling)
- Do NOT use real `setTimeout`/`setInterval` in tests
