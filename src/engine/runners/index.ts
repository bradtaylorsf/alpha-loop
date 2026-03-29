import type { AgentRunner } from "../runner.js";
import { createClaudeRunner } from "./claude.js";
import { createCodexRunner } from "./codex.js";

export { createClaudeRunner } from "./claude.js";
export { createCodexRunner, isCodexInstalled } from "./codex.js";

export function createRunnerFromConfig(agentName: string): AgentRunner {
  switch (agentName) {
    case "claude":
      return createClaudeRunner();
    case "codex":
      return createCodexRunner();
    default:
      throw new Error(`Unknown agent: "${agentName}". Supported agents: claude, codex`);
  }
}
