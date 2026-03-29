import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4002",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "pnpm build:client && PORT=4002 DATABASE_PATH=:memory: MOCK_CLAUDE_API=true npx tsx src/server/index.ts",
    port: 4002,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: "4002",
      DATABASE_PATH: ":memory:",
      MOCK_CLAUDE_API: "true",
    },
  },
});
