Here's the project context:

## Architecture
- **Entry points**: `scripts/loop.sh` (bash loop) and `src/cli/index.ts` (TypeScript CLI) both orchestrate the pipeline. The CLI creates a `GitHubClient`, an `AgentRunner`, and a `Server`, then calls `startLoop()` in `src/engine/loop.ts`.
- **Express server** in `src/server/index.ts` mounts three route groups under `/api`: `status`, `stream` (SSE), and `config`. Server listens on port 4000.
- **Database**: SQLite via `better-sqlite3`, created in `src/server/db.ts`. Stores `runs` (issue processing history) and `sessions`. Queried via prepared statements (`createRun`, `updateRun`).
- **Engine** (`src/engine/`): `loop.ts` is the pipeline orchestrator (setup → implement → test → fix → verify → review → PR → cleanup). `runner.ts` defines the `AgentRunner` interface; concrete runners live in `engine/runners/` (claude, codex). `worktree.ts` manages git worktree isolation. `github.ts` handles Issues/PRs via Octokit.
- **Learning** (`src/learning/`): `extractor.ts` pulls learnings from completed runs; `improver.ts` applies them to agent prompts.

## Conventions
- TypeScript strict mode, ESM, `.js` extensions in imports. Functional style (no classes except API wrappers). `node:` prefix for built-ins.
- Tests in `tests/` mirror `src/` structure, use Jest with `ts-jest`, `forceExit: true`, 30s timeout. Run with `pnpm test`. Tests must close all HTTP connections; use `jest.useFakeTimers()` for timer-based tests.
- New agent runners: add to `src/engine/runners/`, export from `runners/index.ts`. New API routes: create in `src/server/routes/`, mount in `src/server/index.ts` under `/api`.

## Critical Rules
- **Protected files**: `reference/`, `CLAUDE.md`, `.claude/agents/`, `.claude/skills/`, `scripts/loop.sh` — do not modify without explicit ask.
- **Reference code**: Always check `reference/*.reference.ts` before writing new engine code — contains battle-tested edge-case handling.
- **Import extensions**: All relative imports must use `.js` extension (ESM requirement).
- **Test hygiene**: Never leave open HTTP connections or real timers in tests — causes Jest hangs. `forceExit` is a safety net, not a fix.
- **pnpm only** — never use npm or yarn.

## Active State
- Test status: _(to be filled by loop)_
- Recent changes: _(to be filled by loop)_
