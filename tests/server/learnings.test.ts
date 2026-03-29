import express from "express";
import http from "node:http";
import type Database from "better-sqlite3";
import {
  createInMemoryDatabase,
  createRun,
  createLearning,
} from "../../src/server/db";
import { initLearningsRouter } from "../../src/server/routes/learnings";

function createApp(db: Database.Database) {
  const app = express();
  app.use(express.json());
  app.use("/api", initLearningsRouter(db));
  return app;
}

function request(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        return reject(new Error("Failed to get server address"));
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;

      const req = http.request(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

function seedRunsAndLearnings(db: Database.Database) {
  for (let i = 0; i < 5; i++) {
    const run = createRun(db, {
      issue_number: i + 1,
      issue_title: `Issue ${i + 1}`,
      agent: "claude",
      model: "sonnet",
    });
    db.prepare(
      `UPDATE runs SET status = ?, duration_seconds = ?, stages_json = ? WHERE id = ?`,
    ).run(
      i < 3 ? "success" : "failure",
      120 + i * 10,
      JSON.stringify(
        i < 3
          ? ["setup", "implement", "test", "review", "pr", "done"]
          : ["setup", "implement", "test", "fix", "test", "failed"],
      ),
      run.id,
    );
  }

  // Add learnings
  createLearning(db, { run_id: 1, issue_number: 1, type: "pattern", content: "Small PRs are better", confidence: 0.9 });
  createLearning(db, { run_id: 1, issue_number: 1, type: "anti_pattern", content: "Skipping tests is risky", confidence: 0.8 });
  createLearning(db, { run_id: 2, issue_number: 2, type: "prompt_improvement", content: "Add test-first instructions", confidence: 0.85 });
  createLearning(db, { run_id: 3, issue_number: 3, type: "prompt_improvement", content: "Include error handling guidelines", confidence: 0.75 });
}

describe("GET /api/learnings/metrics", () => {
  let db: Database.Database;

  beforeEach(() => { db = createInMemoryDatabase(); });
  afterEach(() => { db.close(); });

  it("returns zero metrics when no runs", async () => {
    const app = createApp(db);
    const res = await request(app, "/api/learnings/metrics");
    expect(res.status).toBe(200);
    expect(res.body.totalRuns).toBe(0);
    expect(res.body.completionRate).toBe(0);
    expect(res.body.avgRetryCount).toBe(0);
    expect(res.body.avgDurationSeconds).toBe(0);
    expect(res.body.failureReasons).toEqual([]);
  });

  it("returns computed metrics with runs", async () => {
    seedRunsAndLearnings(db);
    const app = createApp(db);
    const res = await request(app, "/api/learnings/metrics");
    expect(res.status).toBe(200);
    expect(res.body.totalRuns).toBe(5);
    expect(res.body.successCount).toBe(3);
    expect(res.body.failureCount).toBe(2);
    expect(res.body.completionRate).toBeCloseTo(0.6);
    expect(res.body.avgDurationSeconds).toBeGreaterThan(0);
    expect(res.body.failureReasons.length).toBeGreaterThan(0);
  });
});

describe("GET /api/learnings/suggestions", () => {
  let db: Database.Database;

  beforeEach(() => { db = createInMemoryDatabase(); });
  afterEach(() => { db.close(); });

  it("returns empty suggestions when no learnings", async () => {
    const app = createApp(db);
    const res = await request(app, "/api/learnings/suggestions");
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });

  it("returns only prompt_improvement learnings as suggestions", async () => {
    seedRunsAndLearnings(db);
    const app = createApp(db);
    const res = await request(app, "/api/learnings/suggestions");
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(2);
    // Sorted by confidence desc
    expect(res.body.suggestions[0].content).toBe("Add test-first instructions");
    expect(res.body.suggestions[0].confidence).toBe(0.85);
    expect(res.body.suggestions[1].content).toBe("Include error handling guidelines");
  });

  it("includes run and issue references in suggestions", async () => {
    seedRunsAndLearnings(db);
    const app = createApp(db);
    const res = await request(app, "/api/learnings/suggestions");
    const suggestion = res.body.suggestions[0];
    expect(suggestion).toHaveProperty("id");
    expect(suggestion).toHaveProperty("run_id");
    expect(suggestion).toHaveProperty("issue_number");
    expect(suggestion).toHaveProperty("created_at");
  });
});

describe("Improvement threshold", () => {
  let db: Database.Database;

  beforeEach(() => { db = createInMemoryDatabase(); });
  afterEach(() => { db.close(); });

  it("shouldImprove triggers at every 5 completed runs", async () => {
    const { shouldImprove, defaultImproverConfig } = await import("../../src/learning/improver");
    const config = defaultImproverConfig({ runsPerImprovement: 5 });

    // 3 runs - not enough
    for (let i = 0; i < 3; i++) {
      const run = createRun(db, { issue_number: i + 1, issue_title: `Issue ${i}`, agent: "claude", model: "sonnet" });
      db.prepare(`UPDATE runs SET status = 'success' WHERE id = ?`).run(run.id);
    }
    expect(shouldImprove(db, config)).toBe(false);

    // Add 2 more to reach 5
    for (let i = 3; i < 5; i++) {
      const run = createRun(db, { issue_number: i + 1, issue_title: `Issue ${i}`, agent: "claude", model: "sonnet" });
      db.prepare(`UPDATE runs SET status = 'success' WHERE id = ?`).run(run.id);
    }
    expect(shouldImprove(db, config)).toBe(true);
  });
});
