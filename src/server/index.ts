import express from "express";
import cors from "cors";
import { statusRouter } from "./routes/status.js";
import { streamRouter } from "./routes/stream.js";
import { configRouter } from "./routes/config.js";
import { agentsRouter } from "./routes/agents.js";
import { initRunsRouter } from "./routes/runs.js";
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

const server = app.listen(PORT, () => {
  console.log(`Alpha Loop server listening on port ${PORT}`);
});

export { app, server };
