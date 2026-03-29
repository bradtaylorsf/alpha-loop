import { Router, type Request, type Response, type Router as RouterType } from "express";
import { broadcaster, type SequencedEvent } from "../sse.js";

const router: RouterType = Router();

const HEARTBEAT_INTERVAL_MS = 30_000;

function writeEvent(res: Response, sequenced: SequencedEvent): void {
  res.write(`id: ${sequenced.id}\ndata: ${JSON.stringify(sequenced.event)}\n\n`);
}

router.get("/stream", (req: Request, res: Response) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  // Replay missed events if Last-Event-ID is provided
  const lastEventId = parseInt(req.headers["last-event-id"] as string) || 0;
  if (lastEventId > 0) {
    const missed = broadcaster.replay(lastEventId);
    for (const event of missed) {
      writeEvent(res, event);
    }
  }

  const onEvent = (sequenced: SequencedEvent) => {
    writeEvent(res, sequenced);
  };

  broadcaster.on(onEvent);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    broadcaster.off(onEvent);
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
});

export { router as streamRouter };
