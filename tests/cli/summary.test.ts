jest.mock("node:child_process", () => ({
  execSync: jest.fn(),
}));

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { parse } from "yaml";
import {
  buildIssueResults,
  formatPostRunSummary,
  generateQAChecklist,
  formatQAChecklist,
  buildSessionYaml,
  saveSessionFiles,
  formatPostRunOptions,
  openPRsInBrowser,
} from "../../src/cli/summary";
import type {
  IssueResultEntry,
  SessionSummaryData,
  QAChecklistEntry,
} from "../../src/cli/summary";
import type { LoopResults, PipelineResult } from "../../src/engine/loop";
import type { GitHubIssue } from "../../src/engine/github";

// --- Helpers ---

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 96,
    title: "Create a new event",
    body: "Implement event creation",
    state: "open",
    labels: ["ready"],
    assignee: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    issueNumber: 96,
    stage: "done",
    success: true,
    prNumber: 101,
    duration: 252000,
    ...overrides,
  };
}

function makeSummaryData(overrides: Partial<SessionSummaryData> = {}): SessionSummaryData {
  return {
    sessionName: "bug-fixes-round-1",
    repo: "bradtaylorsf/aging-sidekick",
    started: "2026-03-29T14:30:00Z",
    completed: "2026-03-29T14:42:34Z",
    duration: 754,
    model: "opus",
    mergeStrategy: "session-branch",
    issues: [
      {
        number: 96,
        title: "Create a new event",
        status: "success",
        prNumber: 101,
        prUrl: "https://github.com/bradtaylorsf/aging-sidekick/pull/101",
        duration: 252000,
      },
      {
        number: 97,
        title: "View event details",
        status: "failed",
        error: "test failures after 3 retries",
        duration: 320000,
      },
      {
        number: 98,
        title: "Edit an event",
        status: "success",
        prNumber: 102,
        prUrl: "https://github.com/bradtaylorsf/aging-sidekick/pull/102",
        duration: 182000,
      },
      {
        number: 99,
        title: "Add calendar view",
        status: "skipped",
        duration: 0,
      },
    ],
    ...overrides,
  };
}

// --- Tests ---

describe("buildIssueResults", () => {
  it("builds results from mixed success/failure/skipped pipeline results", () => {
    const issues = new Map<number, GitHubIssue>();
    issues.set(96, makeIssue({ number: 96, title: "Create event" }));
    issues.set(97, makeIssue({ number: 97, title: "View event" }));
    issues.set(98, makeIssue({ number: 98, title: "Edit event" }));

    const loopResults: LoopResults = {
      results: [
        makeResult({ issueNumber: 96, success: true, prNumber: 101, duration: 252000 }),
        makeResult({ issueNumber: 97, success: false, error: "test failures", duration: 320000, stage: "failed", prNumber: undefined }),
        makeResult({ issueNumber: 98, success: false, error: "Skipped by user", duration: 5000, stage: "failed", prNumber: undefined }),
      ],
      issues,
      skippedIssues: [],
    };

    const results = buildIssueResults(loopResults, "owner", "repo");

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(expect.objectContaining({
      number: 96,
      status: "success",
      prNumber: 101,
      prUrl: "https://github.com/owner/repo/pull/101",
    }));
    expect(results[1]).toEqual(expect.objectContaining({
      number: 97,
      status: "failed",
      error: "test failures",
    }));
    expect(results[2]).toEqual(expect.objectContaining({
      number: 98,
      status: "skipped",
    }));
  });

  it("includes issues skipped at between-issues prompt", () => {
    const issues = new Map<number, GitHubIssue>();
    issues.set(96, makeIssue({ number: 96, title: "Create event" }));
    issues.set(99, makeIssue({ number: 99, title: "Calendar view" }));

    const loopResults: LoopResults = {
      results: [
        makeResult({ issueNumber: 96, success: true, prNumber: 101 }),
      ],
      issues,
      skippedIssues: [99],
    };

    const results = buildIssueResults(loopResults, "owner", "repo");

    expect(results).toHaveLength(2);
    expect(results[1]).toEqual(expect.objectContaining({
      number: 99,
      status: "skipped",
      title: "Calendar view",
      duration: 0,
    }));
  });

  it("does not duplicate skipped issues already in results", () => {
    const issues = new Map<number, GitHubIssue>();
    issues.set(98, makeIssue({ number: 98, title: "Edit event" }));

    const loopResults: LoopResults = {
      results: [
        makeResult({ issueNumber: 98, success: false, error: "Skipped by user", stage: "failed" }),
      ],
      issues,
      skippedIssues: [98],
    };

    const results = buildIssueResults(loopResults, "owner", "repo");
    expect(results).toHaveLength(1);
  });
});

