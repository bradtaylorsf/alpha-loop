/**
 * Score Tracking — append-only JSONL score history.
 *
 * Scores are appended to .alpha-loop/evals/scores.jsonl with:
 *   timestamp, config hash, per-case results, composite score, cost.
 *
 * Composite score formula (from autoresearch pattern):
 *   score = (passing/total)*100 - 0.1*avg_retries - 0.01*avg_duration
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Result for a single eval case within a score run. */
export type CaseResult = {
  caseId: string;
  passed: boolean;
  partialCredit: number;
  retries: number;
  duration: number;
  error?: string;
};

/** A single score entry in the JSONL history. */
export type ScoreEntry = {
  timestamp: string;
  configHash: string;
  config: Record<string, unknown>;
  cases: CaseResult[];
  composite: number;
  totalCost: number;
};

const SCORES_FILE = 'scores.jsonl';

/** Get the path to the scores JSONL file. */
export function scoresPath(evalsDir: string): string {
  return join(evalsDir, SCORES_FILE);
}

/**
 * Compute the composite score from case results.
 *
 * score = (passing/total)*100 - 0.1*avg_retries - 0.01*avg_duration
 */
export function computeCompositeScore(cases: CaseResult[]): number {
  if (cases.length === 0) return 0;

  const passing = cases.filter((c) => c.passed).length;
  const totalRetries = cases.reduce((sum, c) => sum + c.retries, 0);
  const totalDuration = cases.reduce((sum, c) => sum + c.duration, 0);

  const avgRetries = totalRetries / cases.length;
  const avgDuration = totalDuration / cases.length;

  const score = (passing / cases.length) * 100 - 0.1 * avgRetries - 0.01 * avgDuration;
  return Math.round(score * 100) / 100;
}

/**
 * Hash a config object to create a stable identifier for comparison.
 */
export function hashConfig(config: Record<string, unknown>): string {
  const sorted = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(sorted).digest('hex').slice(0, 12);
}

/**
 * Append a score entry to the JSONL file.
 */
export function appendScore(evalsDir: string, entry: ScoreEntry): void {
  mkdirSync(evalsDir, { recursive: true });
  const filePath = scoresPath(evalsDir);
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

/**
 * Read all score entries from the JSONL file.
 */
export function readScores(evalsDir: string): ScoreEntry[] {
  const filePath = scoresPath(evalsDir);
  if (!existsSync(filePath)) return [];

  const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
  const entries: ScoreEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as ScoreEntry);
    } catch {
      // Skip malformed lines
    }
  }

  return entries;
}

/**
 * Get the most recent score entry.
 */
export function latestScore(evalsDir: string): ScoreEntry | null {
  const scores = readScores(evalsDir);
  return scores.length > 0 ? scores[scores.length - 1] : null;
}

/**
 * Get score history grouped by config hash.
 * Returns configs sorted by best composite score (descending).
 */
export function scoresByConfig(evalsDir: string): Array<{ configHash: string; config: Record<string, unknown>; scores: ScoreEntry[] }> {
  const all = readScores(evalsDir);
  const grouped = new Map<string, { config: Record<string, unknown>; scores: ScoreEntry[] }>();

  for (const entry of all) {
    if (!grouped.has(entry.configHash)) {
      grouped.set(entry.configHash, { config: entry.config, scores: [] });
    }
    grouped.get(entry.configHash)!.scores.push(entry);
  }

  return Array.from(grouped.entries())
    .map(([configHash, data]) => ({ configHash, ...data }))
    .sort((a, b) => {
      const bestA = Math.max(...a.scores.map((s) => s.composite));
      const bestB = Math.max(...b.scores.map((s) => s.composite));
      return bestB - bestA;
    });
}

/**
 * Derive a human-readable label from a config object.
 * Looks for model names across pipeline steps and combines unique short names.
 */
export function deriveConfigLabel(config: Record<string, unknown>): string {
  const models = new Set<string>();

  // Check top-level model
  if (typeof config.model === 'string' && config.model) {
    models.add(shortModelName(config.model));
  }
  if (typeof config.reviewModel === 'string' && config.reviewModel) {
    models.add(shortModelName(config.reviewModel));
  }

  // Check pipeline step models
  if (config.pipeline && typeof config.pipeline === 'object') {
    for (const step of Object.values(config.pipeline as Record<string, unknown>)) {
      if (step && typeof step === 'object') {
        const s = step as Record<string, unknown>;
        if (typeof s.model === 'string' && s.model) {
          models.add(shortModelName(s.model));
        }
      }
    }
  }

  return models.size > 0 ? Array.from(models).join('+') : 'default';
}

