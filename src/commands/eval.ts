/**
 * Eval Command — run eval suite, capture failures, list cases, view scores.
 *
 * Subcommands:
 *   alpha-loop eval              — Run the eval suite, compute composite score
 *   alpha-loop eval capture      — Interactive: walk through recent failures
 *   alpha-loop eval capture <N>  — Capture a specific issue as an eval case
 *   alpha-loop eval list         — Show eval cases and recent scores
 *   alpha-loop eval scores       — Score history over time
 *   alpha-loop eval search       — Greedy config search (model/agent variants)
 *   alpha-loop eval pareto       — Show score/cost Pareto frontier
 *   alpha-loop eval import-swebench — Import from SWE-bench
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { parse as parseYaml } from 'yaml';
import { log } from '../lib/logger.js';
import { loadConfig } from '../lib/config.js';
import type { Config } from '../lib/config.js';
import {
  loadEvalCases,
  saveEvalCase,
  saveCapturedCase,
  loadUnannotatedCases,
  annotateCapturedCase,
  detectFailureStep,
  formatEvalCase,
  evalsDir,
  buildQualityRubric,
} from '../lib/eval.js';
import type { EvalCase, ExpectedOutcome, PipelineStep } from '../lib/eval.js';
import {
  toSkillCreatorEval,
  fromSkillCreatorEval,
  fromSkillCreatorEvalAll,
} from '../lib/eval-skill-bridge.js';
import type { SkillCreatorEval } from '../lib/eval-skill-bridge.js';
import {
  readScores,
  latestScore,
  scoresByConfig,
  paretoFrontier,
  buildParetoFrontier,
  formatScoreEntry,
  formatParetoTable,
  compareRuns,
  hashConfig,
  deriveConfigLabel,
} from '../lib/score.js';
import { exportEvalCase } from '../lib/eval-export.js';
import type { ScoreEntry, ParetoEntry } from '../lib/score.js';
import {
  listTraceSessions,
  listTraceIssues,
  readTraceMetadata,
  readTrace,
} from '../lib/traces.js';
import { runEvalSuite, estimateRunCost } from '../lib/eval-runner.js';
import { resolveStepConfig } from '../lib/config.js';
import type { PipelineStepName, PipelineConfig, StepConfig } from '../lib/config.js';

export type EvalOptions = {
  tags?: string;
  suite?: string;
  case?: string;
  type?: 'full' | 'step';
  step?: string;
  verbose?: boolean;
};

export type EvalCaptureOptions = {
  issue?: string;
  quality?: boolean;
  session?: string;
};

export type EvalSearchOptions = {
  models?: string;
  agents?: string;
  maxRuns?: string;
  /** Only search over this pipeline step. */
  step?: string;
  /** Minimum acceptable score. */
  minScore?: string;
  /** What to optimize: 'cost' or 'efficiency'. */
  optimize?: string;
  /** Maximum number of eval runs (alias for maxRuns). */
  budget?: string;
};

/** Helper to ask a question via readline. */
function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Run the eval suite.
 */
export async function evalRunCommand(options: EvalOptions): Promise<void> {
  const config = loadConfig();

  // Map --suite to type filter
  let type = options.type;
  if (options.suite === 'step') type = 'step';
  if (options.suite === 'e2e') type = 'full';

  const cases = loadEvalCases({
    tags: options.tags?.split(','),
    type,
    step: options.step as PipelineStep | undefined,
    caseId: options.case,
  });

  if (cases.length === 0) {
    log.warn('No eval cases found. Use `alpha-loop eval capture` to create some.');
    log.info(`Eval cases directory: ${evalsDir(undefined, config.evalDir)}`);
    return;
  }

  log.step(`Running ${cases.length} eval case(s)...`);
  console.log('');

  for (const evalCase of cases) {
    console.log(`  ${formatEvalCase(evalCase)}`);
  }
  console.log('');

  // Show previous score for comparison
  const previousScore = latestScore(evalsDir(undefined, config.evalDir));

  // Execute the eval suite
  const result = await runEvalSuite(cases, config, {
    caseId: options.case,
    verbose: options.verbose,
  });

  // Print results
  console.log('');
  log.step('Results:');
  console.log('');

  for (const caseResult of result.cases) {
    const icon = caseResult.passed ? 'PASS' : 'FAIL';
    const credit = caseResult.partialCredit < 1 ? ` (credit=${caseResult.partialCredit.toFixed(2)})` : '';
    const error = caseResult.error ? ` — ${caseResult.error}` : '';
    const promptTag = caseResult.usingRepoPrompts ? ' [repo]' : '';
    console.log(`  ${icon}  ${caseResult.caseId}  ${caseResult.duration}s${credit}${promptTag}${error}`);
  }

  console.log('');
  console.log(`  Score: ${result.composite}`);
  console.log(`  Pass:  ${result.passCount}/${result.cases.length}`);
  console.log(`  Time:  ${result.totalDuration}s`);

  // Compare to previous run
  if (previousScore) {
    const delta = result.composite - previousScore.composite;
    const arrow = delta > 0 ? '+' : '';
    console.log(`  Delta: ${arrow}${delta.toFixed(2)} (prev: ${previousScore.composite})`);
  }
}

/**
 * Compare two eval runs.
 */