describe("formatPostRunSummary", () => {
  it("displays session header with name and duration", () => {
    const data = makeSummaryData();
    const output = formatPostRunSummary(data);

    expect(output).toContain("Session Complete: bug-fixes-round-1");
    expect(output).toContain("Duration: 12m 34s");
  });

  it("shows correct symbols for each status", () => {
    const data = makeSummaryData();
    const output = formatPostRunSummary(data);

    // Success: ✓
    expect(output).toContain("\u2713 #96");
    // Failed: ✗
    expect(output).toContain("\u2717 #97");
    // Skipped: ⊘
    expect(output).toContain("\u2298 #99");
  });

  it("shows PR numbers for successful issues", () => {
    const data = makeSummaryData();
    const output = formatPostRunSummary(data);

    expect(output).toContain("PR #101");
    expect(output).toContain("PR #102");
  });

  it("shows error messages for failed issues", () => {
    const data = makeSummaryData();
    const output = formatPostRunSummary(data);

    expect(output).toContain("test failures after 3 retries");
  });

  it("shows user skipped for skipped issues", () => {
    const data = makeSummaryData();
    const output = formatPostRunSummary(data);

    expect(output).toContain("SKIPPED");
    expect(output).toContain("user skipped");
  });
});

describe("generateQAChecklist", () => {
  it("generates checklist entries only for successful issues with PRs", () => {
    const issues: IssueResultEntry[] = [
      { number: 96, title: "Create event", status: "success", prNumber: 101, duration: 252000 },
      { number: 97, title: "View event", status: "failed", duration: 320000 },
      { number: 98, title: "Edit event", status: "success", prNumber: 102, duration: 182000 },
    ];

    const issueMap = new Map<number, GitHubIssue>();
    issueMap.set(96, makeIssue({ number: 96, title: "Create event", body: "Create events" }));
    issueMap.set(97, makeIssue({ number: 97, title: "View event" }));
    issueMap.set(98, makeIssue({ number: 98, title: "Edit event", body: "Edit events" }));

    const entries = generateQAChecklist(issues, issueMap);

    expect(entries).toHaveLength(2);
    expect(entries[0].prNumber).toBe(101);
    expect(entries[1].prNumber).toBe(102);
  });

  it("extracts checklist items from acceptance criteria", () => {
    const body = `## Description
Some description

## Acceptance Criteria
- [ ] User can create events
- [ ] Events appear in the list
- [x] Validation errors shown
`;

    const issueMap = new Map<number, GitHubIssue>();
    issueMap.set(96, makeIssue({ number: 96, body }));

    const issues: IssueResultEntry[] = [
      { number: 96, title: "Create event", status: "success", prNumber: 101, duration: 252000 },
    ];

    const entries = generateQAChecklist(issues, issueMap);

    expect(entries[0].checklistItems).toEqual([
      "User can create events",
      "Events appear in the list",
      "Validation errors shown",
    ]);
  });

  it("generates fallback checklist when no acceptance criteria", () => {
    const issueMap = new Map<number, GitHubIssue>();
    issueMap.set(96, makeIssue({ number: 96, body: "Just a description" }));

    const issues: IssueResultEntry[] = [
      { number: 96, title: "Create event", status: "success", prNumber: 101, duration: 252000 },
    ];

    const entries = generateQAChecklist(issues, issueMap);

    expect(entries[0].checklistItems).toHaveLength(2);
    expect(entries[0].checklistItems[0]).toContain("Create event");
    expect(entries[0].checklistItems[1]).toContain("regressions");
  });
});

