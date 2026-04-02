/**
 * Prerequisites Module
 * ====================
 *
 * Verifies that the configured AI CLI agent is installed before starting the pipeline.
 */

import { execSync } from 'node:child_process';
import type { Config } from '../lib/config.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentCheckResult {
  agent: string;
  installed: boolean;
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
 * Checks that the configured agent CLI is installed.
 */
export function checkAgents(config: Config): PrerequisiteResult {
  const result: AgentCheckResult = {
    agent: config.agent,
    installed: isCommandAvailable(config.agent),
  };

  return {
    ok: result.installed,
    results: [result],
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
    lines.push(`  ${icon} ${r.agent}`);
  }

  if (!result.ok) {
    const missing = result.results.filter(r => !r.installed);
    for (const m of missing) {
      lines.push(`\nError: "${m.agent}" is not installed.`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats the pipeline startup summary.
 */
export function formatPipelineSummary(config: Config): string {
  return `Pipeline: ${config.agent}/${config.model}`;
}
