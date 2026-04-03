Here's the project context:

---

## Architecture
- **CLI entry**: `src/cli.ts` uses Commander.js to register subcommands (`init`, `run`, `scan`, `vision`, `auth`, `sync`, `resume`, `review`, `history`). Builds to `dist/cli.js`, invoked as `alpha-loop`.
- **Pipeline core**: `src/lib/pipeline.ts` orchestrates the loop — fetches GitHub issues labeled `ready`, runs them through agent build → test → review → PR stages. `src/lib/github.ts` wraps `gh` CLI for all GitHub API calls.
- **Agent abstraction**: `src/engine/agents.ts` defines CLI arg builders for supported agents (Claude, Codex, OpenCode). `src/lib/agent.ts` spawns the configured agent as a child process with generated prompts from `src/lib/prompts.ts`.
- **No database** — GitHub is the database. Issues = kanban, labels = state machine, PRs = review artifacts. Config lives in `.alpha-loop.yaml` (YAML, loaded by `src/lib/config.ts` with Zod validation).
- **Key directories**: `src/commands/` (CLI handlers), `src/lib/` (shared logic), `src/engine/` (agent integrations), `templates/` (npm-distributed starter files), `.alpha-loop/templates/` (this repo's own agent/skill config).

## Conventions
- TypeScript strict mode, ESM with `.js` extensions in imports. Functional style, no classes. `node:` prefix for builtins.
- Tests in `tests/` mirror `src/` structure, use Jest with `ts-jest`. Run via `pnpm test` (`--runInBand`, `forceExit: true`, 30s timeout). Tests must close all connections; use `jest.useFakeTimers()` for timer logic.
- New commands: add handler in `src/commands/`, register in `src/cli.ts`. New lib modules go in `src/lib/`. New agent support goes in `src/engine/agents.ts`.

## Critical Rules
- **Do not manually publish or bump versions** — CI auto-publishes on merge to `master` using conventional commits (`feat:` → minor, `fix:` → patch).
- **Two `templates/` directories**: root `templates/` = distributed to users via `alpha-loop init`; `.alpha-loop/templates/` = this repo's own config. Don't confuse them.
- **Protected files**: `CLAUDE.md`, `.alpha-loop/templates/`, `.claude/`, `.agents/`, `.codex/` (auto-synced, don't edit directly).
- **Worktrees must live in `.worktrees/`** inside the project, never `../issue-N` in parent directory.
- **Dependencies are minimal** (commander, yaml, zod) — keep it that way. Uses `gh` CLI externally, not Octokit.

## Active State
- Test status: *(filled in by the loop)*
- Recent changes: *(filled in by the loop)*
