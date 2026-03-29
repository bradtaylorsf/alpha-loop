import type Database from "better-sqlite3";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createInMemoryDatabase,
  createRun,
  createLearning,
} from "../../src/server/db";
import type { AgentRunner } from "../../src/engine/runner";
import type { GitHubClient, GitHubPR } from "../../src/engine/github";
import {
  computeMetrics,
  aggregateLearnings,
  buildImprovementPrompt,
  parseImprovementOutput,
  shouldImprove,
  readAgentFiles,
  applyChanges,
  runImprovement,
  defaultImproverConfig,
} from "../../src/learning/improver";
import type { ImproverConfig } from "../../src/learning/improver";

// --- Helpers ---

function mockRunner(output: string, success = true): AgentRunner {
  return {
    name: "mock",
    command: "echo",
    buildArgs: () => [],
    run: async () => ({
      success,
      output,
      exitCode: success ? 0 : 1,
      duration: 100,
    }),
  };
}

function mockGitHub(prNumber = 99): GitHubClient {
  return {
    listIssues: async () => [],
    getIssue: async () => ({
      number: 1,
      title: "Test",
      body: null,
      state: "open",
      labels: [],
      assignee: null,
      createdAt: "",
      updatedAt: "",
    }),
    updateLabels: async () => {},
    addComment: async () => {},
    createPR: async () =>
      ({
        number: prNumber,
        title: "improve: Update agent prompts",
        body: "",
        state: "open",
        merged: false,
        draft: false,
        headBranch: "improve/test",
        baseBranch: "master",
        checksStatus: "pending",
        reviewDecision: null,
      }) as GitHubPR,
    updatePR: async () => {},
    getPRStatus: async () =>
      ({
        number: prNumber,
        title: "",
        body: null,
        state: "open",
        merged: false,
        draft: false,
        headBranch: "",
        baseBranch: "",
        checksStatus: "pending",
        reviewDecision: null,
      }) as GitHubPR,
  };
}

function seedRuns(
  db: Database.Database,
  count: number,
  status: "success" | "failure" = "success",
) {
  for (let i = 0; i < count; i++) {
    const run = createRun(db, {
      issue_number: i + 1,
      issue_title: `Issue ${i + 1}`,
      agent: "claude",
      model: "sonnet",
    });
    db.prepare(`UPDATE runs SET status = ?, duration_seconds = ?, stages_json = ? WHERE id = ?`).run(
      status,
      120 + i * 10,
      JSON.stringify(
        status === "success"
          ? ["setup", "implement", "test", "review", "pr", "done"]
          : ["setup", "implement", "test", "fix", "test", "failed"],
      ),
      run.id,
    );
  }
}

function seedLearnings(db: Database.Database, runId: number) {
  createLearning(db, {
    run_id: runId,
    issue_number: 1,
    type: "pattern",
    content: "Small commits help reviews",
    confidence: 0.9,
  });
  createLearning(db, {
    run_id: runId,
    issue_number: 1,
    type: "anti_pattern",
    content: "Skipping tests causes regressions",
    confidence: 0.85,
  });
  createLearning(db, {
    run_id: runId,
    issue_number: 1,
    type: "prompt_improvement",
    content: "Add explicit test-first instructions",
    confidence: 0.8,
  });
}

function makeTempAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "improver-test-"));
  writeFileSync(
    join(dir, "implementer.md"),
    "---\nname: implementer\n---\n\n# Implementer\n\nBuild stuff.\n",
  );
  writeFileSync(
    join(dir, "reviewer.md"),
    "---\nname: reviewer\n---\n\n# Reviewer\n\nReview stuff.\n",
  );
  return dir;
}

// --- Tests ---

