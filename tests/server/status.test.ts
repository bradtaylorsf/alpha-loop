import express from "express";
import { createStatusRouter } from "../../src/server/routes/status.js";

function createTestApp(): express.Express {
  const app = express();
  app.use("/api", createStatusRouter());
  return app;
}

describe("GET /api/health", () => {
  it("returns status ok with uptime", async () => {
    const app = createTestApp();

    const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
      const server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        fetch(`http://localhost:${port}/api/health`)
          .then((res) => res.json().then((body) => ({ status: res.status, body: body as Record<string, unknown> })))
          .then((result) => {
            server.close();
            resolve(result);
          });
      });
    });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(typeof response.body.uptime).toBe("number");
  });
});

describe("GET /api/status", () => {
  it("returns loopRunning false and issuesProcessed 0", async () => {
    const app = createTestApp();

    const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
      const server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        fetch(`http://localhost:${port}/api/status`)
          .then((res) => res.json().then((body) => ({ status: res.status, body: body as Record<string, unknown> })))
          .then((result) => {
            server.close();
            resolve(result);
          });
      });
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      loopRunning: false,
      issuesProcessed: 0,
    });
  });
});
