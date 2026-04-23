/**
 * Agent Spawn Module
 * ==================
 *
 * Handles spawning different AI CLI agents (Claude, Codex, OpenCode, LM Studio, Ollama)
 * with the correct CLI flags per agent type.
 *
 * lmstudio and ollama piggy-back on existing CLIs: lmstudio uses the `claude`
 * CLI pointed at an Anthropic-compatible local endpoint, ollama uses the
 * `codex` CLI pointed at an OpenAI-compatible local endpoint. Endpoint
 * selection is done via env vars (see `buildEndpointEnv`).
 *
 * Adding a new agent: add a case to AGENT_CLI_MAP and buildAgentArgs().
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { RoutingEndpoint } from '../lib/config.js';

/** Minimal config needed to build agent CLI args. */
export type AgentConfig = {
  agent: string;
  model: string;
  maxTurns?: number;
};

// ============================================================================
// Agent CLI Mapping
// ============================================================================

export type AgentCliDef = {
  command: string;
  promptFlag: string;
  modelFlag: string;
  permissionFlag?: string;
  supportsMaxTurns: boolean;
  maxTurnsFlag?: string;
  /** True when promptFlag is a subcommand (codex 'exec', opencode 'run') rather than a flag like '-p'. */
  isSubcommand: boolean;
};

/**
 * CLI reference for each supported agent.
 * Extend this map to add new agent types.
 */
export const AGENT_CLI_MAP: Record<string, AgentCliDef> = {
  claude: {
    command: 'claude',
    promptFlag: '-p',
    modelFlag: '--model',
    permissionFlag: '--dangerously-skip-permissions',
    supportsMaxTurns: true,
    maxTurnsFlag: '--max-turns',
    isSubcommand: false,
  },
  codex: {
    command: 'codex',
    promptFlag: 'exec',
    modelFlag: '--model',
    permissionFlag: '--full-auto',
    supportsMaxTurns: false,
    isSubcommand: true,
  },
  opencode: {
    command: 'opencode',
    promptFlag: 'run',
    modelFlag: '--model',
    supportsMaxTurns: false,
    isSubcommand: true,
  },
  // lmstudio: LM Studio 0.4.1+ exposes an Anthropic-compatible /v1/messages
  // endpoint, so we invoke the `claude` CLI and point it at the local server
  // via ANTHROPIC_BASE_URL / ANTHROPIC_MODEL (see buildEndpointEnv).
  lmstudio: {
    command: 'claude',
    promptFlag: '-p',
    modelFlag: '--model',
    permissionFlag: '--dangerously-skip-permissions',
    supportsMaxTurns: true,
    maxTurnsFlag: '--max-turns',
    isSubcommand: false,
  },
  // ollama: Ollama exposes an OpenAI-compatible /v1/chat/completions endpoint,
  // so we invoke the `codex` CLI and point it at the local server via
  // OPENAI_BASE_URL / OPENAI_MODEL (see buildEndpointEnv).
  ollama: {
    command: 'codex',
    promptFlag: 'exec',
    modelFlag: '--model',
    permissionFlag: '--full-auto',
    supportsMaxTurns: false,
    isSubcommand: true,
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

  if (agentDef.isSubcommand) {
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
  if (agentDef.isSubcommand) {
    args.push(prompt);
  } else {
    args.push(agentDef.promptFlag, prompt);
  }

  return { command: agentDef.command, args };
}

// ============================================================================
// Endpoint Env Vars
// ============================================================================

/**
 * Build the env-var overrides needed to point a child CLI at a specific
 * routing endpoint. Anthropic-shaped endpoints (`anthropic`, `anthropic_compat`)
 * set ANTHROPIC_BASE_URL / ANTHROPIC_MODEL; OpenAI-compatible endpoints set
 * OPENAI_BASE_URL / OPENAI_MODEL.
 *
 * Callers MUST compute this per stage and not share envs across stages, so
 * that a frontier stage does not inherit a local endpoint from a prior stage.
 */
export function buildEndpointEnv(endpoint: RoutingEndpoint, model: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!endpoint || !endpoint.base_url) return env;
  switch (endpoint.type) {
    case 'anthropic':
    case 'anthropic_compat':
      env.ANTHROPIC_BASE_URL = endpoint.base_url;
      if (model) env.ANTHROPIC_MODEL = model;
      break;
    case 'openai_compat':
      env.OPENAI_BASE_URL = endpoint.base_url;
      if (model) env.OPENAI_MODEL = model;
      break;
  }
  return env;
}

/** Default base URLs for single-agent lmstudio/ollama mode. */
export const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/**
 * Auto-injected env vars for single-agent `lmstudio` / `ollama` mode, so
 * `agent: lmstudio` actually targets the local server instead of silently
 * hitting the real Anthropic API. Respects pre-existing env vars — users who
 * export `ANTHROPIC_BASE_URL` themselves keep full control.
 */
function defaultLocalEnv(agent: string, model: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (agent === 'lmstudio') {
    if (!process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = DEFAULT_LMSTUDIO_BASE_URL;
    if (model && !process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = model;
  } else if (agent === 'ollama') {
    if (!process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = DEFAULT_OLLAMA_BASE_URL;
    if (model && !process.env.OPENAI_MODEL) env.OPENAI_MODEL = model;
  }
  return env;
}

// ============================================================================
// Spawn Agent
// ============================================================================

/**
 * Spawns an agent subprocess with the correct CLI flags.
 * Returns the ChildProcess for the caller to manage (listen to events, pipe stdio, etc.).
 */
export function spawnAgent(
  config: AgentConfig & { model: string },
  prompt: string,
  cwd: string,
  envOverrides?: Record<string, string>,
): ChildProcess {
  const { command, args } = buildAgentArgs(config, prompt);

  // Caller overrides win > agent-default local base URLs > process.env
  const localDefaults = defaultLocalEnv(config.agent, config.model);

  return spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...localDefaults, ...envOverrides },
  });
}
