import express from "express";
import cors from "cors";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { statusRouter } from "./routes/status.js";
import { streamRouter } from "./routes/stream.js";
import { configRouter } from "./routes/config.js";
import { agentsRouter } from "./routes/agents.js";
import { initRunsRouter } from "./routes/runs.js";
import { initLearningsRouter } from "./routes/learnings.js";
import { createDatabase } from "./db.js";

const app: ReturnType<typeof express> = express();
const PORT = process.env.PORT ?? 3000;

const db = createDatabase();

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

const server = app.listen(PORT, () => {
  console.log(`Alpha Loop server listening on port ${PORT}`);
});

export { app, server };
