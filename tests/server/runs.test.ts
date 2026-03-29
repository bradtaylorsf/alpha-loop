import express from "express";
import http from "node:http";
import { createInMemoryDatabase, createRun, getRun, updateRun, listRuns, createLearning } from "../../src/server/db";
import { initRunsRouter } from "../../src/server/routes/runs";
import type Database from "better-sqlite3";

function createApp(db: Database.Database) {
  const app = express();
  app.use(express.json());
  app.use("/api", initRunsRouter(db));
  return app;
}

function request(
  app: express.Express,
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        return reject(new Error("Failed to get server address"));
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const method = options?.method ?? "GET";
      const postData = options?.body ? JSON.stringify(options.body) : undefined;

      const reqOptions: http.RequestOptions = {
        method,
        headers: postData
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) }
          : undefined,
      };

      const req = http.request(url, reqOptions, (res) => {
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
      if (postData) req.write(postData);
      req.end();
    });
  });
}

describe("Database CRUD operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it("creates a run with default values", () => {
    const run = createRun(db, {
      issue_number: 42,
      issue_title: "Fix the bug",
      agent: "claude",
      model: "sonnet",
    });

    expect(run.id).toBe(1);
    expect(run.issue_number).toBe(42);
    expect(run.issue_title).toBe("Fix the bug");
    expect(run.agent).toBe("claude");
    expect(run.model).toBe("sonnet");
    expect(run.status).toBe("running");
    expect(run.stages_json).toBe("[]");
    expect(run.stage_durations_json).toBe("{}");
    expect(run.pr_url).toBeNull();
    expect(run.duration_seconds).toBeNull();
    expect(run.test_output).toBeNull();
    expect(run.review_output).toBeNull();
    expect(run.diff_stat).toBeNull();
    expect(run.created_at).toBeDefined();
  });

  it("gets a run by id", () => {
    createRun(db, { issue_number: 1, issue_title: "Test", agent: "claude", model: "sonnet" });
    const run = getRun(db, 1);
    expect(run).toBeDefined();
    expect(run!.issue_number).toBe(1);
  });

  it("returns undefined for nonexistent run", () => {
    const run = getRun(db, 999);
    expect(run).toBeUndefined();
  });

  it("updates run fields including new fields", () => {
    createRun(db, { issue_number: 1, issue_title: "Test", agent: "claude", model: "sonnet" });

    const stages = JSON.stringify([{ name: "build", duration: 10 }]);
    const stageDurations = JSON.stringify({ setup: 3, implement: 45 });
    const updated = updateRun(db, 1, {
      status: "success",
      stages_json: stages,
      stage_durations_json: stageDurations,
      pr_url: "https://github.com/org/repo/pull/1",
      duration_seconds: 120,
      test_output: "All tests passed",
      review_output: "Looks good",
      diff_stat: "2 files changed",
    });

    expect(updated!.status).toBe("success");
    expect(updated!.stages_json).toBe(stages);
    expect(updated!.stage_durations_json).toBe(stageDurations);
    expect(updated!.pr_url).toBe("https://github.com/org/repo/pull/1");
    expect(updated!.duration_seconds).toBe(120);
    expect(updated!.test_output).toBe("All tests passed");
    expect(updated!.review_output).toBe("Looks good");
    expect(updated!.diff_stat).toBe("2 files changed");
  });

  it("lists runs with pagination", () => {
    for (let i = 1; i <= 5; i++) {
      createRun(db, { issue_number: i, issue_title: `Issue ${i}`, agent: "claude", model: "sonnet" });
    }

    const page1 = listRuns(db, { limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.runs).toHaveLength(2);

    const page2 = listRuns(db, { limit: 2, offset: 2 });
    expect(page2.runs).toHaveLength(2);

    const page3 = listRuns(db, { limit: 2, offset: 4 });
    expect(page3.runs).toHaveLength(1);
  });

  it("filters runs by status", () => {
    createRun(db, { issue_number: 1, issue_title: "A", agent: "claude", model: "sonnet" });
    createRun(db, { issue_number: 2, issue_title: "B", agent: "claude", model: "sonnet" });
    updateRun(db, 1, { status: "success" });
    updateRun(db, 2, { status: "failure" });

    const successes = listRuns(db, { status: "success" });
    expect(successes.total).toBe(1);
    expect(successes.runs[0].issue_number).toBe(1);

    const failures = listRuns(db, { status: "failure" });
    expect(failures.total).toBe(1);
    expect(failures.runs[0].issue_number).toBe(2);
  });

  it("filters runs by search query", () => {
    createRun(db, { issue_number: 10, issue_title: "Fix auth bug", agent: "claude", model: "sonnet" });
    createRun(db, { issue_number: 20, issue_title: "Add dashboard", agent: "claude", model: "sonnet" });

    const result = listRuns(db, { search: "auth" });
    expect(result.total).toBe(1);
    expect(result.runs[0].issue_title).toBe("Fix auth bug");

    const byNumber = listRuns(db, { search: "20" });
    expect(byNumber.total).toBe(1);
    expect(byNumber.runs[0].issue_number).toBe(20);
  });
});

