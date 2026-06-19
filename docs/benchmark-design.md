# Alpha-Loop-Bench — Designing a Legitimate Benchmark for Long-Horizon Coding Agents

A design document for turning Alpha Loop from a tool that *runs* coding agents into a benchmark that *measures* them — model vs. harness vs. methodology — in a way the industry could actually trust.

Status: design / RFC. Author-facing notes and interview talking points are in §12.

---

## 0. The one-paragraph version

Alpha Loop already contains most of a benchmark: a step/full eval framework, a routing matrix runner, a SWE-bench importer, per-stage cost/telemetry, a composite score, and a Pareto analysis. What it does *not* yet have is the methodology that makes a number defensible — fixture isolation, contamination controls, an oracle stronger than "tests pass," repeated runs with confidence intervals, and a clean separation of the three things that are currently entangled: the **model**, the **harness**, and the **Loop methodology** (skills + agent instructions). This document specifies that methodology, names exactly what can and cannot be measured, audits the repo's flaws as a measuring instrument, and gives a phased plan to ship a credible, open-source benchmark.

---

## 1. What is actually being measured (the construct)

Before any code, define the construct precisely. A benchmark is only as legitimate as the clarity of the thing it claims to measure. Alpha-Loop-Bench measures:

> The ability of an automated system to take a software task specified at the level of a GitHub issue and carry it to a *correct, integrated, shipped* change with no human intervention, across a long horizon of multiple files and multiple pipeline stages, at a stated cost and time budget.

Three factors are entangled inside that single sentence, and the central design problem is separating them:

| Factor | What it is in Alpha Loop | Why it matters |
|---|---|---|
| **Model** | The LLM behind a stage (`model`, per-stage `pipeline.*.model`, `routing.stages.*.model`) | The thing vendors ship and the thing a leaderboard nominally ranks |
| **Harness** | The agent CLI + scaffolding: `claude` / `codex` / `opencode` / local, plus tool exposure, context management, retries | Scaffolding changes alone move SWE-bench scores 10–20 points with no model change |
| **Methodology** | Alpha Loop's own skills, agent prompts (`templates/`, `.alpha-loop/templates/`), and the learn loop | This is *your* product. Proving it helps is a different experiment from ranking vendors |

The literature is blunt about this: "when you evaluate an agent, you evaluate harness + model together — the two cannot be separated in practice." A benchmark that reports "Model X scored 40%" without pinning the harness and methodology is reporting noise dressed as signal. Alpha-Loop-Bench's job is to make the pinning explicit and to vary one factor at a time.

### Why "long-horizon" specifically

Short tasks (single-function bug fixes) are saturating and easy to contaminate. The interesting, unsaturated frontier is sustained multi-file work: recent long-horizon sets report agents at ~25% where the same agents hit ~70%+ on short-task SWE-bench Verified, and frontier agent+model combinations score under 65% on hard terminal tasks even at 5+ runs each. That gap is the headroom Alpha-Loop-Bench should live in. A task only qualifies as long-horizon here if it requires **≥3 files touched, ≥2 pipeline stages to genuinely engage (plan + implement at minimum), and a human reference time of ≥30 minutes.**

---

## 2. The design principles a benchmark must satisfy

These are the acceptance criteria for the benchmark itself, drawn from current best-practice checklists for agentic evals. Every later section maps back to one of these.

