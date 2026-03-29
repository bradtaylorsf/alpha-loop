import express, { type Express } from "express";
import cors from "cors";
import { statusRouter } from "./routes/status.js";

const app: Express = express();
const PORT = process.env.PORT ?? 3000;

app.use(cors());
app.use(express.json());
app.use("/api", statusRouter);

app.listen(PORT, () => {
  console.log(`Alpha Loop server listening on port ${PORT}`);
});

export { app };
