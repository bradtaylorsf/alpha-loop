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

# 3. Run the loop — you'll be prompted to pick a milestone
alpha-loop run

# Or target a specific milestone directly
alpha-loop run --milestone "v1.0"
```

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
8. **Create PR** — Opens a PR with test results, review summary, and verification status
8b. **Assumptions** — Agent summarizes assumptions and decisions made, posts as a comment on the issue for user validation
9. **Learn** — Extracts learnings (patterns, anti-patterns, what worked/failed) for future sessions
10. **Update Issue** — Posts results as a comment, updates labels
11. **Auto-Merge** — Merges the PR to the session branch (if enabled)
12. **Cleanup** — Removes the worktree

After all issues are processed, Alpha Loop:
1. **Auto-captures failures** as eval cases for regression testing
2. Generates a **session summary** aggregating learnings across issues
3. Runs a **post-session code review** on the full session diff to catch cross-issue integration problems
4. Creates the **session PR** with all findings included

### Milestone-Based Workflow

When you start the loop interactively, Alpha Loop shows your open milestones and lets you pick which one to work on:

```
  Open Milestones

  0  All issues (no milestone filter)
  1  v1.0 — MVP (5 open, 3/8 done · due 2026-04-15)
  2  v1.1 — Polish (10 open, 0/10 done)

  Select milestone [0-2]: 1
```

This lets you plan work in GitHub milestones and control exactly how much the loop processes per session. You can also pass `--milestone "v1.0"` to skip the prompt, or set `milestone: v1.0` in your config file.

### Session Branches

When `auto_merge` is enabled (default), Alpha Loop creates a session branch (e.g., `session/20260331-002240`) and merges each issue's PR into it. This keeps your main branch clean until you're ready to merge the whole session.

### Learnings

Each completed issue produces a learning file in `.alpha-loop/learnings/` with:
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

Eval cases live in `.alpha-loop/evals/` and scores are appended to `scores.jsonl` (Git-friendly, append-only). The composite score formula is pass-rate primary with lightweight penalties for retries and duration. Real API costs (tokens, USD) are tracked per case from agent output and used for the Pareto frontier.

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

1. Scans for local `agent/issue-*` branches with commits but no open PR
2. Pushes each branch to origin
3. Runs code review
4. Creates PRs and updates issue status

Use `--issue <N>` to resume a specific issue.

### Screenshots

During live verification, the agent takes screenshots at key states and saves them to `.alpha-loop/sessions/<name>/screenshots/issue-<N>/`. These are kept locally (not committed to git) for debugging.

## Commands

| Command | Description |
|---------|-------------|
| `alpha-loop init` | Full onboarding: config, templates, vision, scan, sync, commit |
| `alpha-loop run` | Fetch matching issues, process them all, then exit |
| `alpha-loop run --dry-run` | Preview without making changes |
| `alpha-loop run --epic <N>` | Process an epic — its sub-issues in checklist order, auto-verify on completion (see [docs/epics.md](docs/epics.md)) |
| `alpha-loop run --verify-only <N>` | Run just the epic verification pass — evaluates merged PRs against acceptance criteria |
| `alpha-loop scan` | Generate/refresh project context and instructions file |
| `alpha-loop vision` | **(deprecated)** Use `alpha-loop plan` instead |
| `alpha-loop auth` | Save authenticated browser state for verification |
| `alpha-loop history` | View session history |
| `alpha-loop history <name>` | View a specific session |
| `alpha-loop history <name> --qa` | Show QA checklist for session |
| `alpha-loop history <name> --telemetry` | Show per-stage telemetry table (see [docs/telemetry.md](docs/telemetry.md)) |
| `alpha-loop history --clean` | Remove old session data |
| `alpha-loop report routing` | Aggregate per-stage telemetry + cost-per-issue across sessions |
| `alpha-loop sync` | Sync templates to configured harnesses (Claude, Codex, Cursor, etc.) |
| `alpha-loop resume` | Resume stranded work — push branches, review, open PRs |
| `alpha-loop resume --issue <N>` | Resume a specific issue |
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
| `alpha-loop plan --dry-run` | Display the plan without creating any GitHub resources |
| `alpha-loop plan --yes --seed <file>` | Non-interactive mode: accept all AI recommendations |
| `alpha-loop triage` | Analyze and improve existing issues (staleness, clarity, size, duplicates, support ticket enrichment) |
| `alpha-loop triage --dry-run` | Display findings without making changes |
| `alpha-loop triage --yes` | Non-interactive mode: apply all AI-recommended triage actions |
| `alpha-loop roadmap` | Organize open issues into milestones using AI analysis |
| `alpha-loop roadmap --dry-run` | Display proposed roadmap without making changes |
| `alpha-loop roadmap --yes` | Non-interactive mode: apply all AI-recommended assignments |

### Run Options

```bash
alpha-loop run [options]

