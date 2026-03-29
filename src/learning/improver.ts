import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentRunner } from "../engine/runner.js";
import type { GitHubClient } from "../engine/github.js";
import type { Run, Learning, LearningType } from "../server/db.js";

// --- Types ---

export interface ImprovementMetrics {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  completionRate: number;
  avgRetryCount: number;
  avgDurationSeconds: number;
  failureReasons: Array<{ reason: string; count: number }>;
}

export interface AggregatedLearnings {
  patterns: Learning[];
  antiPatterns: Learning[];
  promptImprovements: Learning[];
}

export interface FileChange {
  path: string;
  original: string;
  updated: string;
  reason: string;
}

export interface ImprovementResult {
  changes: FileChange[];
  metrics: ImprovementMetrics;
  prNumber?: number;
  skipped: boolean;
  reason?: string;
}

export interface ImproverConfig {
  runsPerImprovement: number;
  agentDir: string;
  repoRoot: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

// --- Defaults ---

export function defaultImproverConfig(
  overrides: Partial<ImproverConfig> = {},
): ImproverConfig {
  return {
    runsPerImprovement: overrides.runsPerImprovement ?? 5,
    agentDir: overrides.agentDir ?? "agents",
    repoRoot: overrides.repoRoot ?? process.cwd(),
    owner: overrides.owner ?? "owner",
    repo: overrides.repo ?? "repo",
    baseBranch: overrides.baseBranch ?? "master",
  };
}

// --- Metrics computation ---

export function computeMetrics(db: Database.Database): ImprovementMetrics {
  const runs = db
    .prepare(`SELECT * FROM runs WHERE status IN ('success', 'failure')`)
    .all() as Run[];

  if (runs.length === 0) {
    return {
      totalRuns: 0,
      successCount: 0,
      failureCount: 0,
      completionRate: 0,
      avgRetryCount: 0,
      avgDurationSeconds: 0,
      failureReasons: [],
    };
  }

  const successCount = runs.filter((r) => r.status === "success").length;
  const failureCount = runs.filter((r) => r.status === "failure").length;

  // Compute average retry count from stages_json
  let totalRetries = 0;
  for (const run of runs) {
    try {
      const stages = JSON.parse(run.stages_json) as string[];
      totalRetries += stages.filter((s) => s === "fix").length;
    } catch {
      // Invalid stages_json, skip
    }
  }

  const durations = runs
    .filter((r) => r.duration_seconds !== null)
    .map((r) => r.duration_seconds!);
  const avgDuration =
    durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

  // Extract failure reasons from stages_json of failed runs
  const reasonCounts = new Map<string, number>();
  for (const run of runs.filter((r) => r.status === "failure")) {
    try {
      const stages = JSON.parse(run.stages_json) as string[];
      // The stage before "failed" is the failure point
      const failedIdx = stages.indexOf("failed");
      const failStage =
        failedIdx > 0 ? stages[failedIdx - 1] : "unknown";
      const reason = `Failed at ${failStage}`;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    } catch {
      reasonCounts.set("unknown", (reasonCounts.get("unknown") ?? 0) + 1);
    }
  }

  const failureReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    totalRuns: runs.length,
    successCount,
    failureCount,
    completionRate: successCount / runs.length,
    avgRetryCount: totalRetries / runs.length,
    avgDurationSeconds: avgDuration,
    failureReasons,
  };
}

// --- Learning aggregation ---

export function aggregateLearnings(
  db: Database.Database,
  sinceRunId?: number,
): AggregatedLearnings {
  const query = sinceRunId
    ? `SELECT * FROM learnings WHERE run_id > ? ORDER BY confidence DESC`
    : `SELECT * FROM learnings ORDER BY confidence DESC`;

  const learnings = (
    sinceRunId
      ? db.prepare(query).all(sinceRunId)
      : db.prepare(query).all()
  ) as Learning[];

  return {
    patterns: learnings.filter((l) => l.type === "pattern"),
    antiPatterns: learnings.filter((l) => l.type === "anti_pattern"),
    promptImprovements: learnings.filter(
      (l) => l.type === "prompt_improvement",
    ),
  };
}

// --- Agent file reading ---

