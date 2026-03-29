import express from "express";
import cors from "cors";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { statusRouter } from "./routes/status.js";
import { streamRouter } from "./routes/stream.js";
import { configRouter } from "./routes/config.js";
import { agentsRouter } from "./routes/agents.js";
import { initRunsRouter } from "./routes/runs.js";
import { initLearningsRouter } from "./routes/learnings.js";
import { createDatabase } from "./db.js";

export interface ServerOptions {
  port?: number;
  db?: Database.Database;
}

export function createServer(options: ServerOptions = {}): { app: ReturnType<typeof express>; server: Server; db: Database.Database } {
  const app: ReturnType<typeof express> = express();
  const port = options.port ?? (Number(process.env.PORT) || 4000);
  const db = options.db ?? createDatabase();

  app.use(cors());
  app.use(express.json());
  app.use("/api", statusRouter);
  app.use("/api", streamRouter);
  app.use("/api", configRouter);
  app.use("/api", agentsRouter);
  app.use("/api", initRunsRouter(db));
  app.use("/api", initLearningsRouter(db));

  // Serve built React dashboard in production
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDir = resolve(__dirname, "../client");
  if (existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get("*", (_req, res) => {
      res.sendFile(resolve(clientDir, "index.html"));
    });
  }

  const server = app.listen(port, () => {
    console.log(`Alpha Loop server listening on port ${port}`);
  });

  return { app, server, db };
}

// Auto-start when run directly (backwards compat with `pnpm start`)
const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] === __filename || process.argv[1]?.endsWith("/dist/server/index.js");
if (isDirectRun) {
  const { app, server } = createServer();
  // Keep exports available for tests
  (globalThis as Record<string, unknown>).__alphaLoopApp = app;
  (globalThis as Record<string, unknown>).__alphaLoopServer = server;
}
