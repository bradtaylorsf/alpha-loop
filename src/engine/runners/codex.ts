import { execSync } from "node:child_process";
import type { AgentRunner, RunOptions, RunResult } from "../runner.js";
import { spawnAgent } from "../runner.js";

export function isCodexInstalled(): boolean {
  try {
    execSync("which codex", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function createCodexRunner(): AgentRunner {
  return {
    name: "codex",
    command: "codex",

    buildArgs(options: RunOptions): string[] {
      const args: string[] = [];

      if (options.model) {
        args.push("--model", options.model);
      }

      // Codex uses --full-auto for non-interactive mode
      if (options.permissionMode === "full" || options.permissionMode === "acceptEdits") {
        args.push("--full-auto");
      }

      // Codex takes the prompt as the last positional argument
      args.push(options.prompt);

      return args;
    },

    async run(options: RunOptions): Promise<RunResult> {
      if (!isCodexInstalled()) {
        return {
          success: false,
          output: "codex CLI is not installed. Install it with: npm install -g @openai/codex",
          exitCode: 1,
          duration: 0,
        };
      }

      const args = this.buildArgs(options);
      // Codex takes the prompt as a positional arg, not via stdin
      return spawnAgent(this.command, args, { ...options, prompt: "" });
    },
  };
}
