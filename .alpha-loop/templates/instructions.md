<!-- managed by alpha-loop -->
# Alpha Loop

## Overview
Agent-agnostic automated development loop that orchestrates AI coding agents through a structured pipeline: Plan (GitHub Issues) → Build (AI Agent) → Test → Review → Ship (PR). Supports multiple AI CLI agents (Claude, Codex, OpenCode) and uses GitHub as the single source of truth for project management. Published as `@bradtaylorsf/alpha-loop` on npm.

## Tech Stack
- Language: TypeScript (strict mode, ESM with `.js` extensions in imports)
- Runtime: Node.js 20+
- CLI Framework: Commander.js
- Package manager: pnpm (never npm or yarn)
- Key dependencies: commander (CLI), yaml (config parsing), zod (validation), tsx (dev runner)
- Testing: Jest with `forceExit: true` and `testTimeout: 30000`

## Directory Structure
- `src/cli.ts` — CLI entry point, Commander program definition
- `src/commands/` — Subcommand handlers: `run`, `init`, `scan`, `plan`, `add`, `triage`, `roadmap`, `review`, `evolve`, `eval`, `learn`, `resume`, `history`, `auth`, `sync`, `vision`
- `src/engine/` — Multi-agent engine: agent CLI mapping (`agents.ts`) and system prerequisite checks
- `src/lib/` — Core libraries:
  - Pipeline orchestration (`pipeline.ts`), GitHub API via `gh` CLI (`github.ts`), git worktree management (`worktree.ts`)
  - Agent runner abstraction (`agent.ts`), config loading (`config.ts`), prompt generation (`prompts.ts`)
  - Session/learning tracking (`session.ts`, `learning.ts`), structured logging (`logger.ts`)
  - Planning, scoring, verification (`planning.ts`, `score.ts`, `verify.ts`, `verify-epic.ts`, `epics.ts`)
  - Eval system (`eval.ts`, `eval-runner.ts`, `eval-checks.ts`, `eval-fixtures.ts`, `eval-skill-bridge.ts`, `eval-swebench.ts`, `eval-export.ts`)
  - Template management (`templates.ts`), execution traces (`traces.ts`), shell exec (`shell.ts`), rate limiting (`rate-limit.ts`), input validation (`validation.ts`)
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
- Tests co-located in `tests/` with `.test.ts` suffix

## Non-Negotiables
- **Two `templates/` directories exist** — `templates/` (root) is distribution code affecting all users; `.alpha-loop/templates/` is this repo's own config. Know which you're editing.
- **Protected files**: Do not modify `CLAUDE.md`, `.claude/`, `.agents/`, `.codex/` directly — they are auto-synced from `.alpha-loop/templates/`. Improvements flow through `alpha-loop review --apply`.
- **Never manually publish or bump versions** — CI handles versioning from commit messages (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major). Just merge to master.
- **Worktrees must live in `.worktrees/`** inside the project, never in the parent directory.
- **All shell execution** goes through `src/lib/shell.ts` (`exec()`) — do not use `child_process` directly elsewhere.
- **Jest tests must clean up**: close all HTTP connections/servers in `afterEach`/`afterAll`, use `jest.useFakeTimers()` for timer-based tests, never use real `setTimeout`/`setInterval` in tests.