describe("formatQAChecklist", () => {
  it("returns empty string for no entries", () => {
    expect(formatQAChecklist([])).toBe("");
  });

  it("formats entries with PR numbers and checklist items", () => {
    const entries: QAChecklistEntry[] = [
      {
        prNumber: 101,
        issueTitle: "Create event",
        changedFiles: "src/routes/events.ts, tests/api/events.test.ts (+84 -12)",
        checklistItems: [
          "Navigate to /events/new",
          "Fill in the form",
        ],
      },
    ];

    const output = formatQAChecklist(entries);

    expect(output).toContain("QA Checklist");
    expect(output).toContain("PR #101");
    expect(output).toContain("Create event");
    expect(output).toContain("src/routes/events.ts");
    expect(output).toContain("\u25A1 Navigate to /events/new");
    expect(output).toContain("\u25A1 Fill in the form");
  });
});

describe("buildSessionYaml", () => {
  it("builds correct YAML structure", () => {
    const data = makeSummaryData();
    const yaml = buildSessionYaml(data);

    expect(yaml.name).toBe("bug-fixes-round-1");
    expect(yaml.repo).toBe("bradtaylorsf/aging-sidekick");
    expect(yaml.started).toBe("2026-03-29T14:30:00Z");
    expect(yaml.completed).toBe("2026-03-29T14:42:34Z");
    expect(yaml.duration).toBe(754);
    expect(yaml.model).toBe("opus");
    expect(yaml.merge_strategy).toBe("session-branch");
  });

  it("includes issue results with correct fields", () => {
    const data = makeSummaryData();
    const yaml = buildSessionYaml(data);
    const issues = yaml.issues as Record<string, unknown>[];

    expect(issues).toHaveLength(4);

    // Success with PR
    expect(issues[0]).toEqual(expect.objectContaining({
      number: 96,
      status: "success",
      pr_url: "https://github.com/bradtaylorsf/aging-sidekick/pull/101",
      duration: 252,
    }));

    // Failed with error
    expect(issues[1]).toEqual(expect.objectContaining({
      number: 97,
      status: "failed",
      error: "test failures after 3 retries",
      duration: 320,
    }));

    // Skipped
    expect(issues[3]).toEqual(expect.objectContaining({
      number: 99,
      status: "skipped",
      duration: 0,
    }));
  });
});

describe("saveSessionFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  it("creates session directory and files", () => {
    const data = makeSummaryData();
    const qaText = "## QA\n- Check things";

    const { sessionDir, sessionYamlPath, qaChecklistPath } = saveSessionFiles(data, qaText, tmpDir);

    expect(existsSync(sessionDir)).toBe(true);
    expect(existsSync(sessionYamlPath)).toBe(true);
    expect(existsSync(qaChecklistPath)).toBe(true);
  });

  it("writes valid YAML to session.yaml", () => {
    const data = makeSummaryData();
    const { sessionYamlPath } = saveSessionFiles(data, "", tmpDir);

    const content = readFileSync(sessionYamlPath, "utf-8");
    const parsed = parse(content);

    expect(parsed.name).toBe("bug-fixes-round-1");
    expect(parsed.repo).toBe("bradtaylorsf/aging-sidekick");
    expect(parsed.issues).toHaveLength(4);
    expect(parsed.issues[0].number).toBe(96);
    expect(parsed.issues[0].status).toBe("success");
    expect(parsed.issues[0].pr_url).toContain("/pull/101");
  });

  it("writes QA checklist to qa-checklist.md", () => {
    const data = makeSummaryData();
    const qaText = "PR #101 - Check things\n- [ ] Test it";

    const { qaChecklistPath } = saveSessionFiles(data, qaText, tmpDir);

    const content = readFileSync(qaChecklistPath, "utf-8");
    expect(content).toContain("QA Checklist");
    expect(content).toContain("bug-fixes-round-1");
    expect(content).toContain("PR #101 - Check things");
  });

  it("creates nested session directories", () => {
    const data = makeSummaryData({ sessionName: "deep/nested/session" });
    const { sessionDir } = saveSessionFiles(data, "", tmpDir);

    expect(existsSync(sessionDir)).toBe(true);
    expect(sessionDir).toContain("deep/nested/session");
  });
});

