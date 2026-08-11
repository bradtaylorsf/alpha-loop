<!-- managed by alpha-loop -->
# Alpha Loop

## Overview
Alpha Loop is an agent-agnostic automated development loop implementing The Loop methodology: Plan (GitHub Issues) -> Build (AI Agent) -> Test -> Review -> Ship (PR). GitHub is the source of truth for issues, labels, workflow state, PRs, and CI; Issues act as the kanban and PRs as review artifacts. The project is published as `@bradtaylorsf/alpha-loop`.

The CLI supports onboarding, project scanning, scope planning, issue creation and triage, roadmap organization, continuous or single-issue processing, ordered epic processing and verification, stranded-session recovery, session history inspection, browser authentication capture, and learning-driven improvement reviews. It supports configurable coding harnesses rather than coupling the loop to one agent vendor.

## Tech Stack
- Language: TypeScript in strict mode
- Module system: ESM, with `.js` extensions in source imports
- Runtime: Node.js; compiled output is written to `dist/`
- CLI: Commander.js, exposed through the `alpha-loop` binary
- Package manager: pnpm only
- Agent integration: configurable support for 40+ CLI coding harnesses, including Codex, Claude, and OpenCode-style runners
- GitHub integration: GitHub CLI (`gh`) through shared local helpers
- Browser integration: Playwright-based authentication-state capture and optional browser verification
- Configuration: YAML via `.alpha-loop.yaml`
- Core tooling: `commander`, `yaml`, TypeScript, Jest, and ts-jest

## Directory Structure
- `src/cli.ts` - CLI entry point and Commander command registration
- `src/commands/` - Handlers for `init`, `run`, `scan`, `plan`, `add`, `triage`, `roadmap`, `auth`, `resume`, `review`, `history`, and deprecated `vision`
- `src/engine/agents.ts` - Agent CLI mappings and argument construction
- `src/engine/prerequisites.ts` - Engine-level system prerequisite checks
- `src/lib/agent.ts` - Agent runner abstraction
- `src/lib/config.ts` - `.alpha-loop.yaml` loading and typed configuration
- `src/lib/context.ts`, `src/lib/vision.ts` - Project context and legacy vision helpers
- `src/lib/github.ts` - GitHub issue, PR, and label operations
- `src/lib/learning.ts` - Learning extraction and application
- `src/lib/logger.ts`, `src/lib/shell.ts` - Structured logging and shell execution
- `src/lib/pipeline.ts` - Main issue-processing pipeline
- `src/lib/preflight.ts`, `src/lib/testing.ts`, `src/lib/prerequisites.ts` - Pre-run validation, configured test execution, and tool checks
- `src/lib/prompts.ts` - Agent prompt generation
- `src/lib/session.ts`, `src/lib/worktree.ts` - Session lifecycle and isolated worktree management
- `tests/` - Jest suite mirroring command, library, and engine areas
- `templates/` - Distribution starter skills and agent prompts copied into user projects by `alpha-loop init`
- `.alpha-loop/templates/` - This repository's managed instructions, skills, and agent definitions; source for harness synchronization
- `.alpha-loop/learnings/` - Tracked, team-shared knowledge and proposed updates
- `.alpha-loop/sessions/` - Local, gitignored session logs and artifacts
- `.Codex/`, `.agents/`, `.codex/` - Generated harness-specific outputs synchronized from managed templates
- `.github/workflows/release.yml` - Automated versioning, npm publishing, tagging, and GitHub Release workflow

## Code Style
- Prefer functional modules; avoid classes except where an established local pattern or external API wrapper requires one
- Use `node:` prefixes for Node.js built-in modules
- Use ESM imports with `.js` extensions, including imports targeting TypeScript source modules
- Export types from their defining modules and import them where needed
- Load project configuration from `.alpha-loop.yaml`; new fields must update defaults, parsing, templates, and derived helpers together
- Keep agent behavior aligned between `src/lib/agent.ts` and `src/engine/agents.ts`
- Use shared shell helpers for process execution and the GitHub helper layer for GitHub operations
- Use temporary files for long prompt, issue, PR, or comment bodies instead of fragile shell escaping
- Use `log()` or the project logger for operational status in shared libraries; reserve direct console output for intentional CLI-facing output
- Keep command help, documentation, config templates, and distribution starter assets synchronized when user-facing CLI behavior changes

## Non-Negotiables
- The marker comment `<!-- managed by alpha-loop -->` must remain the first line of managed instructions files
- The two template trees have different purposes: root `templates/` is distribution product code for new users, while `.alpha-loop/templates/` controls this repository's own loop behavior
- Do not modify `AGENTS.md` unless explicitly requested
- Do not edit generated harness outputs directly, including `CLAUDE.md`, `.agents/`, `.codex/`, `.claude/`, `.Codex/`, or any configured synchronization target
- Changes to this repository's own agent assets must flow through `.alpha-loop/templates/`, preferably through `alpha-loop review --apply`
- Never manually publish the package or edit its version; pushes to `master` drive automated semantic versioning and npm/GitHub releases through CI
- Worktrees must live beneath `.worktrees/` inside the project directory
- GitHub remains the datastore; do not introduce a separate persistent database for issues, workflow state, or review state
- Runtime and recovery artifacts such as `.alpha-loop/sessions/`, `.alpha-loop/auth/`, `.worktrees/`, `logs/`, and `*.bak` files are not source unless a task explicitly targets that behavior
- `.alpha-loop/learnings/` is tracked repository knowledge; do not discard, relocate, or ignore it casually
- `alpha-loop vision` is deprecated; use `alpha-loop plan` for project scope generation
