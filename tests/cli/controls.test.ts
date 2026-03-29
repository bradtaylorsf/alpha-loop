// Mock modules with ESM dependencies before any imports
jest.mock("../../src/engine/worktree", () => ({
  createWorktree: jest.fn().mockReturnValue({
    path: "/tmp/issue-42",
    branch: "agent/issue-42",
    issueNumber: 42,
  }),
  removeWorktree: jest.fn(),
  branchName: jest.fn((n: number) => `agent/issue-${n}`),
}));

const mockExecSync = jest.fn();
jest.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

jest.mock("../../src/server/sse", () => ({
  loopEmitter: { emit: jest.fn() },
}));

jest.mock("../../src/server/db", () => ({
  createRun: jest.fn().mockReturnValue({ id: 1 }),
  updateRun: jest.fn(),
}));

jest.mock("../../src/learning/extractor", () => ({
  extractLearnings: jest.fn().mockResolvedValue({ learnings: [] }),
}));

import {
  createNonInteractiveControls,
  injectContext,
} from "../../src/cli/controls";
import type { LoopControls } from "../../src/cli/controls";
import { processIssue, startLoop, defaultConfig } from "../../src/engine/loop";
import type { LoopConfig, PipelineResult, PipelineStage } from "../../src/engine/loop";
import type { AgentRunner, RunResult, RunOptions } from "../../src/engine/runner";
import type { GitHubClient, GitHubIssue } from "../../src/engine/github";

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

function makeRunner(runFn?: (opts: RunOptions) => Promise<RunResult>): AgentRunner {
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

function makeSkipControls(): LoopControls {
  // Controls that simulate pressing 's' immediately after startIssue
  let skipped = false;
  let abortController = new AbortController();

  return {
    startIssue() {
      skipped = false;
      abortController = new AbortController();
      // Simulate pressing 's' — abort immediately
      skipped = true;
      abortController.abort();
    },
    onStage() {},
    getAbortController() { return abortController; },
    async betweenIssues() { return "continue" as const; },
    consumeContext() { return undefined; },
    shouldQuit() { return false; },
    wasSkipped() { return skipped; },
    destroy() {},
  };
}

function makeQuitControls(): LoopControls {
  // Controls that request quit — let current issue finish, then stop
  let quitRequested = false;
  let issueCount = 0;
  let abortController = new AbortController();

  return {
    startIssue() {
      issueCount++;
      abortController = new AbortController();
      // Request quit during first issue
      if (issueCount === 1) {
        quitRequested = true;
      }
    },
    onStage() {},
    getAbortController() { return abortController; },
    async betweenIssues() { return "quit" as const; },
    consumeContext() { return undefined; },
    shouldQuit() { return quitRequested; },
    wasSkipped() { return false; },
    destroy() {},
  };
}

function makeContextControls(contextText: string): LoopControls {
  let context: string | undefined = contextText;
  let abortController = new AbortController();

  return {
    startIssue() {
      abortController = new AbortController();
    },
    onStage() {},
    getAbortController() { return abortController; },
    async betweenIssues() { return "continue" as const; },
    consumeContext() {
      const ctx = context;
      context = undefined;
      return ctx;
    },
    shouldQuit() { return false; },
    wasSkipped() { return false; },
    destroy() {},
  };
}

// --- Tests ---

describe("controls: skip kills subprocess and moves to next issue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("");
  });

  it("skip aborts current process, labels issue as skipped, and adds comment", async () => {
    const controls = makeSkipControls();
    const issue = makeIssue();
    controls.startIssue(issue); // Simulate startLoop calling startIssue
    const runner = makeRunner(async (opts) => {
      // The runner should see the aborted signal
      return makeRunResult({ success: false, exitCode: 1 });
    });
    const github = makeGitHub();
    const config = makeConfig();

    const result = await processIssue(issue, config, runner, github, undefined, {
      controls,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Skipped by user");
    expect(github.updateLabels).toHaveBeenCalledWith(42, ["skipped"], ["in-progress"]);
    expect(github.addComment).toHaveBeenCalledWith(42, "Skipped by user during session");
  });

  it("skip aborts the abort controller signal", async () => {
    const controls = makeSkipControls();
    const issue = makeIssue();
    controls.startIssue(issue); // Simulate startLoop calling startIssue
    let capturedSignal: AbortSignal | undefined;

    const runner = makeRunner(async (opts) => {
      capturedSignal = opts.abortSignal;
      return makeRunResult({ success: false, exitCode: 1 });
    });
    const github = makeGitHub();
    const config = makeConfig();

    await processIssue(issue, config, runner, github, undefined, {
      controls,
    });

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });
});

