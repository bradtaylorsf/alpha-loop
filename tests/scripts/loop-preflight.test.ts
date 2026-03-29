import { execSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT_PATH = join(__dirname, "../../scripts/loop.sh");

/**
 * Source loop.sh functions into a temp script, stripping main/trap/apply_config calls,
 * then run the given bash expression.
 */
function sourceAndRun(
  dir: string,
  expr: string,
  opts: { env?: Record<string, string> } = {},
): string {
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
      "source " + JSON.stringify(filtered),
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
      env: { ...process.env, ...opts.env },
    }).trim();
  } finally {
    try {
      rmSync(filtered, { force: true });
      rmSync(helper, { force: true });
    } catch {}
  }
}

function sourceAndRunWithExit(
  dir: string,
  expr: string,
  opts: { env?: Record<string, string> } = {},
): { stdout: string; exitCode: number } {
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
      "source " + JSON.stringify(filtered),
      expr,
    ].join("\n"),
    { mode: 0o755 },
  );

  try {
    const stdout = execSync("bash " + JSON.stringify(helper), {
      encoding: "utf-8",
      cwd: dir,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    }).trim();
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: ((err.stdout || "") + (err.stderr || "")).trim(),
      exitCode: err.status ?? 1,
    };
  } finally {
    try {
      rmSync(filtered, { force: true });
      rmSync(helper, { force: true });
    } catch {}
  }
}

function makeTempGitRepo(name: string, remote: string): string {
  const dir = join(
    tmpdir(),
    name + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
  );
  mkdirSync(dir, { recursive: true });
  execSync("git init && git remote add origin " + JSON.stringify(remote), {
    cwd: dir,
    stdio: "pipe",
  });
  return dir;
}

describe("run_preflight()", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempGitRepo("preflight", "https://github.com/test/repo.git");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips when --skip-preflight is set", () => {
    const result = sourceAndRun(dir, 'SKIP_PREFLIGHT="true"; run_preflight');
    expect(result).toContain("Skipping pre-flight tests (--skip-preflight)");
  });

  it("skips when SKIP_TESTS is true", () => {
    const result = sourceAndRun(dir, 'SKIP_TESTS="true"; run_preflight');
    expect(result).toContain("Skipping pre-flight tests (SKIP_TESTS=true)");
  });

  it("skips in dry run mode", () => {
    const result = sourceAndRun(dir, 'DRY_RUN="true"; run_preflight');
    expect(result).toContain("Would run pre-flight test validation");
  });

  it("continues when all tests pass", () => {
    // Create a fake test command that passes
    const fakeTestScript = join(dir, "fake-test.sh");
    writeFileSync(
      fakeTestScript,
      [
        "#!/usr/bin/env bash",
        'echo "PASS tests/unit/example.test.ts"',
        'echo "Tests:  42 passed, 42 total"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = sourceAndRun(
      dir,
      `CONFIG_TEST_COMMAND="bash ${JSON.stringify(fakeTestScript)}"; run_preflight`,
    );
    expect(result).toContain("42 passed, 0 failed");
    expect(result).toContain("Pre-flight tests passed");
  });

  it("shows failing tests when some fail (non-interactive defaults to ignore)", () => {
    // Create a fake test command that fails
    const fakeTestScript = join(dir, "fake-test.sh");
    writeFileSync(
      fakeTestScript,
      [
        "#!/usr/bin/env bash",
        'echo "FAIL tests/api/events.test.ts"',
        'echo "  ● events > should update event"',
        'echo "  ● events > should delete event"',
        'echo "PASS tests/unit/utils.test.ts"',
        'echo "Tests:  2 failed, 10 passed, 12 total"',
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    // stdin is not a TTY in tests, so it defaults to option 2 (ignore)
    const result = sourceAndRun(
      dir,
      `CONFIG_TEST_COMMAND="bash ${JSON.stringify(fakeTestScript)}"; run_preflight`,
    );
    expect(result).toContain("10 passed");
    expect(result).toContain("2 failed");
    expect(result).toContain("Non-interactive mode");
    expect(result).toContain("ignoring pre-existing failures");
  });

  it("creates preflight ignore file in non-interactive mode", () => {
    const fakeTestScript = join(dir, "fake-test.sh");
    writeFileSync(
      fakeTestScript,
      [
        "#!/usr/bin/env bash",
        'echo "FAIL tests/api/events.test.ts"',
        'echo "  ● events > should update event"',
        'echo "Tests:  1 failed, 5 passed, 6 total"',
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    // Run preflight, then echo the PREFLIGHT_IGNORE_FILE path
    const result = sourceAndRun(
      dir,
      `CONFIG_TEST_COMMAND="bash ${JSON.stringify(fakeTestScript)}"; run_preflight; echo "IGNORE_FILE=$PREFLIGHT_IGNORE_FILE"`,
    );

    // Extract the ignore file path
    const match = result.match(/IGNORE_FILE=(.+)/);
    expect(match).not.toBeNull();
    const ignoreFile = match![1];
    expect(existsSync(ignoreFile)).toBe(true);

    const contents = readFileSync(ignoreFile, "utf-8");
    expect(contents).toContain("● events > should update event");

    // Clean up
    rmSync(ignoreFile, { force: true });
  });

  it("handles skipped tests in output", () => {
    const fakeTestScript = join(dir, "fake-test.sh");
    writeFileSync(
      fakeTestScript,
      [
        "#!/usr/bin/env bash",
        'echo "PASS tests/unit/example.test.ts"',
        'echo "Tests:  2 skipped, 40 passed, 42 total"',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = sourceAndRun(
      dir,
      `CONFIG_TEST_COMMAND="bash ${JSON.stringify(fakeTestScript)}"; run_preflight`,
    );
    expect(result).toContain("40 passed, 0 failed");
    expect(result).toContain("2 skipped");
  });
});

describe("run_tests() with preflight ignore file", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempGitRepo("preflight-ignore", "https://github.com/test/repo.git");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats pre-existing failures as pass when all failures are ignored", () => {
    // Create a preflight ignore file with known failures
    const ignoreFile = join(dir, "preflight-ignore.txt");
    writeFileSync(ignoreFile, "● events > should update event\n");

    // Create a fake log file with matching failure
    const logFile = join(dir, "test.log");
    writeFileSync(logFile, "  ● events > should update event\n");

    // Create a fake worktree dir
    const worktree = join(dir, "worktree");
    mkdirSync(worktree, { recursive: true });

    // Create fake pnpm in PATH that fails with the known failure
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "pnpm"),
      [
        "#!/usr/bin/env bash",
        'echo "  ● events > should update event"',
        'echo "Tests:  1 failed, 5 passed, 6 total"',
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = sourceAndRun(
      dir,
      `PREFLIGHT_IGNORE_FILE=${JSON.stringify(ignoreFile)}; SKIP_TESTS="false"; DRY_RUN="false"; RUN_FULL="false"; PATH="${binDir}:$PATH"; run_tests ${JSON.stringify(worktree)} ${JSON.stringify(logFile)}; echo "EXIT=$?"`,
    );

    expect(result).toContain("pre-existing (ignored by preflight)");
  });
});
