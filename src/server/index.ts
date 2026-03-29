import express from "express";
import cors from "cors";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import { statusRouter } from "./routes/status.js";
import { streamRouter } from "./routes/stream.js";
import { configRouter } from "./routes/config.js";
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

  const server = app.listen(port, () => {
    console.log(`Alpha Loop server listening on port ${port}`);
  });

  return { app, server, db };
}
