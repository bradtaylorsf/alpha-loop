import express from "express";
import cors from "cors";
import { createStatusRouter } from "./routes/status.js";

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", createStatusRouter());
  return app;
}

const port = process.env.PORT ?? 3000;

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const app = createApp();
  app.listen(port, () => {
    console.log(`Alpha Loop server listening on port ${port}`);
  });
}
