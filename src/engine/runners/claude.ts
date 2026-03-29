import type { AgentRunner, RunOptions, RunResult } from "../runner.js";
import { spawnAgent } from "../runner.js";

export function createClaudeRunner(): AgentRunner {
  return {
    name: "claude",
    command: "claude",

    buildArgs(options: RunOptions): string[] {
      const args = ["-p"];

      if (options.model) {
        args.push("--model", options.model);
      }
      if (options.maxTurns !== undefined) {
        args.push("--max-turns", String(options.maxTurns));
      }
      if (options.permissionMode) {
        args.push("--permission-mode", options.permissionMode);
      }

      return args;
    },

    run(options: RunOptions): Promise<RunResult> {
      const args = this.buildArgs(options);
      return spawnAgent(this.command, args, options);
    },
  };
}
