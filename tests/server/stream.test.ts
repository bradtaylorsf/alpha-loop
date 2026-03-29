import express from "express";
import http from "node:http";
import { streamRouter } from "../../src/server/routes/stream";
import { broadcaster } from "../../src/server/sse";
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
  eventIds: string[];
  destroy: () => void;
}

function connectSSE(port: number, lastEventId?: number): Promise<SSEClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (lastEventId !== undefined) {
      headers["Last-Event-ID"] = String(lastEventId);
    }
    const req = http.get(`http://127.0.0.1:${port}/api/stream`, { headers }, (res) => {
      const messages: string[] = [];
      const eventIds: string[] = [];
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        let currentId = "";
        for (const line of lines) {
          if (line.startsWith("id: ")) {
            currentId = line.slice(4).trim();
          } else if (line.startsWith("data: ")) {
            messages.push(line.slice(6));
            if (currentId) {
              eventIds.push(currentId);
              currentId = "";
            }
          } else if (line.startsWith(": ping")) {
            messages.push("ping");
          }
        }
      });
      resolve({
        res,
        req,
        messages,
        eventIds,
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
    broadcaster.removeAllListeners();
    for (const c of clients) c.destroy();
    clients.length = 0;
    if (server?.listening) await closeServer(server);
    server = null;
  });

  async function connect(lastEventId?: number): Promise<SSEClient> {
    const client = await connectSSE(getPort(server!), lastEventId);
    clients.push(client);
    return client;
  }

  it("returns SSE headers", async () => {
    server = await startServer(createApp());
    const client = await connect();

    expect(client.res.headers["content-type"]).toContain("text/event-stream");
    expect(client.res.headers["cache-control"]).toBe("no-cache");
  });

  it("streams JSON-encoded events with type field and sequence id", async () => {
    server = await startServer(createApp());
    const client = await connect();

    const event: LoopEvent = {
      type: "stage",
      data: { issue: 28, stage: "implement", timestamp: "2026-03-29T00:00:00Z" },
    };
    broadcaster.emit(event);
    await wait(50);

    expect(client.messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(client.messages[0]);
    expect(parsed.type).toBe("stage");
    expect(parsed.data.issue).toBe(28);
    expect(parsed.data.stage).toBe("implement");

    // Should have a numeric event ID
    expect(client.eventIds.length).toBeGreaterThanOrEqual(1);
    expect(parseInt(client.eventIds[0])).toBeGreaterThan(0);
  });

  it("supports multiple simultaneous clients", async () => {
    server = await startServer(createApp());
    const client1 = await connect();
    const client2 = await connect();

    const event: LoopEvent = {
      type: "output",
      data: { line: "Creating health.ts...", timestamp: "2026-03-29T00:00:00Z" },
    };
    broadcaster.emit(event);
    await wait(50);

    expect(client1.messages.length).toBeGreaterThanOrEqual(1);
    expect(client2.messages.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(client1.messages[0]).type).toBe("output");
    expect(JSON.parse(client2.messages[0]).type).toBe("output");
  });

  it("replays missed events on reconnection with Last-Event-ID", async () => {
    server = await startServer(createApp());

    // First, emit events without a connected client
    const event1: LoopEvent = { type: "output", data: { line: "line1", timestamp: "t" } };
    const event2: LoopEvent = { type: "output", data: { line: "line2", timestamp: "t" } };
    const event3: LoopEvent = { type: "output", data: { line: "line3", timestamp: "t" } };

    const id1 = broadcaster.emit(event1);
    const id2 = broadcaster.emit(event2);
    const id3 = broadcaster.emit(event3);

    // Connect with Last-Event-ID = id1, should replay id2 and id3
    const client = await connect(id1);
    await wait(100);

    // Should have received the replayed events
    const dataMessages = client.messages.filter((m) => m !== "ping");
    expect(dataMessages.length).toBeGreaterThanOrEqual(2);

    const parsed = dataMessages.map((m) => JSON.parse(m));
    const lines = parsed.map((p) => p.data.line);
    expect(lines).toContain("line2");
    expect(lines).toContain("line3");
  });

  it("cleans up listener on client disconnect", async () => {
    server = await startServer(createApp());

    const initialCount = broadcaster.listenerCount();
    const client = await connect();
    expect(broadcaster.listenerCount()).toBe(initialCount + 1);

    client.destroy();
    await wait(100);

    expect(broadcaster.listenerCount()).toBe(initialCount);
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
      broadcaster.emit(event);
    }
    await wait(50);

    expect(client.messages.length).toBe(5);
    const types = client.messages.map((m) => JSON.parse(m).type);
    expect(types).toEqual(["stage", "output", "test", "error", "complete"]);
  });

  it("streams new structured event types", async () => {
    server = await startServer(createApp());
    const client = await connect();

    const events: LoopEvent[] = [
      { type: "stage_start", data: { issue: 1, stage: "test", timestamp: "t" } },
      { type: "stage_complete", data: { issue: 1, stage: "test", duration: 15, timestamp: "t" } },
      { type: "test_result", data: { passed: 10, failed: 0, attempt: 1, maxAttempts: 3, timestamp: "t" } },
      { type: "review_result", data: { issue: 1, success: true, timestamp: "t" } },
    ];

    for (const event of events) {
      broadcaster.emit(event);
    }
    await wait(50);

    const types = client.messages.map((m) => JSON.parse(m).type);
    expect(types).toEqual(["stage_start", "stage_complete", "test_result", "review_result"]);
  });
});
