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

/** Minimal config needed to build agent CLI args. */
export type AgentConfig = {
  agent: string;
  model: string;
  maxTurns?: number;
};

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
    promptFlag: 'exec',
    modelFlag: '--model',
    permissionFlag: '--full-auto',
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

  // For agents that use subcommands (codex 'exec', opencode 'run'), add it first
  const isSubcommand = config.agent === 'codex' || config.agent === 'opencode';
  if (isSubcommand) {
    args.push(agentDef.promptFlag);
  }

  // Model flag (skip if empty — let agent CLI use its default)
  if (config.model) {
    args.push(agentDef.modelFlag, config.model);
  }

  // Permission flag (if agent supports it)
  if (agentDef.permissionFlag) {
    args.push(agentDef.permissionFlag);
  }

  // Max turns (only if agent supports it and value is provided)
  if (config.maxTurns != null && agentDef.supportsMaxTurns && agentDef.maxTurnsFlag) {
    args.push(agentDef.maxTurnsFlag, String(config.maxTurns));
  }

  // Prompt: subcommand agents take it as positional arg; flag agents use promptFlag
  if (isSubcommand) {
    args.push(prompt);
  } else {
    args.push(agentDef.promptFlag, prompt);
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
