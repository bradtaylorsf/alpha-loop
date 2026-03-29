import { Router, type Router as RouterType } from "express";

const router: RouterType = Router();

const startTime = Date.now();

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

router.get("/status", (_req, res) => {
  res.json({
    loopRunning: false,
    issuesProcessed: 0,
  });
});

export { router as statusRouter, startTime };