describe("API endpoints", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /api/runs", () => {
    it("returns empty list when no runs", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/runs");
      expect(res.status).toBe(200);
      expect(res.body.runs).toEqual([]);
      expect(res.body.total).toBe(0);
    });

    it("returns paginated runs", async () => {
      for (let i = 1; i <= 3; i++) {
        createRun(db, { issue_number: i, issue_title: `Issue ${i}`, agent: "claude", model: "sonnet" });
      }
      const app = createApp(db);
      const res = await request(app, "/api/runs?limit=2&offset=0");
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(2);
      expect(res.body.total).toBe(3);
    });

    it("filters by status", async () => {
      createRun(db, { issue_number: 1, issue_title: "A", agent: "claude", model: "sonnet" });
      createRun(db, { issue_number: 2, issue_title: "B", agent: "claude", model: "sonnet" });
      updateRun(db, 1, { status: "success" });

      const app = createApp(db);
      const res = await request(app, "/api/runs?status=success");
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].issue_number).toBe(1);
    });

    it("filters by search query", async () => {
      createRun(db, { issue_number: 10, issue_title: "Fix auth", agent: "claude", model: "sonnet" });
      createRun(db, { issue_number: 20, issue_title: "Add feature", agent: "claude", model: "sonnet" });

      const app = createApp(db);
      const res = await request(app, "/api/runs?search=auth");
      expect(res.status).toBe(200);
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0].issue_title).toBe("Fix auth");
    });
  });

  describe("GET /api/runs/:id", () => {
    it("returns a single run with all detail fields", async () => {
      const run = createRun(db, { issue_number: 42, issue_title: "Fix bug", agent: "claude", model: "sonnet" });
      updateRun(db, run.id, {
        status: "success",
        stages_json: JSON.stringify(["setup", "implement", "done"]),
        stage_durations_json: JSON.stringify({ setup: 3, implement: 45 }),
        pr_url: "https://github.com/org/repo/pull/1",
        duration_seconds: 120,
        test_output: "All passed",
        review_output: "LGTM",
        diff_stat: "2 files changed",
      });

      const app = createApp(db);
      const res = await request(app, `/api/runs/${run.id}`);
      expect(res.status).toBe(200);
      expect(res.body.issue_number).toBe(42);
      expect(res.body.issue_title).toBe("Fix bug");
      expect(res.body.status).toBe("success");
      expect(res.body.stage_durations_json).toBe(JSON.stringify({ setup: 3, implement: 45 }));
      expect(res.body.test_output).toBe("All passed");
      expect(res.body.review_output).toBe("LGTM");
      expect(res.body.diff_stat).toBe("2 files changed");
      expect(res.body.pr_url).toBe("https://github.com/org/repo/pull/1");
      expect(res.body.learnings).toBeDefined();
      expect(Array.isArray(res.body.learnings)).toBe(true);
    });

    it("returns run with associated learnings", async () => {
      const run = createRun(db, { issue_number: 42, issue_title: "Fix bug", agent: "claude", model: "sonnet" });
      createLearning(db, {
        run_id: run.id,
        issue_number: 42,
        type: "pattern",
        content: "Good test coverage",
        confidence: 0.8,
      });

      const app = createApp(db);
      const res = await request(app, `/api/runs/${run.id}`);
      expect(res.status).toBe(200);
      expect(res.body.learnings).toHaveLength(1);
      expect(res.body.learnings[0].content).toBe("Good test coverage");
      expect(res.body.learnings[0].type).toBe("pattern");
    });

    it("returns 404 for nonexistent run", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/runs/999");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/);
    });

    it("returns 400 for invalid id", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/runs/abc");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid/);
    });
  });

  describe("POST /api/runs", () => {
    it("creates a new run", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/runs", {
        method: "POST",
        body: { issue_number: 10, issue_title: "New feature", agent: "claude", model: "opus" },
      });
      expect(res.status).toBe(201);
      expect(res.body.issue_number).toBe(10);
      expect(res.body.status).toBe("running");
    });

    it("returns 400 for missing fields", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/runs", {
        method: "POST",
        body: { issue_number: 10 },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Missing/);
    });
  });

  describe("PATCH /api/runs/:id", () => {
    it("updates a run", async () => {
      createRun(db, { issue_number: 1, issue_title: "Test", agent: "claude", model: "sonnet" });
      const app = createApp(db);
      const res = await request(app, "/api/runs/1", {
        method: "PATCH",
        body: { status: "success", duration_seconds: 60 },
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("success");
      expect(res.body.duration_seconds).toBe(60);
    });

    it("updates new detail fields", async () => {
      createRun(db, { issue_number: 1, issue_title: "Test", agent: "claude", model: "sonnet" });
      const app = createApp(db);
      const res = await request(app, "/api/runs/1", {
        method: "PATCH",
        body: {
          stage_durations_json: JSON.stringify({ setup: 5 }),
          test_output: "Tests passed",
          review_output: "Clean code",
          diff_stat: "1 file changed",
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.stage_durations_json).toBe(JSON.stringify({ setup: 5 }));
      expect(res.body.test_output).toBe("Tests passed");
      expect(res.body.review_output).toBe("Clean code");
      expect(res.body.diff_stat).toBe("1 file changed");
    });

    it("returns 404 for nonexistent run", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/runs/999", {
        method: "PATCH",
        body: { status: "failure" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid status", async () => {
      createRun(db, { issue_number: 1, issue_title: "Test", agent: "claude", model: "sonnet" });
      const app = createApp(db);
      const res = await request(app, "/api/runs/1", {
        method: "PATCH",
        body: { status: "banana" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid status/);
    });
  });
});