export function evalCompareCommand(run1: string, run2: string): void {
  const comparison = compareRuns(evalsDir(undefined, loadConfig().evalDir), run1, run2);

  if (!comparison) {
    log.warn('Could not find one or both runs. Use run index (1-based) or timestamp prefix.');
    log.info('Run `alpha-loop eval scores` to see available runs.');
    return;
  }

  log.step('Run Comparison:');
  console.log('');
  console.log(`  Run 1: ${comparison.run1.timestamp.split('T')[0]}  score=${comparison.run1.composite}  cost=$${comparison.run1.totalCost.toFixed(2)}`);
  console.log(`  Run 2: ${comparison.run2.timestamp.split('T')[0]}  score=${comparison.run2.composite}  cost=$${comparison.run2.totalCost.toFixed(2)}`);
  console.log('');

  const scoreDelta = comparison.scoreDelta;
  const scoreArrow = scoreDelta > 0 ? '+' : '';
  console.log(`  Score delta: ${scoreArrow}${scoreDelta.toFixed(2)}`);
  console.log(`  Cost delta:  ${comparison.costDelta >= 0 ? '+' : ''}$${comparison.costDelta.toFixed(2)}`);
  console.log('');

  // Per-case breakdown
  console.log('  Case                              Run 1    Run 2    Delta');
  console.log('  ----                              -----    -----    -----');

  for (const c of comparison.cases) {
    const name = c.caseId.padEnd(32);
    const s1 = c.run1Passed === null ? '  -  ' : (c.run1Passed ? ' PASS' : ' FAIL');
    const s2 = c.run2Passed === null ? '  -  ' : (c.run2Passed ? ' PASS' : ' FAIL');
    const delta = c.delta === 0 ? '   =' : (c.delta > 0 ? `  +${c.delta.toFixed(1)}` : `  ${c.delta.toFixed(1)}`);
    console.log(`  ${name}  ${s1}    ${s2}    ${delta}`);
  }
}

/**
 * Capture a failure as an eval case — interactive walkthrough.
 *
 * Flow:
 *   1. Show unannotated (auto-captured) skeleton cases first, prompt to annotate
 *   2. Show recent session failures grouped by session
 *   3. For each failure: show step, test/verify status, prompt for diagnosis
 */
export async function evalCaptureCommand(options: EvalCaptureOptions): Promise<void> {
  const config = loadConfig();

  if (options.quality) {
    await evalCaptureQualityCommand(options, config);
    return;
  }

  if (options.issue) {
    // Capture a specific issue
    await captureSpecificIssue(parseInt(options.issue, 10), config);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let capturedCount = 0;

  try {
    // Phase 1: Show unannotated skeleton cases first
    const unannotated = loadUnannotatedCases();
    if (unannotated.length > 0) {
      log.step(`Unannotated eval cases (auto-captured):`);
      console.log('');
      for (let i = 0; i < unannotated.length; i++) {
        const u = unannotated[i];
        const meta = u.evalCase;
        console.log(`  ${i + 1}. ${meta.id} (issue #${extractIssueNum(meta.id)}, ${meta.source})`);
      }
      console.log('');

      for (const entry of unannotated) {
        const answer = await ask(rl, `Annotate ${entry.evalCase.id}? (y/n): `);
        if (answer.toLowerCase() !== 'y') continue;

        const annotation = await promptAnnotation(rl);
        annotateCapturedCase(entry.path, annotation);
        capturedCount++;
        log.success(`Annotated: ${entry.evalCase.id}`);
      }

      if (capturedCount > 0) console.log('');
    }

    // Phase 2: Show recent session failures
    const sessionFailures = collectSessionFailures();
    if (sessionFailures.length === 0 && unannotated.length === 0) {
      log.info('No failures found in recent sessions. Nothing to capture.');
      return;
    }

    if (sessionFailures.length > 0) {
      // Group by session
      const grouped = groupBySession(sessionFailures);

      log.step('Recent sessions with failures:');
      console.log('');

      for (const [session, failures] of grouped) {
        console.log(`  ${session} — ${failures.length} failure(s)`);
        for (const f of failures) {
          const step = detectFailureStepFromResult(f.result);
          const tests = f.result.testsPassing ? 'PASS' : 'FAIL';
          const verify = f.result.verifySkipped ? 'SKIP' : (f.result.verifyPassing ? 'PASS' : 'FAIL');
          console.log(`    #${f.issueNum} — ${f.title}`);
          console.log(`      Failed at: ${step} | Tests: ${tests} | Verify: ${verify}`);
        }
        console.log('');
      }

      // Prompt to capture each failure
      let skipAllFailures = false;
      for (const [_session, failures] of grouped) {
        if (skipAllFailures) break;
        for (const failure of failures) {
          const answer = await ask(rl, `Capture #${failure.issueNum}? (y/n/skip all): `);
          if (answer === 'skip all') { skipAllFailures = true; break; }
          if (answer.toLowerCase() !== 'y') continue;

          const annotation = await promptAnnotation(rl);
          const step = detectFailureStepFromResult(failure.result);

          const casePath = saveCapturedCase({
            issueNum: failure.issueNum,
            title: failure.title,
            issueBody: typeof failure.result.issueBody === 'string' ? failure.result.issueBody : undefined,
            step,
            session: failure.session,
            tags: annotation.tags,
          });

          // Immediately annotate since we have the diagnosis
          annotateCapturedCase(casePath, annotation);
          capturedCount++;
          log.success(`Created: ${casePath}`);
        }
      }
    }

    if (capturedCount > 0) {
      console.log('');
      log.info(`Done. ${capturedCount} eval case(s) created/annotated. Run 'alpha-loop eval --suite step' to test.`);
    }
  } finally {
    rl.close();
  }
}

/** Prompt user for failure annotation. */
async function promptAnnotation(rl: readline.Interface): Promise<import('../lib/eval.js').CaseAnnotation> {
  console.log('');
  const whatWentWrong = await ask(rl, '  What went wrong? (one line): ');
  const whatShouldHaveHappened = await ask(rl, '  What should have happened? (one line): ');
  const tagsInput = await ask(rl, '  Tags (comma-separated, optional): ');

  return {
    whatWentWrong,
    whatShouldHaveHappened,
    tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean),
  };
}

