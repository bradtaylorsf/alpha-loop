import {
  processIssue,
  startLoop,
  defaultConfig,
} from "../../src/engine/loop";
import type {
  LoopConfig,
  PipelineResult,
  StageEvent,
  PipelineStage,
} from "../../src/engine/loop";
import type { AgentRunner, RunResult } from "../../src/engine/runner";
import type { GitHubClient, GitHubIssue } from "../../src/engine/github";

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

function makeRunner(runFn?: (opts: unknown) => Promise<RunResult>): AgentRunner {
  return {
    name: "mock-agent",
    command: "mock",
    buildArgs: jest.fn().mockReturnValue([]),
    run: jest.fn().mockImplementation(runFn ?? (() => Promise.resolve(makeRunResult()))),
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

describe("processIssue", () => {
  const { createWorktree, removeWorktree } = jest.requireMock(
    "../../src/engine/worktree",
  );

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: pnpm test passes, git push succeeds
    mockExecSync.mockReturnValue("");
  });

  it("drives an issue through the full pipeline (skip tests/review)", async () => {
    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();
    const stages: PipelineStage[] = [];

    const result = await processIssue(makeIssue(), config, runner, github, (e) => {
      stages.push(e.to);
    });

    expect(result.success).toBe(true);
    expect(result.stage).toBe("done");
    expect(result.prNumber).toBe(100);
    expect(result.issueNumber).toBe(42);
    expect(result.duration).toBeGreaterThanOrEqual(0);

    // Verify stage transitions
    expect(stages).toEqual(["setup", "implement", "pr", "cleanup", "done"]);

    // Verify GitHub interactions
    expect(github.updateLabels).toHaveBeenCalledWith(42, ["in-progress"], ["ready"]);
    expect(github.createPR).toHaveBeenCalled();
    expect(github.updateLabels).toHaveBeenCalledWith(42, ["in-review"], ["in-progress"]);
    expect(github.addComment).toHaveBeenCalledWith(42, expect.stringContaining("PR: #100"));
  });

  it("includes test and review stages when enabled", async () => {
    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig({ skipTests: false, skipReview: false });
    const stages: PipelineStage[] = [];

    // pnpm test passes on first try
    mockExecSync.mockReturnValue("all tests passed");

    const result = await processIssue(makeIssue(), config, runner, github, (e) => {
      stages.push(e.to);
    });

    expect(result.success).toBe(true);
    expect(stages).toContain("test");
    expect(stages).toContain("review");
    // runner.run called for implement + review = 2 calls
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("fails when implementation agent fails", async () => {
    const runner = makeRunner(() =>
      Promise.resolve(makeRunResult({ success: false, exitCode: 1 })),
    );
    const github = makeGitHub();
    const config = makeConfig();

    const result = await processIssue(makeIssue(), config, runner, github);

    expect(result.success).toBe(false);
    expect(result.stage).toBe("failed");
    expect(result.error).toContain("Implementation failed");
    expect(github.updateLabels).toHaveBeenCalledWith(42, ["failed"], ["in-progress"]);
  });

  it("fails when worktree creation fails", async () => {
    createWorktree.mockImplementationOnce(() => {
      throw new Error("worktree error");
    });
    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();

    const result = await processIssue(makeIssue(), config, runner, github);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Worktree creation failed");
    expect(github.addComment).toHaveBeenCalledWith(
      42,
      expect.stringContaining("could not create worktree"),
    );
  });

  it("fails when git push fails", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("git push")) {
        throw new Error("push rejected");
      }
      return "";
    });

    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();

    const result = await processIssue(makeIssue(), config, runner, github);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to push branch");
  });

  it("fails when PR creation fails", async () => {
    const github = makeGitHub({
      createPR: jest.fn().mockRejectedValue(new Error("PR error")),
    });
    const runner = makeRunner();
    const config = makeConfig();

    const result = await processIssue(makeIssue(), config, runner, github);

    expect(result.success).toBe(false);
    expect(result.error).toContain("PR creation failed");
  });

  it("cleans up worktree when autoCleanup is true", async () => {
    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig({ autoCleanup: true });
    const stages: PipelineStage[] = [];

    await processIssue(makeIssue(), config, runner, github, (e) => {
      stages.push(e.to);
    });

    expect(stages).toContain("cleanup");
    expect(removeWorktree).toHaveBeenCalledWith(42);
  });
});

