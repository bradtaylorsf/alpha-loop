# Retry-with-escalation: local tool-call failure falls back to frontier

## Summary

When a local model fails a tool call (malformed JSON, wrong schema, timeout),
retry the step on the configured frontier fallback. Track the rolling error
rate per stage; if it crosses the configured threshold, pin that stage to
the fallback model for the configured revert window.

## Motivation

Local models sporadically produce invalid tool arguments. Without automatic
escalation every flaky local call becomes a hard run failure, which tanks
the hybrid profile's pipeline-success rate.

## Acceptance Criteria

- [ ] `routing.fallback` config accepts `on_tool_error: escalate | retry | fail`
- [ ] Escalation uses the configured `escalate_to` model + endpoint
- [ ] Rolling-error-rate window (default 10 issues) triggers stage pinning
- [ ] Pinned stages revert after `escalation_revert_ms` (default 24h)
