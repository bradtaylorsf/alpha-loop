import { Router, type Router as RouterType } from "express";
import type Database from "better-sqlite3";
import { listLearnings } from "../db.js";
import type { LearningType } from "../db.js";
import { computeMetrics, aggregateLearnings } from "../../learning/improver.js";

let _db: Database.Database;

export function initLearningsRouter(db: Database.Database): RouterType {
  _db = db;
  return router;
}

const VALID_TYPES = new Set<string>(["pattern", "anti_pattern", "prompt_improvement"]);

const router: RouterType = Router();

router.get("/learnings", (_req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(_req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(_req.query.offset as string) || 0, 0);
    const type = _req.query.type as string | undefined;

    if (type !== undefined && !VALID_TYPES.has(type)) {
      res.status(400).json({ error: "Invalid type. Must be: pattern, anti_pattern, or prompt_improvement" });
      return;
    }

    const result = listLearnings(_db, { limit, offset, type: type as LearningType | undefined });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to list learnings" });
  }
});

router.get("/learnings/metrics", (_req, res) => {
  try {
    const metrics = computeMetrics(_db);
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: "Failed to compute metrics" });
  }
});

router.get("/learnings/suggestions", (_req, res) => {
  try {
    const learnings = aggregateLearnings(_db);
    const suggestions = learnings.promptImprovements.map((l) => ({
      id: l.id,
      content: l.content,
      confidence: l.confidence,
      run_id: l.run_id,
      issue_number: l.issue_number,
      created_at: l.created_at,
    }));
    res.json({ suggestions });
  } catch (err) {
    res.status(500).json({ error: "Failed to get suggestions" });
  }
});

export { router as learningsRouter };
