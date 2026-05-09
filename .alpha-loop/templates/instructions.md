<!-- managed by alpha-loop -->
# Alpha Loop

## Overview
Alpha Loop is an agent-agnostic automated development loop that orchestrates Plan (GitHub Issues) -> Build (AI Agent) -> Test -> Review -> Ship (PR). GitHub is the source of truth for issues, labels, projects, milestones, PRs, and CI, with the `gh` CLI as the integration layer. Published as `@bradtaylorsf/alpha-loop`, it also includes eval, telemetry, routing, and self-improvement flows for agent prompts, skills, and config.

## Tech Stack
- Language: TypeScript strict mode, ESM package, `.js` extensions in source imports
- Runtime: Node.js 20+; compiled output goes to `dist/`
- CLI framework: Commander.js with lazy-loaded command handlers
- Package manager: pnpm 9 (do not use npm or yarn for repo workflows)
- Agent CLIs: `claude`, `codex`, `opencode`; `lmstudio` and `ollama` route through compatible Claude/Codex CLI shapes
- GitHub integration: GitHub CLI (`gh`, `gh api`, `gh project`) wrapped by local helpers
- Key dependencies/tooling: `commander`, `@inquirer/prompts`, `yaml`, `tsx`, Jest/ts-jest

## Directory Structure
- `src/cli.ts` - CLI entry point and Commander command registration
- `src/commands/` - Subcommand handlers: `run`, `init`, `scan`, `plan`, `add`, `triage`, `roadmap`, `review`, `evolve`, `eval`, `learn`, `resume`, `history`, `auth`, `sync`, `report`, `vision`
- `src/engine/` - Agent CLI mapping and system prerequisite checks
- `src/lib/` - Shared implementation:
  - Agent execution and prompt construction: `agent.ts`, `prompts.ts`
  - Config, routing, telemetry, and escalation: `config.ts`, `routing-history.ts`, `routing-promotion.ts`, `telemetry.ts`, `escalation.ts`
  - GitHub, shell, rate limiting, sessions, and worktrees: `github.ts`, `shell.ts`, `rate-limit.ts`, `session.ts`, `worktree.ts`
  - Pipeline, planning, verification, learning, and validation: `pipeline.ts`, `planning.ts`, `verify.ts`, `verify-epic.ts`, `learning.ts`, `validation.ts`
  - Eval system: `eval.ts`, `eval-runner.ts`, `eval-checks.ts`, `eval-fixtures.ts`, `eval-matrix.ts`, `eval-report.ts`, `eval-swebench.ts`, `eval-export.ts`
  - Template and initialization support: `templates.ts`, `init-scan.ts`, `context.ts`, `hardware.ts`
- `tests/` - Jest test suite mirroring command/lib/engine areas
- `templates/` - Distribution starter skills, agents, and eval cases shipped to users by `alpha-loop init`
- `.alpha-loop/templates/` - This repo's own managed instructions, skills, and agents; source for harness sync
- `.alpha-loop/evals/` - Eval cases, profiles, config, and score history for this repo
- `.alpha-loop/learnings/` - Team-shared learnings and proposed self-improvement updates
- `docs/` - Product documentation for epics, routing profiles, local models, telemetry, and design notes

## Code Style
- Prefer functional modules; classes are only used where an existing local pattern needs stateful wrappers or custom errors
- Use `node:` prefixes for built-in modules
- Use ESM imports with `.js` extensions even when importing `.ts` source files
- Export types from their defining module and import them where needed
- Config is loaded from `.alpha-loop.yaml` into the `Config` type; new config fields must update defaults, YAML/env mappings, parsing, and derived helpers together
- Agent support is duplicated in `src/lib/agent.ts` and `src/engine/agents.ts`; keep both mappings aligned
- Use `src/lib/shell.ts` helpers for general shell execution and `ghExec()` from `src/lib/rate-limit.ts` for GitHub CLI calls
- Use temp files for long prompt, issue, PR, or comment bodies instead of fragile shell escaping
- Use `log()` for operational status in shared libraries; direct `console` output is reserved for intentional CLI user output
- GitHub interaction goes through the `gh` CLI helpers, not Octokit or a separate REST client

## Non-Negotiables
- The marker comment `<!-- managed by alpha-loop -->` must remain the first line of managed instructions files
- Two `templates/` directories exist: root `templates/` is distribution code for all users; `.alpha-loop/templates/` controls this repo's own loop behavior
- Do not edit generated harness outputs directly: `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.codex/`, `.claude/`, or any configured sync target
- Changes to this repo's own agent assets should flow through `.alpha-loop/templates/`, preferably via `alpha-loop review --apply` or `alpha-loop evolve`
- Never manually publish or bump package versions; release versioning and npm publishing are owned by CI
- Worktrees must live under `.worktrees/` inside the project directory
- GitHub remains the datastore; do not introduce a separate persistent database for issues, workflow state, or review state
- When routing models/endpoints, compute env overrides per stage so local endpoint settings do not leak into frontier stages
- Runtime artifacts such as `.alpha-loop/sessions/`, `.alpha-loop/traces/`, `.alpha-loop/auth/`, `.worktrees/`, and logs are not source unless the task explicitly targets session/history behavior
