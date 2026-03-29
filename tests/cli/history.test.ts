import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { stringify } from "yaml";
import {
  listSessions,
  getSessionDetail,
  formatSessionList,
  formatSessionDetail,
  readQAChecklist,
  cleanOldSessions,
  formatCleanResults,
} from "../../src/cli/history";

// --- Helpers ---

function createSession(
  baseDir: string,
  name: string,
  opts: {
    started?: string;
    duration?: number;
    repo?: string;
    model?: string;
    issues?: Array<{
      number: number;
      status: string;
      pr_url?: string;
      error?: string;
      duration?: number;
    }>;
    qaContent?: string;
    addLogs?: string[];
  } = {},
): void {
  const sessionDir = join(baseDir, "sessions", name);
  mkdirSync(sessionDir, { recursive: true });

  const yamlData = {
    name,
    repo: opts.repo ?? "owner/repo",
    started: opts.started ?? "2026-03-29T14:30:00Z",
    completed: "2026-03-29T14:42:34Z",
    duration: opts.duration ?? 754,
    model: opts.model ?? "opus",
    merge_strategy: "session-branch",
    issues: opts.issues ?? [
      { number: 96, status: "success", pr_url: "https://github.com/owner/repo/pull/101", duration: 252 },
      { number: 97, status: "failed", error: "test failures", duration: 320 },
    ],
  };

  writeFileSync(join(sessionDir, "session.yaml"), stringify(yamlData), "utf-8");

  const qaContent = opts.qaContent ?? "# QA Checklist\n- [ ] Check things";
  writeFileSync(join(sessionDir, "qa-checklist.md"), qaContent, "utf-8");

  if (opts.addLogs) {
    const logsDir = join(sessionDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    for (const logName of opts.addLogs) {
      writeFileSync(join(logsDir, logName), `Log output for ${logName}\n`, "utf-8");
    }
  }
}

// --- Tests ---

describe("listSessions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-history-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no sessions directory exists", () => {
    const sessions = listSessions(tmpDir);
    expect(sessions).toEqual([]);
  });

  it("returns empty array when sessions directory is empty", () => {
    mkdirSync(join(tmpDir, "sessions"), { recursive: true });
    const sessions = listSessions(tmpDir);
    expect(sessions).toEqual([]);
  });

  it("lists sessions with correct counts", () => {
    createSession(tmpDir, "bug-fixes-round-1", {
      started: "2026-03-29T14:30:00Z",
      duration: 754,
      issues: [
        { number: 96, status: "success", pr_url: "https://github.com/o/r/pull/101", duration: 252 },
        { number: 97, status: "failed", error: "test failures", duration: 320 },
        { number: 98, status: "success", pr_url: "https://github.com/o/r/pull/102", duration: 182 },
      ],
    });

    const sessions = listSessions(tmpDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe("bug-fixes-round-1");
    expect(sessions[0].issueCount).toBe(3);
    expect(sessions[0].successCount).toBe(2);
    expect(sessions[0].failedCount).toBe(1);
    expect(sessions[0].duration).toBe(754);
  });

  it("lists multiple sessions sorted by date descending", () => {
    createSession(tmpDir, "first-session", { started: "2026-03-28T10:00:00Z" });
    createSession(tmpDir, "second-session", { started: "2026-03-30T10:00:00Z" });
    createSession(tmpDir, "third-session", { started: "2026-03-29T10:00:00Z" });

    const sessions = listSessions(tmpDir);

    expect(sessions).toHaveLength(3);
    expect(sessions[0].name).toBe("second-session");
    expect(sessions[1].name).toBe("third-session");
    expect(sessions[2].name).toBe("first-session");
  });

  it("handles nested session directories (session/20260330-091500)", () => {
    createSession(tmpDir, "session/20260330-091500", {
      started: "2026-03-30T09:15:00Z",
    });

    const sessions = listSessions(tmpDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe("session/20260330-091500");
  });
});

describe("getSessionDetail", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-history-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-existent session", () => {
    const detail = getSessionDetail(tmpDir, "nonexistent");
    expect(detail).toBeNull();
  });

  it("returns session detail with all fields", () => {
    createSession(tmpDir, "bug-fixes-round-1", {
      repo: "bradtaylorsf/aging-sidekick",
      model: "opus",
      started: "2026-03-29T14:30:00Z",
      duration: 754,
      issues: [
        { number: 96, status: "success", pr_url: "https://github.com/o/r/pull/101", duration: 252 },
        { number: 97, status: "failed", error: "test failures after 3 retries", duration: 320 },
      ],
    });

    const detail = getSessionDetail(tmpDir, "bug-fixes-round-1");

    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("bug-fixes-round-1");
    expect(detail!.repo).toBe("bradtaylorsf/aging-sidekick");
    expect(detail!.model).toBe("opus");
    expect(detail!.duration).toBe(754);
    expect(detail!.issues).toHaveLength(2);
    expect(detail!.issues[0].status).toBe("success");
    expect(detail!.issues[0].prUrl).toBe("https://github.com/o/r/pull/101");
    expect(detail!.issues[1].status).toBe("failed");
    expect(detail!.issues[1].error).toBe("test failures after 3 retries");
  });

  it("finds sessions by name lookup when direct path fails", () => {
    // Create a nested session
    createSession(tmpDir, "session/20260330-091500", {
      started: "2026-03-30T09:15:00Z",
    });

    const detail = getSessionDetail(tmpDir, "session/20260330-091500");
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("session/20260330-091500");
  });
});