/** Shorten a model name for display (e.g. "claude-sonnet-4-6" → "sonnet"). */
function shortModelName(model: string): string {
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('gpt-4o-mini')) return 'gpt4o-mini';
  if (model.includes('gpt-4o')) return 'gpt4o';
  if (model.includes('codex-mini')) return 'codex-mini';
  if (model.includes('deepseek')) return 'deepseek';
  if (model.includes('gemini')) return 'gemini';
  // Last path segment or full name
  const parts = model.split('/');
  return parts[parts.length - 1];
}

/**
 * Compute the Pareto frontier of score vs cost.
 * Returns ParetoEntry[] where no other entry has both higher score AND lower cost.
 */
export function paretoFrontier(evalsDir: string): ParetoEntry[] {
  const all = readScores(evalsDir);
  if (all.length === 0) return [];

  // Sort by composite score descending
  const sorted = [...all].sort((a, b) => b.composite - a.composite);

  const frontier: ParetoEntry[] = [];
  let minCost = Infinity;

  for (const entry of sorted) {
    if (entry.totalCost <= minCost) {
      const efficiency = entry.totalCost > 0 ? entry.composite / entry.totalCost : Infinity;
      const configLabel = deriveConfigLabel(entry.config);
      frontier.push({ ...entry, efficiency, configLabel });
      minCost = entry.totalCost;
    }
  }

  return frontier;
}

/**
 * Build Pareto entries from a pre-loaded array of ScoreEntry (no filesystem).
 */
export function buildParetoFrontier(entries: ScoreEntry[]): ParetoEntry[] {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => b.composite - a.composite);
  const frontier: ParetoEntry[] = [];
  let minCost = Infinity;

  for (const entry of sorted) {
    if (entry.totalCost <= minCost) {
      const efficiency = entry.totalCost > 0 ? entry.composite / entry.totalCost : Infinity;
      const configLabel = deriveConfigLabel(entry.config);
      frontier.push({ ...entry, efficiency, configLabel });
      minCost = entry.totalCost;
    }
  }

  return frontier;
}

/**
 * Format the Pareto frontier as an ASCII score-vs-cost chart.
 * Optionally marks one entry as the current config (★).
 */
export function formatParetoTable(
  frontier: ParetoEntry[],
  currentConfigHash?: string,
): string {
  if (frontier.length === 0) return '  No data on the Pareto frontier.';

  const lines: string[] = [];
  const width = 58;

  lines.push('┌' + '─'.repeat(width) + '┐');
  lines.push('│' + ' Pareto Frontier: Score vs Cost'.padEnd(width) + '│');
  lines.push('│' + ' '.repeat(width) + '│');

  // Find axis bounds
  const maxScore = Math.max(...frontier.map((e) => e.composite));
  const minScore = Math.min(...frontier.map((e) => e.composite));
  const maxCost = Math.max(...frontier.map((e) => e.totalCost));

  // Score axis labels
  const scoreRange = maxScore - minScore;
  const rows = 5;
  for (let i = rows; i >= 0; i--) {
    const scoreVal = minScore + (scoreRange * i) / rows;
    const label = scoreVal.toFixed(0).padStart(5);
    let row = `│ ${label} │`;

    // Plot points on this row
    const rowChars = Array(40).fill(' ');
    for (const entry of frontier) {
      const yPos = scoreRange > 0
        ? Math.round(((entry.composite - minScore) / scoreRange) * rows)
        : Math.round(rows / 2);
      if (yPos === i) {
        const xPos = maxCost > 0
          ? Math.round((entry.totalCost / maxCost) * 39)
          : 20;
        const marker = entry.configHash === currentConfigHash ? '★' : '●';
        rowChars[xPos] = marker;
      }
    }
    row += rowChars.join('');
    row = row.padEnd(width + 1) + '│';
    lines.push(row);
  }

  // X-axis
  const costLabel = `$0${' '.repeat(16)}$${(maxCost / 2).toFixed(0)}${' '.repeat(16)}$${maxCost.toFixed(0)}`;
  lines.push('│       └' + '─'.repeat(40) + '─' + ' '.repeat(width - 42) + '│');
  lines.push('│        ' + costLabel.slice(0, width - 9).padEnd(width - 8) + '│');
  lines.push('│' + ' '.repeat(width) + '│');

  // Legend
  if (currentConfigHash) {
    lines.push('│' + ' ★ = current config    ● = alternatives on frontier'.padEnd(width) + '│');
  }

  // Recommendation: find most efficient entry
  const sorted = [...frontier].sort((a, b) => b.efficiency - a.efficiency);
  const best = sorted[0];
  if (best && frontier.length > 1) {
    const current = frontier.find((e) => e.configHash === currentConfigHash);
    if (current && current.configHash !== best.configHash) {
      const scoreDiff = ((current.composite - best.composite) / current.composite * 100).toFixed(0);
      const costDiff = ((current.totalCost - best.totalCost) / current.totalCost * 100).toFixed(0);
      const rec = ` Recommended: "${best.configLabel}" — ${scoreDiff}% less score, ${costDiff}% cheaper`;
      lines.push('│' + ' '.repeat(width) + '│');
      lines.push('│' + rec.padEnd(width) + '│');
    }
  }

  lines.push('└' + '─'.repeat(width) + '┘');

  // Table of entries
  lines.push('');
  lines.push('  Score    Cost       Efficiency  Config');
  lines.push('  -----    ----       ----------  ------');
  for (const entry of frontier) {
    const marker = entry.configHash === currentConfigHash ? '★' : ' ';
    const score = entry.composite.toFixed(1).padStart(6);
    const cost = `$${entry.totalCost.toFixed(2)}`.padStart(8);
    const eff = entry.efficiency === Infinity ? '     ∞' : entry.efficiency.toFixed(1).padStart(10);
    lines.push(`${marker} ${score}    ${cost}    ${eff}  ${entry.configLabel} (${entry.configHash})`);
  }

  return lines.join('\n');
}

