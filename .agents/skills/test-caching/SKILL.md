---
name: test-caching
description: API response caching for expensive AI API calls in tests. Use when writing tests that call Claude, OpenAI, or other AI APIs.
auto_load: false
priority: medium
---

# Test Caching Skill

## Trigger
When writing tests that make HTTP calls to AI/LLM APIs (Claude, OpenAI, etc.) or any expensive external API.

## How It Works

The `mockExpensiveAPI()` helper intercepts HTTP requests matching a URL pattern.

- **Default mode** (`pnpm test`): Replays responses from fixture files in `tests/fixtures/`. No network calls.
- **Record mode** (`RECORD_FIXTURES=true` / `pnpm test:full`): Lets real requests through, captures responses to fixture files.

## Usage

```typescript
import { mockExpensiveAPI } from '../../src/testing/cache';

describe('my AI feature', () => {
  let mock: ReturnType<typeof mockExpensiveAPI>;

  beforeEach(() => {
    mock = mockExpensiveAPI({
      name: 'my-feature-openai',        // fixture filename
      pattern: 'https://api.openai.com', // URL prefix to intercept
      service: 'openai',                 // metadata
      estimatedCostUSD: 0.02,            // metadata
    });
  });

  afterEach(() => {
    mock.restore(); // always restore HTTP patches
  });

  it('calls the AI API', async () => {
    // In replay mode, this returns the cached response
    // In record mode, this hits the real API and saves the response
    const result = await callMyAIFeature();
    expect(result).toBeDefined();
  });
});
```

## Options

| Option | Required | Description |
|--------|----------|-------------|
| `name` | Yes | Unique fixture name (becomes `<name>.fixture.json`) |
| `pattern` | Yes | URL prefix (string) or RegExp to intercept |
| `service` | No | Service name for metadata (default: `"unknown"`) |
| `estimatedCostUSD` | No | Cost per call for metadata (default: `0`) |
| `fixturesDir` | No | Override fixture directory (default: `tests/fixtures/`) |

## Commands

| Command | Description |
|---------|-------------|
| `pnpm test` | Run tests with cached API responses (default) |
| `pnpm test:full` | Run tests with real API calls, re-record fixtures |

## Fixture Format

Fixtures are stored as JSON arrays in `tests/fixtures/<name>.fixture.json`:

```json
[
  {
    "request": { "url": "https://api.openai.com/v1/chat", "method": "POST", "body": { "model": "gpt-4" } },
    "response": { "status": 200, "headers": {}, "body": { "choices": [] } },
    "metadata": { "recordedAt": "2025-01-15T10:00:00.000Z", "service": "openai", "estimatedCostUSD": 0.02 }
  }
]
```

## Cache Invalidation

Fixtures older than 30 days produce a warning at test startup. Re-record with `RECORD_FIXTURES=true` to refresh.

## In the Loop

`scripts/loop.sh` uses cached mode by default. Pass `--run-full` to bypass cache:

```bash
bash scripts/loop.sh --run-full    # real API calls
bash scripts/loop.sh               # cached (default)
```

## Rules

1. Always call `mock.restore()` in `afterEach` to undo HTTP patches
2. Commit fixture files to git so CI can replay without API keys
3. Use descriptive `name` values — one fixture per test scenario
4. Check `mock.warnings` for staleness alerts in your test setup
