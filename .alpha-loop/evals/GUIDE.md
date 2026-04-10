# Alpha Loop Eval System — Comprehensive Guide

This guide explains how to use the Alpha Loop eval system to measure, improve, and prevent quality regressions in your automated development loop.

For a quick reference of directory structure and check types, see [README.md](./README.md).

---

## 1. Why Evals? (The Problem They Solve)

Your loop says 100% pass rate, 96.67 composite score, 0 retries — but manual review finds 5 critical and 7 major wiring issues. The tests pass because they test the code that was written, not whether the code was wired into the system correctly.

**The core problem**: unit tests pass but features aren't connected. The pipeline reports "success" because:
- The agent wrote code ✓
- The tests pass ✓
- The review didn't catch the gap ✓
- Verification was skipped (non-UI change) ✓

But the feature doesn't actually work at runtime because a service was never registered, a route was never mounted, or a dependency was never injected.

**What evals give you**:
- A measurable score for each pipeline step (plan, implement, review, verify)
- The ability to test: "Does my review prompt catch wiring issues?"
- Before/after comparison when you change prompts
- Regression detection — a prompt change that helps one case shouldn't break another

Without evals, you fix prompts by gut feel and hope for the best. With evals, you have a number that goes up or down.

---

## 2. The Two Types of Eval Failures

### Pipeline Failures
The agent crashed, tests didn't pass, or the review gate explicitly failed. These are easy to detect because the session reports `status: failure`.

**Capture with**: `alpha-loop eval capture`

### Quality Failures (False Positives)
The pipeline "succeeded" but the output is broken. The agent wrote code, tests pass, review said LGTM — but the feature doesn't actually work. These are **more dangerous** because they give false confidence.

**Capture with**: `alpha-loop eval capture --quality`

The `--quality` flag walks through successful sessions and lets you mark which issues had quality problems, attribute them to a pipeline step, and auto-generate LLM judge rubrics.

**Examples of quality failures**:
- Service created but never registered in the dependency injection container
- Route handler written but never mounted on the router
- Configuration value read but the default silently swallows `None`
- Database migration written but the model doesn't reference the new table

---

## 3. Which Pipeline Step Should You Eval?

When you find a problem, the first question is: which pipeline step should have caught it?

| Symptom | Step to Eval | Example |
|---------|-------------|---------|
| Wrong files modified | plan | Planner didn't identify the right files to change |
| Feature works but not wired | implement | Implementer didn't add service to bootstrap |
| Wiring issue not caught | review | Reviewer missed silent None guard |
| Works in test, breaks at runtime | verify | No runtime validation for backend changes |
| Bad patterns repeated across sessions | learn | Learnings not extracted or not applied |

**Rule of thumb**: If the code is wrong, eval the implementer. If the code is right but not connected, eval the reviewer (it should have caught the gap). If neither step catches it, eval the verifier.

---

## 4. Tutorial: From Bug Report to Better Score

Walk through the full cycle using a real example from the livestreamtoagi session.

### Step 1: Discover the Problem
Manual audit of the session finds that `ArtifactRepo` is never instantiated or injected into the `Services` container. Multiple features depend on artifact data, but nothing writes to the artifacts table.

### Step 2: Decide Which Step Failed
The implementer wrote the features but didn't wire the service. The **reviewer** should have caught that `Services` has no `artifact_repo` field and `build_agent_tools()` never passes it to `get_core_tools()`.

This is a **review** eval case.

### Step 3: Create the Eval Case

```bash
mkdir -p .alpha-loop/evals/cases/step/review/006-missing-di-injection/
```

### Step 4: Write the Input (`input.md`)
Copy the frozen diff from the actual session. This is what the reviewer will see:

```markdown
# The diff that should have been flagged

diff --git a/core/services.py b/core/services.py
--- a/core/services.py
+++ b/core/services.py
@@ -15,6 +15,8 @@ class Services:
     db: Database
     llm: LLMProvider
+    # Note: no artifact_repo field added here
...
```

### Step 5: Write the Rubric (`checks.yaml`)

```yaml
type: step
step: review
eval_method: llm-judge
status: ready
timeout: 180
checks:
  - type: llm_judge
    model: claude-haiku-4-5
    rubric: |
      Evaluate whether the review identifies that ArtifactRepo is never
      instantiated or injected into the Services dataclass.

      Score 1-5:
      - Score 5: Review identifies missing injection and explains downstream impact
      - Score 4: Review identifies the missing injection
      - Score 3: Review mentions artifacts being incomplete
      - Score 2: Review discusses features without identifying the gap
      - Score 1: Review does not identify the missing dependency injection
    min_score: 4
```

