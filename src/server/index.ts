import express from "express";
import cors from "cors";
import { statusRouter } from "./routes/status.js";
import { streamRouter } from "./routes/stream.js";

const app: ReturnType<typeof express> = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());
app.use("/api", statusRouter);
app.use("/api", streamRouter);

const server = app.listen(PORT, () => {
  console.log(`Alpha Loop server listening on port ${PORT}`);
});

export { app, server };
