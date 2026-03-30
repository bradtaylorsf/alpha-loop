/**
 * Prerequisites Module
 * ====================
 *
 * Verifies that all configured AI CLI agents are installed before starting the pipeline.
 * Groups stages by agent for clear diagnostic output.
 */

import { execSync } from 'node:child_process';
import { type Config, type StageName, STAGE_NAMES, resolveStageConfig } from './config.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentCheckResult {
  agent: string;
  installed: boolean;
  stages: StageName[];
}

export interface PrerequisiteResult {
  ok: boolean;
  results: AgentCheckResult[];
}

// ============================================================================
// Agent Check
// ============================================================================

/**
 * Checks whether a CLI command is available on the system PATH.
 */
export function isCommandAvailable(command: string): boolean {
  // Validate command name to prevent shell injection from user-controlled config
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
    return false;
  }
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks all agents configured across pipeline stages.
 * Returns structured results showing which agents are installed and which stages they serve.
 */
export function checkAgents(config: Config): PrerequisiteResult {
  // Collect stages grouped by agent
  const agentStages = new Map<string, StageName[]>();

  for (const stage of STAGE_NAMES) {
    const { agent } = resolveStageConfig(config, stage);
    const stages = agentStages.get(agent) ?? [];
    stages.push(stage);
    agentStages.set(agent, stages);
  }

  // Check each unique agent
  const results: AgentCheckResult[] = [];
  for (const [agent, stages] of agentStages) {
    results.push({
      agent,
      installed: isCommandAvailable(agent),
      stages,
    });
  }

  return {
    ok: results.every(r => r.installed),
    results,
  };
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Formats the prerequisite check results for console output.
 */
export function formatCheckResults(result: PrerequisiteResult): string {
  const lines: string[] = ['Checking agents...'];

  for (const r of result.results) {
    const icon = r.installed ? '\u2713' : '\u2717';
    const stageList = r.stages.join(', ');
    lines.push(`  ${icon} ${r.agent} (${stageList})`);
  }

  if (!result.ok) {
    const missing = result.results.filter(r => !r.installed);
    for (const m of missing) {
      lines.push(`\nError: "${m.agent}" is not installed. Affected stages: ${m.stages.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats the pipeline startup summary showing per-stage configuration.
 */
export function formatPipelineSummary(config: Config): string {
  const lines: string[] = ['Pipeline:'];

  for (const stage of STAGE_NAMES) {
    const sc = resolveStageConfig(config, stage);
    const turns = sc.maxTurns ? ` (${sc.maxTurns} turns)` : '';
    const padded = `${stage}:`.padEnd(14);
    lines.push(`  ${padded}${sc.agent}/${sc.model}${turns}`);
  }

  return lines.join('\n');
}
