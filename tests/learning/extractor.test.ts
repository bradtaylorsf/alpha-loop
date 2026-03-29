import type Database from "better-sqlite3";
import {
  createInMemoryDatabase,
  createRun,
  createLearning,
  listLearnings,
  getLearning,
} from "../../src/server/db";
import type { Run, Learning } from "../../src/server/db";
import {
  buildAnalysisPrompt,
  parseAgentOutput,
  extractLearnings,
} from "../../src/learning/extractor";
import type { RunContext } from "../../src/learning/extractor";
import type { AgentRunner } from "../../src/engine/runner";

// --- Helpers ---

function makeRun(db: Database.Database): Run {
  return createRun(db, {
    issue_number: 42,
    issue_title: "Fix the widget",
    agent: "claude",
    model: "sonnet",
  });
}

function makeContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    issueBody: "Implement the widget feature",
    diff: "diff --git a/src/widget.ts\n+export function widget() {}",
    testOutput: "Tests: 5 passed, 0 failed",
    reviewOutput: "LGTM, no issues found",
    retryCount: 0,
    ...overrides,
  };
}

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

// --- Tests ---

describe("buildAnalysisPrompt", () => {
  let db: Database.Database;

  beforeEach(() => { db = createInMemoryDatabase(); });
  afterEach(() => { db.close(); });

  it("includes run details and context in prompt", () => {
    const run = makeRun(db);
    const context = makeContext();
    const prompt = buildAnalysisPrompt(run, context);

    expect(prompt).toContain("#42");
    expect(prompt).toContain("Fix the widget");
    expect(prompt).toContain("Implement the widget feature");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain("Tests: 5 passed");
    expect(prompt).toContain("LGTM");
    expect(prompt).toContain("Retry count: 0");
  });

  it("handles missing context gracefully", () => {
    const run = makeRun(db);
    const context = makeContext({ issueBody: "", diff: "", testOutput: "", reviewOutput: "" });
    const prompt = buildAnalysisPrompt(run, context);

    expect(prompt).toContain("(no description)");
    expect(prompt).toContain("(no diff available)");
    expect(prompt).toContain("(no test output)");
    expect(prompt).toContain("(no review output)");
  });
});

describe("parseAgentOutput", () => {
  it("parses valid JSON array of learnings", () => {
    const output = `[
      {"type": "pattern", "content": "Small commits help", "confidence": 0.9},
      {"type": "anti_pattern", "content": "Skipping tests is bad", "confidence": 0.8}
    ]`;
    const result = parseAgentOutput(output);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("pattern");
    expect(result[0].content).toBe("Small commits help");
    expect(result[0].confidence).toBe(0.9);
    expect(result[1].type).toBe("anti_pattern");
  });

  it("extracts JSON from surrounding text", () => {
    const output = `Here is my analysis:\n[{"type": "pattern", "content": "Good pattern", "confidence": 0.7}]\nEnd of analysis.`;
    const result = parseAgentOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Good pattern");
  });

  it("returns empty array for non-JSON output", () => {
    expect(parseAgentOutput("no json here")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseAgentOutput("[{invalid}]")).toEqual([]);
  });

  it("filters out items with invalid types", () => {
    const output = `[
      {"type": "pattern", "content": "Valid", "confidence": 0.5},
      {"type": "unknown_type", "content": "Invalid type", "confidence": 0.5}
    ]`;
    const result = parseAgentOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("pattern");
  });

  it("filters out items with missing or empty content", () => {
    const output = `[
      {"type": "pattern", "content": "", "confidence": 0.5},
      {"type": "pattern", "confidence": 0.5},
      {"type": "pattern", "content": "Valid", "confidence": 0.5}
    ]`;
    const result = parseAgentOutput(output);
    expect(result).toHaveLength(1);
  });

  it("filters out items with out-of-range confidence", () => {
    const output = `[
      {"type": "pattern", "content": "Too high", "confidence": 1.5},
      {"type": "pattern", "content": "Negative", "confidence": -0.1},
      {"type": "pattern", "content": "Valid", "confidence": 0.5}
    ]`;
    const result = parseAgentOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Valid");
  });

  it("accepts prompt_improvement type", () => {
    const output = `[{"type": "prompt_improvement", "content": "Add more context", "confidence": 0.6}]`;
    const result = parseAgentOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("prompt_improvement");
  });
});

