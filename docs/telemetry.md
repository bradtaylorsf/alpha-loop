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
  "cost_usd": 0.0598,
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
| `tokens_in`      | number            | Input tokens                                                          |
| `tokens_out`     | number            | Output tokens                                                         |
| `cost_usd`       | number            | USD cost. Always `0` for `anthropic_compat` / `openai_compat` endpoints |
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

## CLI surface

### `alpha-loop history <session> --telemetry`

Prints a per-stage table for one session:

```
stage          model                endpoint       tok_in  tok_out  cost_usd  wall_s  tool_err  ok
plan           claude-sonnet-4-6    anthropic-prod  4,120     890    $0.0147   12.34         0  ok
implement      qwen3-coder-30b-a3b  lmstudio       18,432   3,101    $0.0000   88.12         2  ok
review         claude-opus-4-6      anthropic-prod 12,010   1,220    $0.2738   21.40         0  ok
```

### `alpha-loop report routing [--profile <name>] [--since <dur>] [--json]`

Aggregates across every session in `.alpha-loop/traces/` and joins with
`.alpha-loop/learnings/session-*.json` manifests to compute shipped-issue
counts.

Outputs per (stage, model) cells:

- `pipeline_success_rate` — fraction of sessions that shipped a successful
  issue while this cell was active
- `cost_per_issue_shipped` — `sum(cost_usd) / shipped_issues`, `null` when no
  issues shipped
- `median_wall_time_s` — median wall-clock time per invocation
- `tool_error_rate` — `sum(tool_errors) / sum(tool_calls)`
- `delta_*_vs_baseline` — delta vs the highest-cost cell for the same stage
  (the implicit "all-frontier" reference)

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
      "total_cost_usd": 2.4510,
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

`costs.json` in the same trace directory is the existing run-level summary and
is unchanged. `stages.jsonl` is additive and higher-granularity — one line per
agent invocation, vs one entry per step aggregated across invocations.
