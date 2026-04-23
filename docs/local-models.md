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

## Setup

### LM Studio

1. Install LM Studio from <https://lmstudio.ai/>.
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
`ANTHROPIC_BASE_URL` (lmstudio) or `OPENAI_BASE_URL` (ollama) set to the local
server.

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

Pricing for these models is zero in the default pricing table — cost
telemetry reports $0 when they're used.

## Troubleshooting

- **"Could not reach http://localhost:1234/v1/models"** — start the server.
  For LM Studio, open the Developer tab and click "Start server". For Ollama,
  run `ollama serve` (usually auto-started).
- **"Model … is not loaded"** — the server is up but the expected model id
  isn't currently loaded. In LM Studio, load it via the Chat tab or CLI. In
  Ollama, `ollama pull <model>` first.
- **Port collisions** — both LM Studio and Ollama default to fixed ports
  (1234 and 11434). If you've changed them, update `base_url` in the
  endpoint config.
