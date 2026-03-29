import express from "express";
import { statusRouter, startTime } from "../../src/server/routes/status";

function createApp() {
  const app = express();
  app.use("/api", statusRouter);
  return app;
}

// Use lightweight approach without supertest
import http from "http";

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

describe("GET /api/health", () => {
  it("returns status ok and uptime in seconds", async () => {
    const app = createApp();
    const res = await request(app, "/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /api/status", () => {
  it("returns loopRunning false and issuesProcessed 0", async () => {
    const app = createApp();
    const res = await request(app, "/api/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      loopRunning: false,
      issuesProcessed: 0,
    });
  });
});