/** A Pareto entry with computed efficiency metric and label. */
export type ParetoEntry = ScoreEntry & {
  /** Efficiency = score / cost_usd. Infinity if cost is 0. */
  efficiency: number;
  /** Human-readable label for the config (e.g. "sonnet+haiku"). */
  configLabel: string;
};

/** Comparison of two eval runs showing per-case changes. */
export type RunComparison = {
  run1: ScoreEntry;
  run2: ScoreEntry;
  scoreDelta: number;
  costDelta: number;
  cases: Array<{
    caseId: string;
    run1Passed: boolean | null;
    run2Passed: boolean | null;
    run1Score: number | null;
    run2Score: number | null;
    delta: number;
  }>;
};

/**
 * Compare two eval runs by index (1-based) or timestamp prefix.
 * Returns per-case deltas and aggregate score/cost changes.
 */
export function compareRuns(evalsDir: string, ref1: string, ref2: string): RunComparison | null {
  const scores = readScores(evalsDir);
  if (scores.length === 0) return null;

  const resolve = (ref: string): ScoreEntry | undefined => {
    // Try as 1-based index
    const idx = parseInt(ref, 10);
    if (!isNaN(idx) && idx >= 1 && idx <= scores.length) {
      return scores[idx - 1];
    }
    // Try as timestamp prefix
    return scores.find((s) => s.timestamp.startsWith(ref));
  };

  const run1 = resolve(ref1);
  const run2 = resolve(ref2);
  if (!run1 || !run2) return null;

  // Build per-case comparison
  const allCaseIds = new Set<string>();
  for (const c of run1.cases) allCaseIds.add(c.caseId);
  for (const c of run2.cases) allCaseIds.add(c.caseId);

  const cases = Array.from(allCaseIds).sort().map((caseId) => {
    const c1 = run1.cases.find((c) => c.caseId === caseId);
    const c2 = run2.cases.find((c) => c.caseId === caseId);
    return {
      caseId,
      run1Passed: c1?.passed ?? null,
      run2Passed: c2?.passed ?? null,
      run1Score: c1?.partialCredit ?? null,
      run2Score: c2?.partialCredit ?? null,
      delta: (c2?.partialCredit ?? 0) - (c1?.partialCredit ?? 0),
    };
  });

  return {
    run1,
    run2,
    scoreDelta: run2.composite - run1.composite,
    costDelta: run2.totalCost - run1.totalCost,
    cases,
  };
}

/**
 * Format a score entry for display.
 */
export function formatScoreEntry(entry: ScoreEntry): string {
  const passing = entry.cases.filter((c) => c.passed).length;
  const total = entry.cases.length;
  const date = entry.timestamp.split('T')[0];
  return `${date}  score=${entry.composite}  pass=${passing}/${total}  cost=$${entry.totalCost.toFixed(2)}  config=${entry.configHash}`;
}
