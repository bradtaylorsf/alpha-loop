/**
 * Eval Framework Core — define, load, run, and score eval cases.
 *
 * Eval cases live in .alpha-loop/evals/*.yaml and define:
 *   - A fixture repo + ref (the codebase state to test against)
 *   - An issue description (what the agent should implement)
 *   - Expected outcome (what success looks like)
 *   - Tags for filtering and categorization
 *
 * Two eval types:
 *   - 'full' — runs the complete pipeline (slow, expensive, comprehensive)
 *   - 'step' — tests a single pipeline stage (fast, cheap, targeted)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { log } from './logger.js';
import type { Config } from './config.js';
import { computeCompositeScore, appendScore, hashConfig } from './score.js';
import type { CaseResult, ScoreEntry } from './score.js';

/** The pipeline step that a step-level eval targets. */
export type PipelineStep = 'plan' | 'implement' | 'test' | 'review' | 'verify';

/** Expected outcome for an eval case. */
export type ExpectedOutcome = {
  /** Should the pipeline succeed? */
  success: boolean;
  /** Files that should be modified (glob patterns). */
  filesChanged?: string[];
  /** Tests that should pass after implementation. */
  testsPassing?: boolean;
  /** Key strings that should appear in the diff. */
  diffContains?: string[];
  /** Key strings that should NOT appear in the diff. */
  diffNotContains?: string[];
  /** For step evals: expected output patterns. */
  outputContains?: string[];
};

/** An eval case definition loaded from YAML. */
export type EvalCase = {
  /** Unique identifier (derived from filename if not set). */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Type: full pipeline run or single step. */
  type: 'full' | 'step';
  /** For step evals: which pipeline step to test. */
  step?: PipelineStep;
  /** Fixture repository (owner/repo or local path). */
  fixtureRepo: string;
  /** Git ref to checkout for the fixture. */
  fixtureRef: string;
  /** Issue title for the agent. */
  issueTitle: string;
  /** Issue body (markdown) for the agent. */
  issueBody: string;
  /** What we expect the agent to produce. */
  expected: ExpectedOutcome;
  /** Tags for filtering (e.g., 'typescript', 'refactor', 'bug-fix'). */
  tags: string[];
  /** Maximum time in seconds for this case (0 = use default). */
  timeout: number;
  /** Source: how this case was captured ('manual', 'auto-capture', 'swe-bench'). */
  source: string;
};

/** Result of running a single eval case. */
export type EvalResult = {
  caseId: string;
  passed: boolean;
  partialCredit: number;
  retries: number;
  duration: number;
  error?: string;
  details: {
    successMatch: boolean;
    filesMatch: boolean;
    testsMatch: boolean;
    diffMatch: boolean;
  };
};

/** Summary of an eval suite run. */
export type EvalSuiteResult = {
  cases: EvalResult[];
  composite: number;
  totalDuration: number;
  passCount: number;
  failCount: number;
};

const EVALS_DIR = '.alpha-loop/evals';

/** Get the evals directory path. */
export function evalsDir(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), EVALS_DIR);
}

/**
 * Load a single eval case from a YAML file.
 */