/** Extract issue number from a captured case ID like "captured-047-module-format". */
function extractIssueNum(caseId: string): string {
  const match = caseId.match(/captured-(\d+)/);
  return match ? String(parseInt(match[1], 10)) : '?';
}

type SessionFailure = {
  session: string;
  issueNum: number;
  title: string;
  file: string;
  result: Record<string, unknown>;
};

/** Collect failures from recent sessions. */
function collectSessionFailures(): SessionFailure[] {
  const sessionsDir = join(process.cwd(), '.alpha-loop', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  const failures: SessionFailure[] = [];

  for (const sessionDir of sessionDirs.slice(0, 5)) {
    const sessionPath = join(sessionsDir, sessionDir);
    const resultFiles = readdirSync(sessionPath)
      .filter((f) => f.startsWith('result-') && f.endsWith('.json'));

    for (const file of resultFiles) {
      try {
        const result = JSON.parse(readFileSync(join(sessionPath, file), 'utf-8'));
        if (result.status === 'failure') {
          failures.push({
            session: sessionDir,
            issueNum: result.issueNum,
            title: result.title ?? `Issue #${result.issueNum}`,
            file: join(sessionPath, file),
            result,
          });
        }
      } catch {
        // Skip malformed result files
      }
    }
  }

  return failures;
}

/** Group failures by session name. */
function groupBySession(failures: SessionFailure[]): Map<string, SessionFailure[]> {
  const grouped = new Map<string, SessionFailure[]>();
  for (const f of failures) {
    const existing = grouped.get(f.session) ?? [];
    existing.push(f);
    grouped.set(f.session, existing);
  }
  return grouped;
}

/** Detect failure step from a raw session result object. */
function detectFailureStepFromResult(result: Record<string, unknown>): string {
  if (!result.testsPassing) {
    return (typeof result.filesChanged === 'number' && result.filesChanged > 1) ? 'test-fix' : 'implement';
  }
  if (!result.verifyPassing && !result.verifySkipped) return 'verify';
  return 'review';
}

/** Capture a specific issue number as an eval case. */
async function captureSpecificIssue(issueNum: number, config: Config): Promise<void> {
  // Look for this issue in traces
  const sessions = listTraceSessions();
  let found = false;

  for (const session of sessions.reverse()) {
    const issues = listTraceIssues(session);
    if (issues.includes(issueNum)) {
      const metadata = readTraceMetadata(session, issueNum);
      if (metadata) {
        found = true;
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          await captureFromTrace(rl, session, issueNum, metadata, config);
        } finally {
          rl.close();
        }
        break;
      }
    }
  }

  // Fallback: check session result files
  if (!found) {
    const sessionsDir = join(process.cwd(), '.alpha-loop', 'sessions');
    if (existsSync(sessionsDir)) {
      const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();

      for (const sessionDir of sessionDirs) {
        const resultFile = join(sessionsDir, sessionDir, `result-${issueNum}.json`);
        if (existsSync(resultFile)) {
          found = true;
          const result = JSON.parse(readFileSync(resultFile, 'utf-8'));
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try {
            await captureFailure(rl, {
              session: sessionDir,
              issueNum,
              title: result.title ?? `Issue #${issueNum}`,
              file: resultFile,
            }, config);
          } finally {
            rl.close();
          }
          break;
        }
      }
    }
  }

  if (!found) {
    log.warn(`No data found for issue #${issueNum}. Run the pipeline first, or create an eval case manually.`);
  }
}

/** Capture an eval case from trace data. */
async function captureFromTrace(
  rl: readline.Interface,
  session: string,
  issueNum: number,
  metadata: import('../lib/traces.js').TraceMetadata,
  config: Config,
): Promise<void> {
  log.step(`Capturing eval case from trace: session=${session}, issue=#${issueNum}`);

  // Read available trace data
  const plan = readTrace(session, issueNum, 'plan.json');
  const diff = readTrace(session, issueNum, 'diff.patch');

  const step = metadata.testsPassing
    ? (metadata.verifyPassing ? 'review' : 'verify')
    : 'implement';

  console.log(`\n  Issue: #${issueNum} — ${metadata.title}`);
  console.log(`  Status: ${metadata.status}`);
  console.log(`  Failed at: ${step}`);
  console.log(`  Tests: ${metadata.testsPassing ? 'PASS' : 'FAIL'} | Verify: ${metadata.verifySkipped ? 'SKIP' : (metadata.verifyPassing ? 'PASS' : 'FAIL')}`);
  console.log(`  Duration: ${metadata.duration}s, Retries: ${metadata.retries}`);
  if (plan) console.log(`  Plan: available`);
  if (diff) console.log(`  Diff: ${diff.length} chars`);
  console.log('');

  const annotation = await promptAnnotation(rl);

  const casePath = saveCapturedCase({
    issueNum,
    title: metadata.title,
    step,
    session,
    tags: annotation.tags,
  });

  annotateCapturedCase(casePath, annotation);
  log.success(`Eval case saved: ${casePath}`);
}

