/**
 * Trace Storage — Meta-Harness style full execution traces per run.
 *
 * Stores raw prompts, agent outputs, diffs, test output, verify output,
 * and pipeline metadata as separate files in a navigable filesystem:
 *   .alpha-loop/traces/{run}/
 *     manifest.json, config.snapshot.yaml, scores.json, costs.json
 *     prompts/issue-{N}-{step}.md
 *     outputs/issue-{N}-{step}.log
 *     diffs/issue-{N}-{step}.patch
 *     tests/issue-{N}-test-{attempt}.txt
 *     verify/issue-{N}-verify-{attempt}.txt
 *     {issueNum}/metadata.json  (backward compat)
 *
 * Key insight from Meta-Harness (Lee et al., 2026): full trace access
 * outperforms summaries by 15+ points. We store everything raw.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';
import { computeCompositeScore } from './score.js';
import type { CaseResult } from './score.js';
import type { PipelineRecoveryMode } from './pipeline.js';

/** Known trace file names within an issue trace directory (backward compat). */
export type TraceFile =
  | 'agent-output.txt'
  | 'diff.patch'
  | 'test-output.txt'
  | 'review-output.json'
  | 'verify-output.json'
  | 'plan.json'
  | 'metadata.json';

/** Pipeline metadata stored alongside traces. */
export type TraceMetadata = {
  issueNum: number;
  title: string;
  status: 'success' | 'failure';
  recoveryMode?: PipelineRecoveryMode;
  failureReason?: 'transient' | 'permanent';
  duration: number;
  retries: number;
  testsPassing: boolean;
  verifyPassing: boolean;
  verifySkipped: boolean;
  filesChanged: number;
  prUrl?: string;
  timestamp: string;
  agent: string;
  model: string;
  batchMode?: boolean;
  batchSize?: number;
};

/** A complete trace for one issue run. */
export type Trace = {
  session: string;
  issueNum: number;
  dir: string;
  metadata: TraceMetadata;
};

/** Run-level manifest with metadata about the entire run. */
export type RunManifest = {
  runId: string;
  startedAt: string;
  completedAt: string;
  issues: number[];
  config: {
    agent: string;
    model: string;
    reviewModel: string;
    testCommand: string;
    baseBranch: string;
  };
  gitState: {
    branch: string;
    commit: string;
  };
  totalDuration: number;
};

/** Per-issue score in scores.json. */
export type IssueScore = {
  status: 'success' | 'failure';
  recovery_mode?: PipelineRecoveryMode;
  scored?: boolean;
  tests_passed: boolean;
  verify_passed: boolean;
  retries: number;
  duration_seconds: number;
  files_changed: number;
  steps_completed: string[];
};

/** Run-level scores.json format. */
export type ScoresJson = {
  composite_score: number;
  issues: Record<string, IssueScore>;
  aggregate: {
    pass_rate: number;
    avg_retries: number;
    avg_duration: number;
    total_issues: number;
    scored_issues?: number;
    recovered_issues?: number;
    issues_passed: number;
  };
};

/** Per-step cost entry. */
export type StepCost = {
  step: string;
  issueNum: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  token_source?: 'reported' | 'estimated';
  cost_source?: 'reported' | 'priced' | 'unmeasured';
};

/** Run-level costs.json format. */
export type CostsJson = {
  total_cost_usd: number | null;
  by_step: Record<string, {
    model: string;
    /** Sum of measured token counts only; null when none were measured. */
    input_tokens: number | null;
    output_tokens: number | null;
    token_measurement_entries: number;
    entries: number;
    cost_usd: number | null;
  }>;
  by_issue: Record<string, { cost_usd: number | null }>;
};

/** Pipeline result used to compute scores. */
export type PipelineResultForScores = {
  issueNum: number;
  status: 'success' | 'failure';
  recoveryMode?: PipelineRecoveryMode;
  testsPassing: boolean;
  verifyPassing: boolean;
  verifySkipped: boolean;
  retries: number;
  duration: number;
  filesChanged: number;
  stepsCompleted: string[];
};

const TRACES_ROOT = '.alpha-loop/traces';

/** Get the base traces directory. */
export function tracesDir(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), TRACES_ROOT);
}

