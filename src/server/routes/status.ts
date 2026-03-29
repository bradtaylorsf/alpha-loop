import { type Router as RouterType, Router, Request, Response } from "express";

const router: RouterType = Router();

const startTime = Date.now();

router.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

router.get("/status", (_req: Request, res: Response) => {
  res.json({
    loopRunning: false,
    issuesProcessed: 0,
  });
});

export { router as statusRouter };
