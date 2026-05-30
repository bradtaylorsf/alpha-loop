<!-- managed by alpha-loop -->
# Alpha Loop

## Overview
Alpha Loop is an agent-agnostic automated development loop that implements The Loop methodology: Plan (GitHub Issues) -> Build (AI Agent) -> Test -> Review -> Ship (PR). GitHub is the source of truth for issues, labels, PRs, and CI, with GitHub Issues acting as kanban and PRs as review artifacts. The project is published as `@bradtaylorsf/alpha-loop` and includes onboarding, project scanning, planning, issue creation, triage, roadmap organization, continuous issue processing, epic processing and verification, stranded-session resume, history inspection, browser auth-state capture, and self-improvement review flows.

## Tech Stack
- Language: TypeScript strict mode, ESM package, `.js` extensions in source imports
- Runtime: Node.js; compiled output goes to `dist/`; CLI bin is `alpha-loop`
- CLI framework: Commander.js
- Package manager: pnpm only
- Agent CLIs: configurable coding harnesses, with built-in support centered on Codex, Claude, and OpenCode-style command runners
- GitHub integration: GitHub CLI (`gh`) through local helpers
- Browser verification/auth: Playwright-based browser state capture when configured
- Key dependencies/tooling: `commander`, `yaml`, TypeScript, Jest/ts-jest

## Directory Structure
- `src/cli.ts` - CLI entry point and Commander command registration
- `src/commands/` - Subcommand handlers for `init`, `run`, `scan`, `plan`, `add`, `triage`, `roadmap`, `auth`, `resume`, `review`, `history`, and deprecated `vision`
- `src/engine/` - Agent CLI mapping, argument construction, and system prerequisite checks
- `src/lib/agent.ts`, `src/lib/prompts.ts` - Agent runner abstraction and prompt generation
- `src/lib/config.ts` - `.alpha-loop.yaml` loading and typed configuration
- `src/lib/github.ts` - GitHub issue, PR, and label access through the CLI integration layer
- `src/lib/logger.ts`, `src/lib/shell.ts` - Structured logging and shell execution helpers
- `src/lib/context.ts`, `src/lib/vision.ts` - Project context and legacy vision helpers
- `src/lib/pipeline.ts` - Main issue-processing pipeline
- `src/lib/preflight.ts`, `src/lib/testing.ts`, `src/lib/prerequisites.ts` - Pre-run validation, test runner integration, and tool checks
- `src/lib/session.ts`, `src/lib/worktree.ts` - Session management and isolated worktree handling
- `src/lib/learning.ts` - Learning extraction and application support
- `tests/` - Jest suite mirroring command, lib, and engine areas
- `templates/` - Distribution starter skills and agent prompts shipped to users by `alpha-loop init`
- `.alpha-loop/templates/` - This repo's own managed instructions, skills, and agents; source for harness sync
- `.alpha-loop/learnings/` - Tracked team-shared knowledge and proposed updates
- `.alpha-loop/sessions/` - Local, gitignored runtime logs and artifacts
- `.Codex/`, `.agents/`, `.codex/` - Generated harness-specific outputs synced from templates

## Code Style
- Prefer functional modules; avoid classes except where an existing local pattern or external API wrapper calls for them
- Use `node:` prefixes for built-in modules
- Use ESM imports with `.js` extensions even when importing `.ts` source files
- Export types from their defining module and import them where needed
- Config is loaded from `.alpha-loop.yaml`; new config fields must update defaults, parsing, templates, and derived helpers together
- Keep agent support aligned between `src/lib/agent.ts` and `src/engine/agents.ts`
- Use shared shell helpers for command execution and the GitHub helper layer for GitHub operations
- Use temp files for long prompt, issue, PR, or comment bodies instead of fragile shell escaping
- Use `log()` or the project logger for operational status in shared libraries; direct `console` output is reserved for intentional CLI user output
- Keep command help, docs, config templates, and generated starter assets consistent when changing user-facing CLI behavior

## Non-Negotiables
- The marker comment `<!-- managed by alpha-loop -->` must remain the first line of managed instructions files
- Two `templates/` directories exist: root `templates/` is distribution code for all users; `.alpha-loop/templates/` controls this repo's own loop behavior
- Do not edit generated harness outputs directly: `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.codex/`, `.claude/`, `.Codex/`, or any configured sync target
- Changes to this repo's own agent assets should flow through `.alpha-loop/templates/`, preferably via `alpha-loop review --apply`
- Never manually publish or bump package versions; release versioning and npm publishing are owned by CI
- Worktrees must live under `.worktrees/` inside the project directory
- GitHub remains the datastore; do not introduce a separate persistent database for issues, workflow state, or review state
- Runtime and recovery artifacts such as `.alpha-loop/sessions/`, `.alpha-loop/auth/`, `.worktrees/`, `logs/`, and `*.bak` files are not source unless the task explicitly targets that behavior
- `.alpha-loop/learnings/` is tracked repo knowledge; do not discard, relocate, or ignore it casually
- `alpha-loop vision` is deprecated; use `alpha-loop plan` for project scope generation