1. **Outcome validity** — success must mean the task was actually solved, not that a weak proxy passed. (Tests passing ≠ feature working; see §4's oracle.)
2. **Task validity** — each task must be solvable, unambiguous, and actually require the capability claimed. The golden solution must pass; an empty solution must fail.
3. **Contamination control** — tasks the model has memorized measure memory, not capability. Requires temporal holdout and/or private tasks. (§4)
4. **Statistical rigor** — single-run results are unreliable; single-run pass@1 swings 2–6 points by luck of the draw. Requires N≥5 repeats, confidence intervals, and pass@k / reliability metrics. (§6)
5. **Reproducibility & isolation** — a run must not depend on hidden state (prior worktrees, accumulated learnings, live GitHub). Same inputs → same distribution of outcomes. (§7)
6. **Factor separation** — vary model, harness, or methodology one at a time; never report a delta that confounds them. (§3)
7. **Honesty about limits** — state plainly what the benchmark does not measure. (§8)

A benchmark that nails 1–7 is publishable. Alpha Loop today satisfies roughly 2 and half of 6; the rest is the work.

---

## 3. Factor separation: the experimental design

This is where Alpha Loop has an unusual advantage. Because it already supports **per-stage model and endpoint routing** (`routing.stages.{plan,build,test_write,test_exec,review,summary}`), it is a natural ablation rig: you can hold the harness and five stages fixed and swap the model on exactly one stage. Most benchmark harnesses cannot do this at all.

### The cells

Treat the benchmark as a factorial experiment. A "config" is one fully-specified cell:

```
config = (harness, model_per_stage, methodology_variant, task_set, seed_policy)
```

Valid comparisons hold all-but-one constant:

- **Model ranking** — fix harness = `claude` (or `codex`), fix methodology = default, swap the model used on *all* stages. Answers "best model end-to-end for this harness."
- **Stage attribution** — fix everything, swap the model on *one* stage at a time (plan-only, review-only, …). Answers "where does a stronger/cheaper model pay off." This is the question you specifically asked ("what stage each model works best on") and it is only answerable because of per-stage routing.
- **Harness ranking** — fix model, fix methodology, swap `agent` (claude/codex/opencode). Answers "best scaffold for a given model" — with the capability caveat in §8.
- **Methodology A/B** — fix model + harness + tasks + seeds, toggle skills/instructions. This is the internal experiment in §10.

### What is *not* a valid comparison

- Different harnesses with different default models (the usual vendor-blog mistake).
- Any cell where the escalation/fallback is live, because the "model under test" can be silently swapped mid-run (§7, §9).
- Local-endpoint cost vs. cloud-endpoint cost (local records \$0 in telemetry; see §8).

The `eval-matrix` runner already computes per-cell metrics and deltas against a baseline profile — the design above is mostly a discipline layered on top of machinery that exists, plus the isolation fixes in §7.

---

## 4. Tasks: sourcing, schema, and the oracle

You said tasks should come from a variety of places and ideally be unseen. There is no single source that is simultaneously realistic, contamination-proof, cheap, and diverse — so use a **tiered portfolio** and report per-tier, never pooling them into one headline number that hides the tradeoff.

### 4.1 The four task tiers

| Tier | Source | Contamination risk | Realism | Cost to build | Role |
|---|---|---|---|---|---|
| **A — Held-out private** | Hand-authored tasks + hidden test suites, never published | Lowest (you control disclosure) | High | High | The headline metric; the private test set |
| **B — Synthetic seeded** | Procedurally planted bugs/features in fresh or templated repos | None (generated per run) | Medium | Medium (build the generator once) | Reproducibility anchor; cheap volume; regression CI |
| **C — Real GitHub, post-cutoff** | Issues/PRs created *after* a model's training cutoff, frozen at base commit | Low if cutoff is enforced; decays over time | Highest | Medium | Freshness + external validity; rotated quarterly |
| **D — Dogfood** | Alpha Loop's own backlog (its eval cases already exist) | Medium (public repo) | High for *your* domain | Lowest | Fast internal signal; not for the public leaderboard |

Deliberately **demoted: raw SWE-bench Lite/Verified as a headline.** Your `eval-swebench` importer is valuable, but those instances are in everyone's training data now. Use them only as a *calibration baseline* ("our harness reproduces the published SWE-bench number, so our plumbing is sound"), never as the score you rank vendors by. Publishing a contaminated set as your headline is the fastest way for the benchmark to be dismissed.

The "ideally unseen" goal is best served by **Tier A (private)** and **Tier C (temporal holdout)**. Note honestly: you cannot *prove* unseen-ness for any public task (see §8); temporal holdout is the strongest practical approximation, and it decays, which is why the benchmark must be a *living* set that rotates (§11).

### 4.2 Task schema

Extend the existing `metadata.yaml` / `checks.yaml` / `input.md` case format. Add the fields that make a task auditable:

```yaml
# metadata.yaml
id: c-0142-stripe-webhook-retry
tier: C                      # A | B | C | D
source: github:acme/payments#318
provenance_date: 2026-04-12  # issue creation date — the contamination clock
base_sha: 9f2a...            # frozen repo state the agent starts from
language: typescript
difficulty:
  human_reference_minutes: 90
  files_expected: 6
  stages_required: [plan, implement, test, review]
license: MIT                 # must be redistributable to open-source the task
tags: [webhooks, idempotency, retry]
```

```yaml
# oracle.yaml  (renamed from checks.yaml to reflect its true job)
visibility: hidden           # agent never sees these
layers:
  - type: fail_to_pass       # hidden tests that fail before, pass after
    tests: [test_webhook_retry.py::test_idempotent]
  - type: pass_to_pass       # existing tests that must stay green (no regressions)
    tests: [test_webhook.py]
  - type: integration_boot   # the feature is actually wired, not just unit-tested
    command: "python -c 'from app.bootstrap import build; assert build().webhook_retry'"
  - type: diff_guard         # anti-reward-hacking
    forbid_changes_to: ["tests/**", ".github/**"]
  - type: llm_judge          # TIEBREAK ONLY, never primary
    weight: 0
    rubric: ...
```

### 4.3 The oracle problem (this is the crux of outcome validity)

Your own eval GUIDE makes the case better than any paper: *"unit tests pass but features aren't connected… the pipeline reports success because the agent wrote code, tests pass, review said LGTM — but the feature doesn't work at runtime."* That is the false-positive failure mode, and it means **`test_pass` alone is a broken oracle.** A legitimate benchmark needs a layered oracle:

1. **FAIL_TO_PASS** hidden tests — necessary signal the task was addressed.
2. **PASS_TO_PASS** — the change didn't break existing behavior.
3. **Integration/boot check** — the new code is actually reachable from the app entry point (catches the "wired" failures the GUIDE describes).
4. **Diff guard** — the agent cannot edit the tests, CI config, or the oracle itself. Without this, a long-horizon agent *will* eventually "solve" a task by weakening its tests. This must be structurally enforced, not just checked after the fact.
5. **LLM-judge** — allowed only as a zero-weight tiebreak or as a *secondary* quality signal, never as the primary pass/fail. The judge is itself a model with contamination and self-preference bias; a benchmark whose score is decided by a judge model is measuring the judge.

**Task-validity gate (run once per task, before it enters the set):** apply the golden patch → all oracle layers pass 100/100 runs; apply an empty patch → fail 100/100. If either is flaky, the task is rejected. This single gate eliminates most "noise" people blame on the model but that actually comes from a flaky oracle.

---

## 5. Metrics

Report a **vector**, not a single scalar. Collapsing prematurely is how benchmarks lie.

### Primary (outcome)
- **resolved@1** — fraction of tasks fully passing the layered oracle, averaged over N runs, with a 95% bootstrap confidence interval. This is *the* number.
- **pass@k** — probability the task is solved in at least one of k attempts (capability ceiling).
- **pass^k / reliability** — probability it is solved in *all* k attempts (production trustworthiness). For an autonomous loop, reliability matters more than ceiling.

### Stage attribution (the question you care about)
- **Failure-stage distribution** — for each failure, which stage is responsible (plan picked wrong files / implement didn't wire / review missed it / verify absent). Derivable from the existing `stages.jsonl` telemetry + the GUIDE's symptom→stage table.
- **Stage-swap lift** — change in resolved@1 from upgrading the model on exactly one stage. This is the deliverable that answers "which model is best at which stage."

### Efficiency (secondary)
- Cost (USD), input/output tokens, wall-clock, retries, tool-error rate — all already in `costs.json` / telemetry. Report retries as a *metric*, never silently consumed by the score.
- **Files-changed precision/recall** vs. the golden patch — measures planning accuracy independent of test outcome.

### Quality / false-positive rate (a differentiator)
- **% of "successes" that fail an independent post-hoc audit.** This operationalizes your `eval capture --quality` concept as a headline metric. Almost no public benchmark reports it, and it directly measures the failure mode your GUIDE is built around. It is a strong, defensible reason for the benchmark to exist.

### On the composite score
The current formula is `score = (passing/total)*100 − 0.1*avg_retries − 0.01*avg_duration` (documented in `score.ts` as "from autoresearch pattern"). Two problems make it unfit as a *headline*: the weights (0.1, 0.01) are unjustified, and it adds quantities in different units (success %, retry count, seconds) — a 100-second run silently costs a full point regardless of whether it succeeded. Recommendation: keep it as an internal convenience signal, but rank publicly on **resolved@1 + its CI**, and present efficiency via the **Pareto frontier (score vs. cost)** you already compute. If a single utility number is ever required, derive it from a documented, normalized, pre-registered utility function — and show the frontier alongside it so the weighting can be inspected.

---

## 6. Statistics and the run protocol

- **N ≥ 5 runs per (task, config) cell.** Single runs are disqualifying; pass@1 from one run swings 2–6 points on noise alone, which is larger than most claimed improvements.
- Report **mean resolved@1 with a 95% bootstrap CI** per cell. A delta whose CI crosses zero is not a result.
- For methodology A/B (§10), use **paired** analysis (same tasks, both arms) and McNemar / paired bootstrap — far tighter than unpaired, so you need fewer tasks to detect a real effect.
- **Power sizing (rough):** with per-task noise ~3–6 points and a target minimum detectable effect of ~5 points at 80% power, plan for **≥50 tasks per tier × 5 runs**. Fewer tasks is fine for internal iteration but not for a public claim.
- **Pin everything:** model version/date, temperature (0 where the API allows), harness version, Alpha Loop version, config hash. The existing `config.snapshot.yaml` + `hashConfig()` already do most of this — extend the result artifact to store `runs[]` with per-run outcomes, not just an aggregate.

---

## 7. Controlling noise — threats to reproducibility and how to neutralize them

Every item below is grounded in Alpha Loop's actual behavior. These are the things that make two runs of the same task disagree for reasons that have nothing to do with the model.

| # | Noise source (file) | Effect on a benchmark | Control |
|---|---|---|---|
| 1 | **Live GitHub mutation** — `eval-matrix.ts` documents that `processIssue()` hits live GitHub and case IDs parse back to *real issue numbers*, so a matrix run mutates real issues. Dry-run is the default *because of this*. | Trials are not isolated; runs change shared state; cannot reproduce. **This is the #1 blocker.** | Build **fixture isolation**: clone the fixture at `base_sha`, run the pipeline in `--local` mode with all GitHub calls stubbed. No benchmark is legitimate until this lands. |
| 2 | **Learning loop** — learnings persist in `.alpha-loop/learnings/` and are injected into later prompts (`prompts.ts:248`). | Trials are *not independent*; run order changes results; a later run benefits from an earlier one. | For ranking runs: `skip_learn: true` **and** wipe the learnings dir between cells. To study the loop itself, make it an *explicit* variable (§10), never an uncontrolled one. |
| 3 | **Escalation / fallback** — `routing.fallback.on_tool_error: escalate` swaps to a different model after tool errors; a rolling error-rate guardrail can pin a stage to the fallback for 24h. | The "model under test" silently becomes a different model. Destroys model attribution. | Disable fallback for all ranking cells. Measure escalation separately as a *harness* feature. |
| 4 | **Worktree reuse** — `worktree.ts` reuses an existing worktree/branch if present (`resumed` flag). | Stale files from a prior run leak in. | Force a fresh worktree (clean clone) per trial; assert the tree matches `base_sha` before starting. |
| 5 | **Test retries** — `max_test_retries: 3`. | Inflates success and hides flakiness; different cells may retry different amounts. | Hold retries constant across cells and *report* retry count as a metric. The oracle's pass/fail is taken at a fixed attempt budget. |
| 6 | **Timeouts** — `agent_timeout` (30 min default) and a 5-min test timeout; timeout is classified as permanent failure. | Different budgets advantage slower/faster models unfairly. | Fix an identical wall-clock + turn budget across every cell; record budget in the config snapshot. |
| 7 | **Model nondeterminism** — temperature, server-side variation, no pinned version. | Irreducible run-to-run variance. | temp=0 where supported; pin model by dated version; absorb the rest with N≥5 + CIs (don't pretend it's zero). |
| 8 | **Cost estimation fallback** — when tokens aren't returned, cost is estimated as `chars/4`; local endpoints record \$0. | Cost metric is noisy and non-comparable local-vs-cloud. | Prefer provider-reported tokens; flag estimated costs; never compare local \$0 against cloud on the same axis (§8). |
| 9 | **Flaky fixture oracle** | Misattributed to the model. | The §4.3 task-validity gate (golden passes 100/100, empty fails 100/100) rejects flaky tasks before they enter the set. |

The pattern: **isolate (1,2,4), fix-as-constant (5,6), disable-or-make-explicit (3), absorb statistically (7), and gate out (9).**

---

## 8. What cannot be benchmarked (state it plainly)

A benchmark earns trust partly by being honest about its blind spots. Alpha-Loop-Bench cannot measure:

- **True unseen-ness.** You cannot prove a model never saw a task. Temporal holdout (Tier C) and private tasks (Tier A) approximate it; both decay as models retrain. The only durable answer is a *living* benchmark that rotates tasks — there is no static set that stays uncontaminated.
- **Subjective code quality / maintainability / idiomaticity.** The oracle checks behavior and wiring. "Is this code *good*" is a weak proxy at best (LLM-judge), and the judge is itself biased. Don't claim to measure it; measure the false-positive rate instead, which is objective.
- **Transfer to *your* codebase.** A high score predicts performance *on the benchmark*. Generalization to a specific production repo is an assumption, not a measurement.
- **Cross-harness fairness in an absolute sense.** Harnesses expose different capabilities (subagents, memory, browser tools). Holding the model fixed and swapping harness is partly apples-to-oranges; publish a **capability matrix** so readers see what each harness was allowed to do rather than pretending the comparison is clean.
- **Local vs. cloud cost on one axis.** Local endpoints record \$0; that is not "free," it's unmeasured. Cost comparisons are valid only within the same endpoint class.
- **Genuinely ambiguous / human-in-the-loop tasks.** Tasks that legitimately need human judgment (`needs-human-input` outcomes) have no automatable oracle and must be excluded from the scored set, even though they're common in real work.
- **The Loop's non-model stages.** PR creation, label management, GitHub orchestration depend on external services and network, not model skill. Exclude them from the scored construct (they belong in an SRE/reliability dashboard, not the model leaderboard).
- **Correctness in the strong sense.** Tests sample behavior; passing tests cannot prove the absence of bugs. The benchmark measures *demonstrated* correctness against a finite oracle, nothing more.

---

## 9. Alpha Loop's flaws as a measuring instrument (repo audit)

Distinct from the noise sources in §7 — these are properties of the codebase that would undermine a benchmark built naively on top of it. Ordered by severity.

1. **No fixture isolation → live GitHub coupling (blocker).** `eval-matrix.ts` itself documents that case IDs map to real issue numbers and runs mutate the live repo, which is why dry-run is the default. Until tasks run against frozen clones with stubbed GitHub, the harness cannot produce reproducible, side-effect-free trials. Fix first.
2. **Oracle is too weak by default.** `test_pass` is the primary check, but the GUIDE documents exactly how that yields false positives (unwired features). The `integration_boot` and `diff_guard` layers in §4.3 must be mandatory, not optional.
3. **Composite score is arbitrary and single-run.** `score.ts` mixes units with unjustified weights and is computed from one run. Fine internally; unfit as a public headline (§5).
4. **Learning loop contaminates trials.** Persisted, prompt-injected learnings (`learning.ts`, `prompts.ts`) break trial independence — great for a product, disqualifying for an uncontrolled benchmark (§7 #2).
5. **Escalation/fallback confounds model identity.** Routing fallback can replace the model under test mid-run (§7 #3).
6. **Cost signal is noisy.** `chars/4` estimation and \$0 local endpoints make cost non-comparable across endpoint classes (§7 #8).
7. **LLM-judge as grader.** Several step cases grade with `llm_judge` (e.g., `claude-haiku-4-5`). Using a model to grade models invites self-preference and contamination; demote to tiebreak/secondary (§4.3).
8. **Inconsistent definition of "done."** `skip_verify`, `skip_tests`, `skip_review` can each flip per run, so "success" can mean different things across cells. The benchmark must fix a single, non-skippable success definition.
9. **Construct under-sampling.** Existing cases skew to TS/Python wiring bugs. A long-horizon coding benchmark needs language and task-type diversity (refactors, migrations, perf, multi-service) or it measures a narrow slice and claims the whole.
10. **Reward-hacking surface.** The agent runs in the same tree where tests live and can edit them. The `keyword_absent` check is a soft guard; the benchmark needs a *structural* diff guard that fails the trial if protected paths change.

None of these are fatal to Alpha Loop as a *product* — several are features. They are simply the gap between "a loop that ships code" and "an instrument that measures models," and naming them precisely is most of the value of this exercise.

---

## 10. Isolating "do my skills and instructions actually help?"

This is the experiment you most directly control, and it's *easier* than the public leaderboard because you own every variable. It's also the one that tells you whether your product works.

**Design:** a paired, single-factor A/B.

- Hold **model, harness, task set, seeds, budgets** fixed.
- Toggle exactly one methodology factor: skills on/off, or instruction variant A vs. B. Because skills/prompts live in `templates/` vs. `.alpha-loop/templates/`, you can branch them cleanly.
- Run both arms over the **same tasks** (paired) at N≥5 each.
- Use a **two-tier task set**: the existing cheap **step-level** cases (`learn`, `skill`, `review`) for fast iteration, plus a smaller **full-pipeline** set for end-to-end confirmation. A skill that improves a step eval but not end-to-end resolved@1 hasn't earned a ship.

**Analysis:** McNemar / paired bootstrap on resolved@1, plus the false-positive-rate delta. Paired design means a 5-point real effect is detectable with far fewer tasks than the unpaired leaderboard needs.

**Two traps to avoid:**

- **Learning-loop leakage.** If learnings persist, the "off" arm can teach the "on" arm. Wipe learnings between arms (§7 #2).
- **Overfitting via `evolve`.** Your `evolve` command automates propose→eval→keep, which is exactly the right loop — but optimizing against the eval set overfits it. Keep a **held-out methodology test set** that `evolve` never sees, and report the final skill/instruction change against *that*. Pre-register the metric before running so you're not picking the winner post hoc from a dozen metrics.

This A/B is the cleanest "win" to demo: it produces a defensible "our skills add X points of resolved@1, 95% CI [a, b], on tasks the optimizer never saw."

---

## 11. The benchmark spec and release plan

### Directory layout (extends `.alpha-loop/evals`)

```
alpha-loop-bench/
├── tasks/
│   ├── A-private/        # held-out; only hashes + metadata public, tests private
│   ├── B-synthetic/      # generator + seed list (reproducible, fully public)
│   ├── C-github/         # post-cutoff real tasks, frozen at base_sha
│   └── D-dogfood/        # internal only
│       └── <id>/{metadata.yaml, oracle.yaml, input.md, golden.patch}
├── profiles/             # config cells (harness × model-per-stage × methodology)
├── results/
│   └── <run-id>/{config.snapshot.yaml, runs.jsonl, scores.json, costs.json, traces/}
├── CONTAMINATION.md      # provenance + cutoff statement per task
├── CAPABILITY_MATRIX.md  # what each harness was permitted to do
└── LEADERBOARD.md        # versioned, dated, with CIs
```

### Result artifact (extend the existing `scores.json`)

Add a `runs[]` array (per-run outcomes, not just aggregate), per-cell **mean + 95% CI**, pass@k, pass^k, false-positive rate, and the full config hash. The aggregate-only format today cannot express a confidence interval, which is the single most important addition.

### Run protocol (the public recipe)

```bash
# 1. Materialize a task tier into isolated fixtures (no live GitHub)
alpha-loop bench prepare --tier C --out fixtures/

# 2. Run a config cell, N times, fully isolated
alpha-loop bench run --profile claude+opus-allstage \
  --tasks fixtures/ --runs 5 --isolated --skip-learn --no-fallback

# 3. Aggregate with CIs and emit the leaderboard row
alpha-loop bench report --run-id <id> --ci bootstrap
```

(`prepare`, `--isolated`, `--no-fallback`, and the CI-aware `report` are the net-new pieces; the rest maps onto existing `eval` / `eval-matrix` / telemetry code.)

### Credibility checklist for the public release

- **Split disclosure:** publish Tier B fully (it's contamination-proof), publish Tier C tasks but keep some Tier A private as the anti-gaming test set.
- **Versioned + dated** leaderboard; every score carries model date, harness version, N, and CI.
- **Capability matrix** so harness comparisons are read honestly.
- **Raw traces published** so anyone can audit a run.
- **Contamination statement** per task (provenance date vs. model cutoff).
- **N≥5 and CIs required** for any submitted score — make it a submission rule, not a suggestion.

### Phasing

- **Phase 1 (make it real):** fixture isolation (§7 #1) + the layered oracle (§4.3) + N-run/CI reporting + one tier (start with B synthetic, since it's reproducible and contamination-proof). Deliverable: a number you can defend.
- **Phase 2 (make it interesting):** add Tier C post-cutoff tasks and the full harness × model × stage matrix; ship stage-attribution results.
- **Phase 3 (make it durable):** private rotating Tier A, public leaderboard with submission protocol, quarterly task refresh to fight contamination decay.

---

## 12. Interview talking points

- **The thesis in one line:** "Alpha Loop already *ran* agents; I made it *measure* them — and the hard part wasn't the harness, it was separating the model from the scaffold from my own methodology, then proving the number wasn't noise."
- **The sharpest insight:** the harness's own eval-matrix code admits it mutates the live repo and defaults to dry-run — so the very first thing a real benchmark needs is fixture isolation, and most "agent benchmarks" quietly skip it.
- **The validity hook:** "tests passing" is a broken oracle; my own GUIDE documents the false-positive (unwired feature) mode, so the benchmark grades on a layered oracle and *reports a false-positive rate* — a metric almost no leaderboard publishes.
- **The statistics line:** single-run pass@1 swings 2–6 points on luck; I require N≥5 and confidence intervals, so a 3-point "improvement" doesn't get to masquerade as progress.
- **The honesty that builds trust:** I can list what it *cannot* measure — true unseen-ness, subjective quality, cross-harness fairness, transfer to your repo — and that list is in the README, not buried.
- **The thing you'd cut for v1:** real GitHub mining and the public leaderboard; ship synthetic-seeded tasks first because they're reproducible and contamination-proof, prove the plumbing, then earn the harder tiers.
- **Why it's not just SWE-bench-again:** it's long-horizon, harness-and-stage-aware, reports reliability (pass^k) not just ceiling (pass@k), and treats the methodology layer as a first-class, ablatable variable.

---

### Appendix: mapping to existing code

| Need | Already in repo | Net-new work |
|---|---|---|
| Step & full eval cases | `eval.ts`, `.alpha-loop/evals/cases` | Oracle layering, diff guard |
| Routing matrix / per-cell deltas | `eval-matrix.ts`, `eval-report.ts` | N-run loop, CIs |
| Per-stage metrics | `telemetry.ts` (`stages.jsonl`) | Failure-stage attribution rollup |
| Cost / Pareto | `costs.json`, `score.ts` paretoFrontier | Endpoint-class separation, estimated-cost flagging |
| Real-task import | `eval-swebench.ts` | Post-cutoff Tier-C importer; demote raw SWE-bench to calibration |
| Methodology A/B | `evolve`, skill-bridge, capture | Held-out methodology test set, paired stats |
| Isolation | — | **Fixture clone + GitHub stub (Phase 1 blocker)** |
| Reporting | `scores.json` | `runs[]` + CIs + provenance |

---

*Sources informing the methodology: SWE-bench Pro / SWE-EVO (long-horizon construct), Terminal-Bench 2.0 (harness-as-policy, multi-run trials), "Establishing Best Practices for Building Rigorous Agentic Benchmarks" and the Agentic Benchmark Checklist (outcome/task validity, contamination, statistics), and "On Randomness in Agentic Evals" (single-run variance). Repo claims are grounded in this repository's `src/lib/{eval,eval-matrix,score,telemetry,learning,worktree,agent}.ts`, `.alpha-loop/evals/GUIDE.md`, and `.alpha-loop.yaml`.*