### Step 6: Write Metadata (`metadata.yaml`)

```yaml
id: 006-missing-di-injection
description: "Review catches missing ArtifactRepo dependency injection"
tags:
  - review
  - wiring
  - dependency-injection
source: manual
```

### Step 7: Run Baseline

```bash
alpha-loop eval --step review --case 006 --verbose
```

Note the score (e.g., 2/5 — reviewer missed it).

### Step 8: Update the Prompt
Add wiring-detection language to the review prompt in `src/lib/prompts.ts` or your project's `.alpha-loop/templates/agents/reviewer.md`:

```
- Check that every new service/class is registered in the DI container
- Verify that new dependencies are injected, not just imported
- Flag any service that is created locally but never added to the service container
```

### Step 9: Run Again

```bash
alpha-loop eval --step review --case 006 --verbose
```

### Step 10: Compare

```bash
alpha-loop eval compare 1 2
```

Score improved from 2 to 4? Ship the prompt change. Score didn't improve? Iterate on the prompt.

---

## 5. Understanding the Eval Commands

| Command | When to Use | What It Does |
|---------|------------|--------------|
| `eval run` | After prompt changes | Run all evals, get composite score |
| `eval run --suite step` | Quick feedback | Run only step-level evals (fast, cheap) |
| `eval run --step review` | Targeted testing | Run only review step evals |
| `eval run --case 006` | Single case | Run one specific eval case |
| `eval capture` | After session failures | Auto-create eval cases from pipeline failures |
| `eval capture --quality` | After false-positive sessions | Create cases from quality issues in "successful" sessions |
| `eval capture --quality 190` | Specific issue | Capture quality failure for a specific issue number |
| `eval capture --quality --session <name>` | Filter by session | Only look at a specific session |
| `eval list` | Orientation | See what cases exist and their types |
| `eval scores` | Track progress | Score history over time |
| `eval compare <run1> <run2>` | A/B testing | Compare two runs side-by-side per case |
| `eval search` | Optimization | Find best model/config per pipeline step |
| `eval pareto` | Budget optimization | Show score vs cost Pareto frontier |
| `eval estimate` | Before expensive runs | Predict cost of running the eval suite |
| `eval compare-configs <a> <b>` | Config comparison | Compare two YAML configs side-by-side |
| `eval convert` | Format bridge | Convert between AlphaLoop and skill-creator formats |
| `evolve` | Automated optimization | Meta-Harness optimization loop (propose → eval → keep/discard) |

### Filtering Options for `eval run`

- `--tags security,wiring` — run only cases with matching tags
- `--suite step` or `--suite e2e` — run step-level or full pipeline evals
- `--type step` or `--type full` — same as suite
- `--step review` — run only cases for a specific pipeline step
- `--case 006` — run a single case by ID prefix
- `--verbose` — show detailed output per case

---

## 6. How Prompts Propagate (Where to Make Changes)

There are three layers, each serving a different purpose:

```
alpha-loop repo (source code)
├── src/lib/prompts.ts              # Hardcoded prompt logic — affects ALL users
├── templates/skills/               # Default skills shipped to new users
└── templates/agents/               # Default agent prompts shipped to new users

Your project repo (consumer)
├── .alpha-loop/templates/skills/   # YOUR project's skills (override defaults)
├── .alpha-loop/templates/agents/   # YOUR project's agent prompts (override defaults)
└── .alpha-loop.yaml                # YOUR config (model, retries, etc.)

Synced copies (auto-generated, don't edit)
├── .claude/                        # Synced from .alpha-loop/templates/
├── .agents/                        # Synced from .alpha-loop/templates/
└── .codex/                         # Synced from .alpha-loop/templates/
```

### When to Change What

| Scenario | Where to Edit |
|----------|---------------|
| Fix affects ALL alpha-loop users | `src/lib/prompts.ts` or `templates/` |
| Fix is specific to your project | `.alpha-loop/templates/` |
| Testing a prompt change with evals | `.alpha-loop/templates/` first, then upstream if it helps |
| You updated alpha-loop and want new defaults | `alpha-loop review --apply` checks for upgrades |

### Divergence Risk

If you customize `.alpha-loop/templates/agents/reviewer.md` and alpha-loop ships an updated `templates/agents/reviewer.md`, your version wins. This is by design — your customizations are never overwritten.

`alpha-loop review` detects this divergence and offers to merge upstream improvements. Run it periodically to stay current without losing your customizations.

---

## 7. Testing the Implementer (Not Just the Reviewer)

The review step catches issues after the fact. But you can also eval whether the **implementer** produces better code in the first place.

