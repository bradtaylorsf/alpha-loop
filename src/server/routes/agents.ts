import { Router, type Router as RouterType } from "express";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parse } from "yaml";

const router: RouterType = Router();

const AGENTS_DIR = resolve(process.cwd(), "agents");

interface AgentDefinition {
  name: string;
  meta: Record<string, unknown>;
  body: string;
}

function parseAgentFile(filePath: string): AgentDefinition {
  const raw = readFileSync(filePath, "utf-8");
  const name = basename(filePath, ".md");

  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { name, meta: {}, body: raw.trim() };
  }

  const meta = parse(frontmatterMatch[1]) as Record<string, unknown>;
  const body = frontmatterMatch[2].trim();

  return { name, meta, body };
}

function listAgents(): AgentDefinition[] {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  return files.map((f) => parseAgentFile(resolve(AGENTS_DIR, f)));
}

router.get("/agents", (_req, res) => {
  try {
    const agents = listAgents();
    res.json(agents);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list agents";
    res.status(500).json({ error: message });
  }
});

router.get("/agents/:name", (req, res) => {
  try {
    const agentName = req.params.name;
    const filePath = resolve(AGENTS_DIR, `${agentName}.md`);

    try {
      const agent = parseAgentFile(filePath);
      res.json(agent);
    } catch {
      res.status(404).json({ error: `Agent '${agentName}' not found` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read agent";
    res.status(500).json({ error: message });
  }
});

export { router as agentsRouter };
