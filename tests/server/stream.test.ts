import express from "express";
import http from "node:http";
import { EventEmitter } from "node:events";
import { streamRouter } from "../../src/server/routes/stream";
import { loopEmitter } from "../../src/server/sse";
import type { LoopEvent } from "../../src/server/sse";

function createApp(): express.Express {
  const app = express();
  app.use("/api", streamRouter);
  return app;
}

function getPort(server: http.Server): number {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No address");
  return addr.port;
}

function startServer(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface SSEClient {
  res: http.IncomingMessage;
  req: http.ClientRequest;
  messages: string[];
  destroy: () => void;
}

function connectSSE(port: number): Promise<SSEClient> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/stream`, (res) => {
      const messages: string[] = [];
      res.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.startsWith("data: ")) {
            messages.push(line.slice(6));
          } else if (line.startsWith(": ping")) {
            messages.push("ping");
          }
        }
      });
      resolve({
        res,
        req,
        messages,
        destroy: () => { res.destroy(); req.destroy(); },
      });
    });
    req.on("error", reject);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("GET /api/stream", () => {
  let server: http.Server | null = null;
  const clients: SSEClient[] = [];

  afterEach(async () => {
    loopEmitter.removeAllListeners();
    for (const c of clients) c.destroy();
    clients.length = 0;
    if (server?.listening) await closeServer(server);
    server = null;
  });

  async function connect(): Promise<SSEClient> {
    const client = await connectSSE(getPort(server!));
    clients.push(client);
    return client;
  }

  it("returns SSE headers", async () => {
    server = await startServer(createApp());
    const client = await connect();

    expect(client.res.headers["content-type"]).toContain("text/event-stream");
    expect(client.res.headers["cache-control"]).toBe("no-cache");
  });

  it("streams JSON-encoded events with type field", async () => {
    server = await startServer(createApp());
    const client = await connect();

    const event: LoopEvent = {
      type: "stage",
      data: { issue: 28, stage: "implement", timestamp: "2026-03-29T00:00:00Z" },
    };
    loopEmitter.emit("loopEvent", event);
    await wait(50);

    expect(client.messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(client.messages[0]);
    expect(parsed.type).toBe("stage");
    expect(parsed.data.issue).toBe(28);
    expect(parsed.data.stage).toBe("implement");
  });

  it("supports multiple simultaneous clients", async () => {
    server = await startServer(createApp());
    const client1 = await connect();
    const client2 = await connect();

    const event: LoopEvent = {
      type: "output",
      data: { line: "Creating health.ts...", timestamp: "2026-03-29T00:00:00Z" },
    };
    loopEmitter.emit("loopEvent", event);
    await wait(50);

    expect(client1.messages.length).toBeGreaterThanOrEqual(1);
    expect(client2.messages.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(client1.messages[0]).type).toBe("output");
    expect(JSON.parse(client2.messages[0]).type).toBe("output");
  });

  it("configures heartbeat at 30s interval", () => {
    jest.useFakeTimers();
    try {
      const mockReq = new EventEmitter();
      const writtenChunks: string[] = [];
      const mockRes = {
        set: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn((chunk: string) => writtenChunks.push(chunk)),
        on: jest.fn(),
      };

      // Extract the route handler directly from the router
      const streamLayer = (streamRouter as any).stack.find(
        (layer: any) => layer.route?.path === "/stream"
      );
      expect(streamLayer).toBeDefined();
      const handler = streamLayer.route.stack[0].handle;

      handler(mockReq, mockRes);

      jest.advanceTimersByTime(30_000);
      expect(writtenChunks).toContain(": ping\n\n");

      jest.advanceTimersByTime(30_000);
      const pingCount = writtenChunks.filter((c) => c === ": ping\n\n").length;
      expect(pingCount).toBe(2);

      // Cleanup
      mockReq.emit("close");
    } finally {
      jest.useRealTimers();
    }
  });

  it("cleans up listener on client disconnect", async () => {
    server = await startServer(createApp());

    const initialCount = loopEmitter.listenerCount("loopEvent");
    const client = await connect();
    expect(loopEmitter.listenerCount("loopEvent")).toBe(initialCount + 1);

    client.destroy();
    await wait(100);

    expect(loopEmitter.listenerCount("loopEvent")).toBe(initialCount);
  });

  it("streams all event types correctly", async () => {
    server = await startServer(createApp());
    const client = await connect();

    const events: LoopEvent[] = [
      { type: "stage", data: { issue: 1, stage: "test", timestamp: "t" } },
      { type: "output", data: { line: "hello", timestamp: "t" } },
      { type: "test", data: { passed: 45, failed: 2, timestamp: "t" } },
      { type: "error", data: { message: "fail", stage: "test", timestamp: "t" } },
      { type: "complete", data: { issue: 1, prUrl: "https://github.com/pr/1", duration: 120 } },
    ];

    for (const event of events) {
      loopEmitter.emit("loopEvent", event);
    }
    await wait(50);

    expect(client.messages.length).toBe(5);
    const types = client.messages.map((m) => JSON.parse(m).type);
    expect(types).toEqual(["stage", "output", "test", "error", "complete"]);
  });
});
