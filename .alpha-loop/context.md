## Architecture
- CLI entry at `src/cli.ts` (Commander.js); subcommands lazy-imported from `src/commands/*.ts` (run, init, scan, plan, add, triage, roadmap, resume, review, eval, evolve, sync, history, auth, vision, learn).
- Core loop lives in `src/lib/pipeline.ts` driving Plan→Build→Test→Review→Ship via `agent.ts`, `testing.ts`, `verify.ts`, `learning.ts`, `session.ts`, `worktree.ts`.
- "Database" is GitHub: `src/lib/github.ts` wraps the `gh` CLI — issues are the kanban, labels the state machine, PRs the reviews. No local DB.
- Multi-agent harness support in `src/engine/agents.ts` (Claude/Codex/OpenCode arg builders); `src/lib/templates.ts` + `commands/sync.ts` sync `.alpha-loop/templates/` to `.claude/`, `.agents/`, `.codex/`.
- Eval subsystem: `src/lib/eval.ts`, `eval-runner.ts`, `eval-checks.ts`, `score.ts`, `eval-swebench.ts`, driven by `commands/eval.ts` and `commands/evolve.ts`.

## Conventions
- TypeScript strict + ESM, Node ≥20, pnpm only. Imports use `.js` extensions and `node:` prefix for built-ins.
- Functional style, no classes except external-API wrappers. Commander actions always `await import()` their command module.
- Jest (`ts-jest`, CJS transform via `jest.config.cjs`), `forceExit: true`, `testTimeout: 30000`, tests mirror `src/` in `tests/` with `.test.ts` suffix, run via `pnpm test` (`--runInBand`).
- New CLI subcommand: add command file in `src/commands/`, register in `src/cli.ts` with lazy dynamic import, add matching `tests/commands/*.test.ts`.
- New skill/agent prompt: edit `templates/` (shipped to new users) vs `.alpha-loop/templates/` (this repo's own loop) — never edit generated `.claude/`, `.agents/`, `.codex/`.

## Critical Rules
- Do NOT modify `CLAUDE.md`, `.alpha-loop/templates/`, or generated `.claude/`/`.agents/`/`.codex/` directly — changes flow through `alpha-loop review --apply` and `sync`.
- Do NOT bump `package.json` version or run `pnpm publish` — `.github/workflows/release.yml` versions from conventional commits (`feat:`/`fix:`/`BREAKING CHANGE`) on merge to `master`.
- Worktrees live in `.worktrees/` inside the project, never `../issue-N` in the parent dir (see `src/lib/worktree.ts`).
- Tests must close HTTP connections/timers and use `jest.useFakeTimers()` — no real `setTimeout`/`setInterval`, or Jest hangs.
- Keep `cli.ts` command definitions in sync with README/CLAUDE.md command tables; epic flags (`--epic`, `--skip-epic`, `--verify-only`) are wired through `src/lib/epics.ts` + `verify-epic.ts`.

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)