/** Capture a failure from session result as an eval case. */
async function captureFailure(
  rl: readline.Interface,
  failure: { session: string; issueNum: number; title: string; file: string },
  config: Config,
): Promise<void> {
  log.step(`\nCapturing: #${failure.issueNum} — ${failure.title}`);

  const result = JSON.parse(readFileSync(failure.file, 'utf-8'));
  const step = detectFailureStepFromResult(result);

  console.log(`  Failed at: ${step}`);
  console.log(`  Tests: ${result.testsPassing ? 'PASS' : 'FAIL'} | Verify: ${result.verifySkipped ? 'SKIP' : (result.verifyPassing ? 'PASS' : 'FAIL')}`);
  console.log(`  Duration: ${result.duration}s`);
  console.log(`  Files changed: ${result.filesChanged}`);
  console.log('');

  const annotation = await promptAnnotation(rl);

  const casePath = saveCapturedCase({
    issueNum: failure.issueNum,
    title: failure.title,
    step,
    session: failure.session,
    tags: annotation.tags,
  });

  annotateCapturedCase(casePath, annotation);
  log.success(`Eval case saved: ${casePath}`);
}

/** Valid pipeline steps for quality failure attribution. */
const QUALITY_STEPS = ['plan', 'implement', 'review', 'verify'] as const;

type SessionSuccess = {
  session: string;
  issueNum: number;
  title: string;
  file: string;
  result: Record<string, unknown>;
};

/** Collect successful results from recent sessions. */
function collectSessionSuccesses(sessionFilter?: string): SessionSuccess[] {
  const sessionsDir = join(process.cwd(), '.alpha-loop', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  const successes: SessionSuccess[] = [];

  const dirsToScan = sessionFilter
    ? sessionDirs.filter((d) => d.includes(sessionFilter))
    : sessionDirs.slice(0, 5);

  for (const sessionDir of dirsToScan) {
    const sessionPath = join(sessionsDir, sessionDir);
    const resultFiles = readdirSync(sessionPath)
      .filter((f) => f.startsWith('result-') && f.endsWith('.json'));

    for (const file of resultFiles) {
      try {
        const result = JSON.parse(readFileSync(join(sessionPath, file), 'utf-8'));
        if (result.status === 'success') {
          successes.push({
            session: sessionDir,
            issueNum: result.issueNum,
            title: result.title ?? `Issue #${result.issueNum}`,
            file: join(sessionPath, file),
            result,
          });
        }
      } catch {
        // Skip malformed result files
      }
    }
  }

  return successes;
}

/** Prompt user for quality failure annotation (extended with step attribution). */
async function promptQualityAnnotation(rl: readline.Interface): Promise<{
  whatWentWrong: string;
  whichStep: string;
  whatShouldHaveHappened: string;
  tags: string[];
}> {
  console.log('');
  const whatWentWrong = await ask(rl, '  What went wrong? (e.g., "ArtifactRepo never injected"): ');
  const whichStep = await ask(rl, `  Which step should have caught it? (${QUALITY_STEPS.join('/')}): `);
  const whatShouldHaveHappened = await ask(rl, '  What should the step have produced? (e.g., "Review should flag missing DI"): ');
  const tagsInput = await ask(rl, '  Tags (comma-separated, optional): ');

  const step = QUALITY_STEPS.includes(whichStep as typeof QUALITY_STEPS[number])
    ? whichStep
    : 'review';

  return {
    whatWentWrong,
    whichStep: step,
    whatShouldHaveHappened,
    tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean),
  };
}

/**
 * Quality capture mode — walk through successful sessions and capture quality failures.
 *
 * Quality failures are sessions where the pipeline reported success but the output
 * has critical wiring issues. These are the most dangerous failure mode because
 * they give false confidence.
 */
