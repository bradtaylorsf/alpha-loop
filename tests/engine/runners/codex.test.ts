import { createCodexRunner, isCodexInstalled } from "../../../src/engine/runners/codex";
import { createRunnerFromConfig } from "../../../src/engine/runners/index";
import { createClaudeRunner } from "../../../src/engine/runners/claude";

describe("CodexRunner", () => {
  const runner = createCodexRunner();

  it("has correct name and command", () => {
    expect(runner.name).toBe("codex");
    expect(runner.command).toBe("codex");
  });

  describe("buildArgs", () => {
    it("builds args with just a prompt", () => {
      const args = runner.buildArgs({ prompt: "implement feature X" });
      expect(args).toEqual(["implement feature X"]);
    });

    it("includes model flag", () => {
      const args = runner.buildArgs({ prompt: "hello", model: "o3" });
      expect(args).toEqual(["--model", "o3", "hello"]);
    });

    it("includes --full-auto for full permission mode", () => {
      const args = runner.buildArgs({ prompt: "hello", permissionMode: "full" });
      expect(args).toEqual(["--full-auto", "hello"]);
    });

    it("includes --full-auto for acceptEdits permission mode", () => {
      const args = runner.buildArgs({ prompt: "hello", permissionMode: "acceptEdits" });
      expect(args).toEqual(["--full-auto", "hello"]);
    });

    it("does not include --full-auto for other permission modes", () => {
      const args = runner.buildArgs({ prompt: "hello", permissionMode: "plan" });
      expect(args).toEqual(["hello"]);
    });

    it("includes all flags together", () => {
      const args = runner.buildArgs({
        prompt: "build it",
        model: "o3",
        permissionMode: "full",
      });
      expect(args).toEqual(["--model", "o3", "--full-auto", "build it"]);
    });
  });

  describe("run", () => {
    it("returns graceful failure when codex is not installed", async () => {
      // codex is almost certainly not installed in test environment
      if (isCodexInstalled()) {
        return; // skip if codex happens to be installed
      }

      const result = await runner.run({ prompt: "hello" });
      expect(result.success).toBe(false);
      expect(result.output).toContain("codex CLI is not installed");
      expect(result.exitCode).toBe(1);
      expect(result.duration).toBe(0);
    });
  });
});

describe("isCodexInstalled", () => {
  it("returns a boolean", () => {
    expect(typeof isCodexInstalled()).toBe("boolean");
  });
});

describe("createRunnerFromConfig", () => {
  it("creates a claude runner for agent name 'claude'", () => {
    const runner = createRunnerFromConfig("claude");
    expect(runner.name).toBe("claude");
    expect(runner.command).toBe("claude");
  });

  it("creates a codex runner for agent name 'codex'", () => {
    const runner = createRunnerFromConfig("codex");
    expect(runner.name).toBe("codex");
    expect(runner.command).toBe("codex");
  });

  it("throws for unknown agent name", () => {
    expect(() => createRunnerFromConfig("unknown")).toThrow('Unknown agent: "unknown"');
  });
});

describe("ClaudeRunner (from runners module)", () => {
  const runner = createClaudeRunner();

  it("has correct name and command", () => {
    expect(runner.name).toBe("claude");
    expect(runner.command).toBe("claude");
  });

  it("builds args with model and max-turns", () => {
    const args = runner.buildArgs({
      prompt: "hello",
      model: "sonnet",
      maxTurns: 10,
    });
    expect(args).toEqual(["-p", "--model", "sonnet", "--max-turns", "10"]);
  });
});
