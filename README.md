# Alpha Loop

Agent-agnostic automated development loop. Fetches issues from your GitHub project board (optionally filtered by milestone), implements them with an AI coding agent, runs tests, reviews the code, and creates PRs — then moves to the next issue until all matching issues are done.

**The Loop:** Plan (GitHub Issues) -> Build (AI Agent) -> Test -> Review -> Verify -> Learn -> Ship (PR)

## Installation

```bash
# Install globally
npm install -g @bradtaylorsf/alpha-loop

# Or run directly
npx @bradtaylorsf/alpha-loop
```

### Prerequisites

- **Node.js 20+**
- **git** — for worktree isolation
- **[GitHub CLI](https://cli.github.com/)** (`gh`) — authenticated with `gh auth login`
- **AI agent CLI** — set `agent` in your config to one of:
  - [Claude Code](https://claude.ai/code) (`claude`) — default
  - [Codex](https://developers.openai.com/codex/cli/reference) (`codex`)
  - [OpenCode](https://github.com/sst/opencode) (`opencode`)
- **[Playwright CLI](https://www.npmjs.com/package/@playwright/cli)** (optional) — for live verification with screenshots

## Quick Start

```bash
# 1. Initialize — runs full onboarding (config, vision, scan, sync)
cd your-project
alpha-loop init

# 2. Edit .alpha-loop.yaml if needed (agent, model, test_command, etc.)

# 3. Run the loop — you'll be prompted to pick an epic or milestone
alpha-loop run

# Or target a specific milestone directly
alpha-loop run --milestone "v1.0"

# Or process one ready issue directly
alpha-loop run --issue 42
```

### Recommended Epic-First Flow

For planned feature work, use epics as the unit you schedule and ship:

1. `alpha-loop triage` reviews open issues, proposes cleanup, and groups related ready issues into parent epics with ordered child checklists.
2. `alpha-loop roadmap` schedules parent epic issues into milestones, while still scheduling standalone issues that are not part of an epic.
3. `alpha-loop run --epic <N>` ships the epic's child issues in checklist order. Agents working on each child issue receive the parent epic goal, acceptance criteria, and sibling checklist as context.
4. `alpha-loop roadmap --queue` recommends the next ordered epic queue, explains blockers and risks, and prints the exact `alpha-loop run --epics ...` command.
5. `alpha-loop run --epics <A,B,C>` runs several parent epics back-to-back in that exact order, with a separate session branch and PR for each epic.
6. `alpha-loop run --verify-only <N>` re-runs the epic verification pass when you need to re-check shipped child issues against the parent acceptance criteria.

Use `alpha-loop run --issue <N>` when you need to restart or process exactly one ready issue. If that issue appears in exactly one open parent epic checklist, the agent receives that parent epic context and the resulting PR still includes `Part of #<epic>`; if multiple open epics reference it, Alpha Loop exits instead of guessing.

Milestones answer "when should this epic ship?" The epic checklist answers "what child issues ship, and in what order?"

## How It Works

Alpha Loop implements a 12-step pipeline for each issue:

1. **Status Update** — Labels issue `in-progress`, assigns to you, updates project board
2. **Worktree** — Creates an isolated git worktree so work doesn't conflict with other issues
3. **Plan** — Agent analyzes the issue and enriches it with implementation details
3b. **Fetch Comments** — Loads issue comments so the agent has the full conversation context
4. **Implement** — Agent writes the code, guided by project vision, context, comments, and learnings from previous issues
5. **Test + Retry** — Runs your test command; if tests fail, agent fixes and retries (up to `max_test_retries`)
6. **Verify + Retry** — Starts your dev server, uses playwright-cli to test the feature like a real user, takes screenshots
7. **Review** — A review agent reads the diff, checks for gaps, security issues, and missing wiring — fixes what it can
8. **Learn** — Extracts learnings (patterns, anti-patterns, what worked/failed) and commits them in the issue worktree
9. **Create PR** — Opens a PR with the implementation, learning artifact, test results, review summary, and verification status
9b. **Assumptions** — Agent summarizes assumptions and decisions made, posts as a comment on the issue for user validation
10. **Update Issue** — Posts results as a comment, updates labels
11. **Auto-Merge** — Merges the PR to the session branch (if enabled)
12. **Cleanup** — Removes the worktree

After all issues are processed, Alpha Loop:
1. **Auto-captures failures** as eval cases for regression testing
2. Generates a **session summary** aggregating learnings across issues when a session branch is being finalized
3. Runs a **post-session code review** on the full session diff to catch cross-issue integration problems
4. Creates the **session PR** with all findings included

### Milestone-Based Workflow

When you start the loop interactively, Alpha Loop shows open epics above milestones and lets you pick which target to work on:

```
  Open Epics

  1  Multi-tenant support #165 (0/7 done · milestone v1.0)

  Open Milestones

  2  v1.0 — MVP (5 open, 3/8 done · due 2026-04-15 · 1 scheduled epic)
  3  v1.1 — Polish (10 open, 0/10 done)

  0  All ready issues (no filter)

  Select [0-3]: 1
```

This lets you plan work in GitHub milestones and control exactly how much the loop processes per session. You can also pass `--milestone "v1.0"` to skip the prompt, or set `milestone: v1.0` in your config file. If that milestone has exactly one open parent issue labeled `epic`, Alpha Loop processes that epic's checklist; if it has multiple scheduled epics, it exits with their numbers and asks you to choose with `--epic <N>`. Use `--skip-epic --milestone "v1.0"` to force the flat milestone issue flow.

### Session Branches

When `auto_merge` is enabled (default), Alpha Loop creates a session branch (e.g., `session/20260331-002240`) and merges each issue's PR into it. This keeps your main branch clean until you're ready to merge the whole session.

### Learnings

Each completed issue produces a learning file in `.alpha-loop/learnings/` that is committed with that issue's implementation PR. It includes:
- What worked and what failed
- Reusable patterns discovered
- Anti-patterns to avoid
- Suggested skill/prompt updates

These learnings are automatically fed into future implementation prompts, so the agent gets smarter over time.

### Self-Improvement (`alpha-loop review`)

Run `alpha-loop review` to trigger the self-improvement loop. It reads all accumulated learnings, computes metrics (success rate, avg retries, common failures), gathers current agent/skill definitions, and asks the configured agent to propose targeted improvements:

- **Agent prompts** — bake in recurring patterns, eliminate anti-patterns
- **Skill definitions** — add/update skills based on what consistently works or fails
- **Testing environment** — fix Playwright config, port conflicts, auth state, data seeding issues
- **Harness configuration** — tune timeouts, retries, and defaults

Without `--apply`, proposals are saved to `learnings/proposed-updates/` for review. With `--apply`, changes are written and a draft PR is created.

### Eval System (`alpha-loop eval`)

Alpha Loop includes a self-improving eval system inspired by [Meta-Harness](https://arxiv.org/abs/2603.28052) (Lee et al., 2026). It captures real failures as eval cases and tracks composite scores over time to measure whether prompt/skill changes actually help. See the [Comprehensive Eval Guide](.alpha-loop/evals/GUIDE.md) for tutorials, use cases, and how-tos.

```bash
# Capture failures from recent sessions as eval cases
alpha-loop eval capture

# Capture quality failures from successful sessions (false positives)
alpha-loop eval capture --quality
alpha-loop eval capture --quality 190 --session my-session

# Run the eval suite and compute composite score
alpha-loop eval run

# View score history, Pareto frontier, or compare runs
alpha-loop eval scores
alpha-loop eval pareto
alpha-loop eval compare 1 2

# Greedy search over model configurations per pipeline step
alpha-loop eval search --models "haiku,sonnet,opus"

# Estimate cost before running
alpha-loop eval estimate

# Compare two config files side-by-side
alpha-loop eval compare-configs config-a.yaml config-b.yaml

# Apply a single routing profile before running
alpha-loop eval run --profile hybrid-v1

# Matrix run: replay the routing-regression set under every profile and emit a side-by-side report
# Defaults to a dry-run (validates profiles and case structure). Pass --execute to run pipelines for real.
alpha-loop eval run --matrix --tags routing-regression
alpha-loop eval run --matrix --profiles "all-frontier,hybrid-v1" --out eval/reports
alpha-loop eval run --matrix --tags routing-regression --execute  # real runs (see CASE_FORMAT.md)
```

Eval cases live in `.alpha-loop/evals/` and scores are appended to `scores.jsonl` (Git-friendly, append-only). The composite score formula is pass-rate primary with lightweight penalties for retries and duration. Recovered session results are flagged and excluded from aggregate scoring. Real API costs (tokens, USD) are tracked per case from agent output and used for the Pareto frontier.

Step-level evals test individual pipeline stages (plan, implement, test, test-fix, review, learn, skill) and run in seconds using LLM-judge and keyword checks:

```bash
# Run only step-level evals (fast, cheap)
alpha-loop eval --suite step

# Run evals for a specific step
alpha-loop eval --suite step --step review

# Convert between AlphaLoop and skill-creator eval formats
alpha-loop eval convert --direction to-skill
alpha-loop eval convert --direction from-skill --input path/to/evals.json

# Import SWE-bench cases from HuggingFace (requires Python + datasets)
alpha-loop eval import-swebench --count 10 --repo "django/django"
```

### Evolve (`alpha-loop evolve`)

The evolve command runs a Meta-Harness-style optimization loop: a proposer agent reads full execution traces, scores, and source code, then proposes targeted changes to prompts, skills, or config. Changes are evaluated against the eval suite — improvements are kept, regressions are reverted (autoresearch keep/discard pattern).

```bash
alpha-loop evolve                         # Run up to 5 iterations
alpha-loop evolve --max-iterations 10     # Run 10 iterations
alpha-loop evolve --continuous            # Run until manually stopped (Ctrl-C)
alpha-loop evolve --surface prompts       # Only modify agent prompts (safest)
alpha-loop evolve --surface all           # Modify prompts + pipeline code (riskier)
alpha-loop evolve --resume                # Resume from a previous evolve session
alpha-loop evolve --dry-run               # Preview without changes
```

#### Routing promotion/demotion (`alpha-loop evolve routing`)

Propose per-stage routing changes (frontier → local, or revert to fallback) as draft PRs, based on the metrics aggregated by `alpha-loop report routing` plus the matrix eval.

A stage is promoted to its local candidate when (over ≥30 runs): cost-per-issue savings ≥ 40%, pipeline success delta ≥ −3%, and tool-error rate < 2%. Promotions require a matrix eval run within the last 7 days (`alpha-loop eval --matrix --execute`).

```bash
alpha-loop evolve routing                   # Propose promotions as a draft PR
alpha-loop evolve routing --dry-run         # Preview without writing config
alpha-loop evolve routing --demote build    # Manually revert a stage to fallback
```

Every promotion/demotion is appended to `.alpha-loop/learnings/routing-history.md`. PR bodies include a `git revert` rollback snippet plus the previous YAML fragment.

### Batch Mode

By default, Alpha Loop processes issues one at a time — each issue gets its own plan, implement, test, and review agent calls. Batch mode combines multiple issues into single agent calls, dramatically reducing overhead:

```bash
# Process issues in batches of 5 (default)
alpha-loop run --batch

# Custom batch size
alpha-loop run --batch --batch-size 3
```

**How it works:** If a milestone has 13 issues, batch mode processes them in 3 rounds:

| Batch | Issues | Agent Calls |
|-------|--------|-------------|
| Batch 1 | #1-#5 | 1 plan + 1 implement + 1 review |
| Batch 2 | #6-#10 | 1 plan + 1 implement + 1 review |
| Batch 3 | #11-#13 | 1 plan + 1 implement + 1 review |

Each batch goes through the full pipeline:
1. **Batch plan** — One agent call plans all issues, writing per-issue plan JSONs
2. **Batch implement** — One agent call implements all issues, committing per-issue
3. **Test** — Runs the test suite once (with retry loop if needed)
4. **Batch review** — One agent call reviews the entire diff for all issues
5. **PR** — Creates one PR that closes all issues in the batch
6. **Per-issue updates** — Each issue gets individually updated with labels, comments, and PR link

This reduces agent calls from ~3-4 per issue to ~3 per batch. For 5 issues, that's 3 agent calls instead of 15-20.

Or set it permanently in `.alpha-loop.yaml`:

```yaml
batch: true
batch_size: 5
```

### Crash Recovery (`alpha-loop resume`)

If the loop hangs or crashes mid-session, work can be stranded on local branches with no PR. Run `alpha-loop resume` to recover:

1. Reads durable `.alpha-loop/sessions/<session>/session.json` manifests and crash markers first, then falls back to scanning local `agent/issue-*` branches with commits but no open PR
2. Pushes each branch to origin
3. Runs code review
4. Creates WIP PRs, marks issues `In Review`, and updates the session PR with a verification caveat
5. Regenerates missing learning artifacts and the aggregate session summary from recovered session results

Recovered PRs are written with `recoveryMode: "resume"` and are not marked complete. `resume` does not rerun the project test suite or final smoke tests, so verify recovered work before merging.

Use `--issue <N>` to resume a specific issue.

`alpha-loop history <session>` shows both unrecovered `crash-<N>.json` markers and recovered result files separately from normal successes and failures.
Durable session manifests also show active, paused, waiting-for-feedback, QA-requested, resumed, completed, failed, and cleaned-up states, including the saved branch needed to recreate a missing worktree.

### Feedback Ingestion (`alpha-loop feedback ingest`)

Adapters for Slack, Teams, Discord, website forms, or custom services can send human feedback back into Alpha Loop without hard-coding those tools into the core loop. Ingestion writes a canonical GitHub comment with a hidden machine-readable marker, records an idempotency file under `.alpha-loop/feedback/ingested-events/`, classifies the feedback, and updates any matching session manifest.

```bash
# Structured JSON from stdin
cat feedback.json | alpha-loop feedback ingest --json

# JSON payload or plain body text from a file
alpha-loop feedback ingest --body-file feedback.json

# Record a resume request without running resume immediately
alpha-loop feedback ingest --body-file feedback.json --request-resume
```

Payload fields include `repo`, `issueNumber`, `prNumber`, `sessionId`, `source`, `externalEventId`, `externalThreadId`, `externalMessageId`, `author`, `body`, `attachments`, `eventTimestamp`, `classification`, and `resumeRequested`. Duplicate external event ids are reported as already processed instead of creating another GitHub comment.

### Screenshots

During live verification, the agent takes screenshots at key states and saves them to `.alpha-loop/sessions/<name>/screenshots/issue-<N>/`. These are kept locally (not committed to git) for debugging.

## Commands

| Command | Description |
|---------|-------------|
| `alpha-loop init` | Full onboarding: config, templates, vision, scan, sync, commit |
| `alpha-loop run` | Fetch matching issues, process them all, then exit |
| `alpha-loop run --dry-run` | Preview without making changes |
| `alpha-loop run --issue <N>` | Process exactly one open ready issue; child issues inherit one unambiguous parent epic context |
| `alpha-loop run --epic <N>` | Process an epic — its sub-issues in checklist order, auto-verify on completion (see [docs/epics.md](docs/epics.md)) |
| `alpha-loop run --epics <ids>` | Process an ordered comma-separated queue of epics, one session branch and PR per epic |
| `alpha-loop run --epics <ids> --queue-branch-mode independent` | Run queued epics without stacking later session branches on earlier ones |
| `alpha-loop run --verify-only <N>` | Run just the epic verification pass — evaluates merged PRs against acceptance criteria |
| `alpha-loop daemon` | Run hosted daemon mode continuously for repo stewardship |
| `alpha-loop daemon --mode feedback-only` | Poll feedback and resume eligible sessions without triage or new work selection |
| `alpha-loop scan` | Generate/refresh project context and instructions file |
| `alpha-loop vision` | **(deprecated)** Use `alpha-loop plan` instead |
| `alpha-loop auth` | Save authenticated browser state for verification |
| `alpha-loop history` | View session and queue history |
| `alpha-loop history <name>` | View a specific session |
| `alpha-loop history queue-<timestamp>` | Inspect a multi-epic queue manifest, including stopped/pending epics |
| `alpha-loop history <name> --qa` | Show QA checklist for session |
| `alpha-loop history <name> --telemetry` | Show per-stage telemetry table (see [docs/telemetry.md](docs/telemetry.md)) |
| `alpha-loop history --clean` | Remove old session data |
| `alpha-loop report routing` | Aggregate per-stage telemetry + cost-per-issue across sessions |
| `alpha-loop sync` | Add/update templated assets in configured harnesses without deleting harness-only files |
| `alpha-loop sync --check` | Check for drift, including target-only harness files, without writing changes |
| `alpha-loop sync --prune` | Sync templates and remove target-only harness files after logging each pruned path |
| `alpha-loop resume` | Resume stranded work — push branches, review, open WIP PRs |
| `alpha-loop resume --issue <N>` | Resume a specific issue |
| `alpha-loop feedback ingest` | Ingest external human feedback from stdin or `--body-file` |
| `alpha-loop feedback ingest --request-resume` | Mark the matching session resume-requested without running resume |
| `alpha-loop review` | Analyze learnings and propose self-improvements |
| `alpha-loop review --apply` | Apply proposed improvements and create a draft PR |
| `alpha-loop eval` | Run the eval suite and compute composite score |
| `alpha-loop eval capture` | Capture failures as eval cases (interactive) |
| `alpha-loop eval capture --quality` | Capture quality failures from successful sessions (false positives) |
| `alpha-loop eval list` | Show eval cases and recent scores |
| `alpha-loop eval scores` | Show score history over time |
| `alpha-loop eval pareto` | Show score/cost Pareto frontier |
| `alpha-loop eval compare <r1> <r2>` | Compare two eval runs |
| `alpha-loop eval search` | Greedy search over model configurations per pipeline step |
| `alpha-loop eval estimate` | Estimate cost of running the eval suite |
| `alpha-loop eval compare-configs <a> <b>` | Compare two YAML config files side-by-side |
| `alpha-loop eval convert` | Convert between AlphaLoop and skill-creator eval formats |
| `alpha-loop eval import-swebench` | Import eval cases from SWE-bench dataset |
| `alpha-loop eval export <case>` | Export an eval case for contributing back (anonymized by default) |
| `alpha-loop evolve` | Meta-Harness-style automated optimization loop |
| `alpha-loop evolve routing` | Propose routing promotions/demotions as draft PRs based on eval metrics |
| `alpha-loop evolve routing --demote <stage>` | Manually demote a stage to routing.fallback.escalate_to |
| `alpha-loop plan` | Generate a full project scope (milestones + issues) from seed inputs using AI |
| `alpha-loop plan --seed <file>` | Read seed description from a file instead of prompting |
| `alpha-loop plan --dry-run` | Display the plan and save `.alpha-loop/plan.json` without creating GitHub resources |
| `alpha-loop plan --resume` | Create GitHub resources from the saved `.alpha-loop/plan.json` draft |
| `alpha-loop plan --yes --seed <file>` | Non-interactive mode: accept all AI recommendations |
| `alpha-loop triage` | Analyze open issues, clean up backlog noise, and propose/apply epic groups |
| `alpha-loop triage --dry-run` | Display cleanup findings and epic proposals without making changes |
| `alpha-loop triage --yes` | Non-interactive mode: apply AI-selected cleanup actions and epic proposals |
| `alpha-loop roadmap` | Schedule parent epics and standalone issues into milestones using AI analysis |
| `alpha-loop roadmap --queue` | Recommend the next ordered epic run queue without making changes |
| `alpha-loop roadmap --queue --milestone <name>` | Recommend an epic run queue within a release or sprint milestone |
| `alpha-loop roadmap --dry-run` | Display proposed epic/standalone milestone assignments without making changes |
| `alpha-loop roadmap --yes` | Non-interactive mode: apply all AI-recommended epic and standalone assignments |

### Run Options

```bash
alpha-loop run [options]

Options:
  --once              Process one issue and exit
  --dry-run           Preview without making changes
  --model <model>     AI model override (e.g., opus, sonnet, gpt-5.4, gpt-5.3-codex)
  --milestone <name>  Process this milestone's scheduled epic, or flat issues if none
  --skip-tests        Skip test execution
  --skip-review       Skip code review step
  --skip-learn        Skip learning extraction
  --auto-merge        Auto-merge PRs to session branch
  --merge-to <branch> Use an existing branch instead of creating a new session branch
  --batch             Batch mode: process multiple issues per agent call (faster, fewer tokens)
  --batch-size <n>    Issues per batch (default: 5)
  --issue <n>         Process exactly one issue by issue number (skips the picker)
  --epic <n>          Process a specific epic by issue number (skips the picker)
  --epics <ids>       Process multiple epics in order (comma-separated)
  --queue-branch-mode <mode>  Branch mode for --epics: stacked or independent
  --skip-epic         Skip epic discovery, use flat/milestone flow
  --verify-only <n>   Run only the verification pass on an existing epic
```

### Daemon Options

```bash
alpha-loop daemon [options]

Options:
  --mode <mode>                 full, triage-only, feedback-only, or run-only
  --triage-interval <seconds>   Seconds between intake triage ticks
  --feedback-interval <seconds> Seconds between feedback poll/resume ticks
  --run-interval <seconds>      Seconds between ready-work selection ticks
  --health-interval <seconds>   Seconds between daemon health events
  --idle-sleep <seconds>        Seconds to sleep when no tick is due
  --feedback-command <command>  Adapter command returning feedback JSON/NDJSON
  --no-lock                     Disable the repo-level daemon lock
  --once-tick                   Run one due daemon tick and exit
  --max-ticks <n>               Stop after this many daemon ticks
```

For hosted website and web app operation, start with the [Hosted Alpha Loop Setup Guide](docs/hosted-alpha-loop.md). It covers server setup, GitHub labels and templates, safe starter config, lifecycle events, feedback ingestion, resume, QA handoff, health checks, cleanup, and troubleshooting. For a concrete Astro/Sanity marketing-site reference workflow, see the [Aging Sidekick Hosted Pilot Blueprint](docs/aging-sidekick-hosted-pilot.md).

## Configuration

Running `alpha-loop init` creates a `.alpha-loop.yaml` file:

```yaml
# Alpha Loop configuration
repo: owner/repo-name
project: 0  # GitHub Project number (find it in your project URL)
agent: claude  # AI agent CLI: claude, codex, opencode, lmstudio, ollama
# model:       # omit to use agent's default (e.g., opus, gpt-5.4)
label: ready
base_branch: main
test_command: pnpm test
dev_command: pnpm dev
auto_merge: true

# Optional browser QA profile for websites and web apps
web_app:
  build_command: pnpm build
  test_command: pnpm test
  dev_command: pnpm dev
  dev_url: http://localhost:4321
  smoke_test: pnpm build
  screenshots:
    - { name: home-desktop, url: /, viewport: desktop }
    - { name: home-mobile, url: /, viewport: mobile }
  preview:
    command: ./scripts/get-preview-url.sh
    required: false

# Coding harnesses to sync skills/agents to (auto-derived from agent if empty)
harnesses:
  - claude

# Safety limits (0 = unlimited)
max_issues: 20
max_session_duration: 7200  # 2 hours in seconds

# Hosted automation guardrails
automation_policy:
  block_labels: [do-not-automate, needs-human-input]
  # See docs/hosted-policy.md for full marketing-site and web-app profiles.

# Hosted daemon mode
daemon:
  mode: full
  triage_interval: 900
  feedback_interval: 60
  run_interval: 120
  health_interval: 300
  idle_sleep: 30
  feedback_poll_command: ""  # optional adapter command returning JSON/NDJSON
  lock:
    enabled: true
    stale_after: 86400
    path: ""                 # defaults to .alpha-loop/daemon.lock

# Worktree retention for durable session manifests
session_retention:
  paused_worktree_days: 0       # keep paused/waiting/QA worktrees until explicit cleanup
  completed_worktree_days: 30   # clean completed/failed worktrees after 30 days

# Post-session review (runs after all issues, reviews full session diff)
post_session:
  review: true
  security_scan: true

# Lifecycle events for hosted runs and automations
events:
  include_prompt_text: false
  redact:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY
  destinations:
    audit_log:
      type: log
      events: ['*']
    slack_qa:
      type: webhook
      events: [qa.requested, human_input.requested, session.failed]
      url_env: SLACK_WEBHOOK_URL
      format: slack
      required: false

# Eval system
auto_capture: true  # capture failures as eval cases
eval_dir: .alpha-loop/evals
```

### Configuration Reference

| Key | Default | Description |
|-----|---------|-------------|
| `repo` | (auto-detected) | GitHub repo in `owner/name` format |
| `project` | `0` | GitHub Project number (from URL: `users/<owner>/projects/<N>`) |
| `agent` | `claude` | AI agent CLI to use: `claude`, `codex`, or `opencode` |
| `model` | (agent default) | AI model (passed via `--model` flag; omit to use agent's default) |
| `review_model` | (agent default) | AI model for code review and learning extraction |
| `label` | `ready` | GitHub label that marks issues as ready for the loop |
| `base_branch` | `master` | Branch to create PRs against |
| `test_command` | `pnpm test` | Command to run tests |
| `dev_command` | `pnpm dev` | Command to start the dev server for verification |
| `max_turns` | (none) | Max conversation turns for the agent |
| `poll_interval` | `60` | Seconds between issue polling |
| `max_test_retries` | `3` | Times to retry failing tests/verification |
| `milestone` | (none) | Only process issues in this milestone |
| `max_issues` | `0` | Max issues to process per session (0 = unlimited) |
| `max_session_duration` | `0` | Max session duration in seconds (0 = unlimited) |
| `auto_merge` | `true` | Auto-merge issue PRs into the session branch |
| `merge_to` | (none) | Use an existing branch instead of creating a session branch |
| `skip_tests` | `false` | Skip test execution |
| `skip_review` | `false` | Skip code review |
| `skip_verify` | `false` | Skip live verification |
| `skip_learn` | `false` | Skip learning extraction |
| `skip_e2e` | `false` | Skip E2E tests |
| `skip_install` | `false` | Skip `pnpm install` in worktrees |
| `skip_preflight` | `false` | Skip pre-flight test validation |
| `auto_cleanup` | `true` | Auto-remove worktrees after processing |
| `session_retention.paused_worktree_days` | `0` | Days before `history --clean` removes paused/waiting/QA worktrees (`0` = never) |
| `session_retention.completed_worktree_days` | `30` | Days before `history --clean` removes completed/failed worktrees (`0` = never) |
| `run_full` | `false` | Run full pipeline without skipping any steps |
| `verbose` | `false` | Enable verbose agent output |
| `harnesses` | (auto from agent) | Coding harnesses to sync skills/agents to (e.g., `claude`, `codex`) |
| `eval_dir` | `.alpha-loop/evals` | Directory for eval cases and scores |
| `eval_model` | (agent default) | AI model for eval judging |
| `eval_timeout` | `300` | Timeout in seconds for eval case execution |
| `auto_capture` | `true` | Auto-capture failures as eval cases at end of session |
| `batch` | `false` | Enable batch mode — process multiple issues per agent call |
| `batch_size` | `5` | Number of issues per batch when batch mode is enabled |
| `smoke_test` | (none) | Shell command to run as a final smoke test after session review |
| `web_app.setup_command` | top-level `setup_command` | Optional setup command for website/app repos |
| `web_app.build_command` | package `build` script | Build command captured as part of web/app verification |
| `web_app.test_command` | top-level `test_command` | Test command for the web/app profile |
| `web_app.dev_command` | top-level `dev_command` or package script | Dev server command used by browser verification |
| `web_app.dev_url` | framework default | Local dev URL; Astro defaults to `http://localhost:4321`, Vite to `5173`, Next/generic to `3000` |
| `web_app.smoke_test` | top-level `smoke_test` | Optional final smoke command for web/app handoff |
| `web_app.screenshots` | home desktop/mobile for known web frameworks | Screenshot plan entries with `name`, `url`, and `viewport` (`desktop`, `tablet`, `mobile`) |
| `web_app.preview.url` | (none) | Static preview URL, if a hosting service exposes one directly |
| `web_app.preview.command` | (none) | Provider-agnostic command that prints an `http(s)` preview URL |
| `web_app.preview.required` | `false` | Mark preview URL discovery as required for verification |
| `pipeline` | `{}` | Per-step agent/model overrides (see below) |
| `pricing` | (built-in) | Custom token pricing per model for cost tracking |
| `eval_include_agent_prompts` | `true` | Include repo-specific agent prompts during eval runs |
| `eval_include_skills` | `true` | Include repo-specific skills during eval runs |
| `post_session.review` | `true` | Run holistic code review on full session diff |
| `post_session.security_scan` | `true` | Include security scanning in post-session review |
| `events.include_prompt_text` | `false` | Include redacted prompt text in lifecycle events; prompt paths and hashes are always retained when available |
| `events.redact` | `[]` | Env var names or literal values to redact from lifecycle event payloads |
| `events.destinations` | `{}` | Lifecycle event destinations (`log`, `webhook`, `command`) with per-destination event filters |
| `automation_policy.require_labels` | `[]` | Labels required before hosted automation may start an issue |
| `automation_policy.block_labels` | `do-not-automate`, `needs-human-input` | Labels that pause automation and request human input |
| `automation_policy.allowed_paths` | `[]` | Optional glob allowlist for changed files; empty means all paths are allowed unless protected |
| `automation_policy.protected_paths` | `[]` | Glob list of paths that require human input when changed |
| `automation_policy.allowed_commands` | `[]` | Optional allowlist for configured shell commands; entries match exact commands or subcommands |
| `automation_policy.require_human_for` | `[]` | High-risk categories that require human input (`auth`, `billing`, `production-deploy`, `dependency-upgrade`, `sanity-schema`, `secrets`, `migrations`, `destructive-content`, `ambiguous`) |
| `automation_policy.max_active_sessions` | `0` | Maximum active durable sessions (`0` = unlimited) |
| `automation_policy.max_paused_sessions` | `0` | Maximum paused/waiting sessions (`0` = unlimited) |
| `automation_policy.max_issues_per_session` | `0` | Maximum issues hosted automation may process in one session (`0` = unlimited) |
| `automation_policy.max_session_minutes` | `0` | Runtime limit for hosted automation sessions (`0` = unlimited) |
| `automation_policy.max_session_cost_usd` | `0` | Estimated session budget limit (`0` = unlimited) |
| `automation_policy.max_issue_cost_usd` | `0` | Estimated per-issue budget limit (`0` = unlimited) |
| `daemon.mode` | `full` | Hosted daemon mode: `full`, `triage-only`, `feedback-only`, or `run-only` |
| `daemon.triage_interval` | `900` | Seconds between intake triage ticks |
| `daemon.feedback_interval` | `60` | Seconds between feedback poll and resume ticks |
| `daemon.run_interval` | `120` | Seconds between ready-work selection ticks |
| `daemon.health_interval` | `300` | Seconds between daemon health lifecycle events |
| `daemon.idle_sleep` | `30` | Seconds to sleep when no daemon tick is due |
| `daemon.feedback_poll_command` | (none) | Optional adapter command that returns one feedback JSON object, an array, or NDJSON |
| `daemon.lock.enabled` | `true` | Use `.alpha-loop/daemon.lock` to prevent concurrent daemon mutation in one repo |
| `daemon.lock.stale_after` | `86400` | Seconds before a still-live lock can be treated as stale (`0` = PID-only stale checks) |
| `daemon.lock.path` | (none) | Optional custom lock path; empty uses `.alpha-loop/daemon.lock` |

### Lifecycle Events

Alpha Loop emits typed lifecycle events for hosted sessions and daemons: `session.started`, `session.paused`, `human_input.requested`, `qa.requested`, `feedback.received`, `feedback.classified`, `session.resume_requested`, `session.resumed`, `session.completed`, `session.failed`, `daemon.started`, `daemon.idle`, `daemon.health`, `daemon.work.selected`, `daemon.work.skipped`, `daemon.resume.requested`, `daemon.shutdown`, and `daemon.failed`.

### Web/App QA Profile

`web_app` adds browser-oriented verification for Astro, React/Vite, Next, and similar repos. It records screenshot paths, browser console errors, failed network requests, preview URLs, and a human QA checklist in session history, PR bodies, and `qa.requested` events. Preview discovery is provider-agnostic: set `preview.url` or provide a command that prints the URL. See [docs/web-app-profile.md](docs/web-app-profile.md).

Destinations can write to the session history log, POST to webhooks, or run a local command with canonical JSON on stdin. Webhooks can use `format: json`, `slack`, `teams`, or `discord`; command destinations always receive canonical JSON. `--dry-run` prints matching destinations instead of sending.

See [docs/hosted-events.md](docs/hosted-events.md) for Slack, Teams, Discord, email-via-script, and custom service examples.

### Hosted Automation Policy

`automation_policy` constrains unattended hosted runs before issue work starts, before configured commands run, and before PR creation when diffs touch protected paths. Blocked work receives `needs-human-input`, a GitHub comment explaining the decision, and policy metadata in the session manifest and lifecycle event payloads.

See [docs/hosted-policy.md](docs/hosted-policy.md) for ready-to-paste marketing-site and web-app policies.

### Environment Variables

All config options can be set via environment variables (uppercase, same names):

| Variable | Config Key |
|----------|------------|
| `REPO` | `repo` |
| `PROJECT` | `project` |
| `AGENT` | `agent` |
| `MODEL` | `model` |
| `REVIEW_MODEL` | `review_model` |
| `POLL_INTERVAL` | `poll_interval` |
| `MAX_TEST_RETRIES` | `max_test_retries` |
| `MILESTONE` | `milestone` |
| `MAX_ISSUES` | `max_issues` |
| `MAX_SESSION_DURATION` | `max_session_duration` |
| `BASE_BRANCH` | `base_branch` |
| `TEST_COMMAND` | `test_command` |
| `DEV_COMMAND` | `dev_command` |
| `DRY_RUN` | `dry_run` |
| `SKIP_TESTS` | `skip_tests` |
| `SKIP_REVIEW` | `skip_review` |
| `SKIP_VERIFY` | `skip_verify` |
| `SKIP_LEARN` | `skip_learn` |
| `SKIP_E2E` | `skip_e2e` |
| `SKIP_INSTALL` | `skip_install` |
| `SKIP_PREFLIGHT` | `skip_preflight` |
| `AUTO_MERGE` | `auto_merge` |
| `AUTO_CLEANUP` | `auto_cleanup` |
| `SESSION_RETENTION_PAUSED_WORKTREE_DAYS` | `session_retention.paused_worktree_days` |
| `SESSION_RETENTION_COMPLETED_WORKTREE_DAYS` | `session_retention.completed_worktree_days` |
| `MERGE_TO` | `merge_to` |
| `RUN_FULL` | `run_full` |
| `VERBOSE` | `verbose` |
| `EVAL_DIR` | `eval_dir` |
| `EVAL_MODEL` | `eval_model` |
| `EVAL_TIMEOUT` | `eval_timeout` |
| `AUTO_CAPTURE` | `auto_capture` |
| `BATCH` | `batch` |
| `BATCH_SIZE` | `batch_size` |
| `SKIP_POST_SESSION_REVIEW` | `post_session.review` (inverted) |
| `SKIP_POST_SESSION_SECURITY` | `post_session.security_scan` (inverted) |

**Precedence:** CLI flags > environment variables > `.alpha-loop.yaml` > auto-detection > defaults

### Switching Agents

Alpha Loop is agent-agnostic. Set the `agent` field in `.alpha-loop.yaml` to switch which CLI runs the pipeline:

```yaml
# Use Codex instead of Claude
agent: codex
```

```yaml
# Use Codex with a specific model
agent: codex
model: gpt-5.3-codex
```

If you omit `model`, the agent CLI uses its own default (e.g., Claude uses its configured model, Codex uses `gpt-5.4`). Set `model` only when you want to override.

| Agent | Example models | CLI flags used |
|-------|---------------|----------------|
| `claude` | `opus`, `sonnet`, `haiku` | `-p --model MODEL --dangerously-skip-permissions` |
| `codex` | `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex` | `exec --model MODEL --full-auto` |
| `opencode` | `deepseek`, `gpt-4` | `run --model MODEL` |

When you change `agent`, the harness sync automatically targets the correct directories (e.g., `.claude/` for Claude, `.codex/` for Codex). You can also explicitly list harnesses if you use multiple tools:

```yaml
agent: codex
harnesses:
  - codex
  - claude  # also sync to Claude for teammates using it
```

Sync is additive by default: `alpha-loop sync` copies new or changed files from `.alpha-loop/templates/` into each harness path, but it leaves harness-only skills and support files in place. Use `alpha-loop sync --check` to detect strict drift, including target-only files, and `alpha-loop sync --prune` only when you explicitly want to remove files from harness paths that are not present in templates.

### Per-Step Pipeline Config

Use `pipeline` to assign different models to different pipeline stages. This lets you use cheaper models for simple steps and reserve expensive models for implementation:

```yaml
agent: claude
model: claude-sonnet-4-6  # default for all steps

pipeline:
  plan:
    model: claude-haiku-4-5       # cheap model for planning
  implement:
    model: claude-sonnet-4-6      # main model for coding
  review:
    model: claude-opus-4-6        # best model for review
  learn:
    model: claude-haiku-4-5       # cheap model for learning
```

Use `alpha-loop eval search` to automatically find the best model assignment per step via greedy coordinate descent over your eval suite.

### Per-Stage Routing

For hybrid cloud/local setups, use `routing:` to target different models and endpoints for each Loop stage. This is how you offload token-heavy middle stages (Build, Test) to local open-weight models while keeping frontier models for Plan and Review:

```yaml
routing:
  profile: hybrid-v1   # all-frontier | hybrid-v1 | all-local | <custom-name>
  stages:
    plan:       { model: claude-opus-4-7,      endpoint: anthropic }
    build:      { model: qwen3-coder-30b-a3b,  endpoint: lmstudio_local }
    test_write: { model: qwen3-coder-30b-a3b,  endpoint: lmstudio_local }
    test_exec:  { model: qwen3-coder-30b-a3b,  endpoint: lmstudio_local }
    review:     { model: claude-sonnet-4-6,    endpoint: anthropic }
    summary:    { model: gemma-4-31b,          endpoint: lmstudio_local }
  endpoints:
    anthropic:      { type: anthropic,        base_url: "https://api.anthropic.com" }
    lmstudio_local: { type: anthropic_compat, base_url: "http://localhost:1234" }
    ollama_local:   { type: openai_compat,    base_url: "http://localhost:11434/v1" }
  fallback:
    on_tool_error: escalate          # escalate | retry | fail
    escalate_to: { model: claude-sonnet-4-6, endpoint: anthropic }
```

**Stages:** `plan`, `build`, `test_write`, `test_exec`, `review`, `summary` — each takes `{ model, endpoint }` where `endpoint` references a name defined in `routing.endpoints`.

**Endpoint types:** `anthropic` (native Anthropic API), `anthropic_compat` (Anthropic-compatible — e.g. LM Studio), or `openai_compat` (OpenAI-compatible — e.g. Ollama, vLLM). See [docs/local-models.md](docs/local-models.md) for LM Studio and Ollama setup, including the `agent: lmstudio` / `agent: ollama` short form for single-agent local mode.

**Fallback modes:**
- `escalate` — when a routed stage errors on a tool call, retry on `escalate_to` (typically a frontier model)
- `retry` — retry on the same model/endpoint
- `fail` — surface the error without retry

**Profile as a list (A/B):** `profile` may also be an array of names (e.g. `[hybrid-v1, all-local]`). Alpha Loop picks one deterministically per-issue so reruns of the same issue select the same profile — this makes profile comparisons reproducible.

**Backwards compatibility:** If you don't set `routing`, alpha-loop uses the top-level `agent:` / `model:` / `pipeline:` exactly as before — no behavior change.

### Local Model Support

Alpha Loop can run the token-heavy middle of the Loop (Build, Test) against an open-weight coding model on your own machine — typically a 30B-class model in LM Studio or Ollama — while keeping frontier models for Plan and Review. On a 64GB+ Apple Silicon Mac this typically cuts cost-per-issue by 60–80% without sacrificing Plan/Review quality.

- [docs/local-models.md](docs/local-models.md) — hardware prerequisites, install steps for LM Studio 0.4.1+ / Ollama, recommended models (Qwen3-Coder-Next 30B-A3B, Gemma 4 31B, GLM-4.6), Apple Silicon tuning, and troubleshooting.
- [docs/routing-profiles.md](docs/routing-profiles.md) — copy-pasteable profiles: `all-frontier` (baseline), `hybrid-v1` (recommended default), `all-local` (offline / zero-cost), `budget-hawk` (Haiku cloud + local coder).

Quickest path: install LM Studio 0.4.1+, load `qwen3-coder-30b-a3b`, then drop the `hybrid-v1` block from [docs/routing-profiles.md](docs/routing-profiles.md) into your `.alpha-loop.yaml`. `alpha-loop init` detects Apple Silicon + 64GB+ RAM and points you at these docs automatically.

## GitHub Setup

### Labels

The loop uses these labels. Run `alpha-loop init` to create any that are missing:

| Label | Purpose |
|-------|---------|
| `ready` | Issue is ready for the loop to pick up |
| `in-progress` | Loop is actively working on it |
| `in-review` | PR created, awaiting review |
| `failed` | Loop failed after retries |
| `epic` | Parent issue with an ordered sub-issue checklist |

### Milestones

Use GitHub milestones to group issues into planned releases or sprints. When you start the loop, you'll be prompted to pick an epic or milestone; milestone rows show scheduled epic counts when parent epics are assigned to them.

Create milestones at `github.com/<owner>/<repo>/milestones/new`. Set due dates to keep yourself on track.

### Epics

An epic is a GitHub issue with the `epic` label and a task-list body that references sub-issues by number:

```markdown
## Sub-issues
- [ ] #158 Add tenant column to users table
- [ ] #159 Add tenant middleware
- [ ] #160 Scope queries by tenant
```

Run `alpha-loop init` to install the epic issue template at `.github/ISSUE_TEMPLATE/epic.yml`. It applies the `epic` label and prompts for the goal, ordered sub-issues, acceptance criteria, dependencies, sequencing notes, and verification expectations.

When you start the loop, open epics appear above milestones in the picker and show milestone membership when present. You can also target one directly:

```bash
alpha-loop run --epic 165
```

`alpha-loop run --milestone "v1.0"` checks for open epics assigned to that milestone before fetching flat issues. One scheduled epic is processed automatically, multiple scheduled epics require `--epic <N>`, and no scheduled epics falls back to ready non-epic issues in that milestone. `--epic` always wins over `--milestone`; `--skip-epic` disables epic discovery and preserves the flat milestone flow.

For feedback-driven or hosted workflows that need one precise unit of work, use:

```bash
alpha-loop run --issue 158
```

`--issue` fetches only that issue, requires it to be open, labeled with the configured ready label, and not labeled `blocked`, and refuses parent epics with guidance to use `--epic`. When the issue is referenced by exactly one open parent epic, Alpha Loop includes that parent context in the run and updates only that checklist item on success. If multiple open parent epics reference the issue, the command exits before creating a session or mutating GitHub/git state. `--dry-run --issue <N>` prints the resolved target and eligibility decision.

To ask Alpha Loop what to run next, use queue planning:

```bash
alpha-loop roadmap --queue
alpha-loop roadmap --queue --milestone "v1.0"
```

Queue planning is read-only. It inspects open `epic` issues, milestone assignments, checklist progress, child readiness labels, dependency phrases such as `depends on #N`, and likely file overlap. When a runnable queue exists, it prints an executable command like `alpha-loop run --epics 205,166,214`; blocked epics stay out of the command and are listed with their blockers.

To run several epics unattended while keeping review scope separate, pass an explicit queue:

```bash
alpha-loop run --epics 205,166,214
```

The queue is validated before any work starts. Each listed issue must exist, be labeled `epic`, not be duplicated, and be open unless it is already closed as completed. Alpha Loop processes the epics in the given order, creates/finalizes one session branch and PR per epic, and stops on the first epic failure, verification gap, checklist consistency error, or transient agent/rate-limit stop. By default, queue sessions use `stacked` ancestry: later epic session branches start from the previous successful session branch while their PRs still target the configured base branch. Use `--queue-branch-mode independent` for unrelated epics that should all branch from the base branch. Non-dry-run queue attempts write `.alpha-loop/sessions/queue-<timestamp>/queue.json`; `alpha-loop history` lists those manifests and `alpha-loop history queue-<timestamp>` prints stopped/pending epics, session PRs, and rebase notes. `--dry-run` prints the validated queue without mutating GitHub or git state.

Sub-issues are processed in checklist order (not issue-number order). Each sub-issue PR gets `Part of #165` appended, and the epic body's checkboxes auto-flip from `- [ ]` to `- [x]` as PRs merge. When every sub-issue has shipped, the loop runs a verification pass against each sub-issue's acceptance criteria — on `pass` the epic is auto-closed, on `partial` or `fail` it stays open with a `needs-human-input` label and a structured comment explaining the gaps.

See [docs/epics.md](docs/epics.md) for the full feature reference, including `--verify-only`, the `prefer_epics` config option, skip rules, and safety rails.

### GitHub Project Board

Alpha Loop reads issues from a GitHub Project board (v2). Issues are processed in board order, so you control priority by reordering. When combined with milestones, only "Todo" items in the selected milestone are processed.

Set the `project` number in your config (find it in your project URL: `github.com/users/<owner>/projects/<number>`).

### Issue Format

Issues work best with structured acceptance criteria. Run `alpha-loop init` to install two GitHub issue templates:

- `Agent-Ready Task` (`.github/ISSUE_TEMPLATE/agent-ready.yml`) for standalone or sub-issues the loop can implement.
- `Epic` (`.github/ISSUE_TEMPLATE/epic.yml`) for parent issues that group ordered sub-issues and drive final verification.

```markdown
## Description
What needs to be done.

## Acceptance Criteria
- [ ] Specific, testable criterion
- [ ] Another criterion

## Test Requirements
- Unit test for X
- E2E test for Y

## Affected Files/Areas
- src/...
- tests/...
```

## Project Artifacts

| Directory | Git-tracked? | Purpose |
|-----------|-------------|---------|
| `.alpha-loop/vision.md` | Yes | Project vision document |
| `.alpha-loop/context.md` | Yes | Auto-generated project context |
| `.alpha-loop/learnings/` | Yes | Learning files, session manifests, and session summaries (shared with team) |
| `.alpha-loop/evals/` | Yes | Eval cases (YAML) and score history (`scores.jsonl`) |
| `.alpha-loop/traces/` | No (gitignored) | Meta-Harness style execution traces per session |
| `.alpha-loop/sessions/` | No (gitignored) | Local session logs, results JSON, screenshots |
| `.alpha-loop/sessions/<session>/session.json` | No (gitignored) | Durable resumable session state with issue, branch, worktree, PR, stage, status, prompts, transcripts, and logs |
| `.alpha-loop/sessions/queue-<timestamp>/queue.json` | No (gitignored) | Multi-epic queue manifest with status, session PRs, merge order, and stop reason |
| `.alpha-loop/feedback/` | No (gitignored) | Local idempotency records for external feedback adapter events |
| `.alpha-loop/auth/` | No (gitignored) | Saved browser auth state for verification |
| `.worktrees/` | No (gitignored) | Temporary git worktrees during processing |

## Development

```bash
git clone https://github.com/bradtaylorsf/alpha-loop.git
cd alpha-loop
pnpm install
pnpm build
pnpm test

# Run in development mode
pnpm dev -- run --dry-run
```

### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js, TypeScript, ESM |
| CLI Framework | Commander.js |
| AI Agents | Any CLI agent (Claude, Codex, OpenCode) |
| Source of Truth | GitHub (Issues = kanban, PRs = reviews) |
| Package Manager | pnpm |

## License

MIT
