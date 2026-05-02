# Per-stage telemetry + cost-per-issue aggregation (alpha-loop report routing)

## Summary

Capture per-stage token/cost telemetry for every Loop run and expose it via
`alpha-loop report routing` so we can compare profiles head-to-head.

## Motivation

Session-level cost totals hide which stage is expensive. Without per-stage
attribution we can't tell whether a profile swap is saving money on build
or burning it on review.

## Acceptance Criteria

- [ ] Every Loop run appends one row per (stage, model, endpoint) to a
      session-local telemetry log
- [ ] Token counts and cost estimates are tracked per stage
- [ ] `alpha-loop report routing` aggregates across sessions and shows
      cost-per-issue grouped by profile
- [ ] `--since <duration>` filters the window (e.g. 30d, 12h)
- [ ] Output supports both human table and `--json`
