# Idempotent plan with milestone reuse, label auto-creation, and --resume

## Summary

`alpha-loop plan` should tolerate repeat runs: reuse existing milestones,
auto-create missing labels, and offer `--resume` to continue from a saved
plan draft instead of re-prompting the agent.

## Acceptance Criteria

- [ ] Re-running `plan` doesn't create duplicate milestones
- [ ] Labels referenced in the plan are auto-created if missing
- [ ] `--resume` reads `.alpha-loop/plan.json` and picks up where it left off