describe("computeMetrics", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });
  afterEach(() => {
    db.close();
  });

  it("returns zeros when no runs exist", () => {
    const metrics = computeMetrics(db);
    expect(metrics.totalRuns).toBe(0);
    expect(metrics.completionRate).toBe(0);
    expect(metrics.avgRetryCount).toBe(0);
    expect(metrics.avgDurationSeconds).toBe(0);
    expect(metrics.failureReasons).toEqual([]);
  });

  it("computes metrics from successful runs", () => {
    seedRuns(db, 4, "success");
    const metrics = computeMetrics(db);
    expect(metrics.totalRuns).toBe(4);
    expect(metrics.successCount).toBe(4);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.completionRate).toBe(1);
    expect(metrics.avgDurationSeconds).toBeGreaterThan(0);
  });

  it("computes mixed success/failure metrics", () => {
    seedRuns(db, 3, "success");
    seedRuns(db, 2, "failure");
    const metrics = computeMetrics(db);
    expect(metrics.totalRuns).toBe(5);
    expect(metrics.successCount).toBe(3);
    expect(metrics.failureCount).toBe(2);
    expect(metrics.completionRate).toBeCloseTo(0.6);
  });

  it("extracts failure reasons from stages_json", () => {
    seedRuns(db, 2, "failure");
    const metrics = computeMetrics(db);
    expect(metrics.failureReasons.length).toBeGreaterThan(0);
    expect(metrics.failureReasons[0].reason).toContain("Failed at");
  });

  it("counts fix stages as retries", () => {
    seedRuns(db, 2, "failure");
    const metrics = computeMetrics(db);
    // failure runs have ["setup","implement","test","fix","test","failed"] = 1 fix each
    expect(metrics.avgRetryCount).toBe(1);
  });

  it("ignores running runs", () => {
    createRun(db, {
      issue_number: 1,
      issue_title: "Running",
      agent: "claude",
      model: "sonnet",
    });
    const metrics = computeMetrics(db);
    expect(metrics.totalRuns).toBe(0);
  });
});

describe("aggregateLearnings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });
  afterEach(() => {
    db.close();
  });

  it("returns empty groups when no learnings", () => {
    const agg = aggregateLearnings(db);
    expect(agg.patterns).toEqual([]);
    expect(agg.antiPatterns).toEqual([]);
    expect(agg.promptImprovements).toEqual([]);
  });

  it("groups learnings by type", () => {
    seedRuns(db, 1, "success");
    seedLearnings(db, 1);
    const agg = aggregateLearnings(db);
    expect(agg.patterns).toHaveLength(1);
    expect(agg.antiPatterns).toHaveLength(1);
    expect(agg.promptImprovements).toHaveLength(1);
  });

  it("filters by sinceRunId", () => {
    seedRuns(db, 2, "success");
    seedLearnings(db, 1);
    createLearning(db, {
      run_id: 2,
      issue_number: 2,
      type: "pattern",
      content: "New learning",
      confidence: 0.7,
    });
    const agg = aggregateLearnings(db, 1);
    expect(agg.patterns).toHaveLength(1);
    expect(agg.patterns[0].content).toBe("New learning");
    expect(agg.antiPatterns).toHaveLength(0);
  });

  it("sorts by confidence descending", () => {
    seedRuns(db, 1, "success");
    createLearning(db, {
      run_id: 1,
      issue_number: 1,
      type: "pattern",
      content: "Low confidence",
      confidence: 0.3,
    });
    createLearning(db, {
      run_id: 1,
      issue_number: 1,
      type: "pattern",
      content: "High confidence",
      confidence: 0.95,
    });
    const agg = aggregateLearnings(db);
    expect(agg.patterns[0].content).toBe("High confidence");
    expect(agg.patterns[1].content).toBe("Low confidence");
  });
});

describe("readAgentFiles", () => {
  it("reads .md files from agent directory", () => {
    const dir = makeTempAgentDir();
    const files = readAgentFiles(dir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name).sort()).toEqual([
      "implementer",
      "reviewer",
    ]);
    expect(files[0].content).toContain("---");
  });

  it("returns empty array for non-existent directory", () => {
    const files = readAgentFiles("/nonexistent/path");
    expect(files).toEqual([]);
  });
});