Options:
  --once              Process one issue and exit
  --dry-run           Preview without making changes
  --model <model>     AI model override (e.g., opus, sonnet, gpt-5.4, gpt-5.3-codex)
  --milestone <name>  Only process issues in this milestone (skips interactive prompt)
  --skip-tests        Skip test execution
  --skip-review       Skip code review step
  --skip-learn        Skip learning extraction
  --auto-merge        Auto-merge PRs to session branch
  --merge-to <branch> Use an existing branch instead of creating a new session branch
  --batch             Batch mode: process multiple issues per agent call (faster, fewer tokens)
  --batch-size <n>    Issues per batch (default: 5)
  --epic <n>          Process a specific epic by issue number (skips the picker)
  --skip-epic         Skip the epic picker, use flat/milestone flow
  --verify-only <n>   Run only the verification pass on an existing epic
```

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

# Coding harnesses to sync skills/agents to (auto-derived from agent if empty)
harnesses:
  - claude

# Safety limits (0 = unlimited)
max_issues: 20
max_session_duration: 7200  # 2 hours in seconds

# Post-session review (runs after all issues, reviews full session diff)
post_session:
  review: true
  security_scan: true

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
| `pipeline` | `{}` | Per-step agent/model overrides (see below) |
| `pricing` | (built-in) | Custom token pricing per model for cost tracking |
| `eval_include_agent_prompts` | `true` | Include repo-specific agent prompts during eval runs |
| `eval_include_skills` | `true` | Include repo-specific skills during eval runs |
| `post_session.review` | `true` | Run holistic code review on full session diff |
| `post_session.security_scan` | `true` | Include security scanning in post-session review |

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

### Milestones

Use GitHub milestones to group issues into planned releases or sprints. When you start the loop, you'll be prompted to pick a milestone — only issues in that milestone will be processed.

Create milestones at `github.com/<owner>/<repo>/milestones/new`. Set due dates to keep yourself on track.

### Epics

An epic is a GitHub issue with the `epic` label and a task-list body that references sub-issues by number:

```markdown
## Sub-issues
- [ ] #158 Add tenant column to users table
- [ ] #159 Add tenant middleware
- [ ] #160 Scope queries by tenant
```

When you start the loop, open epics appear above milestones in the picker. You can also target one directly:

```bash
alpha-loop run --epic 165
```

Sub-issues are processed in checklist order (not issue-number order). Each sub-issue PR gets `Part of #165` appended, and the epic body's checkboxes auto-flip from `- [ ]` to `- [x]` as PRs merge. When every sub-issue has shipped, the loop runs a verification pass against each sub-issue's acceptance criteria — on `pass` the epic is auto-closed, on `partial` or `fail` it stays open with a `needs-human-input` label and a structured comment explaining the gaps.

See [docs/epics.md](docs/epics.md) for the full feature reference, including `--verify-only`, the `prefer_epics` config option, skip rules, and safety rails.

### GitHub Project Board

Alpha Loop reads issues from a GitHub Project board (v2). Issues are processed in board order, so you control priority by reordering. When combined with milestones, only "Todo" items in the selected milestone are processed.

Set the `project` number in your config (find it in your project URL: `github.com/users/<owner>/projects/<number>`).

### Issue Format

Issues work best with structured acceptance criteria. Run `alpha-loop init` to install an issue template:

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
