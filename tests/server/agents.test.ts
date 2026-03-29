import express from "express";
import http from "node:http";
import { agentsRouter } from "../../src/server/routes/agents";

function createApp() {
  const app = express();
  app.use("/api", agentsRouter);
  return app;
}

function request(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        return reject(new Error("Failed to get server address"));
      }
      const req = http.get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        });
      });
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
    });
  });
}

describe("GET /api/agents", () => {
  it("returns a list of agent definitions", async () => {
    const app = createApp();
    const res = await request(app, "/api/agents");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);

    const names = res.body.map((a: any) => a.name);
    expect(names).toContain("implementer");
    expect(names).toContain("reviewer");

    const implementer = res.body.find((a: any) => a.name === "implementer");
    expect(implementer.meta.name).toBe("implementer");
    expect(implementer.meta.agent).toBe("claude");
    expect(implementer.body).toContain("# Implementer Agent");
  });
});

describe("GET /api/agents/:name", () => {
  it("returns a specific agent definition", async () => {
    const app = createApp();
    const res = await request(app, "/api/agents/reviewer");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("reviewer");
    expect(res.body.meta.name).toBe("reviewer");
    expect(res.body.meta.model).toBe("sonnet");
    expect(res.body.body).toContain("# Reviewer Agent");
  });

  it("returns 404 for unknown agent", async () => {
    const app = createApp();
    const res = await request(app, "/api/agents/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });
});