describe("formatPostRunOptions", () => {
  it("shows all options when PRs and failures exist", () => {
    const issues: IssueResultEntry[] = [
      { number: 96, title: "Create", status: "success", prNumber: 101, prUrl: "https://github.com/o/r/pull/101", duration: 1000 },
      { number: 97, title: "View", status: "failed", error: "test fail", duration: 2000 },
    ];

    const output = formatPostRunOptions(issues);

    expect(output).toContain("[1] Open PRs in browser");
    expect(output).toContain("[2] Retry failed issues (#97)");
    expect(output).toContain("[3] View full session log");
    expect(output).toContain("[4] Done");
  });

  it("hides PR option when no PRs", () => {
    const issues: IssueResultEntry[] = [
      { number: 97, title: "View", status: "failed", error: "test fail", duration: 2000 },
    ];

    const output = formatPostRunOptions(issues);

    expect(output).not.toContain("[1] Open PRs");
    expect(output).toContain("[2] Retry failed issues");
    expect(output).toContain("[3] View full session log");
    expect(output).toContain("[4] Done");
  });

  it("hides retry option when no failures", () => {
    const issues: IssueResultEntry[] = [
      { number: 96, title: "Create", status: "success", prNumber: 101, prUrl: "https://github.com/o/r/pull/101", duration: 1000 },
    ];

    const output = formatPostRunOptions(issues);

    expect(output).toContain("[1] Open PRs");
    expect(output).not.toContain("[2] Retry");
    expect(output).toContain("[3] View full session log");
    expect(output).toContain("[4] Done");
  });
});

describe("openPRsInBrowser", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens each PR URL with platform-appropriate command", () => {
    const issues: IssueResultEntry[] = [
      { number: 96, title: "Create", status: "success", prUrl: "https://github.com/o/r/pull/101", duration: 1000 },
      { number: 97, title: "View", status: "failed", duration: 2000 },
      { number: 98, title: "Edit", status: "success", prUrl: "https://github.com/o/r/pull/102", duration: 1500 },
    ];

    openPRsInBrowser(issues);

    const mockExec = execSync as jest.MockedFunction<typeof execSync>;
    // Should only open PRs for issues with prUrl
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("https://github.com/o/r/pull/101"),
      expect.any(Object),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("https://github.com/o/r/pull/102"),
      expect.any(Object),
    );
  });

  it("handles exec failures gracefully", () => {
    (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(() => {
      throw new Error("no browser");
    });

    const issues: IssueResultEntry[] = [
      { number: 96, title: "Create", status: "success", prUrl: "https://github.com/o/r/pull/101", duration: 1000 },
    ];

    // Should not throw
    expect(() => openPRsInBrowser(issues)).not.toThrow();
  });
});

describe("retry option returns failed issue numbers", () => {
  it("formatPostRunOptions lists failed issue numbers", () => {
    const issues: IssueResultEntry[] = [
      { number: 42, title: "Foo", status: "failed", error: "test fail", duration: 1000 },
      { number: 43, title: "Bar", status: "failed", error: "build fail", duration: 2000 },
    ];

    const output = formatPostRunOptions(issues);
    expect(output).toContain("#42");
    expect(output).toContain("#43");
  });
});
