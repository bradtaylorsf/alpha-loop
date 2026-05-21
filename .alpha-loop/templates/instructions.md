<!-- managed by alpha-loop -->
# Alpha Loop

## Overview
Alpha Loop is an agent-agnostic automated development loop that orchestrates Plan (GitHub Issues) -> Build (AI Agent) -> Test -> Review -> Verify -> Learn -> Ship (PR). GitHub is the source of truth for issues, labels, projects, milestones, epics, PRs, and CI, with the `gh` CLI as the integration layer. Published as `@bradtaylorsf/alpha-loop`, it also includes planning, triage, roadmap, eval, telemetry, routing, trace/cost tracking, and self-improvement flows for agent prompts, skills, and config.

## Tech Stack
- Language: TypeScript strict mode, ESM package, `.js` extensions in source imports
- Runtime: Node.js 20+; compiled output goes to `dist/`; CLI bin is `alpha-loop`
- CLI framework: Commander.js with mostly lazy-loaded command handlers
- Package manager: pnpm 9 (do not use npm or yarn for repo workflows)
- Agent CLIs: `claude`, `codex`, `opencode`; `lmstudio` and `ollama` route through compatible Claude/Codex CLI shapes
- GitHub integration: GitHub CLI (`gh`, `gh api`, `gh project`) wrapped by local helpers and rate limiting
- Browser verification/auth: external `playwright-cli` is used when available
- Key dependencies/tooling: `commander`, `@inquirer/prompts`, `yaml`, `zod`, `tsx`, TypeScript, Jest/ts-jest

## Directory Structure
- `src/cli.ts` - CLI entry point and Commander command registration
- `src/commands/` - Subcommand handlers: `run`, `init`, `scan`, `plan`, `add`, `triage`, `roadmap`, `review`, `evolve`, `evolve-routing`, `eval`, `learn`, `resume`, `history`, `auth`, `sync`, `report`, `vision`
- `src/engine/` - Agent CLI mapping and system prerequisite checks
- `src/lib/agent.ts`, `prompts.ts`, `cli-args.ts` - Agent execution, prompt construction, and argv normalization
- `src/lib/config.ts`, `routing-history.ts`, `routing-promotion.ts`, `telemetry.ts`, `escalation.ts` - Config, routing profiles, telemetry, and fallback guardrails
- `src/lib/github.ts`, `rate-limit.ts`, `shell.ts`, `session.ts`, `worktree.ts` - GitHub CLI access, shell helpers, sessions, and isolated worktrees
- `src/lib/pipeline.ts`, `planning.ts`, `epics.ts`, `verify.ts`, `verify-epic.ts`, `learning.ts`, `validation.ts`, `preflight.ts` - Core loop, epic parsing, planning, verification, learning, and queue validation
- `src/lib/eval*.ts`, `score.ts`, `traces.ts` - Eval cases, runners, matrix reports, SWE-bench import/export, scoring, secret checks, and full execution traces
- `src/lib/templates.ts`, `init-scan.ts`, `context.ts`, `hardware.ts` - Template discovery, initialization scan, project context, and local-model hardware hints
- `tests/` - Jest suite mirroring command/lib/engine areas
- `templates/` - Distribution starter skills, agents, and eval cases shipped to users by `alpha-loop init`
- `.alpha-loop/templates/` - This repo's own managed instructions, skills, and agents; source for harness sync
- `.alpha-loop/evals/` - This repo's eval cases, profiles, config, and score history
- `.alpha-loop/learnings/` - Tracked team-shared learnings, session manifests/summaries, routing history, and proposed updates
- `docs/` - Product documentation for epics, routing profiles, local models, telemetry, and design notes
- `plugins/alpha-loop-epic-runner/` - Bundled Codex plugin/skill for epic loop workflows
- `scripts/` - Maintenance scripts such as routing regression fixture generation
- `learnings/` - Legacy learning artifacts; current loop output belongs under `.alpha-loop/learnings/`

## Code Style
- Prefer functional modules; classes are only used where an existing local pattern needs stateful wrappers or custom errors
- Use `node:` prefixes for built-in modules
- Use ESM imports with `.js` extensions even when importing `.ts` source files
- Export types from their defining module and import them where needed
- Config is loaded from `.alpha-loop.yaml` into the `Config` type; new config fields must update defaults, YAML/env mappings, parsing, init template hints, and derived helpers together
- Agent support is duplicated in `src/lib/agent.ts` and `src/engine/agents.ts`; keep both mappings aligned
- Use `src/lib/shell.ts` helpers for general shell execution and `ghExec()` from `src/lib/rate-limit.ts` for GitHub CLI calls
- Use temp files for long prompt, issue, PR, or comment bodies instead of fragile shell escaping
- Use `log()` for operational status in shared libraries; direct `console` output is reserved for intentional CLI user output
- GitHub interaction goes through the `gh` CLI helpers, not Octokit or a separate REST client
- Harness sync targets live in `src/commands/sync.ts` `HARNESS_REGISTRY`; preserve managed-marker overwrite safety when changing sync behavior

## Non-Negotiables
- The marker comment `<!-- managed by alpha-loop -->` must remain the first line of managed instructions files
- Two `templates/` directories exist: root `templates/` is distribution code for all users; `.alpha-loop/templates/` controls this repo's own loop behavior
- Do not edit generated harness outputs directly: `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.codex/`, `.claude/`, `.Codex/`, or any configured sync target
- Changes to this repo's own agent assets should flow through `.alpha-loop/templates/`, preferably via `alpha-loop review --apply` or `alpha-loop evolve`
- Never manually publish or bump package versions; release versioning and npm publishing are owned by CI
- Worktrees must live under `.worktrees/` inside the project directory
- GitHub remains the datastore; do not introduce a separate persistent database for issues, workflow state, or review state
- When routing models/endpoints, compute env overrides per stage so local endpoint settings do not leak into frontier stages
- Runtime and recovery artifacts such as `.alpha-loop/sessions/`, `.alpha-loop/traces/`, `.alpha-loop/auth/`, `.alpha-loop/escalation-state.json`, `.alpha-loop/plan.json`, `.worktrees/`, `logs/`, and `*.bak` files are not source unless the task explicitly targets that behavior
- `.alpha-loop/learnings/` and `.alpha-loop/evals/` are tracked repo knowledge/eval source; do not discard, relocate, or ignore them casually
