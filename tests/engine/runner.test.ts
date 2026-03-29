import { createClaudeRunner, createRunner } from "../../src/engine/runner";
import type { RunOptions } from "../../src/engine/runner";

describe("ClaudeRunner", () => {
  const runner = createClaudeRunner();

  it("has correct name and command", () => {
    expect(runner.name).toBe("claude");
    expect(runner.command).toBe("claude");
  });

  describe("buildArgs", () => {
    it("builds minimal args with just a prompt", () => {
      const args = runner.buildArgs({ prompt: "hello" });
      expect(args).toEqual(["-p"]);
    });

    it("includes model flag", () => {
      const args = runner.buildArgs({ prompt: "hello", model: "sonnet" });
      expect(args).toEqual(["-p", "--model", "sonnet"]);
    });

    it("includes max-turns flag", () => {
      const args = runner.buildArgs({ prompt: "hello", maxTurns: 5 });
      expect(args).toEqual(["-p", "--max-turns", "5"]);
    });

    it("includes permission-mode flag", () => {
      const args = runner.buildArgs({ prompt: "hello", permissionMode: "plan" });
      expect(args).toEqual(["-p", "--permission-mode", "plan"]);
    });

    it("includes all flags together", () => {
      const args = runner.buildArgs({
        prompt: "hello",
        model: "opus",
        maxTurns: 10,
        permissionMode: "full",
      });
      expect(args).toEqual([
        "-p",
        "--model", "opus",
        "--max-turns", "10",
        "--permission-mode", "full",
      ]);
    });
  });
});

describe("createRunner (generic)", () => {
  it("creates a custom agent runner", () => {
    const runner = createRunner({
      name: "codex",
      command: "codex",
      buildArgs: (opts: RunOptions) => ["--prompt", opts.prompt],
    });

    expect(runner.name).toBe("codex");
    expect(runner.command).toBe("codex");
    expect(runner.buildArgs({ prompt: "test" })).toEqual(["--prompt", "test"]);
  });
});

describe("Runner process handling", () => {
  it("returns success and output for a passing command", async () => {
    const runner = createRunner({
      name: "echo",
      command: "echo",
      buildArgs: (opts: RunOptions) => [opts.prompt],
    });

    const result = await runner.run({ prompt: "hello world" });
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("returns failure for a non-zero exit code", async () => {
    const runner = createRunner({
      name: "false",
      command: "false",
      buildArgs: () => [],
    });

    const result = await runner.run({ prompt: "" });
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it("returns failure for a command that does not exist", async () => {
    const runner = createRunner({
      name: "nonexistent",
      command: "definitely-not-a-real-command-abc123",
      buildArgs: () => [],
    });

    const result = await runner.run({ prompt: "" });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("respects the cwd parameter", async () => {
    const runner = createRunner({
      name: "pwd",
      command: "pwd",
      buildArgs: () => [],
    });

    const result = await runner.run({ prompt: "", cwd: "/tmp" });
    expect(result.success).toBe(true);
    // /tmp may resolve to /private/tmp on macOS
    expect(["/tmp", "/private/tmp"]).toContain(result.output.trim());
  });

  it("streams output to a log file", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const logFile = path.join(os.tmpdir(), `runner-test-${Date.now()}.log`);

    const runner = createRunner({
      name: "echo",
      command: "echo",
      buildArgs: (opts: RunOptions) => [opts.prompt],
    });

    await runner.run({ prompt: "log test", logFile });

    const content = fs.readFileSync(logFile, "utf-8");
    expect(content).toContain("log test");

    fs.unlinkSync(logFile);
  });
});

describe("Integration: claude --help", () => {
  const skipReason = process.env.TEST_INTEGRATION
    ? undefined
    : "set TEST_INTEGRATION=1 to run";
  const maybeIt = skipReason ? it.skip : it;

  maybeIt("can invoke claude -p --help", async () => {
    const runner = createClaudeRunner();
    const result = await runner.run({ prompt: "--help" });
    // claude -p --help should either succeed or print usage info
    // The exact behavior depends on claude CLI version, so we just check it ran
    expect(typeof result.output).toBe("string");
    expect(typeof result.exitCode).toBe("number");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  }, 15000);
});
