import express from "express";
import http from "node:http";
import { createInMemoryDatabase, createRun, getRun, updateRun, listRuns } from "../../src/server/db";
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
    expect(run.pr_url).toBeNull();
    expect(run.duration_seconds).toBeNull();
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

  it("updates run fields", () => {
    createRun(db, { issue_number: 1, issue_title: "Test", agent: "claude", model: "sonnet" });

    const stages = JSON.stringify([{ name: "build", duration: 10 }]);
    const updated = updateRun(db, 1, {
      status: "success",
      stages_json: stages,
      pr_url: "https://github.com/org/repo/pull/1",
      duration_seconds: 120,
    });

    expect(updated!.status).toBe("success");
    expect(updated!.stages_json).toBe(stages);
    expect(updated!.pr_url).toBe("https://github.com/org/repo/pull/1");
    expect(updated!.duration_seconds).toBe(120);
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
  });

  describe("GET /api/runs/:id", () => {
    it("returns a single run", async () => {
      createRun(db, { issue_number: 42, issue_title: "Fix bug", agent: "claude", model: "sonnet" });
      const app = createApp(db);
      const res = await request(app, "/api/runs/1");
      expect(res.status).toBe(200);
      expect(res.body.issue_number).toBe(42);
      expect(res.body.issue_title).toBe("Fix bug");
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
