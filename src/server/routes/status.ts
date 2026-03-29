import { Router, type Request, type Response } from "express";

const startTime = Date.now();

export function createStatusRouter(): Router {
  const router = Router();

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

  return router;
}
