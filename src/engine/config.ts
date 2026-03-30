/**
 * Configuration Module
 * ====================
 *
 * Loads and validates .alpha-loop.yaml with per-stage agent/model configuration.
 * Uses Zod for schema validation with sensible defaults.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

// ============================================================================
// Constants
// ============================================================================

export const STAGE_NAMES = ['implement', 'fix', 'review', 'verify', 'learn', 'aggregate'] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export const DEFAULT_AGENT = 'claude';
export const DEFAULT_MODEL = 'opus';

// ============================================================================
// Schemas
// ============================================================================

export const AgentConfigSchema = z.object({
  agent: z.string().default(DEFAULT_AGENT),
  model: z.string().optional(),
  maxTurns: z.number().optional(),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

const StagesSchema = z.object({
  implement: AgentConfigSchema.optional(),
  fix: AgentConfigSchema.optional(),
  review: AgentConfigSchema.optional(),
  verify: AgentConfigSchema.optional(),
  learn: AgentConfigSchema.optional(),
  aggregate: AgentConfigSchema.optional(),
}).strict().optional().default({});

export const ConfigSchema = z.object({
  repo: z.string(),
  project: z.number().optional(),
  model: z.string().default(DEFAULT_MODEL),
  review_model: z.string().optional(),
  max_turns: z.number().optional(),
  label: z.string().default('ready'),
  base_branch: z.string().default('master'),
  test_command: z.string().default('pnpm test'),
  poll_interval: z.number().default(60),
  stages: StagesSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

// ============================================================================
// Config Loading
// ============================================================================

export function loadConfig(cwd: string): Config {
  const configPath = resolve(cwd, '.alpha-loop.yaml');
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw);
  return ConfigSchema.parse(parsed);
}

// ============================================================================
// Stage Config Resolution
// ============================================================================

/**
 * Resolves the agent configuration for a given pipeline stage.
 * Merges stage-specific config with global defaults:
 *   - agent: stage.agent → 'claude'
 *   - model: stage.model → config.model → 'opus'
 *   - maxTurns: stage.maxTurns → config.max_turns → undefined
 */
export function resolveStageConfig(config: Config, stage: StageName): Required<Pick<AgentConfig, 'agent' | 'model'>> & Pick<AgentConfig, 'maxTurns'> {
  const stageConfig = config.stages[stage];

  return {
    agent: stageConfig?.agent ?? DEFAULT_AGENT,
    model: stageConfig?.model ?? config.model ?? DEFAULT_MODEL,
    maxTurns: stageConfig?.maxTurns ?? config.max_turns,
  };
}