describe("controls: context injection appears in next prompt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("");
  });

  it("user context is injected into the implementation prompt", async () => {
    const contextText = "The events API uses a custom date format, check src/utils/dates.ts";
    const controls = makeContextControls(contextText);
    let capturedPrompt = "";

    const runner = makeRunner(async (opts) => {
      capturedPrompt = opts.prompt;
      return makeRunResult();
    });
    const github = makeGitHub();
    const config = makeConfig();

    await processIssue(makeIssue(), config, runner, github, undefined, {
      controls,
    });

    expect(capturedPrompt).toContain("## Additional Context from User");
    expect(capturedPrompt).toContain(contextText);
  });

  it("context is consumed (only used once)", async () => {
    const controls = makeContextControls("some context");
    const prompts: string[] = [];

    const runner = makeRunner(async (opts) => {
      prompts.push(opts.prompt);
      return makeRunResult();
    });
    const github = makeGitHub();
    const config = makeConfig({ skipTests: false, skipReview: false });

    await processIssue(makeIssue(), config, runner, github, undefined, {
      controls,
    });

    // First call (implement) should have context
    expect(prompts[0]).toContain("## Additional Context from User");
    // Second call (review) should NOT have context (already consumed)
    expect(prompts[1]).not.toContain("## Additional Context from User");
  });
});

describe("controls: quit finishes current issue then stops", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("");
  });

  it("quit completes current issue but does not process next", async () => {
    const controls = makeQuitControls();
    const runner = makeRunner();
    const issues = [makeIssue({ number: 42 }), makeIssue({ number: 43 })];
    const github = makeGitHub({
      listIssues: jest.fn().mockResolvedValue(issues),
    });
    const config = makeConfig();
    const processedIssues: number[] = [];

    const origRun = runner.run;
    (runner.run as jest.Mock).mockImplementation(async (opts: RunOptions) => {
      // Track which issues were processed by extracting issue number from prompt
      const match = opts.prompt.match(/#(\d+)/);
      if (match) processedIssues.push(Number(match[1]));
      return makeRunResult();
    });

    await startLoop(config, runner, github, undefined, {
      once: true,
      selectedIssues: [42, 43],
      controls,
    });

    // Only the first issue should have been processed
    expect(processedIssues.filter((n) => n === 42).length).toBeGreaterThan(0);
    expect(processedIssues.filter((n) => n === 43).length).toBe(0);
  });
});

describe("non-interactive controls (no TTY)", () => {
  it("processes without waiting for input", async () => {
    const controls = createNonInteractiveControls();

    // All methods should be safe no-ops
    controls.startIssue(makeIssue());
    controls.onStage("setup");
    expect(controls.shouldQuit()).toBe(false);
    expect(controls.wasSkipped()).toBe(false);
    expect(controls.consumeContext()).toBeUndefined();

    const action = await controls.betweenIssues(
      { issueNumber: 42, stage: "done", success: true, duration: 1000 },
      makeIssue({ number: 43 }),
    );
    expect(action).toBe("continue");

    controls.destroy(); // Should not throw
  });

  it("getAbortController returns a fresh controller per issue", () => {
    const controls = createNonInteractiveControls();

    controls.startIssue(makeIssue({ number: 1 }));
    const ac1 = controls.getAbortController();

    controls.startIssue(makeIssue({ number: 2 }));
    const ac2 = controls.getAbortController();

    expect(ac1).not.toBe(ac2);
    expect(ac1.signal.aborted).toBe(false);
    expect(ac2.signal.aborted).toBe(false);
  });
});

describe("injectContext", () => {
  it("appends context section to prompt", () => {
    const prompt = "Implement issue #42";
    const context = "Check the utils folder";
    const result = injectContext(prompt, context);

    expect(result).toContain("Implement issue #42");
    expect(result).toContain("## Additional Context from User");
    expect(result).toContain("Check the utils folder");
  });

  it("preserves original prompt content", () => {
    const prompt = "Line 1\nLine 2\nLine 3";
    const result = injectContext(prompt, "extra info");

    expect(result).toContain("Line 1\nLine 2\nLine 3");
    expect(result).toContain("extra info");
  });
});

describe("abort signal integration with runner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecSync.mockReturnValue("");
  });

  it("abort signal is passed through to runner.run", async () => {
    const abortController = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const controls: LoopControls = {
      startIssue() {},
      onStage() {},
      getAbortController() { return abortController; },
      async betweenIssues() { return "continue" as const; },
      consumeContext() { return undefined; },
      shouldQuit() { return false; },
      wasSkipped() { return false; },
      destroy() {},
    };

    const runner = makeRunner(async (opts) => {
      receivedSignal = opts.abortSignal;
      return makeRunResult();
    });
    const github = makeGitHub();
    const config = makeConfig();

    await processIssue(makeIssue(), config, runner, github, undefined, {
      controls,
    });

    expect(receivedSignal).toBe(abortController.signal);
  });
});
