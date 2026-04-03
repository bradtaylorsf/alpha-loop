<!-- managed by alpha-loop -->
Here's the project instructions file:

<!-- managed by alpha-loop -->
# Alpha Loop

## Overview
Agent-agnostic automated development loop that orchestrates AI coding agents through a structured pipeline: Plan (GitHub Issues) → Build (AI Agent) → Test → Review → Ship (PR). It supports multiple AI CLI agents (Claude, Codex, OpenCode) and uses GitHub as the single source of truth for project management. Published as `@bradtaylorsf/alpha-loop` on npm.

## Tech Stack
- Language: TypeScript (strict mode, ESM with `.js` extensions in imports)
- Runtime: Node.js 20+
- CLI Framework: Commander.js
- Package manager: pnpm (never npm or yarn)
- Key dependencies: commander (CLI), yaml (config parsing), zod (validation), tsx (dev runner)

## Directory Structure
- `src/cli.ts` — CLI entry point, Commander program definition
- `src/commands/` — Subcommand handlers (run, init, scan, vision, review, resume, history, auth, sync)
- `src/engine/` — Multi-agent engine: agent CLI mapping (`agents.ts`) and system prerequisite checks
- `src/lib/` — Core libraries: pipeline orchestration, GitHub API via `gh` CLI, git worktree management, agent runner abstraction, config loading, prompt generation, session/learning tracking
- `tests/` — Jest test suite mirroring `src/` structure
- `templates/` — **Distribution templates** shipped to users via `alpha-loop init`
- `.alpha-loop/templates/` — **This repo's own** skill and agent definitions for self-development

## Code Style
- Functional style, no classes (except wrapping external APIs)
- Use `node:` prefix for all built-in modules (`node:path`, `node:fs`, `node:child_process`)
- ESM: all imports use `.js` extension even for `.ts` source files
- Types exported from their defining module, imported where needed
- GitHub interaction goes through the `gh` CLI (no Octokit/REST client)
- Config loaded from `.alpha-loop.yaml` at project root, typed with `Config` type
- Worktrees created inside `.worktrees/` within the project directory (never `../` in parent)
- Logging via `src/lib/logger.ts` — use `log()` not `console.log`

## Non-Negotiables
- **Two `templates/` directories exist** — `templates/` (root) is distribution code affecting all users; `.alpha-loop/templates/` is this repo's own config. Know which you're editing.
- **Protected files**: Do not modify `CLAUDE.md`, `.claude/`, `.agents/`, `.codex/` directly — they are auto-synced from `.alpha-loop/templates/`.
- **Never manually publish or bump versions** — CI handles versioning from commit messages (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major). Just merge to master.
- **Worktrees must live in `.worktrees/`** inside the project, never in the parent directory.
- **All shell execution** goes through `src/lib/shell.ts` (`exec()`) — do not use `child_process` directly elsewhere.
- **Jest tests must clean up**: close all HTTP connections/servers in `afterEach`/`afterAll`, use `jest.useFakeTimers()` for timer-based tests, never use real `setTimeout` in tests.
