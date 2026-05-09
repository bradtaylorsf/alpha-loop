## Architecture
- CLI entry point is `src/cli.ts`, published as `dist/cli.js`; Commander registers subcommands and lazy-loads handlers from `src/commands/*.ts`.
- Main loop is `src/commands/run.ts`: loads `.alpha-loop.yaml`, syncs agent assets, runs preflight, fetches GitHub issues/epics/milestones, then calls `processIssue`/`processBatch` in `src/lib/pipeline.ts`.
- No traditional database. GitHub is the datastore: issues, labels, PRs, projects, milestones queried/mutated through `src/lib/github.ts` using `gh`, `gh api`, and `gh project`.
- Key directories: `src/commands` for CLI handlers, `src/lib` for orchestration/shared logic, `src/engine` for agent CLI mapping, `tests` mirroring source areas, `templates` for npm-distributed starter assets, `.alpha-loop/templates` for this repo’s own synced agent assets.

## Conventions
- TypeScript strict mode, ESM package, `.js` extensions in imports, functional style, `node:` prefixes for built-ins, pnpm-only workflows.
- Tests use Jest + ts-jest with `*.test.ts` under `tests/`; run via `pnpm test` (`jest --runInBand`) with `forceExit` and 30s timeout.
- New CLI commands should be registered in `src/cli.ts`, implemented in `src/commands/<name>.ts`, and covered under `tests/commands`.
- New config fields must be added consistently in `src/lib/config.ts`: `Config`, `DEFAULTS`, YAML/env maps, parsing/validation as needed.

## Critical Rules
- Do not casually edit protected/generated files: `AGENTS.md`, `CLAUDE.md`, `.agents/`, `.codex/`, `.claude/`; synced outputs come from `.alpha-loop/templates`.
- Do not confuse `templates/` with `.alpha-loop/templates/`: root `templates/` ships to users; `.alpha-loop/templates/` controls this repo’s own loop behavior.
- Agent support is duplicated in `src/lib/agent.ts` and `src/engine/agents.ts`; adding/changing an agent must keep both mappings and tests aligned.
- Do not manually publish or bump versions; releases are automated from commits pushed to `master`.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
- Session/runtime artifacts live under `.alpha-loop/sessions`, `.worktrees`, logs, and generated traces; avoid treating them as source unless intentionally working on session history.
