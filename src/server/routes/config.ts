import { Router, type Router as RouterType } from "express";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";

const router: RouterType = Router();

const CONFIG_PATH = resolve(process.cwd(), "config.yaml");

const DEFAULT_CONFIG: Record<string, unknown> = {
  loop: {
    repo: "",
    project: 0,
    baseBranch: "master",
    pollInterval: 60,
    maxTestRetries: 3,
    labels: { ready: "ready" },
  },
  agent: {
    name: "claude",
    model: "opus",
    reviewModel: "opus",
    maxTurns: 30,
  },
  tests: {
    skipTests: false,
    skipReview: false,
  },
};

function readConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return (parse(raw) as Record<string, unknown>) ?? DEFAULT_CONFIG;
}

router.get("/config", (_req, res) => {
  try {
    const config = readConfig();
    res.json(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read config";
    res.status(500).json({ error: message });
  }
});

router.put("/config", (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== "object" || Array.isArray(newConfig)) {
      res.status(400).json({ error: "Request body must be a JSON object" });
      return;
    }
    writeFileSync(CONFIG_PATH, stringify(newConfig), "utf-8");
    res.json(newConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to write config";
    res.status(500).json({ error: message });
  }
});

export { router as configRouter };