describe("processIssue retry logic", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("retries tests up to maxTestRetries times", async () => {
    let testAttempt = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("pnpm test")) {
        testAttempt++;
        if (testAttempt < 3) {
          const err = new Error("test fail") as Error & { stdout: string };
          err.stdout = "FAIL: some test";
          throw err;
        }
        return "all tests passed";
      }
      return "";
    });

    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig({ skipTests: false, maxTestRetries: 3 });
    const stages: PipelineStage[] = [];

    const result = await processIssue(makeIssue(), config, runner, github, (e) => {
      stages.push(e.to);
    });

    expect(result.success).toBe(true);
    // implement + 2 fix calls = 3
    expect(runner.run).toHaveBeenCalledTimes(3);
    // Should have: setup, implement, test (1), fix (1), test (2), fix (2), test (3), pr, done
    expect(stages).toContain("fix");
    expect(stages).toContain("test");
  });

  it("continues to PR even when all test retries fail", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("pnpm test")) {
        const err = new Error("test fail") as Error & { stdout: string };
        err.stdout = "FAIL";
        throw err;
      }
      return "";
    });

    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig({ skipTests: false, maxTestRetries: 2 });

    const result = await processIssue(makeIssue(), config, runner, github);

    // Still creates a PR even with failing tests
    expect(result.success).toBe(true);
    expect(result.prNumber).toBe(100);
    // implement + 1 fix call (retries - 1 because last attempt doesn't fix)
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});

describe("startLoop", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("");
  });

  it("polls for issues and processes them", async () => {
    const issue = makeIssue();
    let callCount = 0;
    const github = makeGitHub({
      listIssues: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve([issue]);
        return Promise.resolve([]);
      }),
    });
    const runner = makeRunner();
    const config = makeConfig({ pollInterval: 0.01 });

    // Stop the loop after a short delay
    const timeout = setTimeout(() => {
      process.emit("SIGINT", "SIGINT");
    }, 100);

    await startLoop(config, runner, github);
    clearTimeout(timeout);

    expect(github.listIssues).toHaveBeenCalledWith({
      labels: ["ready"],
      state: "open",
    });
    // Should have processed the issue (runner.run called at least once for implement)
    expect(runner.run).toHaveBeenCalled();
  });

  it("stops on SIGTERM", async () => {
    const github = makeGitHub({
      listIssues: jest.fn().mockResolvedValue([]),
    });
    const runner = makeRunner();
    const config = makeConfig({ pollInterval: 0.01 });

    const timeout = setTimeout(() => {
      process.emit("SIGTERM", "SIGTERM");
    }, 50);

    await startLoop(config, runner, github);
    clearTimeout(timeout);

    // Should have exited gracefully
    expect(github.listIssues).toHaveBeenCalled();
  });
});

describe("defaultConfig", () => {
  it("returns sensible defaults", () => {
    const config = defaultConfig();
    expect(config.baseBranch).toBe("master");
    expect(config.model).toBe("sonnet");
    expect(config.maxTurns).toBe(30);
    expect(config.maxTestRetries).toBe(3);
    expect(config.pollInterval).toBe(60);
    expect(config.label).toBe("ready");
    expect(config.skipTests).toBe(false);
    expect(config.skipReview).toBe(false);
    expect(config.dryRun).toBe(false);
    expect(config.autoCleanup).toBe(true);
  });

  it("accepts overrides", () => {
    const config = defaultConfig({ model: "opus", maxTurns: 10 });
    expect(config.model).toBe("opus");
    expect(config.maxTurns).toBe(10);
    expect(config.baseBranch).toBe("master"); // default preserved
  });
});

describe("stage event logging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("");
  });

  it("emits stage events with issue number and messages", async () => {
    const runner = makeRunner();
    const github = makeGitHub();
    const config = makeConfig();
    const events: StageEvent[] = [];

    await processIssue(makeIssue(), config, runner, github, (e) => {
      events.push(e);
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].issueNumber).toBe(42);
    expect(events[0].to).toBe("setup");
    expect(events.every((e) => e.issueNumber === 42)).toBe(true);

    // Each transition has from/to
    for (const event of events) {
      expect(event.from).toBeDefined();
      expect(event.to).toBeDefined();
    }
  });
});
