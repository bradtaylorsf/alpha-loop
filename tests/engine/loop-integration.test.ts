import {
  processIssue,
  defaultConfig,
} from "../../src/engine/loop";
import type {
  LoopConfig,
  PipelineStage,
} from "../../src/engine/loop";
import type { AgentRunner, RunResult } from "../../src/engine/runner";
import type { GitHubClient, GitHubIssue } from "../../src/engine/github";
import { broadcaster } from "../../src/server/sse";
import type { LoopEvent, SequencedEvent } from "../../src/server/sse";
import { createInMemoryDatabase, getRun, listRuns, listLearnings } from "../../src/server/db";
import type Database from "better-sqlite3";

// --- Mock worktree module ---
jest.mock("../../src/engine/worktree", () => ({
  createWorktree: jest.fn().mockReturnValue({
    path: "/tmp/issue-42",
    branch: "agent/issue-42",
    issueNumber: 42,
  }),
  removeWorktree: jest.fn(),
  branchName: jest.fn((n: number) => `agent/issue-${n}`),
}));

// --- Mock child_process.execSync for tests and push ---
const mockExecSync = jest.fn();
jest.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// --- Mock extractLearnings to avoid spawning real agent ---
jest.mock("../../src/learning/extractor", () => ({
  extractLearnings: jest.fn().mockResolvedValue({
    learnings: [
      { type: "pattern", content: "Test pattern", confidence: 0.8 },
    ],
    raw: "[]",
  }),
}));

// --- Helpers ---
function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 42,
    title: "Add widget feature",
    body: "Implement a widget",
    state: "open",
    labels: ["ready"],
    assignee: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    success: true,
    output: "Done",
    exitCode: 0,
    duration: 1000,
    ...overrides,
  };
}

function makeRunner(): AgentRunner {
  return {
    name: "mock-agent",
    command: "mock",
    buildArgs: jest.fn().mockReturnValue([]),
    run: jest.fn().mockResolvedValue(makeRunResult()),
  };
}

function makeGitHub(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    listIssues: jest.fn().mockResolvedValue([]),
    getIssue: jest.fn().mockResolvedValue(makeIssue()),
    updateLabels: jest.fn().mockResolvedValue(undefined),
    addComment: jest.fn().mockResolvedValue(undefined),
    createPR: jest.fn().mockResolvedValue({
      number: 100,
      title: "feat: Add widget feature (closes #42)",
      body: "",
      state: "open",
      merged: false,
      draft: false,
      headBranch: "agent/issue-42",
      baseBranch: "master",
      checksStatus: "pending",
      reviewDecision: null,
    }),
    updatePR: jest.fn().mockResolvedValue(undefined),
    getPRStatus: jest.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return defaultConfig({
    skipTests: true,
    skipReview: true,
    autoCleanup: false,
    dryRun: false,
    ...overrides,
  });
}

// --- Tests ---

describe("processIssue SSE integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("");
    broadcaster.removeAllListeners();
  });

  it("emits SSE stage events during pipeline", async () => {
    const sseEvents: LoopEvent[] = [];
    broadcaster.on((seq: SequencedEvent) => {
      sseEvents.push(seq.event);
    });

    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();

    await processIssue(makeIssue(), config, runner, github);

    const stageEvents = sseEvents.filter((e) => e.type === "stage");
    expect(stageEvents.length).toBeGreaterThan(0);

    const stages = stageEvents.map((e) => (e as any).data.stage);
    expect(stages).toContain("setup");
    expect(stages).toContain("implement");
    expect(stages).toContain("pr");
    expect(stages).toContain("done");

    // All stage events should have issue number and timestamp
    for (const event of stageEvents) {
      expect((event as any).data.issue).toBe(42);
      expect((event as any).data.timestamp).toBeDefined();
    }
  });

  it("emits complete event on success", async () => {
    const sseEvents: LoopEvent[] = [];
    broadcaster.on((seq: SequencedEvent) => {
      sseEvents.push(seq.event);
    });

    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();

    await processIssue(makeIssue(), config, runner, github);

    const completeEvents = sseEvents.filter((e) => e.type === "complete");
    expect(completeEvents).toHaveLength(1);
    expect((completeEvents[0] as any).data.issue).toBe(42);
    expect((completeEvents[0] as any).data.prUrl).toContain("/pull/100");
    expect((completeEvents[0] as any).data.duration).toBeGreaterThanOrEqual(0);
  });

  it("emits error event on failure", async () => {
    const sseEvents: LoopEvent[] = [];
    broadcaster.on((seq: SequencedEvent) => {
      sseEvents.push(seq.event);
    });

    const runner = makeRunner();
    (runner.run as jest.Mock).mockResolvedValue(makeRunResult({ success: false, exitCode: 1 }));
    const github = makeGitHub();
    const config = makeConfig();

    await processIssue(makeIssue(), config, runner, github);

    const errorEvents = sseEvents.filter((e) => e.type === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect((errorEvents[0] as any).data.message).toContain("Implementation failed");
  });
});

describe("processIssue DB integration", () => {
  let db: Database.Database;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("");
    broadcaster.removeAllListeners();
    db = createInMemoryDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it("creates a run record at start and updates on success", async () => {
    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();

    const result = await processIssue(makeIssue(), config, runner, github, undefined, { db });

    expect(result.success).toBe(true);

    // Check run was created and updated
    const { runs } = listRuns(db);
    expect(runs).toHaveLength(1);

    const run = runs[0];
    expect(run.issue_number).toBe(42);
    expect(run.issue_title).toBe("Add widget feature");
    expect(run.agent).toBe("mock-agent");
    expect(run.status).toBe("success");
    expect(run.pr_url).toContain("/pull/100");
    expect(run.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(run.stages_json)).toContain("done");
  });

  it("updates run record on failure", async () => {
    const runner = makeRunner();
    (runner.run as jest.Mock).mockResolvedValue(makeRunResult({ success: false, exitCode: 1 }));
    const github = makeGitHub();
    const config = makeConfig();

    const result = await processIssue(makeIssue(), config, runner, github, undefined, { db });

    expect(result.success).toBe(false);

    const { runs } = listRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failure");
    expect(JSON.parse(runs[0].stages_json)).toContain("failed");
  });

  it("calls extractLearnings after successful run", async () => {
    const { extractLearnings } = jest.requireMock("../../src/learning/extractor");

    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();

    await processIssue(makeIssue(), config, runner, github, undefined, { db });

    expect(extractLearnings).toHaveBeenCalledTimes(1);
    expect(extractLearnings).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, status: "success" }),
      expect.objectContaining({ issueBody: "Implement a widget" }),
      runner,
      db,
    );
  });

  it("does not call extractLearnings on failure", async () => {
    const { extractLearnings } = jest.requireMock("../../src/learning/extractor");

    const runner = makeRunner();
    (runner.run as jest.Mock).mockResolvedValue(makeRunResult({ success: false, exitCode: 1 }));
    const github = makeGitHub();
    const config = makeConfig();

    await processIssue(makeIssue(), config, runner, github, undefined, { db });

    expect(extractLearnings).not.toHaveBeenCalled();
  });

  it("works without db (no crash)", async () => {
    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();

    // No db passed — should not throw
    const result = await processIssue(makeIssue(), config, runner, github);
    expect(result.success).toBe(true);
  });
});
