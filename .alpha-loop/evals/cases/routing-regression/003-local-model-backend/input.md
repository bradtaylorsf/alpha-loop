# Local-model backend: LM Studio / Ollama with Anthropic-compatible endpoint

## Summary

Add two new agent backends — `lmstudio` and `ollama` — that forward to a
local Anthropic-compatible or OpenAI-compatible endpoint. Preflight must
verify the endpoint responds on `/v1/models` before the run starts.

## Acceptance Criteria

- [ ] Config accepts `agent: lmstudio | ollama`
- [ ] Endpoint base URL configurable per endpoint
- [ ] Preflight probes only loopback endpoints (never public hosts)
- [ ] Tool-call schema matches what the Loop already emits for `claude`
