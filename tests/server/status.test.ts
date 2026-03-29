import express from "express";
import request from "supertest";
import { statusRouter } from "../../src/server/routes/status";

const app = express();
app.use("/api", statusRouter);

describe("GET /api/health", () => {
  it("returns status ok with uptime", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
  });
});

describe("GET /api/status", () => {
  it("returns loop status", async () => {
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      loopRunning: false,
      issuesProcessed: 0,
    });
  });
});
