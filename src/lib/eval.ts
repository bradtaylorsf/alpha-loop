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
import { join, basename, relative } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { log } from './logger.js';
import type { Config } from './config.js';
import type { PipelineResult } from './pipeline.js';
import { computeCompositeScore, appendScore, hashConfig } from './score.js';
import type { CaseResult, ScoreEntry } from './score.js';
import { parseChecks } from './eval-checks.js';
import type { CheckDefinition } from './eval-checks.js';

/** Status of a captured eval case. */
export type CapturedCaseStatus = 'needs-annotation' | 'ready';

/** The pipeline step that a step-level eval targets. */
export type PipelineStep = 'plan' | 'implement' | 'test' | 'review' | 'verify' | 'learn' | 'skill' | 'test-fix';

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
  /** Machine-checkable acceptance criteria (from checks.yaml). */
  checks?: CheckDefinition[];
  /** For step cases: raw input text (from input.md). */
  inputText?: string;
  /** Status of captured cases ('needs-annotation' or 'ready'). */
  captureStatus?: CapturedCaseStatus;
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
    outputMatch: boolean;
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

/** Get the evals directory path. Uses config evalDir if provided, otherwise default. */
export function evalsDir(projectDir?: string, evalDir?: string): string {
  return join(projectDir ?? process.cwd(), evalDir ?? EVALS_DIR);
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
 * Load an eval case from a directory containing issue.md, checks.yaml, metadata.yaml.
 */
export function loadEvalCaseDir(dirPath: string): EvalCase | null {
  try {
    const metadataPath = join(dirPath, 'metadata.yaml');
    const checksPath = join(dirPath, 'checks.yaml');
    const issuePath = join(dirPath, 'issue.md');
    const inputPath = join(dirPath, 'input.md');

    if (!existsSync(metadataPath) || !existsSync(checksPath)) return null;

    const metadata = parseYaml(readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
    const checksRaw = parseYaml(readFileSync(checksPath, 'utf-8')) as Record<string, unknown>;

    // Parse issue.md — title is the first markdown heading, body is the rest
    let issueTitle = '';
    let issueBody = '';
    if (existsSync(issuePath)) {
      const issueContent = readFileSync(issuePath, 'utf-8');
      const titleMatch = issueContent.match(/^#\s+(.+)$/m);
      issueTitle = titleMatch ? titleMatch[1].trim() : '';
      issueBody = titleMatch
        ? issueContent.slice(titleMatch.index! + titleMatch[0].length).trim()
        : issueContent;
    }

    // Parse input.md for step cases
    let inputText: string | undefined;
    if (existsSync(inputPath)) {
      inputText = readFileSync(inputPath, 'utf-8');
    }

    const id = basename(dirPath);
    const type = String(checksRaw.type ?? metadata.type ?? 'e2e');
    const evalType = type === 'step' ? 'step' : 'full';

    const checks = parseChecks(checksRaw);

    // Read capture status from checks.yaml (auto-captured cases use 'needs-annotation')
    const captureStatus = checksRaw.status === 'needs-annotation' ? 'needs-annotation' as CapturedCaseStatus
      : checksRaw.status === 'ready' ? 'ready' as CapturedCaseStatus
      : undefined;

    // Resolve fixture repo — support SWE-bench metadata with nested swebench.repo
    const swebench = metadata.swebench as Record<string, unknown> | undefined;
    let fixtureRepo = String(checksRaw.repo ?? metadata.repo ?? '');
    let fixtureRef = String(checksRaw.fixture_ref ?? metadata.fixture_ref ?? 'main');

    if (swebench && typeof swebench === 'object') {
      if (!fixtureRepo && swebench.repo) fixtureRepo = String(swebench.repo);
      if (fixtureRef === 'main' && swebench.base_commit) fixtureRef = String(swebench.base_commit);
    }

    return {
      id,
      description: String(metadata.description ?? (issueTitle || id)),
      type: evalType,
      step: checksRaw.step ? String(checksRaw.step) as PipelineStep : undefined,
      fixtureRepo,
      fixtureRef,
      issueTitle,
      issueBody: issueBody || inputText || '',
      expected: {
        success: true,
        testsPassing: checks.some((c) => c.type === 'test_pass') ? true : undefined,
      },
      tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
      timeout: typeof checksRaw.timeout === 'number' ? checksRaw.timeout : (typeof metadata.timeout === 'number' ? metadata.timeout : 0),
      source: String(metadata.source ?? 'manual'),
      checks,
      inputText,
      captureStatus,
    };
  } catch (err) {
    log.warn(`Failed to load eval case dir ${dirPath}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Load all eval cases from the evals directory.
 * Supports both flat case-*.yaml files and directory-based cases under cases/{e2e,step}/.
 * Optionally filter by tags, type, step, or caseId prefix.
 */
export function loadEvalCases(options?: {
  projectDir?: string;
  evalDir?: string;
  tags?: string[];
  type?: 'full' | 'step';
  step?: PipelineStep;
  caseId?: string;
  includeUnannotated?: boolean;
}): EvalCase[] {
  const dir = evalsDir(options?.projectDir, options?.evalDir);
  if (!existsSync(dir)) return [];

  const cases: EvalCase[] = [];

  // Load flat case-*.yaml files (backward compat)
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') && f.startsWith('case-'));
  for (const file of files) {
    const evalCase = loadEvalCase(join(dir, file));
    if (evalCase) cases.push(evalCase);
  }

  // Load directory-based cases under cases/{e2e,step}/
  const casesDir = join(dir, 'cases');
  if (existsSync(casesDir)) {
    for (const suiteType of ['e2e', 'step']) {
      const suiteDir = join(casesDir, suiteType);
      if (!existsSync(suiteDir)) continue;

      // Step cases may have an extra level: step/{review,plan,...}/001-name/
      if (suiteType === 'step') {
        const stepDirs = readdirSync(suiteDir, { withFileTypes: true })
          .filter((d) => d.isDirectory());
        for (const stepDir of stepDirs) {
          const stepPath = join(suiteDir, stepDir.name);
          // Check if this is a case dir or a step-name dir
          if (existsSync(join(stepPath, 'metadata.yaml'))) {
            const evalCase = loadEvalCaseDir(stepPath);
            if (evalCase) cases.push(evalCase);
          } else {
            // Nested: step/{stepName}/{caseDir}/
            const caseDirs = readdirSync(stepPath, { withFileTypes: true })
              .filter((d) => d.isDirectory());
            for (const caseDir of caseDirs) {
              const evalCase = loadEvalCaseDir(join(stepPath, caseDir.name));
              if (evalCase) cases.push(evalCase);
            }
          }
        }
      } else {
        const caseDirs = readdirSync(suiteDir, { withFileTypes: true })
          .filter((d) => d.isDirectory());
        for (const caseDir of caseDirs) {
          const evalCase = loadEvalCaseDir(join(suiteDir, caseDir.name));
          if (evalCase) cases.push(evalCase);
        }
      }
    }
  }

  // Apply filters
  const filtered = cases.filter((evalCase) => {
    // Skip unannotated cases unless explicitly including them
    if (evalCase.captureStatus === 'needs-annotation' && !options?.includeUnannotated) return false;

    // Filter by case ID prefix
    if (options?.caseId && !evalCase.id.startsWith(options.caseId)) return false;

    // Filter by type (map 'e2e' suite to 'full' type)
    if (options?.type && evalCase.type !== options.type) return false;

    // Filter by step
    if (options?.step && evalCase.step !== options.step) return false;

    // Filter by tags (any match)
    if (options?.tags && options.tags.length > 0) {
      const hasTag = options.tags.some((t) => evalCase.tags.includes(t));
      if (!hasTag) return false;
    }

    return true;
  });

  return filtered.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Save an eval case to a YAML file.
 */
export function saveEvalCase(evalCase: EvalCase, projectDir?: string, evalDirOverride?: string): string {
  const dir = evalsDir(projectDir, evalDirOverride);
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
    outputMatch: true,
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
    checks.outputMatch = evalCase.expected.outputContains.every((s) => actual.output.includes(s));
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
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
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

  appendScore(evalsDir(projectDir, config.evalDir), entry);

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

// ============================================================================
// Capture Workflow — save, load, and annotate captured eval cases
// ============================================================================

/** Options for saving a captured eval case. */
export type SaveCapturedCaseOptions = {
  issueNum: number;
  title: string;
  issueBody?: string;
  step: string;
  session: string;
  tags?: string[];
  projectDir?: string;
};

/**
 * Detect which pipeline step failed from a PipelineResult.
 */
export function detectFailureStep(result: PipelineResult): string {
  if (!result.testsPassing) {
    // If the issue's filesChanged > 0, the agent at least tried to implement;
    // multiple retries suggest a test-fix loop failure
    return result.filesChanged > 1 ? 'test-fix' : 'implement';
  }
  if (!result.verifyPassing && !result.verifySkipped) return 'verify';
  return 'review';
}

/**
 * Generate a slug from an issue title for directory naming.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Save a captured eval case as a directory-based skeleton.
 * Creates .alpha-loop/evals/cases/step/{stepName}/captured-{issueNum}-{slug}/
 * with metadata.yaml, checks.yaml, and issue.md.
 *
 * Returns the path to the created case directory.
 */
export function saveCapturedCase(opts: SaveCapturedCaseOptions & { evalDir?: string }): string {
  const dir = evalsDir(opts.projectDir, opts.evalDir);
  const slug = slugify(opts.title);
  const caseDirName = `captured-${String(opts.issueNum).padStart(3, '0')}-${slug}`;
  const casePath = join(dir, 'cases', 'step', opts.step, caseDirName);

  mkdirSync(casePath, { recursive: true });

  // metadata.yaml
  const metadata = stringifyYaml({
    id: caseDirName,
    description: opts.title,
    tags: opts.tags ?? [],
    source: 'auto-captured',
    captured_from: {
      issue: opts.issueNum,
      session: opts.session,
      date: new Date().toISOString().split('T')[0],
    },
  });
  writeFileSync(join(casePath, 'metadata.yaml'), metadata);

  // checks.yaml — skeleton with needs-annotation status
  const checks = stringifyYaml({
    type: 'step',
    step: opts.step,
    eval_method: 'pending',
    status: 'needs-annotation',
    source: 'auto-captured',
    captured_from: {
      issue: opts.issueNum,
      session: opts.session,
      date: new Date().toISOString().split('T')[0],
    },
    checks: [],
  });
  writeFileSync(join(casePath, 'checks.yaml'), checks);

  // issue.md
  const issueContent = `# ${opts.title}\n\n${opts.issueBody ?? `Captured from issue #${opts.issueNum}`}\n`;
  writeFileSync(join(casePath, 'issue.md'), issueContent);

  return casePath;
}

/**
 * Load all unannotated (needs-annotation) captured cases.
 */
export function loadUnannotatedCases(projectDir?: string, evalDirOverride?: string): Array<{ path: string; evalCase: EvalCase }> {
  const cases = loadEvalCases({ projectDir, evalDir: evalDirOverride, includeUnannotated: true });
  return cases
    .filter((c) => c.captureStatus === 'needs-annotation')
    .map((c) => {
      // Reconstruct the directory path from the case ID
      const dir = evalsDir(projectDir, evalDirOverride);
      // Search for the case directory
      const casePath = findCaseDir(dir, c.id);
      return { path: casePath, evalCase: c };
    })
    .filter((entry) => entry.path !== '');
}

/**
 * Find a case directory by its ID within the evals directory tree.
 */
function findCaseDir(baseDir: string, caseId: string): string {
  const casesDir = join(baseDir, 'cases');
  if (!existsSync(casesDir)) return '';

  for (const suiteType of ['e2e', 'step']) {
    const suiteDir = join(casesDir, suiteType);
    if (!existsSync(suiteDir)) continue;

    if (suiteType === 'step') {
      const stepDirs = readdirSync(suiteDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      for (const stepDir of stepDirs) {
        const candidate = join(suiteDir, stepDir.name, caseId);
        if (existsSync(candidate) && existsSync(join(candidate, 'checks.yaml'))) {
          return candidate;
        }
        // Also check nested
        const nested = join(suiteDir, stepDir.name);
        if (existsSync(nested)) {
          const subdirs = readdirSync(nested, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name === caseId);
          if (subdirs.length > 0) return join(nested, subdirs[0].name);
        }
      }
    } else {
      const candidate = join(suiteDir, caseId);
      if (existsSync(candidate) && existsSync(join(candidate, 'checks.yaml'))) {
        return candidate;
      }
    }
  }

  return '';
}

/** Annotation data for a captured case. */
export type CaseAnnotation = {
  whatWentWrong: string;
  whatShouldHaveHappened: string;
  tags?: string[];
};

/**
 * Annotate a captured case — updates checks.yaml with failure description,
 * expected behavior, and sets status to 'ready'.
 */
export function annotateCapturedCase(casePath: string, annotation: CaseAnnotation): void {
  const checksPath = join(casePath, 'checks.yaml');
  if (!existsSync(checksPath)) {
    throw new Error(`No checks.yaml found at ${casePath}`);
  }

  const checksRaw = parseYaml(readFileSync(checksPath, 'utf-8')) as Record<string, unknown>;

  checksRaw.status = 'ready';
  checksRaw.eval_method = 'annotated';
  checksRaw.failure_description = annotation.whatWentWrong;
  checksRaw.expected_behavior = annotation.whatShouldHaveHappened;

  // Add keyword checks based on the annotation
  const checks: Array<Record<string, unknown>> = [];
  if (annotation.whatShouldHaveHappened) {
    checks.push({
      type: 'keyword_present',
      keywords: extractKeywords(annotation.whatShouldHaveHappened),
    });
  }
  if (checks.length > 0) {
    checksRaw.checks = checks;
  }

  writeFileSync(checksPath, stringifyYaml(checksRaw));

  // Update metadata tags if provided
  if (annotation.tags && annotation.tags.length > 0) {
    const metadataPath = join(casePath, 'metadata.yaml');
    if (existsSync(metadataPath)) {
      const metadata = parseYaml(readFileSync(metadataPath, 'utf-8')) as Record<string, unknown>;
      const existingTags = Array.isArray(metadata.tags) ? metadata.tags.map(String) : [];
      metadata.tags = [...new Set([...existingTags, ...annotation.tags])];
      writeFileSync(metadataPath, stringifyYaml(metadata));
    }
  }
}

/**
 * Extract meaningful keywords from annotation text for keyword_present checks.
 */
function extractKeywords(text: string): string[] {
  // Split on common delimiters and take meaningful words (>3 chars)
  return text
    .split(/[\s,;.!?]+/)
    .filter((w) => w.length > 3)
    .map((w) => w.toLowerCase())
    .slice(0, 5);
}
