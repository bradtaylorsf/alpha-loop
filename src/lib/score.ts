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
 * Compute the Pareto frontier of score vs cost.
 * Returns entries where no other entry has both higher score AND lower cost.
 */
export function paretoFrontier(evalsDir: string): ScoreEntry[] {
  const all = readScores(evalsDir);
  if (all.length === 0) return [];

  // Sort by composite score descending
  const sorted = [...all].sort((a, b) => b.composite - a.composite);

  const frontier: ScoreEntry[] = [];
  let minCost = Infinity;

  for (const entry of sorted) {
    if (entry.totalCost <= minCost) {
      frontier.push(entry);
      minCost = entry.totalCost;
    }
  }

  return frontier;
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
