Here's the project context:

---

## Architecture
- **CLI entry**: `src/cli.ts` uses Commander.js to register all subcommands (`run`, `plan`, `triage`, `eval`, `evolve`, etc.), most lazy-loaded via dynamic `import()`
- **Pipeline core**: `src/lib/pipeline.ts` orchestrates the Plan→Build→Test→Review→Ship loop; `src/lib/agent.ts` shells out to whichever AI CLI is configured (claude, codex, opencode)
- **GitHub as database**: `src/lib/github.ts` wraps `gh` CLI for issues, PRs, labels, milestones — no traditional DB; state lives in GitHub labels and issue metadata
- **Eval system**: `src/lib/eval*.ts` + `src/commands/eval.ts` provide a self-improving eval suite with step-level and e2e cases, scoring, Pareto analysis, and SWE-bench import
- **Config**: `.alpha-loop.yaml` at project root defines repo, agent, harnesses, pricing; loaded by `src/lib/config.ts` via Zod validation

## Conventions
- TypeScript strict mode, ESM, `.js` extensions in imports, functional style (no classes), `node:` prefix for builtins
- Tests in `tests/` mirroring `src/` structure, Jest with `ts-jest`, run via `pnpm test` (`--runInBand`, `forceExit: true`, 30s timeout)
- New commands: add handler in `src/commands/`, register in `src/cli.ts`; new lib modules go in `src/lib/`
- Templates shipped to users live in root `templates/`; this repo's own dev config lives in `.alpha-loop/templates/`
- Releases are fully automated — commit to `master` triggers CI versioning + npm publish

## Critical Rules
- **Never manually bump versions** or run `npm publish` — CI handles it from commit messages (`feat:` → minor, `fix:` → patch)
- **Never edit `.claude/`, `.agents/`, `.codex/` directly** — they are auto-synced from `.alpha-loop/templates/` via `alpha-loop sync`
- **`CLAUDE.md` is protected** — do not modify without explicit request
- Tests must close all connections in `afterEach`/`afterAll`; use `jest.useFakeTimers()` for timer-based tests; no real `setTimeout` in tests
- Two `templates/` dirs exist: root = npm distribution defaults, `.alpha-loop/templates/` = this repo's own config — edit the right one

## Active State
- Test status: _(filled by loop)_
- Recent changes: _(filled by loop)_
