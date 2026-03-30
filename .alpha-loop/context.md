Here's the project context:

## Architecture
- **Entry points**: `scripts/loop.sh` starts the loop, calling `src/engine/loop.ts` which orchestrates the pipeline (setup → implement → test → fix → verify → review → PR → cleanup). Express server in `src/server/index.ts` mounts routes from `routes/{status,stream,config}.ts` on `/api`.
- **Agent runners**: `src/engine/runner.ts` defines the `AgentRunner` interface; concrete implementations in `src/engine/runners/{claude,codex}.ts`. Any CLI agent can be plugged in by implementing `buildArgs()` + `run()`.
- **Database**: SQLite via `better-sqlite3`, schema initialized in `src/server/db.ts`. Tables: `runs` (pipeline execution history), `sessions` (ordered issue batches), `learnings` (extracted patterns/anti-patterns). Query via prepared statements on the `Database` instance.
- **GitHub integration**: `src/engine/github.ts` handles issues (kanban via labels) and PRs. `src/engine/worktree.ts` provides git worktree isolation per issue.
- **Learning loop**: `src/learning/extractor.ts` extracts learnings post-run; `src/learning/improver.ts` feeds them back into agent prompts.

## Conventions
- TypeScript strict mode, ESM (`"type": "module"`), `.js` extensions in imports, `node:` prefix for builtins.
- Functional style — no classes except API wrappers. Config validated with Zod.
- Tests in `tests/` directory (mirrors `src/` structure), Jest with `forceExit: true`, `testTimeout: 30000`, run via `pnpm test` (`jest --runInBand`). Must close all HTTP connections in teardown; use `jest.useFakeTimers()` for timer-based tests.
- New routes: create in `src/server/routes/`, import and mount in `src/server/index.ts` under `/api`.
- New agent runners: implement `AgentRunner` interface, add to `src/engine/runners/`.

## Critical Rules
- **Protected files**: `reference/`, `CLAUDE.md`, `.claude/agents/`, `.claude/skills/`, `scripts/loop.sh` — do not modify without explicit instruction.
- **Reference directory**: Always check `reference/*.reference.ts` before writing new engine code — contains battle-tested edge-case handling for JSONL parsing, git locks, rate limits.
- **Server teardown**: Tests that create servers MUST close them in `afterEach`/`afterAll` or Jest hangs.
- **GitHub is the database**: Issues = kanban state, labels = state machine, PRs = reviews. Don't duplicate this state.
- **pnpm only** — never use npm or yarn.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
