

## What We're Building

Alpha Loop is a TypeScript CLI that orchestrates an automated development loop for coding agents. It manages the full cycle: planning (GitHub Issues), implementation (AI agents), code review, gap analysis, Playwright-based testing, and shipping (PRs). It includes session-based self-learning that improves testing environments, coding context, and agent/skill recommendations after each run.

## Who It's For

Technical users — developers and engineers who run coding agents from the terminal. No UI; all interaction is CLI flags, config files, and stdout/stderr output. Assume users are comfortable with git, GitHub workflows, and YAML configuration.

## Current Stage & Priority

MVP / early development. The goal is core flows working end-to-end reliably. No polish, no optional features, no premature abstraction. Get the loop running: pick an issue, spin up an agent, test the output, review it, ship or retry. Self-learning and gap analysis can be minimal but must exist in the loop from day one, even if rudimentary.

## Decision Guidelines

- **End-to-end first.** Build the thinnest possible path through the entire loop before deepening any single phase. A working loop that handles happy paths beats a perfect planner with no reviewer.
- **GitHub is the database.** Issues are the kanban, labels are state, PRs are reviews, Actions are CI. Do not introduce external state stores or databases.
- **Agent-agnostic by design.** The loop orchestrates agents via CLI commands. Support Claude Code first, but never hardcode agent-specific logic into the core loop. Agent config lives in YAML.
- **Fail loudly, recover gracefully.** Log structured errors, surface them clearly in CLI output. If a phase fails, the loop should know how to retry or skip with clear reporting — not silently continue.
- **Defer anything cosmetic.** No color themes, no progress bars, no interactive prompts. Plain text output, exit codes, and log files. Add polish only after the loop is reliable.
- **Self-learning is a first-class loop phase, not an afterthought.** Even in MVP, each session should emit a structured learnings artifact (testing gaps, agent performance, suggested prompt changes). The format matters more than the sophistication.
- **Lean on reference code.** The `reference/` directory contains debugged patterns for JSONL parsing, GitHub API interaction, git worktree management, and logging. Adopt these before writing new implementations.

## What Good Looks Like

- A developer runs `pnpm loop:once`, and the CLI picks a labeled GitHub issue, delegates it to a configured agent, runs Playwright tests against the result, performs a code review pass, and opens a PR — all without manual intervention.
- The loop handles common failures (test flakes, agent errors, git lock contention) with retries and clear log output, not crashes.
- After each session, a structured learnings file is written that a future session can read to make better decisions.
- The codebase is simple enough that a developer can read `scripts/loop.sh` and the TypeScript entry point and understand the full flow in under 30 minutes.