describe("buildImprovementPrompt", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });
  afterEach(() => {
    db.close();
  });

  it("includes metrics, learnings, and agent content", () => {
    seedRuns(db, 5, "success");
    seedLearnings(db, 1);
    const metrics = computeMetrics(db);
    const learnings = aggregateLearnings(db);
    const agentFiles = [{ name: "implementer", content: "# Implementer" }];

    const prompt = buildImprovementPrompt(metrics, learnings, agentFiles);

    expect(prompt).toContain("Total runs: 5");
    expect(prompt).toContain("100.0%");
    expect(prompt).toContain("Small commits help reviews");
    expect(prompt).toContain("Skipping tests causes regressions");
    expect(prompt).toContain("Add explicit test-first instructions");
    expect(prompt).toContain("# Implementer");
    expect(prompt).toContain("JSON array");
  });

  it("shows (none) when no learnings exist for a type", () => {
    const metrics = computeMetrics(db);
    const learnings = { patterns: [], antiPatterns: [], promptImprovements: [] };
    const prompt = buildImprovementPrompt(metrics, learnings, []);
    expect(prompt).toContain("(none)");
  });
});

describe("parseImprovementOutput", () => {
  it("parses valid JSON array of changes", () => {
    const output = `[
      {"path": "implementer.md", "content": "# Updated", "reason": "Added patterns"}
    ]`;
    const result = parseImprovementOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("implementer.md");
    expect(result[0].content).toBe("# Updated");
    expect(result[0].reason).toBe("Added patterns");
  });

  it("extracts JSON from surrounding text", () => {
    const output = `Here are my suggestions:\n[{"path": "reviewer.md", "content": "# New", "reason": "Better"}]\nDone.`;
    const result = parseImprovementOutput(output);
    expect(result).toHaveLength(1);
  });

  it("returns empty for non-JSON output", () => {
    expect(parseImprovementOutput("no changes needed")).toEqual([]);
  });

  it("returns empty for invalid JSON", () => {
    expect(parseImprovementOutput("[{invalid}]")).toEqual([]);
  });

  it("filters out items with missing fields", () => {
    const output = `[
      {"path": "a.md", "content": "ok", "reason": "good"},
      {"path": "", "content": "ok", "reason": "bad path"},
      {"path": "b.md", "content": "", "reason": "empty content"},
      {"path": "c.md", "content": "ok"}
    ]`;
    const result = parseImprovementOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("a.md");
  });
});

describe("shouldImprove", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });
  afterEach(() => {
    db.close();
  });

  it("returns false with no runs", () => {
    const config = defaultImproverConfig({ runsPerImprovement: 5 });
    expect(shouldImprove(db, config)).toBe(false);
  });

  it("returns true when run count is multiple of runsPerImprovement", () => {
    seedRuns(db, 5, "success");
    const config = defaultImproverConfig({ runsPerImprovement: 5 });
    expect(shouldImprove(db, config)).toBe(true);
  });

  it("returns false when run count is not a multiple", () => {
    seedRuns(db, 3, "success");
    const config = defaultImproverConfig({ runsPerImprovement: 5 });
    expect(shouldImprove(db, config)).toBe(false);
  });

  it("returns true at 10 runs with runsPerImprovement=5", () => {
    seedRuns(db, 10, "success");
    const config = defaultImproverConfig({ runsPerImprovement: 5 });
    expect(shouldImprove(db, config)).toBe(true);
  });

  it("counts failure runs too", () => {
    seedRuns(db, 3, "success");
    seedRuns(db, 2, "failure");
    const config = defaultImproverConfig({ runsPerImprovement: 5 });
    expect(shouldImprove(db, config)).toBe(true);
  });
});

