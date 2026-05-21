## Architecture
- `src/cli.ts` is the Commander entry point; most commands lazy-load handlers from `src/commands/*.ts`, then delegate shared behavior to `src/lib/*`.
- Main execution flows through `src/commands/run.ts` into `src/lib/pipeline.ts`, which orchestrates issue plan, agent implementation, tests, verification, review, PR creation, learnings, and cleanup.
- Database is GitHub: issues/projects/milestones/PRs are queried and mutated through `src/lib/github.ts` using the `gh` CLI; repo/project/label settings live in `.alpha-loop.yaml`.
- Key directories: `src/commands` for CLI handlers, `src/lib` for orchestration/helpers, `src/engine` for agent CLI definitions, `tests` mirroring source modules, `templates` for npm-shipped defaults, `.alpha-loop` for this repo’s context/learnings/evals/templates.

## Conventions
- TypeScript strict mode, ESM package, `.js` extensions in source imports, functional style, `node:` prefixes for built-ins, pnpm-only workflows.
- Tests use Jest + ts-jest in Node, `*.test.ts` files under `tests/`, heavy mocking of shell/GitHub/agent boundaries, run via `pnpm test` (`jest --runInBand`).
- New CLI features must be registered in `src/cli.ts`, implemented in `src/commands/<name>.ts`, and covered by command/lib tests.
- Config additions must update `Config`, `DEFAULTS`, YAML/env key maps, parsing/coercion in `src/lib/config.ts`, `.alpha-loop.yaml` docs, and related tests.

## Critical Rules
- Do not casually modify `AGENTS.md`, `CLAUDE.md`, `.alpha-loop/templates/`, `.agents/`, `.codex/`, or `.claude/`; templates are the source, harness folders are synced outputs.
- Do not confuse root `templates/` npm distribution defaults with `.alpha-loop/templates/` repo-local loop configuration.
- Agent support spans `src/lib/config.ts`, `src/engine/agents.ts`, `src/lib/agent.ts`, and `src/commands/sync.ts`; update these together when adding agents/harnesses.
- Releases are automated from pushes to `master` by `.github/workflows/release.yml`; do not manually publish or bump package versions.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
- Runtime config: current repo config uses `agent: codex`, `base_branch: master`, `label: ready`, `test_command: pnpm test`, and codex harness sync.
