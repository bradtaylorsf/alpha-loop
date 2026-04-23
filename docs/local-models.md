# Local Models: LM Studio & Ollama

Alpha Loop can route any Loop stage to a local model server so token-heavy
middle stages (Build, Test) run against open-weight models on your own
hardware while frontier models still handle Plan and Review.

Two servers are supported out of the box:

| Server    | Endpoint type       | Default URL                     | Wrapping CLI |
|-----------|---------------------|----------------------------------|--------------|
| LM Studio | `anthropic_compat`  | `http://localhost:1234`          | `claude`     |
| Ollama    | `openai_compat`     | `http://localhost:11434/v1`      | `codex`      |

LM Studio 0.4.1+ ships a native Anthropic-compatible `/v1/messages` endpoint,
so the `claude` CLI can talk to it directly with one env var — no translation
proxy. Ollama exposes an OpenAI-compatible `/v1/chat/completions` endpoint, so
the `codex` CLI works the same way.

For ready-to-copy routing configurations (`all-frontier`, `hybrid-v1`,
`all-local`, `budget-hawk`) see
[docs/routing-profiles.md](routing-profiles.md).

## Hardware prerequisites

Running a 30B-class coding model alongside the rest of alpha-loop is the
current sweet spot. You want enough unified memory to keep the full KV-cache
resident at a 64–128K context window while a second model (summary / triage)
is also loaded.

| Hardware                      | Feasible | Notes                                                      |
|-------------------------------|----------|------------------------------------------------------------|
| Apple Silicon M3/M4 Max, 128GB| Yes      | Recommended. Runs Qwen3-Coder-Next 30B-A3B + Gemma 4 31B concurrently at 262K context |
| Apple Silicon M-series, 64GB  | Yes      | Minimum. Load one 30B coder at a time; swap out for summaries |
| Apple Silicon, 32GB or less   | No       | Not enough to keep a 30B model + KV cache resident         |
| CUDA GPU, 48GB+ VRAM          | Yes      | Works, but alpha-loop has only been tuned on Apple Silicon |
| Intel / AMD without GPU       | No       | CPU-only inference is too slow for the Loop's timeouts     |

The `alpha-loop init` command detects Apple Silicon with ≥64GB RAM and offers
to point you at the hybrid/local routing docs automatically.

### Recommended models

| Model                        | Role                   | Size  | Notes                                                     |
|------------------------------|------------------------|-------|-----------------------------------------------------------|
| Qwen3-Coder-Next 30B-A3B     | Primary coder (Build, Test) | ~46 tok/s on M4 Max 128GB, 262K context. Best open-weight tool-calling tested so far |
| Gemma 4 31B                  | Utility (Summary, Triage, Learn) | Fast, good at structured-text extraction; cheap to keep co-resident |
| GLM-4.6                      | Aspirational coder     | Larger | Strong reasoning, but tight on 128GB if a second model is loaded — treat as experimental |

Pricing for these three models is zero in the default pricing table — cost
telemetry reports `$0` when they're used.

## Install LM Studio or Ollama

### LM Studio (0.4.1+ required for the native Anthropic endpoint)

1. Install LM Studio from <https://lmstudio.ai/>. **Version 0.4.1 or newer** —
   older builds do not expose `/v1/messages` and will fail the preflight check.
2. Load a coding-capable model (e.g. `qwen3-coder-30b-a3b`, `glm-4.6`).
3. Start the server (Developer tab → "Start server"). Default port is `1234`.
4. Verify it's up:
   ```bash
   curl http://localhost:1234/v1/models
   ```
   You should see your loaded model's id in the `data` array.

### Ollama

1. Install Ollama from <https://ollama.com/>.
2. Pull a coding model:
   ```bash
   ollama pull llama3.1:70b
   ```
3. Ollama auto-starts a server on port `11434`. Verify:
   ```bash
   curl http://localhost:11434/v1/models
   ```

## Single-agent mode (short form)

The simplest setup runs the whole Loop against one local model:

```yaml
# .alpha-loop.yaml
agent: lmstudio
model: qwen3-coder-30b-a3b
```

or for Ollama:

```yaml
agent: ollama
model: llama3.1:70b
```

This is backwards compatible — everything else in the Loop behaves exactly as
if you'd set `agent: claude`, except spawned child processes have
`ANTHROPIC_BASE_URL` (lmstudio) or `OPENAI_BASE_URL` (ollama) auto-injected
and pointed at the default local server:

| Agent       | Env var              | Default value                  |
|-------------|----------------------|--------------------------------|
| `lmstudio`  | `ANTHROPIC_BASE_URL` | `http://localhost:1234`        |
| `ollama`    | `OPENAI_BASE_URL`    | `http://localhost:11434/v1`    |

If you've already exported one of those env vars in your shell (e.g. to point
at a non-default port), alpha-loop respects it — your export wins.

## Per-stage routing (hybrid)

