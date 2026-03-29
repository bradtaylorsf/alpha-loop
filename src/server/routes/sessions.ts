import { Router, type Router as RouterType } from "express";
import type Database from "better-sqlite3";
import {
  createSession,
  getSession,
  listSessions,
  updateSessionStatus,
  reorderSessionIssues,
  deleteSession,
  type SessionStatus,
} from "../db.js";

let _db: Database.Database;

export function initSessionsRouter(db: Database.Database): RouterType {
  _db = db;
  return router;
}

const router: RouterType = Router();

const VALID_STATUSES = new Set<SessionStatus>(["pending", "active", "completed", "cancelled"]);

// List sessions
router.get("/sessions", (_req, res) => {
  try {
    const status = _req.query.status as string | undefined;
    const sessions = listSessions(_db, { status });
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

// Get session by ID
router.get("/sessions/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }
    const session = getSession(_db, id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: "Failed to get session" });
  }
});

// Create session
router.post("/sessions", (req, res) => {
  try {
    const { name, issues } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "Missing required field: name" });
      return;
    }
    if (!issues || !Array.isArray(issues) || issues.length === 0) {
      res.status(400).json({ error: "Missing required field: issues (non-empty array)" });
      return;
    }
    for (const issue of issues) {
      if (!issue.issue_number || typeof issue.issue_number !== "number") {
        res.status(400).json({ error: "Each issue must have a numeric issue_number" });
        return;
      }
    }
    const session = createSession(_db, { name, issues });
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: "Failed to create session" });
  }
});

// Update session (reorder issues or change status)
router.patch("/sessions/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }
    const existing = getSession(_db, id);
    if (!existing) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    const { issues, status } = req.body;

    if (status !== undefined) {
      if (!VALID_STATUSES.has(status)) {
        res.status(400).json({ error: "Invalid status. Must be: pending, active, completed, or cancelled" });
        return;
      }
      const updated = updateSessionStatus(_db, id, status);
      if (!issues) {
        res.json(updated);
        return;
      }
    }

    if (issues && Array.isArray(issues)) {
      const updated = reorderSessionIssues(_db, id, { issues });
      res.json(updated);
      return;
    }

    res.json(getSession(_db, id));
  } catch (err) {
    res.status(500).json({ error: "Failed to update session" });
  }
});

// Delete session (only pending)
router.delete("/sessions/:id", (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }
    const existing = getSession(_db, id);
    if (!existing) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(409).json({ error: "Can only delete pending sessions" });
      return;
    }
    deleteSession(_db, id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// AI-powered prioritization
router.post("/sessions/:id/prioritize", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }
    const session = getSession(_db, id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (session.issues.length === 0) {
      res.status(400).json({ error: "Session has no issues to prioritize" });
      return;
    }

    // Build prioritization prompt
    const issueDescriptions = session.issues
      .map((i) => `- Issue #${i.issue_number} (current position: ${i.position})`)
      .join("\n");

    const prompt = buildPrioritizationPrompt(session.name, issueDescriptions);

    // Try to call Claude CLI for prioritization
    const { spawn } = await import("node:child_process");
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn("claude", ["-p", prompt], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30000,
      });

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      proc.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `claude exited with code ${code}`));
      });
      proc.on("error", reject);
    });

    // Parse the AI response - expect JSON array of issue numbers in priority order
    const orderedNumbers = parseAIPrioritization(result, session.issues.map((i) => i.issue_number));

    // Apply new ordering
    const reorderInput = orderedNumbers.map((num, idx) => ({
      issue_number: num,
      position: idx,
    }));
    const updated = reorderSessionIssues(_db, id, { issues: reorderInput });

    res.json({
      ...updated,
      ai_reasoning: result.trim(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to prioritize";
    res.status(500).json({ error: `AI prioritization failed: ${message}` });
  }
});

export function buildPrioritizationPrompt(sessionName: string, issueDescriptions: string): string {
  return `You are prioritizing GitHub issues for a development session called "${sessionName}".

Here are the issues:
${issueDescriptions}

Analyze these issues and suggest an optimal processing order based on:
1. Dependencies (issues that others depend on should come first)
2. Complexity (simpler issues first to build momentum)
3. Impact (higher impact issues prioritized)

Respond with ONLY a JSON array of issue numbers in the recommended order, e.g. [1, 3, 2].
Do not include any other text.`;
}

export function parseAIPrioritization(aiResponse: string, validNumbers: number[]): number[] {
  // Try to extract a JSON array from the response
  const match = aiResponse.match(/\[[\d\s,]+\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as number[];
      // Validate all numbers are in the valid set
      const validSet = new Set(validNumbers);
      const filtered = parsed.filter((n) => validSet.has(n));
      // Add any missing numbers at the end
      for (const num of validNumbers) {
        if (!filtered.includes(num)) {
          filtered.push(num);
        }
      }
      return filtered;
    } catch {
      // Fall through to default
    }
  }
  // If parsing fails, return original order
  return validNumbers;
}

export { router as sessionsRouter };
