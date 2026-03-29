import express from "express";
import http from "node:http";
import { configRouter } from "../../src/server/routes/config";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
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

let originalConfig: string | undefined;

beforeAll(() => {
  if (existsSync(CONFIG_PATH)) {
    originalConfig = readFileSync(CONFIG_PATH, "utf-8");
  }
});

afterAll(() => {
  if (originalConfig !== undefined) {
    writeFileSync(CONFIG_PATH, originalConfig, "utf-8");
  } else if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH);
  }
});

describe("GET /api/config", () => {
  it("returns defaults when config.yaml does not exist", async () => {
    const app = createApp();
    const res = await request(app, "/api/config");

    expect(res.status).toBe(200);
    expect(res.body.loop).toBeDefined();
    expect(res.body.agent).toBeDefined();
    expect(res.body.agent.model).toBe("opus");
  });
});

describe("PUT /api/config", () => {
  it("creates and returns the config", async () => {
    const app = createApp();
    const newConfig = {
      loop: { repo: "test/repo", baseBranch: "main" },
      agent: { name: "codex", model: "gpt-4" },
      tests: { command: "npm test" },
    };

    const res = await request(app, "/api/config", { method: "PUT", body: newConfig });

    expect(res.status).toBe(200);
    expect(res.body.loop.repo).toBe("test/repo");
    expect(res.body.agent.name).toBe("codex");
  });

  it("rejects array body", async () => {
    const app = createApp();
    const res = await request(app, "/api/config", { method: "PUT", body: [1, 2, 3] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a JSON object/);
  });
});