export function loadEvalCase(filePath: string): EvalCase | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    const id = String(parsed.id ?? basename(filePath, '.yaml'));
    const expected = (parsed.expected ?? {}) as Record<string, unknown>;

    return {
      id,
      description: String(parsed.description ?? ''),
      type: parsed.type === 'step' ? 'step' : 'full',
      step: parsed.step ? String(parsed.step) as PipelineStep : undefined,
      fixtureRepo: String(parsed.fixture_repo ?? parsed.fixtureRepo ?? ''),
      fixtureRef: String(parsed.fixture_ref ?? parsed.fixtureRef ?? 'main'),
      issueTitle: String(parsed.issue_title ?? parsed.issueTitle ?? ''),
      issueBody: String(parsed.issue_body ?? parsed.issueBody ?? ''),
      expected: {
        success: expected.success !== false,
        filesChanged: Array.isArray(expected.files_changed) ? expected.files_changed.map(String) : undefined,
        testsPassing: typeof expected.tests_passing === 'boolean' ? expected.tests_passing : undefined,
        diffContains: Array.isArray(expected.diff_contains) ? expected.diff_contains.map(String) : undefined,
        diffNotContains: Array.isArray(expected.diff_not_contains) ? expected.diff_not_contains.map(String) : undefined,
        outputContains: Array.isArray(expected.output_contains) ? expected.output_contains.map(String) : undefined,
      },
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      timeout: typeof parsed.timeout === 'number' ? parsed.timeout : 0,
      source: String(parsed.source ?? 'manual'),
    };
  } catch (err) {
    log.warn(`Failed to load eval case from ${filePath}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Load all eval cases from the evals directory.
 * Optionally filter by tags or type.
 */
export function loadEvalCases(options?: {
  projectDir?: string;
  tags?: string[];
  type?: 'full' | 'step';
  step?: PipelineStep;
}): EvalCase[] {
  const dir = evalsDir(options?.projectDir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && f.startsWith('case-'));
  const cases: EvalCase[] = [];

  for (const file of files) {
    const evalCase = loadEvalCase(join(dir, file));
    if (!evalCase) continue;

    // Filter by type
    if (options?.type && evalCase.type !== options.type) continue;

    // Filter by step
    if (options?.step && evalCase.step !== options.step) continue;

    // Filter by tags (any match)
    if (options?.tags && options.tags.length > 0) {
      const hasTag = options.tags.some((t) => evalCase.tags.includes(t));
      if (!hasTag) continue;
    }

    cases.push(evalCase);
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Save an eval case to a YAML file.
 */
export function saveEvalCase(evalCase: EvalCase, projectDir?: string): string {
  const dir = evalsDir(projectDir);
  mkdirSync(dir, { recursive: true });

  const filePath = join(dir, `case-${evalCase.id}.yaml`);

  const yamlData: Record<string, unknown> = {
    id: evalCase.id,
    description: evalCase.description,
    type: evalCase.type,
    ...(evalCase.step && { step: evalCase.step }),
    fixture_repo: evalCase.fixtureRepo,
    fixture_ref: evalCase.fixtureRef,
    issue_title: evalCase.issueTitle,
    issue_body: evalCase.issueBody,
    expected: {
      success: evalCase.expected.success,
      ...(evalCase.expected.filesChanged && { files_changed: evalCase.expected.filesChanged }),
      ...(evalCase.expected.testsPassing !== undefined && { tests_passing: evalCase.expected.testsPassing }),
      ...(evalCase.expected.diffContains && { diff_contains: evalCase.expected.diffContains }),
      ...(evalCase.expected.diffNotContains && { diff_not_contains: evalCase.expected.diffNotContains }),
      ...(evalCase.expected.outputContains && { output_contains: evalCase.expected.outputContains }),
    },
    tags: evalCase.tags,
    timeout: evalCase.timeout,
    source: evalCase.source,
  };

  writeFileSync(filePath, stringifyYaml(yamlData));
  return filePath;
}

/**
 * Evaluate a completed pipeline result against expected outcomes.
 * Returns partial credit based on how many criteria match.
 */
export function evaluateResult(
  evalCase: EvalCase,
  actual: {
    success: boolean;
    testsPassing: boolean;
    diff: string;
    filesChanged: string[];
    output: string;
    retries: number;
    duration: number;
  },
): EvalResult {
  const checks = {
    successMatch: actual.success === evalCase.expected.success,
    filesMatch: true,
    testsMatch: true,
    diffMatch: true,
  };

  // Check files changed
  if (evalCase.expected.filesChanged && evalCase.expected.filesChanged.length > 0) {
    checks.filesMatch = evalCase.expected.filesChanged.every((pattern) =>
      actual.filesChanged.some((f) => f.includes(pattern) || minimatch(f, pattern)),
    );
  }

  // Check tests passing
  if (evalCase.expected.testsPassing !== undefined) {
    checks.testsMatch = actual.testsPassing === evalCase.expected.testsPassing;
  }

  // Check diff contains
  if (evalCase.expected.diffContains) {
    checks.diffMatch = evalCase.expected.diffContains.every((s) => actual.diff.includes(s));
  }
  if (evalCase.expected.diffNotContains) {
    checks.diffMatch = checks.diffMatch &&
      evalCase.expected.diffNotContains.every((s) => !actual.diff.includes(s));
  }

  // Check output contains (for step evals)
  if (evalCase.expected.outputContains) {
    checks.diffMatch = checks.diffMatch &&
      evalCase.expected.outputContains.every((s) => actual.output.includes(s));
  }

  // Compute partial credit (0-1)
  const checkValues = Object.values(checks);
  const partialCredit = checkValues.filter(Boolean).length / checkValues.length;
  const passed = checkValues.every(Boolean);

  return {
    caseId: evalCase.id,
    passed,
    partialCredit,
    retries: actual.retries,
    duration: actual.duration,
    details: checks,
  };
}

/**
 * Simple glob-like pattern matching (supports * wildcards).
 * Not a full glob implementation — just enough for eval file matching.
 */
function minimatch(str: string, pattern: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(str);
}

/**
 * Record eval suite results: compute composite score and append to score history.
 */
export function recordEvalResults(
  results: EvalResult[],
  config: Config,
  cost: number,
  projectDir?: string,
): EvalSuiteResult {
  const caseResults: CaseResult[] = results.map((r) => ({
    caseId: r.caseId,
    passed: r.passed,
    partialCredit: r.partialCredit,
    retries: r.retries,
    duration: r.duration,
    error: r.error,
  }));

  const composite = computeCompositeScore(caseResults);

  const configObj: Record<string, unknown> = {
    agent: config.agent,
    model: config.model,
    reviewModel: config.reviewModel,
    maxTestRetries: config.maxTestRetries,
    testCommand: config.testCommand,
  };

  const entry: ScoreEntry = {
    timestamp: new Date().toISOString(),
    configHash: hashConfig(configObj),
    config: configObj,
    cases: caseResults,
    composite,
    totalCost: cost,
  };

  appendScore(evalsDir(projectDir), entry);

  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.length - passCount;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  return { cases: results, composite, totalDuration, passCount, failCount };
}

/**
 * Format eval case for display.
 */
export function formatEvalCase(evalCase: EvalCase): string {
  const tags = evalCase.tags.length > 0 ? ` [${evalCase.tags.join(', ')}]` : '';
  const step = evalCase.step ? ` (${evalCase.step})` : '';
  return `${evalCase.id}: ${evalCase.description} — ${evalCase.type}${step}${tags}`;
}
