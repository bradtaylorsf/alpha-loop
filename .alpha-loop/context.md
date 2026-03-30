Here's the project context:

## Architecture
- **Entry point**: `src/cli.ts` is the CLI entry point (Commander.js). Subcommands in `src/commands/` handle `init`, `run`, `scan`, `history`, `auth`, and `vision`.
- **Pipeline**: `src/lib/pipeline.ts` orchestrates the issue processing pipeline (setup → implement → test → fix → verify → review → PR → cleanup).
- **Agent abstraction**: `src/lib/agent.ts` provides the agent runner abstraction. `src/engine/agents.ts` handles multi-agent configuration and selection.
- **GitHub integration**: `src/lib/github.ts` handles issues (kanban via labels) and PRs. `src/lib/worktree.ts` provides git worktree isolation per issue.
- **Learning loop**: `src/lib/learning.ts` extracts learnings post-run and feeds them back into agent prompts.
- **Configuration**: `src/lib/config.ts` loads `.alpha-loop.yaml`. `src/engine/config.ts` validates engine config with Zod.

## Conventions
- TypeScript strict mode, ESM (`"type": "module"`), `.js` extensions in imports, `node:` prefix for builtins.
- Functional style — no classes except API wrappers. Config validated with Zod.
- Tests in `tests/` directory (mirrors `src/` structure), Jest with `forceExit: true`, `testTimeout: 30000`, run via `pnpm test` (`jest --runInBand`). Must close all HTTP connections in teardown; use `jest.useFakeTimers()` for timer-based tests.

## Critical Rules
- **Protected files**: `CLAUDE.md`, `.claude/agents/`, `.claude/skills/` — do not modify without explicit instruction.
- **Server teardown**: Tests that create servers MUST close them in `afterEach`/`afterAll` or Jest hangs.
- **GitHub is the database**: Issues = kanban state, labels = state machine, PRs = reviews. Don't duplicate this state.
- **pnpm only** — never use npm or yarn.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
