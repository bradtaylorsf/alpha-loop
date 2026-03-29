import { Router, type Request, type Response, type Router as RouterType } from "express";
import { loopEmitter, type LoopEvent } from "../sse.js";

const router: RouterType = Router();

const HEARTBEAT_INTERVAL_MS = 30_000;

router.get("/stream", (req: Request, res: Response) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const onEvent = (event: LoopEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  loopEmitter.on("loopEvent", onEvent);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    loopEmitter.off("loopEvent", onEvent);
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
});

export { router as streamRouter };