export function readAgentFiles(
  agentDir: string,
): Array<{ name: string; path: string; content: string }> {
  let files: string[];
  try {
    files = readdirSync(agentDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  return files.map((f) => ({
    name: f.replace(/\.md$/, ""),
    path: join(agentDir, f),
    content: readFileSync(join(agentDir, f), "utf-8"),
  }));
}

// --- Prompt builder ---

export function buildImprovementPrompt(
  metrics: ImprovementMetrics,
  learnings: AggregatedLearnings,
  agentFiles: Array<{ name: string; content: string }>,
): string {
  const formatLearnings = (items: Learning[]): string =>
    items.length === 0
      ? "(none)"
      : items
          .slice(0, 20)
          .map((l) => `- [${l.confidence.toFixed(2)}] ${l.content}`)
          .join("\n");

  const agentSections = agentFiles
    .map(
      (a) => `### ${a.name}.md\n\`\`\`markdown\n${a.content}\n\`\`\``,
    )
    .join("\n\n");

  return `You are improving an automated development loop's agent prompts based on accumulated learnings.

## Performance Metrics
- Total runs: ${metrics.totalRuns}
- Completion rate: ${(metrics.completionRate * 100).toFixed(1)}%
- Success: ${metrics.successCount}, Failure: ${metrics.failureCount}
- Average retries per run: ${metrics.avgRetryCount.toFixed(1)}
- Average duration: ${metrics.avgDurationSeconds.toFixed(0)}s
${metrics.failureReasons.length > 0 ? `- Top failure reasons:\n${metrics.failureReasons.map((r) => `  - ${r.reason}: ${r.count} times`).join("\n")}` : ""}

## Accumulated Learnings

### Patterns (things that work well)
${formatLearnings(learnings.patterns)}

### Anti-Patterns (things to avoid)
${formatLearnings(learnings.antiPatterns)}

### Prompt Improvements (specific suggestions)
${formatLearnings(learnings.promptImprovements)}

## Current Agent Definitions

${agentSections}

## Instructions

Based on the metrics and learnings above, suggest specific improvements to the agent definition files. Focus on:
1. Incorporating successful patterns into agent guidelines
2. Adding warnings about anti-patterns
3. Applying specific prompt improvements suggested by the learnings
4. Addressing the most common failure reasons

Output ONLY a JSON array of file changes. Each change must have:
- "path": the filename (e.g., "implementer.md")
- "content": the complete new file content
- "reason": why this change improves performance

Only include files that need changes. If no changes are needed, output an empty array [].

Output ONLY the JSON array:`;
}

// --- Parse improvement output ---

export function parseImprovementOutput(
  raw: string,
): Array<{ path: string; content: string; reason: string }> {
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (item): item is { path: string; content: string; reason: string } =>
      typeof item === "object" &&
      item !== null &&
      typeof item.path === "string" &&
      item.path.length > 0 &&
      typeof item.content === "string" &&
      item.content.length > 0 &&
      typeof item.reason === "string" &&
      item.reason.length > 0,
  );
}

// --- Should improve check ---

export function shouldImprove(
  db: Database.Database,
  config: ImproverConfig,
): boolean {
  const { count } = db
    .prepare(
      `SELECT COUNT(*) as count FROM runs WHERE status IN ('success', 'failure')`,
    )
    .get() as { count: number };

  return count > 0 && count % config.runsPerImprovement === 0;
}

// --- Apply changes ---

export function applyChanges(
  changes: Array<{ path: string; content: string; reason: string }>,
  agentDir: string,
): FileChange[] {
  const applied: FileChange[] = [];

  for (const change of changes) {
    // Sanitize path: only allow simple filenames ending in .md
    const filename = change.path.replace(/^.*[\\/]/, "");
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(filename)) continue;

    const fullPath = join(agentDir, filename);
    let original = "";
    try {
      original = readFileSync(fullPath, "utf-8");
    } catch {
      // New file, original is empty
    }

    // Skip if content is identical
    if (original === change.content) continue;

    writeFileSync(fullPath, change.content, "utf-8");
    applied.push({
      path: fullPath,
      original,
      updated: change.content,
      reason: change.reason,
    });
  }

  return applied;
}

// --- Main improvement orchestrator ---

export async function runImprovement(
  db: Database.Database,
  runner: AgentRunner,
  github: GitHubClient,
  config: ImproverConfig,
): Promise<ImprovementResult> {
  // Check if improvement is due
  if (!shouldImprove(db, config)) {
    return {
      changes: [],
      metrics: computeMetrics(db),
      skipped: true,
      reason: "Not enough completed runs since last improvement",
    };
  }

  // Compute metrics
  const metrics = computeMetrics(db);
  if (metrics.totalRuns === 0) {
    return {
      changes: [],
      metrics,
      skipped: true,
      reason: "No completed runs to analyze",
    };
  }

  // Aggregate learnings
  const learnings = aggregateLearnings(db);
  const totalLearnings =
    learnings.patterns.length +
    learnings.antiPatterns.length +
    learnings.promptImprovements.length;

  if (totalLearnings === 0) {
    return {
      changes: [],
      metrics,
      skipped: true,
      reason: "No learnings to apply",
    };
  }

  // Read current agent files
  const agentFiles = readAgentFiles(config.agentDir);

  // Build prompt and invoke agent
  const prompt = buildImprovementPrompt(metrics, learnings, agentFiles);
  const result = await runner.run({ prompt, maxTurns: 10 });

  // Parse suggested changes
  const suggestions = parseImprovementOutput(result.output);
  if (suggestions.length === 0) {
    return {
      changes: [],
      metrics,
      skipped: false,
      reason: "Agent suggested no changes",
    };
  }

  // Apply changes to files
  const changes = applyChanges(suggestions, config.agentDir);
  if (changes.length === 0) {
    return {
      changes: [],
      metrics,
      skipped: false,
      reason: "No effective changes after applying suggestions",
    };
  }

  // Create PR with improvements
  const prBody = buildPRBody(metrics, changes);
  const branch = `improve/agent-prompts-${Date.now()}`;
  const pr = await github.createPR({
    branch,
    base: config.baseBranch,
    title: "improve: Update agent prompts based on learnings",
    body: prBody,
  });

  return {
    changes,
    metrics,
    prNumber: pr.number,
    skipped: false,
  };
}

// --- PR body builder ---

function buildPRBody(
  metrics: ImprovementMetrics,
  changes: FileChange[],
): string {
  const changeList = changes
    .map((c) => `- **${c.path}**: ${c.reason}`)
    .join("\n");

  return `## Agent Prompt Improvements

Based on analysis of ${metrics.totalRuns} runs (${(metrics.completionRate * 100).toFixed(1)}% completion rate).

### Changes
${changeList}

### Metrics at time of improvement
| Metric | Value |
|--------|-------|
| Total runs | ${metrics.totalRuns} |
| Completion rate | ${(metrics.completionRate * 100).toFixed(1)}% |
| Avg retries | ${metrics.avgRetryCount.toFixed(1)} |
| Avg duration | ${metrics.avgDurationSeconds.toFixed(0)}s |

---
Automated by alpha-loop self-improvement system`;
}