async function evalCaptureQualityCommand(options: EvalCaptureOptions, config: Config): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let capturedCount = 0;

  try {
    // If a specific issue number is given with --quality, capture it directly
    if (options.issue) {
      const issueNum = parseInt(options.issue, 10);
      const successes = collectSessionSuccesses(options.session);
      const found = successes.find((s) => s.issueNum === issueNum);

      if (!found) {
        log.warn(`No successful session result found for issue #${issueNum}. Only "success" results can be quality-captured.`);
        return;
      }

      log.step(`Quality capture for issue #${issueNum} from session ${found.session}`);
      console.log(`  Issue: #${found.issueNum} — ${found.title}`);
      console.log(`  Status: success (pipeline passed)`);
      console.log('');

      const annotation = await promptQualityAnnotation(rl);

      const casePath = saveCapturedCase({
        issueNum: found.issueNum,
        title: found.title,
        issueBody: typeof found.result.issueBody === 'string' ? found.result.issueBody : undefined,
        step: annotation.whichStep,
        session: found.session,
        tags: [...(annotation.tags), 'quality-failure'],
        source: 'quality-capture',
      });

      const rubric = buildQualityRubric(annotation.whatWentWrong, annotation.whatShouldHaveHappened);
      annotateCapturedCase(casePath, {
        whatWentWrong: annotation.whatWentWrong,
        whatShouldHaveHappened: annotation.whatShouldHaveHappened,
        tags: [...(annotation.tags), 'quality-failure'],
        qualityRubric: rubric,
      });

      capturedCount++;
      log.success(`Quality eval case saved: ${casePath}`);
      return;
    }

    // Interactive mode — show successful sessions and let user select issues
    const successes = collectSessionSuccesses(options.session);
    if (successes.length === 0) {
      log.info('No successful session results found. Quality capture requires sessions with status: success.');
      return;
    }

    // Group by session
    const grouped = new Map<string, SessionSuccess[]>();
    for (const s of successes) {
      const existing = grouped.get(s.session) ?? [];
      existing.push(s);
      grouped.set(s.session, existing);
    }

    log.step('Successful sessions (candidates for quality review):');
    console.log('');

    for (const [session, results] of grouped) {
      console.log(`  ${session} — ${results.length} successful issue(s)`);
      for (const r of results) {
        const tests = r.result.testsPassing ? 'PASS' : 'FAIL';
        const verify = r.result.verifySkipped ? 'SKIP' : (r.result.verifyPassing ? 'PASS' : 'FAIL');
        console.log(`    #${r.issueNum} — ${r.title}`);
        console.log(`      Tests: ${tests} | Verify: ${verify} | Duration: ${r.result.duration}s`);
      }
      console.log('');
    }

    // Prompt to capture quality issues
    let skipAllQuality = false;
    for (const [_session, results] of grouped) {
      if (skipAllQuality) break;
      for (const result of results) {
        const answer = await ask(rl, `Quality issue in #${result.issueNum}? (y/n/skip all): `);
        if (answer === 'skip all') { skipAllQuality = true; break; }
        if (answer.toLowerCase() !== 'y') continue;

        const annotation = await promptQualityAnnotation(rl);

        const casePath = saveCapturedCase({
          issueNum: result.issueNum,
          title: result.title,
          issueBody: typeof result.result.issueBody === 'string' ? result.result.issueBody : undefined,
          step: annotation.whichStep,
          session: result.session,
          tags: [...(annotation.tags), 'quality-failure'],
          source: 'quality-capture',
        });

        const rubric = buildQualityRubric(annotation.whatWentWrong, annotation.whatShouldHaveHappened);
        annotateCapturedCase(casePath, {
          whatWentWrong: annotation.whatWentWrong,
          whatShouldHaveHappened: annotation.whatShouldHaveHappened,
          tags: [...(annotation.tags), 'quality-failure'],
          qualityRubric: rubric,
        });

        capturedCount++;
        log.success(`Quality eval case saved: ${casePath}`);
      }
    }

    if (capturedCount > 0) {
      console.log('');
      log.info(`Done. ${capturedCount} quality eval case(s) created. Run 'alpha-loop eval --suite step' to test.`);
    } else {
      log.info('No quality issues captured.');
    }
  } finally {
    rl.close();
  }
}

/**
 * List eval cases and recent scores.
 */
export function evalListCommand(): void {
  const cases = loadEvalCases();
  const dir = evalsDir(undefined, loadConfig().evalDir);

  if (cases.length === 0) {
    log.info('No eval cases found.');
    log.info(`Create eval cases in: ${dir}`);
    log.info('Or use `alpha-loop eval capture` to capture from failures.');
    return;
  }

  log.step(`Eval Cases (${cases.length}):`);
  console.log('');

  const fullCases = cases.filter((c) => c.type === 'full');
  const stepCases = cases.filter((c) => c.type === 'step');

  if (fullCases.length > 0) {
    console.log('  Full Pipeline:');
    for (const c of fullCases) {
      console.log(`    ${formatEvalCase(c)}`);
    }
  }

  if (stepCases.length > 0) {
    console.log('  Step-Level:');
    for (const c of stepCases) {
      console.log(`    ${formatEvalCase(c)}`);
    }
  }

  console.log('');

  // Show latest score
  const latest = latestScore(dir);
  if (latest) {
    console.log(`  Latest score: ${formatScoreEntry(latest)}`);
  }
}

/**
 * Show score history.
 */
export function evalScoresCommand(): void {
  const scores = readScores(evalsDir(undefined, loadConfig().evalDir));

  if (scores.length === 0) {
    log.info('No scores recorded yet. Run `alpha-loop eval` to generate scores.');
    return;
  }

  log.step(`Score History (${scores.length} entries):`);
  console.log('');

  // Show last 20 entries
  const recent = scores.slice(-20);
  for (const entry of recent) {
    console.log(`  ${formatScoreEntry(entry)}`);
  }

  console.log('');

  // Show trend
  if (scores.length >= 2) {
    const first = scores[0].composite;
    const last = scores[scores.length - 1].composite;
    const delta = last - first;
    const arrow = delta > 0 ? '+' : '';
    console.log(`  Trend: ${first} -> ${last} (${arrow}${delta.toFixed(2)})`);
  }
}

/**
 * Show score/cost Pareto frontier with ASCII chart.
 */
export function evalParetoCommand(): void {
  const config = loadConfig();
  const frontier = paretoFrontier(evalsDir(undefined, config.evalDir));

  if (frontier.length === 0) {
    log.info('No scores recorded yet. Run `alpha-loop eval` to generate scores.');
    return;
  }

  // Determine current config hash for marking
  const currentConfigObj: Record<string, unknown> = {
    agent: config.agent,
    model: config.model,
    reviewModel: config.reviewModel,
    pipeline: config.pipeline,
  };
  const currentHash = hashConfig(currentConfigObj);

  log.step(`Pareto Frontier (${frontier.length} entries):`);
  console.log('');
  console.log(formatParetoTable(frontier, currentHash));
}

/** All pipeline steps available for search. */
const ALL_PIPELINE_STEPS: PipelineStepName[] = ['plan', 'implement', 'test_fix', 'review', 'verify', 'learn'];

/** Default models to search over if not specified. */
const DEFAULT_SEARCH_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'];