describe("extractLearnings", () => {
  let db: Database.Database;

  beforeEach(() => { db = createInMemoryDatabase(); });
  afterEach(() => { db.close(); });

  it("invokes agent, parses output, and stores learnings in DB", async () => {
    const run = makeRun(db);
    const context = makeContext();
    const agentOutput = `[
      {"type": "pattern", "content": "Tests passed first try", "confidence": 0.85},
      {"type": "anti_pattern", "content": "Large diff is hard to review", "confidence": 0.7}
    ]`;
    const runner = mockRunner(agentOutput);

    const result = await extractLearnings(run, context, runner, db);

    expect(result.learnings).toHaveLength(2);
    expect(result.raw).toBe(agentOutput);

    const stored = listLearnings(db);
    expect(stored.total).toBe(2);
    expect(stored.learnings[0].run_id).toBe(run.id);
    expect(stored.learnings[0].issue_number).toBe(42);
  });

  it("handles agent returning no valid learnings", async () => {
    const run = makeRun(db);
    const context = makeContext();
    const runner = mockRunner("I have no learnings to share");

    const result = await extractLearnings(run, context, runner, db);

    expect(result.learnings).toHaveLength(0);
    expect(listLearnings(db).total).toBe(0);
  });

  it("handles agent failure gracefully", async () => {
    const run = makeRun(db);
    const context = makeContext();
    const runner = mockRunner("error occurred", false);

    const result = await extractLearnings(run, context, runner, db);

    expect(result.learnings).toHaveLength(0);
  });
});

describe("Learnings DB CRUD", () => {
  let db: Database.Database;

  beforeEach(() => { db = createInMemoryDatabase(); });
  afterEach(() => { db.close(); });

  it("creates and retrieves a learning", () => {
    const run = makeRun(db);
    const learning = createLearning(db, {
      run_id: run.id,
      issue_number: 42,
      type: "pattern",
      content: "Small PRs get reviewed faster",
      confidence: 0.9,
    });

    expect(learning.id).toBe(1);
    expect(learning.type).toBe("pattern");
    expect(learning.content).toBe("Small PRs get reviewed faster");
    expect(learning.confidence).toBe(0.9);

    const fetched = getLearning(db, 1);
    expect(fetched).toBeDefined();
    expect(fetched!.content).toBe("Small PRs get reviewed faster");
  });

  it("lists learnings with pagination", () => {
    const run = makeRun(db);
    for (let i = 0; i < 5; i++) {
      createLearning(db, {
        run_id: run.id,
        issue_number: 42,
        type: "pattern",
        content: `Learning ${i}`,
        confidence: 0.5,
      });
    }

    const page1 = listLearnings(db, { limit: 2, offset: 0 });
    expect(page1.total).toBe(5);
    expect(page1.learnings).toHaveLength(2);

    const page2 = listLearnings(db, { limit: 2, offset: 4 });
    expect(page2.learnings).toHaveLength(1);
  });

  it("filters learnings by type", () => {
    const run = makeRun(db);
    createLearning(db, { run_id: run.id, issue_number: 42, type: "pattern", content: "A", confidence: 0.5 });
    createLearning(db, { run_id: run.id, issue_number: 42, type: "anti_pattern", content: "B", confidence: 0.5 });
    createLearning(db, { run_id: run.id, issue_number: 42, type: "prompt_improvement", content: "C", confidence: 0.5 });

    const patterns = listLearnings(db, { type: "pattern" });
    expect(patterns.total).toBe(1);
    expect(patterns.learnings[0].content).toBe("A");

    const antiPatterns = listLearnings(db, { type: "anti_pattern" });
    expect(antiPatterns.total).toBe(1);
    expect(antiPatterns.learnings[0].content).toBe("B");
  });
});

