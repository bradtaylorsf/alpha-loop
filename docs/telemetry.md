# Per-Stage Telemetry

Alpha Loop emits one telemetry record per stage invocation so that routing
decisions — "is this local model good enough for the Build stage?" — can be
answered with apples-to-apples data across many issues. Session-level cost
logs hide which stage burned the tokens; per-stage telemetry does not.

## Where it's stored

```
.alpha-loop/traces/<session>/stages.jsonl
```

Each line is a JSON object with the following shape:

```json
{
  "stage": "implement",
  "model": "claude-sonnet-4-6",
  "endpoint": "anthropic-prod",
  "endpoint_type": "anthropic",
  "tokens_in": 12480,
  "tokens_out": 2156,
  "token_source": "reported",
  "cost_usd": 0.0598,
  "cost_source": "reported",
  "wall_time_s": 42.183,
  "tool_calls": 18,
  "tool_errors": 1,
  "stage_success": true,
  "started_at": "2026-04-23T18:12:34.123Z",
  "profile": "hybrid-v1",
  "issue_num": 161
}
```

### Field reference

| Field            | Type              | Notes                                                                 |
|------------------|-------------------|-----------------------------------------------------------------------|
| `stage`          | string            | `plan`, `implement`, `test_fix`, `review`, `review_fix`, `verify_fix`, `assumptions`, `batch-plan`, `batch-implement`, `batch-test_fix`, `batch-review`, `batch-review_fix` |
| `model`          | string            | Model id used for this invocation                                     |
| `endpoint`       | string            | Named endpoint from `routing.endpoints`; `default` when routing isn't used |
| `endpoint_type`  | string            | `anthropic`, `anthropic_compat` (LM Studio), or `openai_compat` (Ollama) — optional |
| `tokens_in`      | number            | Input tokens; authoritative only when `token_source` is `reported`     |
| `tokens_out`     | number            | Output tokens; authoritative only when `token_source` is `reported`    |
| `token_source`   | string            | `reported`, `estimated` (from output length), or `unmeasured` (legacy) |
| `cost_usd`       | number or null    | USD cost; `null` means the invocation could not be measured or priced  |
| `cost_source`    | string            | `reported`, `priced` (measured tokens × configured price), or `unmeasured` |
| `wall_time_s`    | number            | Wall-clock duration of the agent invocation, in seconds               |
| `tool_calls`     | number            | Count of `tool_use` blocks in the stream                              |
| `tool_errors`    | number            | Count of `tool_result` blocks with `is_error: true`, or classifier fallback |
| `stage_success`  | boolean           | `true` when the agent process exited with code 0                      |
| `started_at`     | ISO-8601 string   | Timestamp captured at the start of the stage                          |
| `profile`        | string (optional) | Active routing profile (deterministic pick for multi-profile configs) |
| `issue_num`      | number (optional) | Issue number the stage was processing                                 |

### Backward compatibility

Sessions that completed before this change contain no `stages.jsonl`. Readers
(`alpha-loop history <session> --telemetry`, `alpha-loop report routing`) fall
back to the manifest's embedded `stages` array if present, otherwise print a
`No per-stage telemetry recorded for this session.` message and continue.
Legacy stage records that lack provenance fields are retained but treated as
unmeasured; their historical zeroes and token counts are not promoted to
authoritative measurements.

## CLI surface

### `alpha-loop history <session> --telemetry`

Prints a per-stage table for one session:

```
stage          model                endpoint       tok_in  tok_out  cost_usd  wall_s  tool_err  ok
plan           claude-sonnet-4-6    anthropic-prod  4,120     890    $0.0147   12.34         0  ok
implement      unknown              default        ~18,432  ~3,101    n/a      88.12         2  ok
review         claude-opus-4-6      anthropic-prod 12,010   1,220    $0.2738   21.40         0  ok
```

`~` marks a length-derived token estimate. Session totals sum reported tokens
only. If any stage cost is unmeasured, the session cost total is `n/a` rather
than a misleading partial dollar amount.

### `alpha-loop report routing [--profile <name>] [--since <dur>] [--json]`

Aggregates across every session in `.alpha-loop/traces/` and joins with
`.alpha-loop/learnings/session-*.json` manifests to compute shipped-issue
counts.

Outputs per (stage, model) cells:

- `pipeline_success_rate` — fraction of sessions that shipped a successful
  issue while this cell was active
- `cost_per_issue_shipped` — `sum(cost_usd) / shipped_issues`, `null` when no
  issues shipped or when any run in the cell has unmeasured cost
- `median_wall_time_s` — median wall-clock time per invocation
- `tool_error_rate` — `sum(tool_errors) / sum(tool_calls)`
- `delta_*_vs_baseline` — delta vs the highest-cost cell for the same stage
  (the implicit "all-frontier" reference)

Token totals include reported counts only. `token_measurement_runs` and
`cost_measurement_runs` expose coverage. Incomplete cell/global cost totals are
`null`, and unmeasured cells are excluded from cost baselines and routing
promotion decisions. An explicit `0/0` model price remains a measured free
cost; an absent pricing key does not.

The command accepts zero arguments (all-time, all profiles). A duration may be
supplied as `30d`, `12h`, `45m`, or `90s`.

### JSON export shape

`alpha-loop report routing --json` emits:

```json
{
  "cells": [
    {
      "stage": "implement",
      "model": "claude-sonnet-4-6",
      "endpoint": "anthropic-prod",
      "endpoint_type": "anthropic",
      "profile": "hybrid-v1",
      "runs": 42,
      "tokens_in": 524288,
      "tokens_out": 90123,
      "token_measurement_runs": 42,
      "total_cost_usd": 2.4510,
      "cost_measurement_runs": 42,
      "pipeline_success_rate": 0.905,
      "cost_per_issue_shipped": 0.0580,
      "median_wall_time_s": 41.0,
      "tool_error_rate": 0.012,
      "delta_cost_per_issue_shipped_vs_baseline": -0.0120,
      "delta_median_wall_time_s_vs_baseline": 2.3,
      "delta_tool_error_rate_vs_baseline": 0.004,
      "delta_pipeline_success_rate_vs_baseline": -0.02
    }
  ],
  "total_sessions": 6,
  "total_stages": 128,
  "total_issues_shipped": 34,
  "total_cost_usd": 6.7812,
  "cost_measurement_runs": 128,
  "token_measurement_runs": 128,
  "filters": {
    "profile": "hybrid-v1",
    "since_ms": 1714000000000,
    "baseline": "all-frontier"
  }
}
```

The eval system (`alpha-loop eval`) can ingest this JSON directly — every
field is stable and typed in `src/lib/telemetry.ts` under `RoutingAggregation`.

## Relationship to `costs.json`

`costs.json` in the same trace directory is the run-level summary.
Unmeasured step costs now remain `null`, so an incomplete run cannot silently
become `$0`. Its per-step token totals include measured entries only and expose
`token_measurement_entries` / `entries` coverage. `stages.jsonl` remains the
higher-granularity source with explicit per-invocation provenance.

When an automation cost budget is configured, an unmeasured step blocks the
budget check with an explicit measurement-unavailable reason; it is never
counted as zero spend.
