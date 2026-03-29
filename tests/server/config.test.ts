import express from "express";
import http from "node:http";
import { configRouter } from "../../src/server/routes/config";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATH = resolve(process.cwd(), "config.yaml");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", configRouter);
  return app;
}

function request(
  app: express.Express,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        return reject(new Error("Failed to get server address"));
      }
      const payload = options.body ? JSON.stringify(options.body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path,
          method: options.method ?? "GET",
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : undefined,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          });
        }
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

let originalConfig: string;

beforeAll(() => {
  originalConfig = readFileSync(CONFIG_PATH, "utf-8");
});

afterAll(() => {
  writeFileSync(CONFIG_PATH, originalConfig, "utf-8");
});

describe("GET /api/config", () => {
  it("returns the current config", async () => {
    const app = createApp();
    const res = await request(app, "/api/config");

    expect(res.status).toBe(200);
    expect(res.body.loop).toBeDefined();
    expect(res.body.loop.repo).toBe("bradtaylorsf/alpha-loop");
    expect(res.body.agent).toBeDefined();
    expect(res.body.agent.name).toBe("claude");
    expect(res.body.tests).toBeDefined();
    expect(res.body.tests.command).toBe("pnpm test");
  });
});

describe("PUT /api/config", () => {
  it("updates the config and returns it", async () => {
    const app = createApp();
    const newConfig = {
      loop: {
        repo: "test/repo",
        baseBranch: "main",
        pollInterval: 120,
        maxTestRetries: 5,
        labels: { ready: "todo", inProgress: "doing", inReview: "review" },
      },
      agent: {
        name: "codex",
        model: "gpt-4",
        reviewModel: "gpt-4",
        maxTurns: 20,
        permissionMode: "plan",
      },
      tests: { command: "npm test", skipTests: true, skipReview: true },
    };

    const res = await request(app, "/api/config", { method: "PUT", body: newConfig });

    expect(res.status).toBe(200);
    expect(res.body.loop.repo).toBe("test/repo");
    expect(res.body.agent.name).toBe("codex");

    // Verify it was persisted
    const readRes = await request(app, "/api/config");
    expect(readRes.body.loop.repo).toBe("test/repo");
  });

  it("rejects array body", async () => {
    const app = createApp();
    const res = await request(app, "/api/config", { method: "PUT", body: [1, 2, 3] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a JSON object/);
  });
});
