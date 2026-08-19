## Architecture
- `src/cli.ts` is the Commander.js entry point; it registers handlers from `src/commands/*.ts` for `init`, `run`, `resume`, `scan`, `plan`, `review`, `history`, and related workflows.
- `src/commands/run.ts` drives execution through `src/lib/pipeline.ts`, which coordinates agents, worktrees, tests, GitHub state, sessions, prompts, and learning extraction.
- GitHub is the database: Issues form the kanban, labels represent workflow state, PRs hold reviews, and Actions provide CI; access is centralized in `src/lib/github.ts`.
- `src/lib/` contains shared workflow services, while `src/engine/` handles agent CLI selection and prerequisites; `tests/` mirrors source behavior.
- Root `templates/` contains npm-distributed starter assets; `.alpha-loop/` contains this repository’s configuration, tracked learnings, and local session data.

## Conventions
- Node.js with strict TypeScript and ESM; imports include `.js` extensions, built-ins use the `node:` prefix, and implementations favor functional patterns over classes.
- Commander.js defines the CLI, YAML supplies configuration through `.alpha-loop.yaml` and `src/lib/config.ts`, and `pnpm` is the only supported package manager.
- Jest tests use `.test.ts`, live under `tests/`, and run with `pnpm test`; builds run with `pnpm build`.
- New commands require a handler in `src/commands/`, registration/help text in `src/cli.ts`, tests, and synchronized README/CLAUDE command documentation.
- Agent behavior is defined through templates and synchronized into harness-specific directories for Codex and other supported coding agents.

## Critical Rules
- Do not modify `AGENTS.md`; do not directly edit `.Codex/`, `.agents/`, `.codex/`, or `.alpha-loop/templates/`, which are protected or generated workflow assets.
- Do not confuse root `templates/`—distributed to users—with `.alpha-loop/templates/`, which configures this repository’s own loop.
- Keep CLI flags/help, command handlers, README, and CLAUDE.md synchronized whenever public commands or configuration change.
- Tests must close servers and HTTP connections, use fake timers for polling or heartbeat behavior, and never leave open handles.
- Never publish manually or edit the package version; merging conventional commits to `master` triggers the automated release workflow.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
