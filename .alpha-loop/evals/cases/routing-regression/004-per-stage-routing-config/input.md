# Add per-stage model routing config schema to .alpha-loop.yaml

## Summary

Introduce a `routing` block that names endpoints and wires each Loop stage
(plan, build, test_write, test_exec, review, summary) to a specific model
+ endpoint. Replaces the per-step model override for users adopting the
new routing profile model.

## Acceptance Criteria

- [ ] `routing.endpoints` defines named endpoints with `type` + `base_url`
- [ ] `routing.stages` maps each stage to `{ model, endpoint }`
- [ ] Invalid stage/endpoint references log a warning and are ignored
- [ ] Existing `pipeline.<step>` overrides remain respected
