# Routing-Regression Case Format

This directory holds the `routing-regression` eval suite — a set of
previously-shipped issues with a known-good merged PR that act as a
regression harness. Every case re-runs the same issue under each routing
profile so we can detect quality drops when new models ship.

## Why this suite exists

Model churn (Gemma, Llama, Qwen refreshes) makes promotions/demotions of
a routing profile hard to justify without a reproducible score. Each case
is a real, reviewed PR — the canonical "a competent implementation looks
like this" target. Scoring compares the live profile's output against
that target.

## Directory layout

```
.alpha-loop/evals/cases/routing-regression/
  CASE_FORMAT.md              # this file
  001-issue-slug/
    metadata.yaml
    input.md                  # redacted issue body
    golden.patch              # merged PR diff (may be stub if not yet backfilled)
    checks.yaml               # pass/fail rubric
  002-another-issue/
    ...
```

## metadata.yaml

Required fields:

```yaml
id: "001-issue-slug"           # directory name; alphanumeric + dashes
source_pr: 177                 # merged PR number in this repo
source_issue: 161              # issue the PR closed
base_sha: "c9132a17"           # commit on which the PR was merged
ci_status: success             # 'success' when this PR was green in CI
description: "Short one-liner"
tags:
  - routing-regression
  - telemetry                  # problem domain tags (optional)
source: routing-regression     # keeps it filterable with --tags
```

## input.md

The issue body that was handed to the agent. Redact any repo-private
URLs, tokens, or stakeholder names before check-in. The build script
runs the secret scanner over every file — dirty cases are rejected at
commit time and at runtime.

Start with a single `# Title` heading; the first line is treated as the
issue title by the loader.

## golden.patch

The unified diff of the merged PR at `base_sha`. `diff_similarity`
compares the profile's generated patch against this file; it's
**informational only** — a valid alternative implementation is fine.

If the diff is too large / sensitive to check in, the patch file may be
a small stub containing a `# TODO: backfill` marker. Cases with stub
diffs skip the `diff_similarity` score but still run `pipeline_success`
and `test_pass_rate`.

## checks.yaml

Declares which scorers apply and how to score them:

```yaml
type: routing-regression
timeout: 900
scorers:
  pipeline_success:
    hard: true              # if false, the whole case fails
  test_pass_rate:
    min_fraction: 1.0       # all original tests must stay green
  diff_similarity:
    informational: true     # never fails the case; just reported
```

## Adding a case

1. Pick a merged PR with green CI and a clear issue body.
2. Run `pnpm tsx scripts/build-routing-regression-cases.ts <PR#> [<PR#> ...]`
   to scaffold the directory.
3. Inspect `input.md` / `golden.patch` and redact anything sensitive.
4. Adjust `checks.yaml` timeouts if the original ran long.
5. Commit — the pre-commit secret scan fails the push on any hit.

## Running the suite

```
alpha-loop eval --tags routing-regression
alpha-loop eval --matrix --tags routing-regression           # dry-run (safe default)
alpha-loop eval --matrix --tags routing-regression --execute # real pipeline runs
```

The matrix form runs every case under all three canonical profiles and
writes a Markdown + CSV comparison to `eval/reports/routing-<date>.{md,csv}`.

**Why `--execute` is opt-in:** the current eval pipeline calls
`processIssue()`, which mutates live GitHub state (project board, labels,
branches). Case IDs like `001-…` parse back to real issue numbers on the
active repo, so running a matrix without isolation would update issues
#1, #2, … and assign them to the current user. Until fixture isolation
lands (clean clone at `source_pr`'s `base_sha` with no GitHub mutation),
the default `--matrix` run is a dry-run that validates profile YAML and
case structure and emits a SKIP-marked report. Pass `--execute` only on a
self-hosted runner or scratch repo where GitHub side-effects are
acceptable.