For hybrid cloud/local setups, use the `routing:` block to target different
models and endpoints per stage. This lets you keep frontier models for Plan
and Review while offloading Build, Test, and Summary locally:

```yaml
routing:
  profile: hybrid-v1
  stages:
    plan:       { model: claude-opus-4-7,     endpoint: anthropic }
    build:      { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    test_write: { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    test_exec:  { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
    review:     { model: claude-sonnet-4-6,   endpoint: anthropic }
    summary:    { model: gemma-4-31b,         endpoint: lmstudio_local }
  endpoints:
    anthropic:      { type: anthropic,        base_url: "https://api.anthropic.com" }
    lmstudio_local: { type: anthropic_compat, base_url: "http://localhost:1234" }
    ollama_local:   { type: openai_compat,    base_url: "http://localhost:11434/v1" }
  fallback:
    on_tool_error: escalate
    escalate_to: { model: claude-sonnet-4-6, endpoint: anthropic }
```

Each stage invocation resolves its own env vars. Frontier stages never
inherit local-endpoint env from a previous local stage — the Loop clears
`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` between stages that don't need them.

For drop-in profile files under `.alpha-loop/evals/profiles/` (what
`alpha-loop eval --matrix` and `alpha-loop eval run --profile` consume), see
[docs/routing-profiles.md](routing-profiles.md).

## Preflight check

Before a stage routed to a local endpoint runs, Alpha Loop issues
`GET <base_url>/v1/models` and verifies the configured model id appears in
the response. If the server is down or the wrong model is loaded, the stage
fails fast with an actionable error:

```
Start LM Studio and load model qwen3-coder-30b-a3b
(Model "qwen3-coder-30b-a3b" is not loaded at http://localhost:1234. Available: gemma-4-31b)
```

Remote endpoints (e.g. `api.anthropic.com`) are never probed — the check only
fires for loopback addresses (`localhost`, `127.0.0.1`, `::1`, `*.local`).

## Model IDs

Use the exact id reported by `/v1/models`. A few known-good picks on
consumer hardware:

| Model ID              | Server       | Notes                                       |
|-----------------------|--------------|---------------------------------------------|
| `qwen3-coder-30b-a3b` | LM Studio    | MLX, ~46 tok/s on M4 Max 128GB, 262K ctx    |
| `gemma-4-31b`         | LM Studio    | Good for summary/learn stages               |
| `glm-4.6`             | LM Studio    | Strong reasoning                            |
| `llama3.1:70b`        | Ollama       | OpenAI-compatible route                     |

## Apple Silicon tuning

A few LM Studio knobs make the difference between "30 tok/s, stable" and
"swapping to disk and dying":

- **Context window.** Start at `65536` tokens — plenty for most Loop stages
  and keeps the KV-cache footprint reasonable. Bump to `131072` or `262144`
  only on 128GB machines and only when you actually need the headroom
  (long-diff review passes).
- **Batch size.** LM Studio's default batch (`512`) is usually right on
  MLX builds. If you see long-prompt stalls, drop to `256`.
- **KV-cache quantization.** Leave it at default (`F16`) on 128GB. On 64GB,
  switch to `Q8_0` — frees ~30% of KV memory for a small quality hit that's
  invisible on coding tasks.
- **Prompt caching.** Keep LM Studio's "Keep in memory" on for the primary
  coder model. The Loop re-uses the same system prompt across Build and Test
  stages, and cold-reloading a 30B model between stages adds ~10–20s.
- **Concurrent models.** On 128GB you can keep Qwen3-Coder-Next + Gemma 4
  co-resident for fast Summary/Learn swaps. On 64GB, only load one at a
  time and let the `summary` stage fall back to a cloud endpoint.

## Troubleshooting

- **"Could not reach http://localhost:1234/v1/models"** — start the server.
  For LM Studio, open the Developer tab and click "Start server". For Ollama,
  run `ollama serve` (usually auto-started).
- **"Model … is not loaded"** — the server is up but the expected model id
  isn't currently loaded. In LM Studio, load it via the Chat tab or CLI. In
  Ollama, `ollama pull <model>` first.
- **Tool-call errors / malformed tool output.** Open-weight models have more
  variance in tool-call formatting than frontier models. If you see
  `on_tool_error: escalate` kicking in frequently for a stage, the rolling
  error-rate guardrail will auto-revert that stage to the frontier fallback
  after it exceeds `escalation_error_threshold` (default 8% over 10 issues).
  Check `alpha-loop report routing` for the actual rate.
- **Escalation not firing.** `fallback.on_tool_error: escalate` only fires on
  tool-call errors, not on empty/unhelpful output. If a local model is
  producing low-quality code that passes tool-call parsing, use
  `alpha-loop eval --matrix` against the `routing-regression` suite to
  catch it — don't rely on escalation alone.
- **Port collisions** — both LM Studio and Ollama default to fixed ports
  (1234 and 11434). If you've changed them, update `base_url` in the
  endpoint config.
