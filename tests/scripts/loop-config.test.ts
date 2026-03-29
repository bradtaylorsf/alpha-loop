import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT_PATH = join(__dirname, "../../scripts/loop.sh");

/**
 * Source loop.sh functions into a temp script, stripping main/trap/apply_config calls,
 * then run the given bash expression.
 */
function sourceAndRun(dir: string, expr: string): string {
  // Create a filtered copy of loop.sh that doesn't call main or set traps
  const filtered = join(dir, "_loop_filtered.sh");
  // Strip: main "$@", standalone apply_config, init subcommand block, trap lines
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
    }).trim();
  } finally {
    try {
      rmSync(filtered, { force: true });
      rmSync(helper, { force: true });
    } catch {}
  }
}

function runLoopSh(
  args: string,
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync("bash " + JSON.stringify(SCRIPT_PATH) + " " + args, {
      encoding: "utf-8",
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: ((err.stdout || "") + (err.stderr || "")).trim(),
      exitCode: err.status ?? 1,
    };
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

describe("detect_repo()", () => {
  it("detects repo from HTTPS remote", () => {
    const dir = makeTempGitRepo("https", "https://github.com/testowner/testrepo.git");
    try {
      const result = sourceAndRun(dir, "detect_repo");
      expect(result).toBe("testowner/testrepo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects repo from SSH remote", () => {
    const dir = makeTempGitRepo("ssh", "git@github.com:sshowner/sshrepo.git");
    try {
      const result = sourceAndRun(dir, "detect_repo");
      expect(result).toBe("sshowner/sshrepo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles HTTPS remote without .git suffix", () => {
    const dir = makeTempGitRepo("nogit", "https://github.com/owner/repo");
    try {
      const result = sourceAndRun(dir, "detect_repo");
      expect(result).toBe("owner/repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("load_config()", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempGitRepo("config", "https://github.com/default/repo.git");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads repo from .alpha-loop.yaml", () => {
    writeFileSync(join(dir, ".alpha-loop.yaml"), "repo: configowner/configrepo\nmodel: opus\n");
    const result = sourceAndRun(dir, 'load_config ".alpha-loop.yaml" && echo "$CONFIG_REPO"');
    expect(result).toBe("configowner/configrepo");
  });

  it("loads all config fields", () => {
    writeFileSync(
      join(dir, ".alpha-loop.yaml"),
      [
        "repo: myowner/myrepo",
        "project: 5",
        "model: opus",
        "review_model: opus",
        "max_turns: 50",
        "label: todo",
        "merge_strategy: session",
        "test_command: pnpm test",
        "dev_command: pnpm dev",
      ].join("\n") + "\n",
    );
    const result = sourceAndRun(
      dir,
      'load_config ".alpha-loop.yaml" && echo "$CONFIG_REPO|$CONFIG_PROJECT|$CONFIG_MODEL|$CONFIG_REVIEW_MODEL|$CONFIG_MAX_TURNS|$CONFIG_LABEL"',
    );
    expect(result).toBe("myowner/myrepo|5|opus|opus|50|todo");
  });

  it("returns failure when config file does not exist", () => {
    const result = sourceAndRun(
      dir,
      'load_config ".alpha-loop.yaml" && echo "found" || echo "not-found"',
    );
    expect(result).toBe("not-found");
  });

  it("ignores comments and empty lines", () => {
    writeFileSync(
      join(dir, ".alpha-loop.yaml"),
      "# This is a comment\n\nrepo: commented/repo\n# Another comment\nmodel: opus\n",
    );
    const result = sourceAndRun(
      dir,
      'load_config ".alpha-loop.yaml" && echo "$CONFIG_REPO|$CONFIG_MODEL"',
    );
    expect(result).toBe("commented/repo|opus");
  });
});

describe("init subcommand", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempGitRepo("init", "https://github.com/initowner/initrepo.git");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .alpha-loop.yaml with auto-detected repo", () => {
    const { exitCode } = runLoopSh("init", { cwd: dir });
    expect(exitCode).toBe(0);

    const configPath = join(dir, ".alpha-loop.yaml");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    expect(content).toContain("repo: initowner/initrepo");
    expect(content).toContain("model: opus");
    expect(content).toContain("review_model: opus");
    expect(content).toContain("max_turns: 30");
    expect(content).toContain("label: ready");
  });

  it("refuses to overwrite existing .alpha-loop.yaml", () => {
    writeFileSync(join(dir, ".alpha-loop.yaml"), "repo: existing/repo\n");
    const { exitCode, stdout } = runLoopSh("init", { cwd: dir });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("already exists");
  });
});

describe("config priority order", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempGitRepo("priority", "https://github.com/gitowner/gitrepo.git");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("env var REPO takes precedence over .alpha-loop.yaml", () => {
    writeFileSync(join(dir, ".alpha-loop.yaml"), "repo: configowner/configrepo\n");
    const result = sourceAndRun(
      dir,
      'REPO="envowner/envrepo"; apply_config; echo "$REPO"',
    );
    expect(result).toBe("envowner/envrepo");
  });

  it(".alpha-loop.yaml takes precedence over git remote", () => {
    writeFileSync(join(dir, ".alpha-loop.yaml"), "repo: configowner/configrepo\n");
    const result = sourceAndRun(dir, 'apply_config; echo "$REPO"');
    expect(result).toBe("configowner/configrepo");
  });

  it("git remote is used when no env var or config file", () => {
    const result = sourceAndRun(dir, 'apply_config; echo "$REPO"');
    expect(result).toBe("gitowner/gitrepo");
  });
});
