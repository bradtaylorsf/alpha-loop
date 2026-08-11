## Architecture
- `src/cli.ts` is the Commander.js entry point; it registers handlers from `src/commands/*.ts` for `init`, `run`, `scan`, `plan`, `resume`, `review`, `history`, and related commands.
- `src/commands/run.ts` drives execution through `src/lib/pipeline.ts`; agent invocation, testing, sessions, GitHub state, prompts, and worktrees are separated into focused modules under `src/lib/`.
- GitHub is the database: issues provide the kanban and work definitions, labels represent workflow state, pull requests hold reviews, and Actions provides CI. GitHub access is centralized in `src/lib/github.ts`.
- `src/engine/` contains agent CLI selection, argument construction, and prerequisite checks; `templates/` contains files distributed to new projects.
- `.alpha-loop/` stores this repository’s loop configuration, tracked learnings, source templates, and gitignored session artifacts.

## Conventions
- Node.js, strict TypeScript, ESM, Commander.js, and pnpm; local imports include `.js` extensions and built-in modules use the `node:` prefix.
- Code favors small functional modules rather than classes, with command orchestration in `src/commands/` and reusable behavior in `src/lib/`.
- Jest tests live under `tests/`, mirror the source layout, and use `.test.ts`; run them with `pnpm test` and compile with `pnpm build`.
- Tests must close servers and HTTP connections, use fake timers for polling or heartbeat behavior, and avoid real `setTimeout`/`setInterval`.
- New CLI features must be implemented in `src/commands/`, registered in `src/cli.ts`, tested in the matching `tests/` area, and reflected in public command documentation.

## Critical Rules
- Do not modify `AGENTS.md` unless explicitly requested; do not directly edit generated `.Codex/`, `.agents/`, or `.codex/` content.
- `.alpha-loop/templates/` is this repository’s workflow source of truth and should be changed through `alpha-loop review --apply`, not edited directly.
- Keep `templates/` and `.alpha-loop/templates/` distinct: the former ships to users, while the latter configures this repository.
- Command flags/help, configuration options, public APIs, and directory changes must stay synchronized across implementation, tests, `README.md`, and `CLAUDE.md`.
- Never publish manually or edit the package version; merging conventional commits to `master` triggers the automated release workflow.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
