# Alpha Loop Docs

This folder holds the longer-form guides that support the README. Start with the README for install and basic usage, then use these docs when you need a deeper workflow.

## Planning And Execution

- [Epics](epics.md) - parent issues, ordered sub-issues, queue execution, verification-only runs, and epic safety rails.
- [Superpowers add-command plan](superpowers/plans/2026-04-15-add-command.md) and [design spec](superpowers/specs/2026-04-15-add-command-design.md) - historical planning artifacts for the `add` workflow.

## Hosted Operation

- [Hosted Alpha Loop Setup](hosted-alpha-loop.md) - running Alpha Loop as a repo-scoped worker for websites and browser apps.
- [Hosted Automation Policy](hosted-policy.md) - safe starter policy profiles, allowed commands, protected paths, and human-review gates.
- [Hosted Lifecycle Events](hosted-events.md) - webhook, log, and command event payloads for session and daemon state.
- [Web/App Verification Profile](web-app-profile.md) - browser verification, screenshots, preview URLs, console/network checks, and QA handoff.

## Models, Routing, And Telemetry

- [Local Models](local-models.md) - LM Studio and Ollama setup, hardware guidance, and local endpoint notes.
- [Routing Profiles](routing-profiles.md) - copy-pasteable routing profiles for all-frontier, hybrid, all-local, and budget-focused runs.
- [Telemetry](telemetry.md) - per-stage telemetry fields, storage paths, and routing-analysis usage.

## Evaluation And Benchmarking

- [Benchmark Design](benchmark-design.md) - RFC for Alpha-Loop-Bench, including fixture isolation, task tiers, layered oracles, repeated runs, and methodology A/B tests.

## Local-Only Artifacts

Runtime state should stay out of this folder and out of the repo root:

- `.alpha-loop/sessions/` - local session manifests, logs, screenshots, and queue state.
- `.alpha-loop/traces/` - local telemetry traces.
- `.alpha-loop/auth/` - local browser auth state.
- `.worktrees/` - temporary issue worktrees.

Root-level `sessions/` is legacy cleanup territory and should not be committed.
