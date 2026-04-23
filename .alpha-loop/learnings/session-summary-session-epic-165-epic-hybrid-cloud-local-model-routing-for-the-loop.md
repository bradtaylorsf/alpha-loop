# Session Summary: session/epic-165-epic-hybrid-cloud-local-model-routing-for-the-loop

## Overview
Epic #165 shipped end-to-end hybrid cloud/local model routing across 7 sub-issues (schema → local backend → escalation → telemetry → eval matrix → auto-tuning → docs) with a 100% success rate and zero test-fix retries. The loop delivered clean builds and green tests on first pass for every issue, with reviewers catching meaningful gaps (silent env-var misrouting on #159, missing `.gitignore` on #160, model-ID drift on #164) before merge. The dominant cross-cutting issue is layering features with partially unwired surfaces — config types, exported helpers, and doc claims that outrun their actual call sites.

## Recurring Patterns
- **Warn-and-skip parsing for optional config blocks** (#158, #161) — invalid sub-fields log `[config]` warnings and drop, preserving backwards compat and forward-compat with future schema additions
- **Auto-inject endpoint env vars at the spawn boundary** (#159) — never at config load, so user shell exports remain source of truth; test precedence explicitly (auto-inject → user export → `options.env`)
- **Restrict preflight HTTP probes to loopback only** (#159, #161) — `localhost`, `127.0.0.1`, `::1`, `*.local` — avoid spurious network calls / rate-limiting against remote endpoints
- **Per-stage layering on top of legacy `agent:`/`model:`** (#160, #161) — `routing.stages.*` + `routing.endpoints.*` + `routing.fallback` cleanly extends without breaking existing configs
- **Reuse already-wired infrastructure** (#163) — #163's auto-demotion hooked into #160's EscalationStore instead of building a parallel path
- **Stub-with-TODO + `isStubPatch()` gating** (#162, #163) — lets eval cases ship rate-limited; scoring degrades gracefully until golden patches are backfilled

## Recurring Anti-Patterns
- **Config/type surface exceeds implementation** — unused params (`_issueId` on #158), unimplemented fallback modes (`retry` on #160), exported turn-state APIs only exercised by tests (#160), `evaluateDemotion()` tested but never invoked (#163), `scorers:` block parsed docs but not consumed by runner (#162)
- **Docs claim behavior the code doesn't implement** — #159 shipped docs promising auto-injected env vars before the wiring existed (silent paid-API misrouting); #164 copy-paste YAML examples drifted from canonical IDs in `.alpha-loop/evals/profiles/*.yaml`
- **New stages/features don't hit every call site** — #160 added `summary` routing but the post-PR `assumptions` step at `pipeline.ts:1081` still uses raw `spawnAgent`; #159 parsed `routing:` config that was inert until #160/#161 wired callers
- **Brittle verification harnesses** — #164's inline `node -e` heredoc with embedded regex errored out before validating anything; reviewer's manual check was the only real signal
- **Epic ACs not rewritten per child issue** (#158) — parent's runtime-wiring AC appeared unmet on a schema-only child, creating the illusion of missed scope

## Recommendations
- **Reviewer agent: add a "call-site audit" check for new types/stages/backends.** When a PR adds a routing stage, agent type, fallback mode, or exported helper, grep every spawn/dispatch site and flag surfaces declared in config but not consumed in runtime code. This would have caught #159's missing env injection, #160's unwired `summary` stage and unused `newTurnState`/`shouldEscalate`, #162's ignored `scorers:` block, and #163's orphaned `evaluateDemotion()`.
- **Update `docs-sync` skill: grep before introducing identifiers in docs.** When adding model IDs, config keys, profile names, or env var names to docs, search `.alpha-loop/evals/profiles/`, `src/**`, and existing docs for canonical values and reuse verbatim. Flag any identifier that appears only in docs. Would have caught #164's `claude-opus-4-7` / `qwen3-coder-30b-a3b` / `gemma-4-31b` drift.
- **Update reviewer/docs-sync: trace code paths when docs claim auto-behavior.** Any doc statement of the form "X is auto-set/auto-injected/auto-detected" requires tracing from CLI entry to the child-process spawn or equivalent boundary before approval — don't trust the doc as evidence the wiring exists.
- **Implementer prompt: ban unused parameters and speculative exports.** Don't carry forward `_issueId`-style params "for future wiring" and don't export helpers (`newTurnState`, `evaluateDemotion`) that only tests invoke. Add them when a real caller needs them.
- **Planner/issue-rewrite: restate parent epic ACs in child-scope terms.** When breaking an epic into sub-issues, rewrite each child's ACs to match its actual deliverable so "deferred" requirements don't read as missed scope (see #158).
- **Verification policy: no inline `node -e` with regex/heredocs.** Write a one-shot script file or run `pnpm test` against a real test. Shell+JS escape interactions make inline validators silently fail (see #164).
- **Track backfill debt as a follow-up issue.** #162 and #163 shipped 17 stub `golden.patch` files. Open a single follow-up to (a) wire `diffSimilarity()` into `runMatrix()`, (b) consume `scorers.test_pass_rate.min_fraction` in `parseChecks()`, and (c) backfill the stubs via `gh pr diff` once rate-limits reset.

## Metrics
| Metric | Value |
|--------|-------|
| Issues processed | 7 |
| Success rate | 100% |
| Avg duration | 1106s |
| Total duration | 129 min |
