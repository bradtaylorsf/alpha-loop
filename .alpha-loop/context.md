## Architecture
- `src/cli.ts` is the Commander entry point; handlers live in `src/commands/`. `run.ts` coordinates the Plan → Build → Test → Review → Ship workflow through shared pipeline libraries.
- GitHub is the database: issues track work, labels represent state, PRs support review, and Actions run CI. Access GitHub through `src/lib/github.ts`.
- `src/engine/` handles agent CLI arguments and prerequisites. `src/lib/` contains configuration, prompts, sessions, worktrees, testing, learning, and shell helpers.
- `.alpha-loop.yaml` configures agents, models, and harnesses. Root `templates/` ships starter configuration; `.alpha-loop/templates/` configures this repository’s own loop.

## Conventions
- Node.js and strict TypeScript with ESM; use `.js` import extensions, `node:` built-in imports, functional patterns, and pnpm. Avoid classes except for external API wrappers.
- Jest tests live in `tests/`, mirror `src/`, and use `.test.ts` filenames. Run `pnpm test`; compile with `pnpm build`.
- Tests must close HTTP connections and servers during teardown. Use Jest fake timers for polling and heartbeat tests; avoid real timers. Jest uses `forceExit: true` and a 30-second timeout.
- Add command handlers under `src/commands/` and register them in `src/cli.ts`. Keep command help, README/CLAUDE command documentation, and configuration documentation aligned with changes.

## Critical Rules
- Do not modify `AGENTS.md` unless explicitly requested. Change `.alpha-loop/templates/` through `alpha-loop review --apply`; never directly edit generated `.Codex/`, `.agents/`, or `.codex/` files.
- Do not confuse distribution `templates/` with repository-specific `.alpha-loop/templates/`: changes to the former affect newly initialized user projects.
- Preserve agent independence: keep harness argument construction, prompt generation, and configuration compatible when changing agent integrations.
- Never manually publish or bump versions. `.github/workflows/release.yml` automates releases from eligible pushes to `master`; conventional commit messages determine version increments.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
- Context source: supplied project instructions; repository files and current runtime state were not inspected because tool use was prohibited.
