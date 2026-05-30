## Architecture
- CLI entry point is `src/cli.ts`; it uses Commander to register subcommands and dispatches to handlers in `src/commands/*.ts`.
- Main loop execution flows through `src/commands/run.ts` into shared libraries such as `lib/pipeline.ts`, `lib/agent.ts`, `lib/github.ts`, `lib/testing.ts`, `lib/session.ts`, and `lib/worktree.ts`.
- GitHub is the database: issues are work items, labels are state, PRs are review artifacts, and Actions provide CI. GitHub access is centralized in `src/lib/github.ts`.
- Key directories: `src/commands` contains CLI commands, `src/lib` shared logic, `src/engine` agent/prerequisite plumbing, `tests` mirrors source tests, `templates` contains npm-distributed starter assets, and `.alpha-loop/templates` contains this repo’s own loop config.

## Conventions
- Code is TypeScript, strict mode, ESM; local imports use `.js` extensions and Node built-ins use the `node:` prefix.
- Style is mostly functional; avoid classes unless wrapping external APIs or matching an existing pattern.
- Tests use Jest with `.test.ts` files under `tests/`; run with `pnpm test`, and build with `pnpm build`.
- New CLI commands should be implemented under `src/commands`, registered in `src/cli.ts`, covered in `tests`, and reflected in docs/help text when user-facing behavior changes.

## Critical Rules
- Do not modify `AGENTS.md` unless explicitly asked.
- Do not edit `.Codex/`, `.agents/`, or `.codex/` directly; they are generated from template sources.
- Do not confuse `templates/` with `.alpha-loop/templates/`: root `templates/` ships to users, while `.alpha-loop/templates/` controls this repo’s own loop behavior.
- Do not manually publish, run `pnpm publish`/`npm publish`, or bump package versions; releases are automated from commits merged to `master`.
- Tests must close HTTP servers/connections and use fake timers for timer-based behavior; avoid real timers that keep Jest open.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
