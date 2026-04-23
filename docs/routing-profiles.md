# Routing Profiles

A routing profile is a named recipe for which model runs which Loop stage.
Alpha Loop ships with a small library of profiles you can copy straight into
`.alpha-loop.yaml`. They're the same shape `alpha-loop eval run --profile` and
`alpha-loop eval --matrix` consume, so once a profile is wired, you can also
A/B it against your eval suite.

Every YAML block below validates against the `RoutingConfig` schema in
[src/lib/config.ts](../src/lib/config.ts). Field reference lives in the
[Per-Stage Routing section of the README](../README.md#per-stage-routing).

For hardware, install, and tuning specifics, see
[docs/local-models.md](local-models.md).

## Choosing a profile

| Profile        | Best when                                     | Tradeoff                                             |
|----------------|-----------------------------------------------|------------------------------------------------------|
| `all-frontier` | You need max autonomy & don't care about cost | Highest cost per issue; no local dependency          |
| `hybrid-v1`    | You have a 64GB+ Mac and want to cut cost     | ~60–80% cost reduction; local coder handles Build/Test; Plan/Review stay frontier |
| `all-local`    | Offline, zero-cost, privacy-constrained       | Lower pipeline success rate; requires 128GB for a coder + summary model concurrently |
| `budget-hawk`  | Large batch runs where quality floor > peak   | Haiku everywhere cloud-side — cheap, slower to convergence on hard issues |

Pick one to start. Once you have telemetry, use
`alpha-loop report routing` to compare cost-per-issue-shipped and
pipeline-success deltas between profiles on your own issues, then promote
the winner with `alpha-loop evolve routing`.

## `all-frontier`

Baseline. Every stage runs on an Anthropic frontier model. This is the
reference profile `alpha-loop eval --matrix` compares against.

```yaml
routing:
  profile: all-frontier
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  stages:
    plan:       { model: claude-opus-4-7,   endpoint: anthropic }
    build:      { model: claude-sonnet-4-6, endpoint: anthropic }
    test_write: { model: claude-sonnet-4-6, endpoint: anthropic }
    test_exec:  { model: claude-sonnet-4-6, endpoint: anthropic }
    review:     { model: claude-sonnet-4-6, endpoint: anthropic }
    summary:    { model: claude-haiku-4-5,  endpoint: anthropic }
```

**When this wins:** brand-new agentic workflow where you can't afford a
regression, or issue sets that are heavy on reasoning-per-token (complex
migrations, security reviews). Measurement only — not the long-term target.

## `hybrid-v1` (recommended default)

Frontier Opus for Plan, frontier Sonnet for Review, local Qwen3-Coder-Next
for the token-heavy middle. Gemma 4 handles summary/learn locally.
Tool-call errors on any local stage escalate back to Sonnet so a stuck local
run doesn't wedge the Loop.

```yaml
routing:
  profile: hybrid-v1
  endpoints:
    anthropic:      { type: anthropic,        base_url: "https://api.anthropic.com" }
    lmstudio_local: { type: anthropic_compat, base_url: "http://localhost:1234" }
  stages:
    plan:       { model: claude-opus-4-7,     endpoint: anthropic }
    build:      { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    test_write: { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    test_exec:  { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    review:     { model: claude-sonnet-4-6,   endpoint: anthropic }
    summary:    { model: gemma-4-31b,         endpoint: lmstudio_local }
  fallback:
    on_tool_error: escalate
    escalate_to:
      model: claude-sonnet-4-6
      endpoint: anthropic
    escalation_window_issues: 10
    escalation_error_threshold: 0.08
```

**When this wins:** you have a 64GB+ Apple Silicon Mac, run the Loop
frequently, and want to cut the dominant cost (Build + Test) without
sacrificing Plan/Review judgment. This is the profile `alpha-loop init`
points you at when it detects qualifying hardware.

## `all-local`

Everything on your machine. No frontier dependency, no network egress, no
cost. Uses Qwen3-Coder-Next for all coding stages and Gemma 4 via Ollama
for the summary stage.

```yaml
routing:
  profile: all-local
  endpoints:
    lmstudio_local: { type: anthropic_compat, base_url: "http://localhost:1234" }
    ollama_local:   { type: openai_compat,    base_url: "http://localhost:11434/v1" }
  stages:
    plan:       { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    build:      { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    test_write: { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    test_exec:  { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    review:     { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    summary:    { model: gemma-4-31b,         endpoint: ollama_local }
  fallback:
    on_tool_error: fail
```

**When this wins:** offline development, privacy-constrained repos, or
benchmarking open-weight models end-to-end. Expect a lower pipeline-success
rate than `hybrid-v1` — there's no frontier escalation to catch stuck runs.
Best paired with `alpha-loop eval --matrix` to quantify the delta against
`all-frontier` on your own issues before committing.

## `budget-hawk`

Haiku for every cloud-side stage, local for the middle. Designed for large
batch runs where per-issue cost matters more than peak reasoning quality.

```yaml
routing:
  profile: budget-hawk
  endpoints:
    anthropic:      { type: anthropic,        base_url: "https://api.anthropic.com" }
    lmstudio_local: { type: anthropic_compat, base_url: "http://localhost:1234" }
  stages:
    plan:       { model: claude-haiku-4-5,    endpoint: anthropic }
    build:      { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    test_write: { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    test_exec:  { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    review:     { model: claude-haiku-4-5,    endpoint: anthropic }
    summary:    { model: claude-haiku-4-5,    endpoint: anthropic }
  fallback:
    on_tool_error: escalate
    escalate_to:
      model: claude-sonnet-4-6
      endpoint: anthropic
```

**When this wins:** bulk triage-style work, doc-touch-up PRs, or any workload
where you're paying for a lot of issues per day and they're individually
simple. Haiku is cheap enough that the Plan/Review cost becomes negligible —
the middle stages dominate, and those are local.

## Comparing profiles with telemetry

Once two or more profiles have run on your repo, compare them:

```bash
alpha-loop report routing
alpha-loop report routing --profile hybrid-v1
alpha-loop report routing --since 30d --json > report.json
```

The output aggregates per-(stage, model) cells across every session with
`cost_per_issue_shipped`, `pipeline_success_rate`, and `tool_error_rate`,
plus deltas against the highest-cost cell for each stage (the implicit
`all-frontier` reference). This is the metric surface `alpha-loop evolve
routing` reads when it proposes promotions:

```text
stage       model                  runs  success  cost/issue  Δcost    tool_err
plan        claude-opus-4-7          42    0.93    $0.12       —        0.001
plan        claude-haiku-4-5         18    0.89    $0.01      -$0.11    0.003
build       claude-sonnet-4-6        42    0.95    $0.18       —        0.004
build       qwen3-coder-30b-a3b      38    0.91    $0.00      -$0.18    0.017
review      claude-sonnet-4-6        60    0.97    $0.27       —        0.002
```

A stage is eligible for promotion to its local candidate when, over ≥30
runs: cost-per-issue savings ≥ 40%, pipeline-success delta ≥ −3%, and
tool-error rate < 2%. See the [README's evolve routing
section](../README.md#routing-promotiondemotion-alpha-loop-evolve-routing)
for the full promotion/demotion loop.

## Profile files for eval/matrix runs

The above blocks go directly in `.alpha-loop.yaml`. For
`alpha-loop eval run --profile <name>` and `alpha-loop eval --matrix`, put
the same content into a file under `.alpha-loop/evals/profiles/<name>.yaml`.
Three profiles ship with alpha-loop out of the box:

- `.alpha-loop/evals/profiles/all-frontier.yaml`
- `.alpha-loop/evals/profiles/hybrid-v1.yaml`
- `.alpha-loop/evals/profiles/all-local.yaml`

Add your own `budget-hawk.yaml` (or any custom profile) in that directory
and it becomes available to the eval matrix.