/** Get the run directory for a session. */
export function runDir(session: string, projectDir?: string): string {
  return join(tracesDir(projectDir), session.replace(/\//g, '-'));
}

/** Get the directory for a specific issue trace within a session. */
export function traceDir(session: string, issueNum: number, projectDir?: string): string {
  return join(runDir(session, projectDir), String(issueNum));
}

/**
 * Write a trace file for an issue.
 * Creates the directory structure if it doesn't exist.
 */
export function writeTrace(
  session: string,
  issueNum: number,
  file: TraceFile,
  content: string,
  projectDir?: string,
): void {
  const dir = traceDir(session, issueNum, projectDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, file);
  writeFileSync(filePath, content);
  log.info(`Trace written: ${filePath}`);
}

/**
 * Write trace metadata for an issue.
 */
export function writeTraceMetadata(
  session: string,
  issueNum: number,
  metadata: TraceMetadata,
  projectDir?: string,
): void {
  writeTrace(session, issueNum, 'metadata.json', JSON.stringify(metadata, null, 2) + '\n', projectDir);
}

/**
 * Write a file into a named subdirectory of the run (prompts/, outputs/, diffs/, tests/, verify/).
 */
export function writeTraceToSubdir(
  session: string,
  subdir: string,
  filename: string,
  content: string,
  projectDir?: string,
): void {
  const dir = join(runDir(session, projectDir), subdir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, filename);
  writeFileSync(filePath, content);
  log.info(`Trace written: ${filePath}`);
}

/**
 * Write the run-level manifest.json.
 */
export function writeRunManifest(
  session: string,
  manifest: RunManifest,
  projectDir?: string,
): void {
  const dir = runDir(session, projectDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'manifest.json');
  writeFileSync(filePath, JSON.stringify(manifest, null, 2) + '\n');
  log.info(`Run manifest written: ${filePath}`);
}

/**
 * Write the config snapshot for the run.
 */
export function writeConfigSnapshot(
  session: string,
  configYaml: string,
  projectDir?: string,
): void {
  const dir = runDir(session, projectDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'config.snapshot.yaml');
  writeFileSync(filePath, configYaml);
  log.info(`Config snapshot written: ${filePath}`);
}

/**
 * Write scores.json for the run.
 */
export function writeScores(
  session: string,
  scores: ScoresJson,
  projectDir?: string,
): void {
  const dir = runDir(session, projectDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'scores.json');
  writeFileSync(filePath, JSON.stringify(scores, null, 2) + '\n');
  log.info(`Scores written: ${filePath}`);
}

/**
 * Write costs.json for the run.
 */
export function writeCosts(
  session: string,
  costs: CostsJson,
  projectDir?: string,
): void {
  const dir = runDir(session, projectDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'costs.json');
  writeFileSync(filePath, JSON.stringify(costs, null, 2) + '\n');
  log.info(`Costs written: ${filePath}`);
}

/**
 * Persist one writer's pipeline results and recompute the session-wide
 * scores.json from every writer's sidecar — same shape as persistStepCosts,
 * so a per-issue write can never clobber another issue's scores.
 */
export function persistIssueScores(
  session: string,
  scope: string,
  results: PipelineResultForScores[],
  projectDir?: string,
): void {
  const dir = join(runDir(session, projectDir), 'score-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scope}.json`), JSON.stringify(results, null, 2) + '\n');

  const all: PipelineResultForScores[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as PipelineResultForScores[];
      if (Array.isArray(parsed)) all.push(...parsed);
    } catch { /* skip corrupt sidecar */ }
  }
  writeScores(session, computeScores(all), projectDir);
}

/**
 * Persist one writer's raw step costs and recompute the session-wide
 * costs.json from every writer's sidecar. Each writer (an issue, a batch, a
 * finalize pass) owns one sidecar keyed by `scope`, last write wins for that
 * scope only — so a deferred background task finishing after a later issue's
 * write can no longer clobber that issue's costs.
 */
export function persistStepCosts(
  session: string,
  scope: string,
  stepCosts: StepCost[],
  projectDir?: string,
): void {
  const dir = join(runDir(session, projectDir), 'step-costs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${scope}.json`), JSON.stringify(stepCosts, null, 2) + '\n');

  const all: StepCost[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as StepCost[];
      if (Array.isArray(parsed)) all.push(...parsed);
    } catch { /* skip corrupt sidecar */ }
  }
  writeCosts(session, computeCosts(all), projectDir);
}

/**
 * Compute scores.json from pipeline results.
 */
export function computeScores(results: PipelineResultForScores[]): ScoresJson {
  const issues: Record<string, IssueScore> = {};

  for (const r of results) {
    const recovered = r.recoveryMode !== undefined;
    issues[String(r.issueNum)] = {
      status: r.status,
      recovery_mode: r.recoveryMode,
      scored: !recovered,
      tests_passed: r.testsPassing,
      verify_passed: r.verifyPassing,
      retries: r.retries,
      duration_seconds: r.duration,
      files_changed: r.filesChanged,
      steps_completed: r.stepsCompleted,
    };
  }

  const scoredResults = results.filter((r) => r.recoveryMode === undefined);
  const total = scoredResults.length;
  const recovered = results.length - total;
  const passed = scoredResults.filter((r) => r.status === 'success').length;
  const passRate = total > 0 ? passed / total : 0;
  const avgRetries = total > 0 ? scoredResults.reduce((sum, r) => sum + r.retries, 0) / total : 0;
  const avgDuration = total > 0 ? scoredResults.reduce((sum, r) => sum + r.duration, 0) / total : 0;

  // Use the canonical composite score formula from score.ts
  const caseResults: CaseResult[] = scoredResults.map((r) => ({
    caseId: String(r.issueNum),
    passed: r.status === 'success',
    partialCredit: r.status === 'success' ? 1 : 0,
    retries: r.retries,
    duration: r.duration,
  }));
  const compositeScore = computeCompositeScore(caseResults);

  return {
    composite_score: compositeScore,
    issues,
    aggregate: {
      pass_rate: Math.round(passRate * 1000) / 1000,
      avg_retries: Math.round(avgRetries * 10) / 10,
      avg_duration: Math.round(avgDuration),
      total_issues: results.length,
      scored_issues: total,
      recovered_issues: recovered,
      issues_passed: passed,
    },
  };
}

/**
 * Compute costs.json from per-step cost entries.
 */
export function computeCosts(stepCosts: StepCost[]): CostsJson {
  const byStep: CostsJson['by_step'] = {};
  const byIssue: CostsJson['by_issue'] = {};
  let totalCost = 0;
  let completeTotal = true;

  for (const sc of stepCosts) {
    // Aggregate by step name
    if (!byStep[sc.step]) {
      byStep[sc.step] = {
        model: sc.model,
        input_tokens: 0,
        output_tokens: 0,
        token_measurement_entries: 0,
        entries: 0,
        cost_usd: 0,
      };
    }
    const stepTotals = byStep[sc.step];
    stepTotals.entries++;
    // Legacy sidecars predate provenance but were written from agent usage;
    // only newly explicit `estimated` entries are excluded.
    if (sc.token_source !== 'estimated') {
      stepTotals.input_tokens = (stepTotals.input_tokens ?? 0) + sc.input_tokens;
      stepTotals.output_tokens = (stepTotals.output_tokens ?? 0) + sc.output_tokens;
      stepTotals.token_measurement_entries++;
    }
    if (sc.cost_usd == null) {
      stepTotals.cost_usd = null;
      completeTotal = false;
    } else if (stepTotals.cost_usd != null) {
      stepTotals.cost_usd += sc.cost_usd;
    }

    // Aggregate by issue
    const issueKey = String(sc.issueNum);
    if (!byIssue[issueKey]) {
      byIssue[issueKey] = { cost_usd: 0 };
    }
    if (sc.cost_usd == null) {
      byIssue[issueKey].cost_usd = null;
    } else if (byIssue[issueKey].cost_usd != null) {
      byIssue[issueKey].cost_usd += sc.cost_usd;
    }

    if (sc.cost_usd != null) totalCost += sc.cost_usd;
  }

  // Round all cost values
  for (const step of Object.values(byStep)) {
    if (step.token_measurement_entries === 0) {
      step.input_tokens = null;
      step.output_tokens = null;
    }
    if (step.cost_usd != null) step.cost_usd = Math.round(step.cost_usd * 10000) / 10000;
  }
  for (const issue of Object.values(byIssue)) {
    if (issue.cost_usd != null) issue.cost_usd = Math.round(issue.cost_usd * 10000) / 10000;
  }

  return {
    total_cost_usd: completeTotal ? Math.round(totalCost * 10000) / 10000 : null,
    by_step: byStep,
    by_issue: byIssue,
  };
}

/**
 * Read a trace file. Returns null if it doesn't exist.
 */
export function readTrace(
  session: string,
  issueNum: number,
  file: TraceFile,
  projectDir?: string,
): string | null {
  const filePath = join(traceDir(session, issueNum, projectDir), file);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

/**
 * Read trace metadata for an issue. Returns null if it doesn't exist.
 */
export function readTraceMetadata(
  session: string,
  issueNum: number,
  projectDir?: string,
): TraceMetadata | null {
  const raw = readTrace(session, issueNum, 'metadata.json', projectDir);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TraceMetadata;
  } catch {
    return null;
  }
}

/**
 * List all sessions that have traces.
 */
export function listTraceSessions(projectDir?: string): string[] {
  const root = tracesDir(projectDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * List all issue numbers with traces in a session.
 */
export function listTraceIssues(session: string, projectDir?: string): number[] {
  const sessionDir = runDir(session, projectDir);
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => parseInt(d.name, 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
}

/**
 * List all traces across all sessions.
 * Returns them newest-first by session name (which is timestamp-based).
 */
export function listTraces(projectDir?: string): Trace[] {
  const traces: Trace[] = [];
  const sessions = listTraceSessions(projectDir);

  for (const session of sessions.reverse()) {
    const issues = listTraceIssues(session, projectDir);
    for (const issueNum of issues) {
      const metadata = readTraceMetadata(session, issueNum, projectDir);
      if (metadata) {
        traces.push({
          session,
          issueNum,
          dir: traceDir(session, issueNum, projectDir),
          metadata,
        });
      }
    }
  }

  return traces;
}

/**
 * Get the full filesystem path context for a trace.
 * Returns all trace files and their sizes for Meta-Harness-style filesystem access.
 */
export function getTraceFiles(session: string, issueNum: number, projectDir?: string): Array<{ file: string; size: number }> {
  const dir = traceDir(session, issueNum, projectDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .map((file) => {
      const filePath = join(dir, file);
      const content = readFileSync(filePath, 'utf-8');
      return { file, size: content.length };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}