/**
 * Greedy coordinate descent search over model/agent configs.
 *
 * Strategy:
 *   1. Establish baseline: run eval with current config → S₀, C₀
 *   2. For each pipeline step, try alternative models (holding others fixed)
 *   3. Keep Pareto-optimal changes (better score at ≤ cost, or same score at lower cost)
 *   4. Repeat until no step can be improved or budget is exhausted
 */
export async function evalSearchCommand(options: EvalSearchOptions): Promise<void> {
  const config = loadConfig();
  const cases = loadEvalCases();

  if (cases.length === 0) {
    log.warn('No eval cases found. Create some first with `alpha-loop eval capture`.');
    return;
  }

  const models = options.models?.split(',').map((m) => m.trim()) ?? DEFAULT_SEARCH_MODELS;
  const budget = parseInt(options.budget ?? options.maxRuns ?? '20', 10);
  const minScore = options.minScore ? parseFloat(options.minScore) : 0;
  const optimizeFor = options.optimize === 'cost' ? 'cost' : 'efficiency';
  const stepsToSearch: PipelineStepName[] = options.step
    ? [options.step as PipelineStepName]
    : ALL_PIPELINE_STEPS;

  log.step('Config Search (Greedy Coordinate Descent)');
  console.log(`  Models: ${models.join(', ')}`);
  console.log(`  Steps:  ${stepsToSearch.join(', ')}`);
  console.log(`  Budget: ${budget} eval runs`);
  console.log(`  Min score: ${minScore}`);
  console.log(`  Optimize: ${optimizeFor}`);
  console.log(`  Eval cases: ${cases.length}`);
  console.log('');

  let runsUsed = 0;
  const allResults: ScoreEntry[] = [];

  // Step 1: Establish baseline
  log.step('Step 1: Running baseline eval...');
  const baselineResult = await runEvalSuite(cases, config, { verbose: options.maxRuns === undefined });
  runsUsed++;

  const baselineScore = baselineResult.composite;
  const baselineCost = baselineResult.totalCost;

  const baselineConfigObj: Record<string, unknown> = {
    agent: config.agent,
    model: config.model,
    reviewModel: config.reviewModel,
    pipeline: config.pipeline,
  };
  allResults.push({
    timestamp: new Date().toISOString(),
    configHash: hashConfig(baselineConfigObj),
    config: baselineConfigObj,
    cases: baselineResult.cases.map((r) => ({
      caseId: r.caseId,
      passed: r.passed,
      partialCredit: r.partialCredit,
      retries: r.retries,
      duration: r.duration,
    })),
    composite: baselineScore,
    totalCost: baselineCost,
  });

  console.log(`  Baseline: score=${baselineScore.toFixed(1)}, cost=$${baselineCost.toFixed(2)}`);
  console.log('');

  // Track best config per step
  let currentPipeline: PipelineConfig = { ...config.pipeline };
  let bestScore = baselineScore;

  // Step 2: Sweep one step at a time
  log.step('Step 2: Sweeping pipeline steps...');

  for (const step of stepsToSearch) {
    if (runsUsed >= budget) {
      log.info(`  Budget exhausted (${runsUsed}/${budget} runs used). Stopping.`);
      break;
    }

    const currentResolved = resolveStepConfig({ ...config, pipeline: currentPipeline }, step);
    log.info(`  Sweeping step: ${step} (current: ${currentResolved.model})`);

    let stepBestScore = bestScore;
    let stepBestCost = baselineCost;
    let stepBestModel: string | null = null;

    for (const model of models) {
      if (runsUsed >= budget) break;
      if (model === currentResolved.model) continue; // skip current

      const override: PipelineConfig = {
        ...currentPipeline,
        [step]: { ...(currentPipeline[step] ?? {}), model },
      };

      log.info(`    Trying ${step}=${model}...`);

      const result = await runEvalSuite(cases, config, {
        configOverrides: override,
      });
      runsUsed++;

      const score = result.composite;
      const cost = result.totalCost;

      const configObj: Record<string, unknown> = {
        agent: config.agent,
        model: config.model,
        reviewModel: config.reviewModel,
        pipeline: override,
      };
      allResults.push({
        timestamp: new Date().toISOString(),
        configHash: hashConfig(configObj),
        config: configObj,
        cases: result.cases.map((r) => ({
          caseId: r.caseId,
          passed: r.passed,
          partialCredit: r.partialCredit,
          retries: r.retries,
          duration: r.duration,
        })),
        composite: score,
        totalCost: cost,
      });

      console.log(`    ${step}=${model}: score=${score.toFixed(1)}, cost=$${cost.toFixed(2)}`);

      // Check if this meets minimum score
      if (score < minScore) {
        console.log(`    Rejected: below min-score (${minScore})`);
        continue;
      }

      // Is this Pareto-optimal vs current best for this step?
      const isBetter = optimizeFor === 'cost'
        ? (score >= stepBestScore && cost < stepBestCost) || (score > stepBestScore && cost <= stepBestCost)
        : (score >= stepBestScore - 1 && cost < stepBestCost) || (score > stepBestScore);

      if (isBetter) {
        stepBestScore = score;
        stepBestCost = cost;
        stepBestModel = model;
      }
    }

    // Keep the best change for this step
    if (stepBestModel) {
      currentPipeline = {
        ...currentPipeline,
        [step]: { ...(currentPipeline[step] ?? {}), model: stepBestModel },
      };
      bestScore = stepBestScore;
      log.success(`  Adopted: ${step}=${stepBestModel} (score=${stepBestScore.toFixed(1)})`);
    } else {
      log.info(`  No improvement found for ${step}, keeping current.`);
    }
  }

  // Step 3: Report results
  console.log('');
  log.step('Search Complete');
  console.log(`  Runs used: ${runsUsed}/${budget}`);
  console.log(`  Baseline score: ${baselineScore.toFixed(1)}`);
  console.log(`  Final score: ${bestScore.toFixed(1)}`);
  console.log('');

  // Show final config
  log.step('Recommended Pipeline Config:');
  for (const step of ALL_PIPELINE_STEPS) {
    const resolved = resolveStepConfig({ ...config, pipeline: currentPipeline }, step);
    const override = currentPipeline[step];
    const marker = override?.model ? ' (changed)' : '';
    console.log(`  ${step.padEnd(12)} agent=${resolved.agent}  model=${resolved.model}${marker}`);
  }
  console.log('');

  // Show Pareto frontier from all results
  const frontier = buildParetoFrontier(allResults);
  if (frontier.length > 1) {
    log.step('Pareto Frontier from Search:');
    console.log('');
    console.log(formatParetoTable(frontier, allResults[0]?.configHash));
  }
}