describe("formatSessionList", () => {
  it("returns message when no sessions", () => {
    const output = formatSessionList([]);
    expect(output).toContain("No sessions found");
  });

  it("formats session list with correct symbols", () => {
    const sessions = [
      {
        name: "bug-fixes-round-1",
        date: "2026-03-29T14:30:00Z",
        issueCount: 3,
        successCount: 2,
        failedCount: 1,
        duration: 754,
        dirPath: "/tmp/sessions/bug-fixes-round-1",
      },
    ];

    const output = formatSessionList(sessions);

    expect(output).toContain("Sessions:");
    expect(output).toContain("bug-fixes-round-1");
    expect(output).toContain("2026-03-29");
    expect(output).toContain("3 issues");
    expect(output).toContain("2 \u2713"); // 2 success
    expect(output).toContain("1 \u2717"); // 1 failed
    expect(output).toContain("12m 34s");
  });

  it("uses singular 'issue' for single issue sessions", () => {
    const sessions = [
      {
        name: "quick-fix",
        date: "2026-03-30T09:15:00Z",
        issueCount: 1,
        successCount: 1,
        failedCount: 0,
        duration: 252,
        dirPath: "/tmp/sessions/quick-fix",
      },
    ];

    const output = formatSessionList(sessions);
    expect(output).toContain("1 issue");
  });
});

describe("formatSessionDetail", () => {
  it("formats full session detail", () => {
    const detail = {
      name: "bug-fixes-round-1",
      date: "2026-03-29T14:30:00Z",
      repo: "bradtaylorsf/aging-sidekick",
      model: "opus",
      duration: 754,
      mergeStrategy: "session-branch",
      issues: [
        { number: 96, title: "Create a new event", status: "success" as const, prUrl: "https://github.com/o/r/pull/101", duration: 252 },
        { number: 97, title: "View event details", status: "failed" as const, error: "test failures after 3 retries", duration: 320 },
        { number: 98, title: "Edit an event", status: "success" as const, prUrl: "https://github.com/o/r/pull/102", duration: 182 },
      ],
      qaChecklistPath: "sessions/bug-fixes-round-1/qa-checklist.md",
      logsDir: "sessions/bug-fixes-round-1/logs/",
    };

    const output = formatSessionDetail(detail);

    expect(output).toContain("Session: bug-fixes-round-1");
    expect(output).toContain("Repo:    bradtaylorsf/aging-sidekick");
    expect(output).toContain("Model:   opus");
    expect(output).toContain("12m 34s");
    expect(output).toContain("Issues:");
    expect(output).toContain("\u2713 #96");
    expect(output).toContain("PR #101");
    expect(output).toContain("\u2717 #97");
    expect(output).toContain("FAILED");
    expect(output).toContain("test failures after 3 retries");
    expect(output).toContain("QA Checklist:");
    expect(output).toContain("Logs:");
  });
});

describe("readQAChecklist", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-history-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for non-existent session", () => {
    expect(readQAChecklist(tmpDir, "nonexistent")).toBeNull();
  });

  it("returns QA checklist content", () => {
    createSession(tmpDir, "my-session", {
      qaContent: "# QA\n- [ ] Test the feature\n- [ ] Check regressions",
    });

    const qa = readQAChecklist(tmpDir, "my-session");

    expect(qa).not.toBeNull();
    expect(qa).toContain("Test the feature");
    expect(qa).toContain("Check regressions");
  });
});

describe("cleanOldSessions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-history-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes sessions older than specified days", () => {
    // Create an old session (60 days ago)
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    createSession(tmpDir, "old-session", { started: oldDate });

    // Create a recent session
    createSession(tmpDir, "recent-session", { started: new Date().toISOString() });

    const removed = cleanOldSessions(tmpDir, 30);

    expect(removed).toContain("old-session");
    expect(removed).not.toContain("recent-session");
  });

  it("returns empty array when no old sessions", () => {
    createSession(tmpDir, "recent-session", { started: new Date().toISOString() });

    const removed = cleanOldSessions(tmpDir, 30);
    expect(removed).toEqual([]);
  });

  it("returns empty array when no sessions exist", () => {
    const removed = cleanOldSessions(tmpDir, 30);
    expect(removed).toEqual([]);
  });
});

describe("formatCleanResults", () => {
  it("shows message when no sessions removed", () => {
    const output = formatCleanResults([]);
    expect(output).toContain("No sessions older than 30 days");
  });

  it("lists removed sessions", () => {
    const output = formatCleanResults(["old-session-1", "old-session-2"]);
    expect(output).toContain("Removed 2 session(s)");
    expect(output).toContain("old-session-1");
    expect(output).toContain("old-session-2");
  });
});

describe("session log storage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-history-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("logs are stored in sessions/{name}/logs/ directory", () => {
    createSession(tmpDir, "test-session", {
      addLogs: ["issue-96.log", "issue-97.log"],
    });

    const logsDir = join(tmpDir, "sessions", "test-session", "logs");
    const log96 = readFileSync(join(logsDir, "issue-96.log"), "utf-8");
    const log97 = readFileSync(join(logsDir, "issue-97.log"), "utf-8");

    expect(log96).toContain("issue-96.log");
    expect(log97).toContain("issue-97.log");
  });
});
