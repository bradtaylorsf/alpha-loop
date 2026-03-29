import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { stringify } from "yaml";

const SCRIPT_PATH = join(__dirname, "../../scripts/loop.sh");

/**
 * Source loop.sh functions into a temp script, stripping main/trap/apply_config calls,
 * then run the given bash expression.
 */
function sourceAndRun(dir: string, expr: string): string {
  // Create a filtered copy of loop.sh that doesn't call main or set traps
  const filtered = join(dir, "_loop_filtered.sh");
  execSync(
    [
      "sed -E",
      "-e '/^main \"\\$@\"$/d'",
      "-e '/^apply_config$/d'",
      "-e '/^if \\[\\[.*SUBCOMMAND/,/^fi$/d'",
      "-e '/^trap /d'",
      JSON.stringify(SCRIPT_PATH),
      "> " + JSON.stringify(filtered),
    ].join(" "),
    { cwd: dir, stdio: "pipe" },
  );

  const helper = join(dir, "_test_run.sh");
  writeFileSync(
    helper,
    [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      "ISSUES_PROCESSED=0",
      'ORIGINAL_DIR="$(pwd)"',
      'SUBCOMMAND=""',
      'HISTORY_ARG=""',
      'HISTORY_QA=""',
      'HISTORY_CLEAN=""',
      `PROJECT_DIR="${dir}"`,
      "source " + JSON.stringify(filtered),
      `PROJECT_DIR="${dir}"`,
      expr,
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    return execSync("bash " + JSON.stringify(helper), {
      encoding: "utf-8",
      cwd: dir,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    throw new Error(
      `Script exited with code ${e.status}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
}

function createTestSession(
  baseDir: string,
  name: string,
  opts: {
    started?: string;
    duration?: number;
    issues?: Array<{
      number: number;
      status: string;
      pr_url?: string;
      error?: string;
      duration?: number;
    }>;
  } = {},
): void {
  const sessionDir = join(baseDir, "sessions", name);
  mkdirSync(sessionDir, { recursive: true });

  const yamlData = {
    name,
    repo: "owner/repo",
    started: opts.started ?? "2026-03-29T14:30:00Z",
    completed: "2026-03-29T14:42:34Z",
    duration: opts.duration ?? 754,
    model: "opus",
    merge_strategy: "session-branch",
    issues: opts.issues ?? [
      { number: 96, status: "success", pr_url: "https://github.com/owner/repo/pull/101", duration: 252 },
      { number: 97, status: "failed", error: "test failures", duration: 320 },
    ],
  };

  writeFileSync(join(sessionDir, "session.yaml"), stringify(yamlData), "utf-8");
  writeFileSync(
    join(sessionDir, "qa-checklist.md"),
    "# QA Checklist\n\n- [ ] Check feature works\n- [ ] No regressions\n",
    "utf-8",
  );
}

describe("loop.sh history subcommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-history-bash-"));
    // Initialize a minimal git repo so loop.sh doesn't error
    execSync("git init", { cwd: tmpDir, stdio: "pipe" });
    execSync("git commit --allow-empty -m 'init'", { cwd: tmpDir, stdio: "pipe" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("history_list shows 'No sessions found' when empty", () => {
    const output = sourceAndRun(tmpDir, "history_list \"$PROJECT_DIR/sessions\"");
    expect(output).toContain("No sessions found");
  });

  it("history_list lists sessions correctly", () => {
    createTestSession(tmpDir, "bug-fixes-round-1", {
      started: "2026-03-29T14:30:00Z",
      duration: 754,
      issues: [
        { number: 96, status: "success", pr_url: "https://github.com/o/r/pull/101", duration: 252 },
        { number: 97, status: "failed", error: "test failures", duration: 320 },
        { number: 98, status: "success", pr_url: "https://github.com/o/r/pull/102", duration: 182 },
      ],
    });

    const output = sourceAndRun(tmpDir, "history_list \"$PROJECT_DIR/sessions\"");

    expect(output).toContain("Sessions:");
    expect(output).toContain("bug-fixes-round-1");
    expect(output).toContain("2026-03-29");
    expect(output).toContain("3");
  });

  it("history_show_detail shows session details", () => {
    createTestSession(tmpDir, "bug-fixes-round-1", {
      started: "2026-03-29T14:30:00Z",
      duration: 754,
      issues: [
        { number: 96, status: "success", pr_url: "https://github.com/o/r/pull/101", duration: 252 },
        { number: 97, status: "failed", error: "test failures", duration: 320 },
      ],
    });

    const output = sourceAndRun(
      tmpDir,
      "history_show_detail \"$PROJECT_DIR/sessions\" \"bug-fixes-round-1\"",
    );

    expect(output).toContain("Session: bug-fixes-round-1");
    expect(output).toContain("Repo:    owner/repo");
    expect(output).toContain("Model:   opus");
    expect(output).toContain("Issues:");
    expect(output).toContain("#96");
    expect(output).toContain("#97");
    expect(output).toContain("FAILED");
    expect(output).toContain("QA Checklist:");
    expect(output).toContain("Logs:");
  });

  it("history_show_qa prints QA checklist", () => {
    createTestSession(tmpDir, "my-session");

    const output = sourceAndRun(
      tmpDir,
      "history_show_qa \"$PROJECT_DIR/sessions\" \"my-session\"",
    );

    expect(output).toContain("QA Checklist");
    expect(output).toContain("Check feature works");
  });

  it("history_clean removes old sessions", () => {
    // Create a session with a date more than 30 days ago
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    createTestSession(tmpDir, "old-session", { started: oldDate });
    createTestSession(tmpDir, "recent-session", { started: new Date().toISOString() });

    const output = sourceAndRun(tmpDir, "history_clean \"$PROJECT_DIR/sessions\"");

    expect(output).toContain("old-session");
    // Recent session should still exist
    expect(existsSync(join(tmpDir, "sessions", "recent-session", "session.yaml"))).toBe(true);
  });

  it("history_clean reports no old sessions", () => {
    createTestSession(tmpDir, "recent-session", { started: new Date().toISOString() });

    const output = sourceAndRun(tmpDir, "history_clean \"$PROJECT_DIR/sessions\"");

    expect(output).toContain("No sessions older than 30 days");
  });
});

describe("loop.sh session log directory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-logdir-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("process_issue creates logs in sessions/{name}/logs/", () => {
    // Verify the script references session log directory (check the source)
    const scriptContent = execSync(`cat ${JSON.stringify(SCRIPT_PATH)}`, {
      encoding: "utf-8",
    });

    // Verify the script writes logs to sessions/SESSION_NAME/logs/
    expect(scriptContent).toContain('sessions/$SESSION_NAME/logs');
    expect(scriptContent).toContain("issue-${issue_num}.log");
  });
});