export type EvalImportSwebenchOptions = {
  dataset?: string;
  datasetId?: string;
  count?: string;
  repo?: string;
  ids?: string;
  step?: string;
};

/**
 * Import SWE-bench cases from HuggingFace or a local JSONL file.
 *
 * Downloads entries from HuggingFace (requires Python + datasets library),
 * converts each to a directory-based eval case under .alpha-loop/evals/cases/e2e/,
 * and updates config.yaml with repo base commit mappings.
 */
export async function evalImportSwebenchCommand(options?: EvalImportSwebenchOptions): Promise<void> {
  const { importSwebench, listImportedSwebenchCases } = await import('../lib/eval-swebench.js');

  log.step('SWE-bench Import');

  const count = importSwebench({
    dataset: options?.dataset,
    datasetId: options?.datasetId,
    count: options?.count ? parseInt(options.count, 10) : undefined,
    repo: options?.repo,
    ids: options?.ids,
    step: options?.step ?? 'implement',
  });

  if (count > 0) {
    log.success(`Imported ${count} SWE-bench eval case(s).`);

    const existing = listImportedSwebenchCases();
    log.info(`Total SWE-bench cases: ${existing.length}`);
  }
}

export type EvalConvertOptions = {
  direction?: string;
  input?: string;
  output?: string;
};

/**
 * Convert between AlphaLoop eval format and skill-creator format.
 *
 * Directions:
 *   to-skill     — Convert AlphaLoop eval case → skill-creator evals.json
 *   from-skill   — Convert skill-creator evals.json → AlphaLoop eval cases
 */
export function evalConvertCommand(options: EvalConvertOptions): void {
  const direction = options.direction ?? 'to-skill';

  if (direction === 'to-skill') {
    // Load AlphaLoop eval cases and convert to skill-creator format
    const cases = loadEvalCases({
      type: 'step',
      step: 'skill' as PipelineStep,
    });

    if (cases.length === 0) {
      log.warn('No skill eval cases found. Create some in .alpha-loop/evals/cases/step/skill/');
      return;
    }

    const converted: SkillCreatorEval[] = cases.map(toSkillCreatorEval);

    for (const sc of converted) {
      console.log(JSON.stringify(sc, null, 2));
      console.log('');
    }

    log.info(`Converted ${cases.length} case(s) to skill-creator format.`);
  } else if (direction === 'from-skill') {
    if (!options.input) {
      log.warn('Provide --input <path> pointing to a skill-creator evals.json file.');
      return;
    }

    if (!existsSync(options.input)) {
      log.warn(`File not found: ${options.input}`);
      return;
    }

    const raw = JSON.parse(readFileSync(options.input, 'utf-8')) as SkillCreatorEval;
    const cases = fromSkillCreatorEvalAll(raw);

    for (const evalCase of cases) {
      const path = saveEvalCase(evalCase);
      log.success(`Created: ${path}`);
    }

    log.info(`Converted ${cases.length} skill-creator eval(s) to AlphaLoop format.`);
  } else {
    log.warn(`Unknown direction: ${direction}. Use 'to-skill' or 'from-skill'.`);
  }
}

export type EvalEstimateOptions = {
  config?: string;
};

/**
 * Estimate cost of running the eval suite with a given config.
 * Shows per-step breakdown using pricing table and average token estimates.
 */
