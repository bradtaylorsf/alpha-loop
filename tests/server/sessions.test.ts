import express from "express";
import http from "node:http";
import {
  createInMemoryDatabase,
  createSession,
  getSession,
  listSessions,
  updateSessionStatus,
  reorderSessionIssues,
  deleteSession,
  updateSessionIssueStatus,
  getActiveSession,
} from "../../src/server/db";
import { initSessionsRouter } from "../../src/server/routes/sessions";
import { buildPrioritizationPrompt, parseAIPrioritization } from "../../src/server/routes/sessions";
import type Database from "better-sqlite3";

function createApp(db: Database.Database) {
  const app = express();
  app.use(express.json());
  app.use("/api", initSessionsRouter(db));
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

// --- Database CRUD tests ---

describe("Session Database CRUD operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it("creates a session with issues", () => {
    const session = createSession(db, {
      name: "Sprint 1",
      issues: [
        { issue_number: 10, position: 0 },
        { issue_number: 20, position: 1 },
        { issue_number: 30, position: 2 },
      ],
    });

    expect(session.id).toBe(1);
    expect(session.name).toBe("Sprint 1");
    expect(session.status).toBe("pending");
    expect(session.completed_at).toBeNull();
    expect(session.issues).toHaveLength(3);
    expect(session.issues[0].issue_number).toBe(10);
    expect(session.issues[0].position).toBe(0);
    expect(session.issues[2].issue_number).toBe(30);
  });

  it("assigns default positions when not provided", () => {
    const session = createSession(db, {
      name: "Auto-order",
      issues: [{ issue_number: 5 }, { issue_number: 10 }],
    });

    expect(session.issues[0].position).toBe(0);
    expect(session.issues[1].position).toBe(1);
  });

  it("gets a session by id", () => {
    createSession(db, { name: "Test", issues: [{ issue_number: 1 }] });
    const session = getSession(db, 1);
    expect(session).toBeDefined();
    expect(session!.name).toBe("Test");
    expect(session!.issues).toHaveLength(1);
  });

  it("returns undefined for nonexistent session", () => {
    expect(getSession(db, 999)).toBeUndefined();
  });

  it("lists all sessions", () => {
    createSession(db, { name: "A", issues: [{ issue_number: 1 }] });
    createSession(db, { name: "B", issues: [{ issue_number: 2 }] });

    const sessions = listSessions(db);
    expect(sessions).toHaveLength(2);
  });

  it("lists sessions filtered by status", () => {
    createSession(db, { name: "A", issues: [{ issue_number: 1 }] });
    createSession(db, { name: "B", issues: [{ issue_number: 2 }] });
    updateSessionStatus(db, 1, "active");

    const active = listSessions(db, { status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("A");

    const pending = listSessions(db, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe("B");
  });

  it("updates session status", () => {
    createSession(db, { name: "Test", issues: [{ issue_number: 1 }] });

    const active = updateSessionStatus(db, 1, "active");
    expect(active!.status).toBe("active");
    expect(active!.completed_at).toBeNull();

    const completed = updateSessionStatus(db, 1, "completed");
    expect(completed!.status).toBe("completed");
    expect(completed!.completed_at).toBeDefined();
  });

  it("reorders session issues", () => {
    createSession(db, {
      name: "Reorder",
      issues: [
        { issue_number: 10, position: 0 },
        { issue_number: 20, position: 1 },
        { issue_number: 30, position: 2 },
      ],
    });

    const updated = reorderSessionIssues(db, 1, {
      issues: [
        { issue_number: 30, position: 0 },
        { issue_number: 10, position: 1 },
        { issue_number: 20, position: 2 },
      ],
    });

    expect(updated!.issues[0].issue_number).toBe(30);
    expect(updated!.issues[1].issue_number).toBe(10);
    expect(updated!.issues[2].issue_number).toBe(20);
  });

  it("deletes a pending session", () => {
    createSession(db, { name: "Delete me", issues: [{ issue_number: 1 }] });

    const result = deleteSession(db, 1);
    expect(result).toBe(true);
    expect(getSession(db, 1)).toBeUndefined();
  });

  it("does not delete non-pending sessions", () => {
    createSession(db, { name: "Active", issues: [{ issue_number: 1 }] });
    updateSessionStatus(db, 1, "active");

    const result = deleteSession(db, 1);
    expect(result).toBe(false);
    expect(getSession(db, 1)).toBeDefined();
  });

  it("updates session issue status", () => {
    createSession(db, { name: "Test", issues: [{ issue_number: 10 }] });

    updateSessionIssueStatus(db, 1, 10, "in_progress");
    let session = getSession(db, 1)!;
    expect(session.issues[0].status).toBe("in_progress");

    updateSessionIssueStatus(db, 1, 10, "completed", "https://github.com/org/repo/pull/1");
    session = getSession(db, 1)!;
    expect(session.issues[0].status).toBe("completed");
    expect(session.issues[0].pr_url).toBe("https://github.com/org/repo/pull/1");
  });

  it("gets active session", () => {
    createSession(db, { name: "Pending", issues: [{ issue_number: 1 }] });
    createSession(db, { name: "Active", issues: [{ issue_number: 2 }] });
    updateSessionStatus(db, 2, "active");

    const active = getActiveSession(db);
    expect(active).toBeDefined();
    expect(active!.name).toBe("Active");
  });

  it("returns undefined when no active session", () => {
    createSession(db, { name: "Pending", issues: [{ issue_number: 1 }] });
    expect(getActiveSession(db)).toBeUndefined();
  });
});

// --- API endpoint tests ---

describe("Sessions API endpoints", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });

  afterEach(() => {
    db.close();
  });

  describe("POST /api/sessions", () => {
    it("creates a session", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions", {
        method: "POST",
        body: {
          name: "Sprint 1",
          issues: [{ issue_number: 10 }, { issue_number: 20 }],
        },
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Sprint 1");
      expect(res.body.status).toBe("pending");
      expect(res.body.issues).toHaveLength(2);
    });

    it("returns 400 for missing name", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions", {
        method: "POST",
        body: { issues: [{ issue_number: 1 }] },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/name/);
    });

    it("returns 400 for missing issues", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions", {
        method: "POST",
        body: { name: "Test" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/issues/);
    });

    it("returns 400 for empty issues array", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions", {
        method: "POST",
        body: { name: "Test", issues: [] },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sessions", () => {
    it("returns empty list when no sessions", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
    });

    it("returns all sessions with issues", async () => {
      createSession(db, { name: "A", issues: [{ issue_number: 1 }] });
      createSession(db, { name: "B", issues: [{ issue_number: 2 }, { issue_number: 3 }] });

      const app = createApp(db);
      const res = await request(app, "/api/sessions");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(2);
      // Most recent first
      expect(res.body.sessions[0].name).toBe("B");
    });

    it("filters by status", async () => {
      createSession(db, { name: "A", issues: [{ issue_number: 1 }] });
      createSession(db, { name: "B", issues: [{ issue_number: 2 }] });
      updateSessionStatus(db, 1, "active");

      const app = createApp(db);
      const res = await request(app, "/api/sessions?status=active");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].name).toBe("A");
    });
  });

  describe("GET /api/sessions/:id", () => {
    it("returns a session with issues", async () => {
      createSession(db, {
        name: "Sprint 1",
        issues: [{ issue_number: 10, position: 0 }, { issue_number: 20, position: 1 }],
      });

      const app = createApp(db);
      const res = await request(app, "/api/sessions/1");
      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Sprint 1");
      expect(res.body.issues).toHaveLength(2);
      expect(res.body.issues[0].issue_number).toBe(10);
    });

    it("returns 404 for nonexistent session", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions/999");
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid id", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions/abc");
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /api/sessions/:id", () => {
    it("updates session status", async () => {
      createSession(db, { name: "Test", issues: [{ issue_number: 1 }] });

      const app = createApp(db);
      const res = await request(app, "/api/sessions/1", {
        method: "PATCH",
        body: { status: "active" },
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("active");
    });

    it("reorders issues", async () => {
      createSession(db, {
        name: "Reorder",
        issues: [
          { issue_number: 10, position: 0 },
          { issue_number: 20, position: 1 },
        ],
      });

      const app = createApp(db);
      const res = await request(app, "/api/sessions/1", {
        method: "PATCH",
        body: {
          issues: [
            { issue_number: 20, position: 0 },
            { issue_number: 10, position: 1 },
          ],
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.issues[0].issue_number).toBe(20);
      expect(res.body.issues[1].issue_number).toBe(10);
    });

    it("returns 404 for nonexistent session", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions/999", {
        method: "PATCH",
        body: { status: "active" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid status", async () => {
      createSession(db, { name: "Test", issues: [{ issue_number: 1 }] });

      const app = createApp(db);
      const res = await request(app, "/api/sessions/1", {
        method: "PATCH",
        body: { status: "banana" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid status/);
    });
  });

  describe("DELETE /api/sessions/:id", () => {
    it("deletes a pending session", async () => {
      createSession(db, { name: "Delete me", issues: [{ issue_number: 1 }] });

      const app = createApp(db);
      const res = await request(app, "/api/sessions/1", { method: "DELETE" });
      expect(res.status).toBe(204);
    });

    it("returns 409 for non-pending session", async () => {
      createSession(db, { name: "Active", issues: [{ issue_number: 1 }] });
      updateSessionStatus(db, 1, "active");

      const app = createApp(db);
      const res = await request(app, "/api/sessions/1", { method: "DELETE" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/pending/);
    });

    it("returns 404 for nonexistent session", async () => {
      const app = createApp(db);
      const res = await request(app, "/api/sessions/999", { method: "DELETE" });
      expect(res.status).toBe(404);
    });
  });
});

// --- AI prioritization prompt/parsing tests ---

describe("AI Prioritization", () => {
  it("builds a prioritization prompt with session info", () => {
    const prompt = buildPrioritizationPrompt("Sprint 1", "- Issue #10 (current position: 0)\n- Issue #20 (current position: 1)");

    expect(prompt).toContain("Sprint 1");
    expect(prompt).toContain("Issue #10");
    expect(prompt).toContain("Issue #20");
    expect(prompt).toContain("Dependencies");
    expect(prompt).toContain("Complexity");
    expect(prompt).toContain("Impact");
    expect(prompt).toContain("JSON array");
  });

  it("parses valid AI response", () => {
    const result = parseAIPrioritization("[20, 10, 30]", [10, 20, 30]);
    expect(result).toEqual([20, 10, 30]);
  });

  it("handles AI response with extra text", () => {
    const result = parseAIPrioritization(
      "Based on my analysis, I recommend: [30, 10, 20]\nThis order optimizes for dependencies.",
      [10, 20, 30]
    );
    expect(result).toEqual([30, 10, 20]);
  });

  it("adds missing issues to end of parsed result", () => {
    const result = parseAIPrioritization("[20, 10]", [10, 20, 30]);
    expect(result).toEqual([20, 10, 30]);
  });

  it("filters out invalid issue numbers", () => {
    const result = parseAIPrioritization("[999, 10, 20]", [10, 20, 30]);
    expect(result).toEqual([10, 20, 30]);
  });

  it("returns original order on unparseable response", () => {
    const result = parseAIPrioritization("I cannot determine the order.", [10, 20, 30]);
    expect(result).toEqual([10, 20, 30]);
  });
});