### How Implement Evals Work

1. Provide a fixture repo at a specific commit (the starting state)
2. Give the implementer an issue to implement
3. Check: did it wire things up? Did it add to bootstrap? Did it register routes?

### Check Types for Implement Evals

```yaml
# .alpha-loop/evals/cases/step/implement/006-wire-new-service/checks.yaml
type: step
step: implement
checks:
  - type: grep
    file: core/bootstrap.py
    pattern: "artifact_repo"
  - type: grep
    file: core/tool_executor.py
    pattern: "artifact_repo=services.artifact_repo"
  - type: file_exists
    path: core/repositories/artifact_repo.py
  - type: test_pass
```

### When to Use Implement vs Review Evals

- **Implement evals**: "Does the agent wire things up correctly in the first place?"
- **Review evals**: "Does the reviewer catch it when the implementer forgets?"

Both are valuable. Implement evals are slower and more expensive (they run the full agent), but they test the proactive case. Review evals are fast and cheap (they just check the reviewer's output against a frozen diff).

---

## 8. Verification Methods

The verify step supports multiple methods beyond Playwright browser testing:

| Method | Use Case | How It Works |
|--------|----------|-------------|
| `playwright` | UI changes | Spawns agent with playwright-cli to test the app |
| `script` | Custom validation | Runs a shell command, passes if exit code 0 |
| `boot` | Service startup | Imports/runs the app entry point, checks for crashes |
| `cli` | CLI testing | Runs CLI commands, checks exit codes |
| `api` | API endpoints | Runs API validation commands |

### Configuring Verification in Plans

The planning agent now supports non-UI verification:

```json
{
  "verification": {
    "needed": true,
    "method": "script",
    "command": "python -c \"from core.bootstrap import bootstrap_services; import asyncio; svc = asyncio.run(bootstrap_services()); assert svc.artifact_repo is not None\"",
    "reason": "Verify service container resolves all dependencies"
  }
}
```

### Smoke Test Config

Add a global smoke test that runs after every session:

```yaml
# .alpha-loop.yaml
smoke_test: "python -c 'from core.bootstrap import bootstrap_services; ...'"
```

This runs after the verify step and before the PR is created.

---

## 9. When to Retire an Eval Case

An eval case should be retired when:

- **Structurally prevented**: A lint rule, type check, or CI gate now catches the issue automatically. The eval is redundant.
- **Consistently maxed out**: The eval scores 5/5 across multiple prompt versions and model configurations. It's no longer discriminating between good and bad prompts.
- **Fixture is unrealistic**: The underlying codebase has changed so much that the frozen diff/fixture doesn't represent realistic code anymore.

**Don't retire cases just because your current prompts score well.** Future prompt changes could regress. Keep eval cases as a safety net until the issue is structurally prevented.

### How to Retire

Move the case directory to `.alpha-loop/evals/retired/` (or just delete it). Document why in a commit message so you can restore it if needed.

---

## 10. Contributing Eval Cases Back to Alpha Loop

If you find a wiring pattern that alpha-loop's default prompts should catch:

1. **Create the eval case** in your project's `.alpha-loop/evals/cases/`
2. **Verify it works** — run it against your current prompts, confirm the score reflects what you expect
3. **Generalize the input** — replace project-specific names with generic ones (e.g., `ArtifactRepo` → `ServiceRepo`, `livestreamtoagi` → `myproject`)
4. **Submit a PR** to alpha-loop adding the case to `templates/` or `.alpha-loop/evals/`
5. **Include the prompt fix** that makes the eval pass — the case is most valuable when paired with the improvement it drives

This builds a shared eval suite that improves the default prompts for everyone. The more diverse the eval cases, the more robust the prompts become.

---

## Quick Reference

### Creating a Step Eval Case

```bash
mkdir -p .alpha-loop/evals/cases/step/{step-name}/{case-name}/
```

Every case needs three files:
- `metadata.yaml` — id, description, tags, source
- `checks.yaml` — type, step, eval_method, checks
- `input.md` — the raw input fed to the agent (diff for review, issue for implement)

### Running Evals

```bash
alpha-loop eval                          # Run all evals
alpha-loop eval --suite step             # Step-level only (fast)
alpha-loop eval --step review --verbose  # Review cases with details
alpha-loop eval scores                   # Score history
alpha-loop eval compare 1 2              # Compare two runs
```

### Capturing Failures

```bash
alpha-loop eval capture                  # Interactive: walk through failures
alpha-loop eval capture 47               # Capture specific issue
alpha-loop eval capture --quality        # Quality failures from successful sessions
alpha-loop eval capture --quality 190    # Specific quality failure
```