describe("applyChanges", () => {
  it("writes updated content to agent files", () => {
    const dir = makeTempAgentDir();
    const changes = applyChanges(
      [{ path: "implementer.md", content: "# Updated Implementer", reason: "Better" }],
      dir,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].original).toContain("# Implementer");
    expect(changes[0].updated).toBe("# Updated Implementer");
    expect(readFileSync(join(dir, "implementer.md"), "utf-8")).toBe(
      "# Updated Implementer",
    );
  });

  it("skips files with identical content", () => {
    const dir = makeTempAgentDir();
    const original = readFileSync(join(dir, "implementer.md"), "utf-8");
    const changes = applyChanges(
      [{ path: "implementer.md", content: original, reason: "No change" }],
      dir,
    );
    expect(changes).toHaveLength(0);
  });

  it("rejects paths with directory traversal", () => {
    const dir = makeTempAgentDir();
    const changes = applyChanges(
      [{ path: "../../../etc/passwd", content: "bad", reason: "hack" }],
      dir,
    );
    expect(changes).toHaveLength(0);
  });

  it("rejects non-.md filenames", () => {
    const dir = makeTempAgentDir();
    const changes = applyChanges(
      [{ path: "config.yaml", content: "bad", reason: "wrong type" }],
      dir,
    );
    expect(changes).toHaveLength(0);
  });

  it("handles new files that do not exist yet", () => {
    const dir = makeTempAgentDir();
    const changes = applyChanges(
      [{ path: "new-agent.md", content: "# New Agent", reason: "New" }],
      dir,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].original).toBe("");
    expect(readFileSync(join(dir, "new-agent.md"), "utf-8")).toBe("# New Agent");
  });
});

describe("runImprovement", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createInMemoryDatabase();
  });
  afterEach(() => {
    db.close();
  });

  it("skips when not enough runs", async () => {
    seedRuns(db, 3, "success");
    const config = defaultImproverConfig({ runsPerImprovement: 5 });
    const result = await runImprovement(
      db,
      mockRunner("[]"),
      mockGitHub(),
      config,
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("Not enough");
  });

  it("skips when no learnings exist", async () => {
    seedRuns(db, 5, "success");
    const config = defaultImproverConfig({ runsPerImprovement: 5 });
    const result = await runImprovement(
      db,
      mockRunner("[]"),
      mockGitHub(),
      config,
    );
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain("No learnings");
  });

  it("runs improvement and creates PR when conditions are met", async () => {
    const dir = makeTempAgentDir();
    seedRuns(db, 5, "success");
    seedLearnings(db, 1);

    const agentOutput = JSON.stringify([
      {
        path: "implementer.md",
        content: "# Improved Implementer\n\nNew guidelines based on learnings.",
        reason: "Incorporated successful patterns",
      },
    ]);

    const config = defaultImproverConfig({
      runsPerImprovement: 5,
      agentDir: dir,
    });

    const github = mockGitHub(42);
    const result = await runImprovement(
      db,
      mockRunner(agentOutput),
      github,
      config,
    );

    expect(result.skipped).toBe(false);
    expect(result.changes).toHaveLength(1);
    expect(result.prNumber).toBe(42);
    expect(result.metrics.totalRuns).toBe(5);
  });

  it("returns no changes when agent suggests empty array", async () => {
    const dir = makeTempAgentDir();
    seedRuns(db, 5, "success");
    seedLearnings(db, 1);

    const config = defaultImproverConfig({
      runsPerImprovement: 5,
      agentDir: dir,
    });
    const result = await runImprovement(
      db,
      mockRunner("[]"),
      mockGitHub(),
      config,
    );
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain("no changes");
  });

  it("handles agent failure gracefully", async () => {
    const dir = makeTempAgentDir();
    seedRuns(db, 5, "success");
    seedLearnings(db, 1);

    const config = defaultImproverConfig({
      runsPerImprovement: 5,
      agentDir: dir,
    });
    const result = await runImprovement(
      db,
      mockRunner("error", false),
      mockGitHub(),
      config,
    );
    expect(result.skipped).toBe(false);
    expect(result.changes).toHaveLength(0);
  });
});

describe("defaultImproverConfig", () => {
  it("returns defaults", () => {
    const config = defaultImproverConfig();
    expect(config.runsPerImprovement).toBe(5);
    expect(config.agentDir).toBe("agents");
    expect(config.baseBranch).toBe("master");
  });

  it("accepts overrides", () => {
    const config = defaultImproverConfig({
      runsPerImprovement: 10,
      owner: "myorg",
    });
    expect(config.runsPerImprovement).toBe(10);
    expect(config.owner).toBe("myorg");
  });
});