export function evalEstimateCommand(options: EvalEstimateOptions): void {
  let config: Config;

  if (options.config) {
    // Load config from specified file
    if (!existsSync(options.config)) {
      log.warn(`Config file not found: ${options.config}`);
      return;
    }
    // parseYaml imported at top of file
    const raw = readFileSync(options.config, 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    config = loadConfig(parsed as Partial<Config>);
  } else {
    config = loadConfig();
  }

  const cases = loadEvalCases();
  if (cases.length === 0) {
    log.warn('No eval cases found.');
    return;
  }

  const estimate = estimateRunCost(cases.length, config);

  log.step('Cost Estimate');
  console.log(`  Eval cases: ${estimate.caseCount}`);
  console.log('');
  console.log('  Step          Model                     Cost/Case');
  console.log('  ----          -----                     ---------');

  for (const step of estimate.steps) {
    const stepName = step.step.padEnd(14);
    const modelName = step.model.padEnd(24);
    const cost = `$${step.costPerCase.toFixed(4)}`;
    console.log(`  ${stepName}  ${modelName}  ${cost}`);
  }

  console.log('');
  console.log(`  Total per case:  $${estimate.totalPerCase.toFixed(4)}`);
  console.log(`  Total for suite: $${estimate.totalForSuite.toFixed(2)} (${estimate.caseCount} cases)`);
}

export type EvalCompareConfigsOptions = {
  configA: string;
  configB: string;
};

/**
 * Compare two YAML config files side-by-side showing per-step model/agent differences.
 */
export function evalCompareConfigsCommand(configAPath: string, configBPath: string): void {
  if (!existsSync(configAPath)) {
    log.warn(`Config file not found: ${configAPath}`);
    return;
  }
  if (!existsSync(configBPath)) {
    log.warn(`Config file not found: ${configBPath}`);
    return;
  }

  const configA = loadConfig({ ...loadYamlOverrides(configAPath) });
  const configB = loadConfig({ ...loadYamlOverrides(configBPath) });

  const steps: PipelineStepName[] = ['plan', 'implement', 'test_fix', 'review', 'verify', 'learn'];

  log.step('Config Comparison');
  console.log('');
  console.log(`  Config A: ${configAPath}`);
  console.log(`  Config B: ${configBPath}`);
  console.log('');
  console.log('  Step          Config A                  Config B');
  console.log('  ----          --------                  --------');

  for (const step of steps) {
    const a = resolveStepConfig(configA, step);
    const b = resolveStepConfig(configB, step);
    const stepName = step.padEnd(14);
    const aDesc = `${a.agent}/${a.model || 'default'}`.padEnd(24);
    const bDesc = `${b.agent}/${b.model || 'default'}`;
    const marker = (a.agent !== b.agent || a.model !== b.model) ? ' ←' : '';
    console.log(`  ${stepName}  ${aDesc}  ${bDesc}${marker}`);
  }

  // Cost comparison
  const cases = loadEvalCases();
  if (cases.length > 0) {
    const estA = estimateRunCost(cases.length, configA);
    const estB = estimateRunCost(cases.length, configB);
    console.log('');
    console.log(`  Estimated cost (${cases.length} cases):`);
    console.log(`    Config A: $${estA.totalForSuite.toFixed(2)}`);
    console.log(`    Config B: $${estB.totalForSuite.toFixed(2)}`);
    const diff = estB.totalForSuite - estA.totalForSuite;
    const pct = estA.totalForSuite > 0 ? ((diff / estA.totalForSuite) * 100).toFixed(0) : '0';
    console.log(`    Delta: ${diff >= 0 ? '+' : ''}$${diff.toFixed(2)} (${diff >= 0 ? '+' : ''}${pct}%)`);
  }
}

/** Load a YAML file as partial config overrides. */
function loadYamlOverrides(path: string): Partial<Config> {
  // parseYaml imported at top of file
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') return {};

  const result: Partial<Config> = {};
  if (typeof parsed.agent === 'string') result.agent = parsed.agent as Config['agent'];
  if (typeof parsed.model === 'string') result.model = parsed.model;
  if (typeof parsed.review_model === 'string') result.reviewModel = parsed.review_model;

  // Parse pipeline
  if (parsed.pipeline && typeof parsed.pipeline === 'object') {
    const pipelineRaw = parsed.pipeline as Record<string, unknown>;
    const pipeline: PipelineConfig = {};
    const validSteps: PipelineStepName[] = ['plan', 'implement', 'test_fix', 'review', 'verify', 'learn'];
    for (const step of validSteps) {
      const entry = pipelineRaw[step];
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const stepCfg: StepConfig = {};
        if (typeof e.agent === 'string') stepCfg.agent = e.agent;
        if (typeof e.model === 'string') stepCfg.model = e.model;
        if (Object.keys(stepCfg).length > 0) pipeline[step] = stepCfg;
      }
    }
    if (Object.keys(pipeline).length > 0) result.pipeline = pipeline;
  }

  // Parse pricing
  if (parsed.pricing && typeof parsed.pricing === 'object') {
    const pricing: Record<string, { input: number; output: number }> = {};
    for (const [model, value] of Object.entries(parsed.pricing as Record<string, unknown>)) {
      const v = value as Record<string, unknown>;
      if (typeof v?.input === 'number' && typeof v?.output === 'number') {
        pricing[model] = { input: v.input, output: v.output };
      }
    }
    if (Object.keys(pricing).length > 0) result.pricing = pricing;
  }

  return result;
}

export type EvalExportOptions = {
  anonymize?: boolean;
  output?: string;
  pr?: boolean;
};

/**
 * Export an eval case for contributing back to alpha-loop.
 * Creates a contribution-ready directory with anonymized case files
 * and a PROMPT_CHANGES.md documenting local prompt modifications.
 */
export function evalExportCommand(caseId: string, options: EvalExportOptions): void {
  const projectDir = process.cwd();

  log.step(`Exporting eval case: ${caseId}`);

  try {
    const result = exportEvalCase(caseId, projectDir, {
      anonymize: options.anonymize !== false,
      outputDir: options.output,
    });

    log.success(`Exported to: ${result.outputDir}`);
    if (result.anonymized) {
      log.info('Project-specific details have been anonymized.');
      log.info('Review the output before submitting.');
    }
    if (result.promptChangesPath) {
      log.info(`Prompt changes documented: ${result.promptChangesPath}`);
    }

    if (options.pr) {
      log.info('');
      log.info('To submit a PR to alpha-loop:');
      log.info('  1. Fork https://github.com/bradtaylorsf/alpha-loop');
      log.info(`  2. Copy ${result.outputDir} to templates/evals/cases/ in your fork`);
      log.info('  3. Open a PR with the eval case and any prompt improvements');
    }
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
  }
}
