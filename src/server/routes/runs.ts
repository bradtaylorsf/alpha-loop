import { Router, type Router as RouterType } from "express";
import type Database from "better-sqlite3";
import { getRun, listRuns, createRun, updateRun } from "../db.js";

let _db: Database.Database;

export function initRunsRouter(db: Database.Database): RouterType {
  _db = db;
  return router;
}

const router: RouterType = Router();

router.get("/runs", (_req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(_req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(_req.query.offset as string) || 0, 0);
    const result = listRuns(_db, { limit, offset });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to list runs" });
  }
});

router.get("/runs/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid run ID" });
      return;
    }
    const run = getRun(_db, id);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: "Failed to get run" });
  }
});

router.post("/runs", (req, res) => {
  try {
    const { issue_number, issue_title, agent, model } = req.body;
    if (!issue_number || !issue_title || !agent || !model) {
      res.status(400).json({ error: "Missing required fields: issue_number, issue_title, agent, model" });
      return;
    }
    const run = createRun(_db, { issue_number, issue_title, agent, model });
    res.status(201).json(run);
  } catch (err) {
    res.status(500).json({ error: "Failed to create run" });
  }
});

const VALID_STATUSES = new Set(["running", "success", "failure"]);

router.patch("/runs/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid run ID" });
      return;
    }
    const existing = getRun(_db, id);
    if (!existing) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const { status, stages_json, pr_url, duration_seconds } = req.body;
    if (status !== undefined && !VALID_STATUSES.has(status)) {
      res.status(400).json({ error: "Invalid status. Must be: running, success, or failure" });
      return;
    }
    const run = updateRun(_db, id, { status, stages_json, pr_url, duration_seconds });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: "Failed to update run" });
  }
});

export { router as runsRouter };
