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
  cost_usd: number;
};

/** Run-level costs.json format. */
export type CostsJson = {
  total_cost_usd: number;
  by_step: Record<string, {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  }>;
  by_issue: Record<string, { cost_usd: number }>;
};

/** Pipeline result used to compute scores. */
export type PipelineResultForScores = {
  issueNum: number;
  status: 'success' | 'failure';
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
 * Compute scores.json from pipeline results.
 */
export function computeScores(results: PipelineResultForScores[]): ScoresJson {
  const issues: Record<string, IssueScore> = {};

  for (const r of results) {
    issues[String(r.issueNum)] = {
      status: r.status,
      tests_passed: r.testsPassing,
      verify_passed: r.verifyPassing,
      retries: r.retries,
      duration_seconds: r.duration,
      files_changed: r.filesChanged,
      steps_completed: r.stepsCompleted,
    };
  }

  const total = results.length;
  const passed = results.filter((r) => r.status === 'success').length;
  const passRate = total > 0 ? passed / total : 0;
  const avgRetries = total > 0 ? results.reduce((sum, r) => sum + r.retries, 0) / total : 0;
  const avgDuration = total > 0 ? results.reduce((sum, r) => sum + r.duration, 0) / total : 0;

  // Composite score: weighted combination of pass rate, retry efficiency, and duration efficiency
  const retryPenalty = Math.min(avgRetries / 3, 1); // 3+ retries avg = max penalty
  const compositeScore = total > 0
    ? Math.round((passRate * 80 + (1 - retryPenalty) * 20) * 10) / 10
    : 0;

  return {
    composite_score: compositeScore,
    issues,
    aggregate: {
      pass_rate: Math.round(passRate * 1000) / 1000,
      avg_retries: Math.round(avgRetries * 10) / 10,
      avg_duration: Math.round(avgDuration),
      total_issues: total,
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

  for (const sc of stepCosts) {
    // Aggregate by step name
    if (!byStep[sc.step]) {
      byStep[sc.step] = {
        model: sc.model,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      };
    }
    byStep[sc.step].input_tokens += sc.input_tokens;
    byStep[sc.step].output_tokens += sc.output_tokens;
    byStep[sc.step].cost_usd += sc.cost_usd;

    // Aggregate by issue
    const issueKey = String(sc.issueNum);
    if (!byIssue[issueKey]) {
      byIssue[issueKey] = { cost_usd: 0 };
    }
    byIssue[issueKey].cost_usd += sc.cost_usd;

    totalCost += sc.cost_usd;
  }

  // Round all cost values
  for (const step of Object.values(byStep)) {
    step.cost_usd = Math.round(step.cost_usd * 10000) / 10000;
  }
  for (const issue of Object.values(byIssue)) {
    issue.cost_usd = Math.round(issue.cost_usd * 10000) / 10000;
  }

  return {
    total_cost_usd: Math.round(totalCost * 10000) / 10000,
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
