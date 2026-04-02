# Playwright E2E Testing Skill

## Overview

This skill teaches agents how to write and maintain Playwright end-to-end tests for the Alpha Loop dashboard. E2E tests validate that the app works visually in a browser, catching issues that pass unit tests but break the UI.

## Test Configuration

- **Test directory**: `tests/e2e/`
- **Config file**: `playwright.config.ts`
- **E2E port**: `4002` (isolated from dev 4001 and prod 4000)
- **Database**: In-memory SQLite (`DATABASE_PATH=:memory:`)
- **Mock API**: `MOCK_CLAUDE_API=true` to avoid real AI calls
- **Browser**: Chromium only
- **Run command**: `pnpm test:e2e`

## Writing E2E Tests

### File naming

- Place tests in `tests/e2e/`
- Use `.spec.ts` suffix (e.g., `dashboard.spec.ts`)

### Test structure

```typescript
import { test, expect } from "@playwright/test";

test.describe("Feature Name", () => {
  test("describes what it validates", async ({ page }) => {
    await page.goto("/");
    // Use waitForSelector or expect with auto-waiting
    await expect(page.locator("h1")).toHaveText("Alpha Loop");
  });
});
```

### Best practices for reliability

1. **Use Playwright auto-waiting** — `expect(locator).toBeVisible()` auto-waits up to the configured timeout
2. **Avoid fixed timeouts** — use `waitForSelector`, `waitForResponse`, or `expect` assertions instead of `page.waitForTimeout()`
3. **Use data-testid attributes** — prefer `[data-testid='config-view']` over fragile CSS selectors
4. **Clean up state** — each test should work in isolation, don't depend on test execution order
5. **Seed test data via API** — create test data by hitting API endpoints, not by manipulating the DB directly

### Seeding test data

```typescript
test("shows runs created via API", async ({ request, page }) => {
  // Create test data via API
  await request.post("/api/runs", {
    data: {
      issue_number: 42,
      issue_title: "Test issue",
      agent: "claude",
      model: "sonnet",
    },
  });

  // Navigate and verify
  await page.goto("/");
  await page.click("button:has-text('Run History')");
  await expect(page.locator("text=Test issue")).toBeVisible();
});
```

### Testing SSE / Live View

```typescript
test("live view connects to SSE stream", async ({ page }) => {
  await page.goto("/");
  // The EventSource connection happens automatically
  await expect(page.locator("text=Connected")).toBeVisible({ timeout: 5000 });
});
```

### Common selectors

| Element | Selector |
|---------|----------|
| App title | `h1` (text: "Alpha Loop") |
| Tab buttons | `button:has-text('Live View')`, `button:has-text('Run History')`, `button:has-text('Config')` |
| Live log | `[data-testid='live-log']` |
| Config view | `[data-testid='config-view']` |
| Config editor | `[data-testid='config-editor']` |
| Status badge | `[data-testid='status-badge']` |
| History table | `table` within Run History tab |

## Running E2E Tests

```bash
# Run all E2E tests
pnpm test:e2e

# Run with headed browser (for debugging)
npx playwright test --headed

# Run a specific test file
npx playwright test tests/e2e/dashboard.spec.ts

# Show test report after failure
npx playwright show-report
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SKIP_E2E` | `false` | Skip Playwright in the loop pipeline |
| `DATABASE_PATH` | file path | Set to `:memory:` for in-memory SQLite |
| `MOCK_CLAUDE_API` | `false` | Mock Claude API calls |
| `PORT` | `4000` | Server port (E2E uses `4002`) |

## Integration with Loop Pipeline

E2E tests run after unit/API tests in the loop pipeline:

1. Implement
2. Run unit/API tests (with retry)
3. **Run Playwright E2E tests** (with same retry loop)
4. Code review
5. Create PR

If `SKIP_E2E=true`, the E2E step is skipped. E2E test failures trigger the same retry loop as unit tests — the agent receives the error output and attempts to fix the issue.
