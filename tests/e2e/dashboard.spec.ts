import { test, expect } from "@playwright/test";

test.describe("Dashboard", () => {
  test("loads and displays the app header", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Alpha Loop");
  });

  test("shows Live View tab by default", async ({ page }) => {
    await page.goto("/");
    // Live View has a status bar with connection indicator
    await expect(page.locator("text=Waiting for events...")).toBeVisible();
  });

  test("navigates between tabs", async ({ page }) => {
    await page.goto("/");

    // Click Run History tab
    await page.click("button:has-text('Run History')");
    await expect(page.locator("h2:has-text('Run History')")).toBeVisible();

    // Click Config tab
    await page.click("button:has-text('Config')");
    await expect(page.locator("h2:has-text('Configuration')")).toBeVisible();

    // Click back to Live View
    await page.click("button:has-text('Live View')");
    await expect(page.locator("text=Waiting for events...")).toBeVisible();
  });
});

test.describe("Live View", () => {
  test("shows connection status indicator", async ({ page }) => {
    await page.goto("/");
    // SSE connection status should show Connected or Disconnected
    await expect(
      page.locator("text=Connected").or(page.locator("text=Disconnected")),
    ).toBeVisible();
  });

  test("has a log area for events", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-testid='live-log']")).toBeVisible();
  });
});

test.describe("Run History", () => {
  test("displays run history table or empty state", async ({ page }) => {
    await page.goto("/");
    await page.click("button:has-text('Run History')");

    // Either shows the table or "No runs yet"
    await expect(
      page.locator("table").or(page.locator("text=No runs yet")),
    ).toBeVisible();
  });

  test("shows correct table headers", async ({ page }) => {
    await page.goto("/");
    await page.click("button:has-text('Run History')");

    // Wait for data to load (may show "No runs yet" or the table)
    await expect(
      page.locator("h2:has-text('Run History')"),
    ).toBeVisible();

    // If there are runs, verify table structure
    const table = page.locator("table");
    if (await table.isVisible()) {
      await expect(table.locator("th:has-text('Issue')")).toBeVisible();
      await expect(table.locator("th:has-text('Status')")).toBeVisible();
      await expect(table.locator("th:has-text('Duration')")).toBeVisible();
    }
  });

  test("has a refresh button", async ({ page }) => {
    await page.goto("/");
    await page.click("button:has-text('Run History')");
    await expect(page.locator("button:has-text('Refresh')")).toBeVisible();
  });

  test("shows runs created via API", async ({ request, page }) => {
    // Seed a run via the API
    const createRes = await request.post("/api/runs", {
      data: {
        issue_number: 99,
        issue_title: "E2E test issue",
        agent: "claude",
        model: "sonnet",
      },
    });
    // The runs API may not have a POST endpoint — skip if 404
    if (createRes.status() === 404) {
      test.skip();
      return;
    }
    expect(createRes.ok()).toBeTruthy();

    await page.goto("/");
    await page.click("button:has-text('Run History')");
    await expect(page.locator("text=E2E test issue")).toBeVisible();
  });
});

test.describe("Config", () => {
  test("displays configuration data", async ({ page }) => {
    await page.goto("/");
    await page.click("button:has-text('Config')");

    // Config should load and display JSON
    await expect(page.locator("[data-testid='config-view']")).toBeVisible();
  });

  test("has an edit button", async ({ page }) => {
    await page.goto("/");
    await page.click("button:has-text('Config')");
    await expect(page.locator("button:has-text('Edit')")).toBeVisible();
  });

  test("enters edit mode and shows editor", async ({ page }) => {
    await page.goto("/");
    await page.click("button:has-text('Config')");

    // Wait for config to load
    await expect(page.locator("[data-testid='config-view']")).toBeVisible();

    // Enter edit mode
    await page.click("button:has-text('Edit')");
    await expect(page.locator("[data-testid='config-editor']")).toBeVisible();

    // Cancel and save buttons should appear
    await expect(page.locator("button:has-text('Cancel')")).toBeVisible();
    await expect(page.locator("button:has-text('Save')")).toBeVisible();
  });

  test("can cancel editing", async ({ page }) => {
    await page.goto("/");
    await page.click("button:has-text('Config')");
    await expect(page.locator("[data-testid='config-view']")).toBeVisible();

    await page.click("button:has-text('Edit')");
    await expect(page.locator("[data-testid='config-editor']")).toBeVisible();

    await page.click("button:has-text('Cancel')");
    await expect(page.locator("[data-testid='config-view']")).toBeVisible();
  });
});

test.describe("API Health", () => {
  test("health endpoint returns OK", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  test("config endpoint returns data", async ({ request }) => {
    const res = await request.get("/api/config");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toBeDefined();
  });

  test("runs endpoint returns data", async ({ request }) => {
    const res = await request.get("/api/runs");
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty("runs");
    expect(data).toHaveProperty("total");
  });
});
