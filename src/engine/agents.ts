/**
 * Agent Spawn Module
 * ==================
 *
 * Handles spawning different AI CLI agents (Claude, Codex, OpenCode)
 * with the correct CLI flags per agent type.
 *
 * Adding a new agent: add a case to AGENT_CLI_MAP and buildAgentArgs().
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentConfig } from './config.js';

// ============================================================================
// Agent CLI Mapping
// ============================================================================

/**
 * CLI reference for each supported agent.
 * Extend this map to add new agent types.
 */
export const AGENT_CLI_MAP: Record<string, {
  command: string;
  promptFlag: string;
  modelFlag: string;
  permissionFlag?: string;
  supportsMaxTurns: boolean;
  maxTurnsFlag?: string;
}> = {
  claude: {
    command: 'claude',
    promptFlag: '-p',
    modelFlag: '--model',
    permissionFlag: '--dangerously-skip-permissions',
    supportsMaxTurns: true,
    maxTurnsFlag: '--max-turns',
  },
  codex: {
    command: 'codex',
    promptFlag: '-q',
    modelFlag: '--model',
    permissionFlag: '--auto-edit',
    supportsMaxTurns: false,
  },
  opencode: {
    command: 'opencode',
    promptFlag: 'run',
    modelFlag: '--model',
    supportsMaxTurns: false,
  },
};

// ============================================================================
// Build Agent Args
// ============================================================================

export interface AgentArgs {
  command: string;
  args: string[];
}

/**
 * Constructs the CLI command and arguments for spawning an agent.
 * Throws if the agent type is not recognized.
 */
export function buildAgentArgs(config: AgentConfig & { model: string }, prompt: string): AgentArgs {
  const agentDef = AGENT_CLI_MAP[config.agent];
  if (!agentDef) {
    throw new Error(
      `Unknown agent type: "${config.agent}". Supported agents: ${Object.keys(AGENT_CLI_MAP).join(', ')}`,
    );
  }

  const args: string[] = [];

  // For opencode, "run" is a subcommand, not a flag
  if (config.agent === 'opencode') {
    args.push(agentDef.promptFlag); // 'run'
  }

  // Model flag
  args.push(agentDef.modelFlag, config.model);

  // Permission flag (if agent supports it)
  if (agentDef.permissionFlag) {
    args.push(agentDef.permissionFlag);
  }

  // Max turns (only if agent supports it and value is provided)
  if (config.maxTurns && agentDef.supportsMaxTurns && agentDef.maxTurnsFlag) {
    args.push(agentDef.maxTurnsFlag, String(config.maxTurns));
  }

  // Prompt flag — for claude/codex it's a flag before the prompt text
  if (config.agent !== 'opencode') {
    args.push(agentDef.promptFlag, prompt);
  } else {
    // opencode takes prompt as a positional arg after 'run'
    args.push(prompt);
  }

  return { command: agentDef.command, args };
}

// ============================================================================
// Spawn Agent
// ============================================================================

/**
 * Spawns an agent subprocess with the correct CLI flags.
 * Returns the ChildProcess for the caller to manage (listen to events, pipe stdio, etc.).
 */
export function spawnAgent(config: AgentConfig & { model: string }, prompt: string, cwd: string): ChildProcess {
  const { command, args } = buildAgentArgs(config, prompt);

  return spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}
