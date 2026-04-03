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
} from '../lib/eval.js';
import type { EvalCase, ExpectedOutcome } from '../lib/eval.js';
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
  formatScoreEntry,
  compareRuns,
} from '../lib/score.js';
import {
  listTraceSessions,
  listTraceIssues,
  readTraceMetadata,
  readTrace,
} from '../lib/traces.js';
import { runEvalSuite } from '../lib/eval-runner.js';

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
};

export type EvalSearchOptions = {
  models?: string;
  agents?: string;
  maxRuns?: string;
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
    step: options.step as any,
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
    console.log(`  ${icon}  ${caseResult.caseId}  ${caseResult.duration}s${credit}${error}`);
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
      for (const [_session, failures] of grouped) {
        for (const failure of failures) {
          const answer = await ask(rl, `Capture #${failure.issueNum}? (y/n/skip all): `);
          if (answer === 'skip all') break;
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
 * Show score/cost Pareto frontier.
 */
export function evalParetoCommand(): void {
  const frontier = paretoFrontier(evalsDir(undefined, loadConfig().evalDir));

  if (frontier.length === 0) {
    log.info('No scores recorded yet.');
    return;
  }

  log.step(`Pareto Frontier (${frontier.length} entries):`);
  console.log('');
  console.log('  Score    Cost      Config');
  console.log('  -----    ----      ------');

  for (const entry of frontier) {
    const score = entry.composite.toFixed(2).padStart(6);
    const cost = `$${entry.totalCost.toFixed(2)}`.padStart(8);
    console.log(`  ${score}    ${cost}    ${entry.configHash}`);
  }
}

/**
 * Greedy search over model/agent configs.
 */
export async function evalSearchCommand(options: EvalSearchOptions): Promise<void> {
  const config = loadConfig();
  const cases = loadEvalCases();

  if (cases.length === 0) {
    log.warn('No eval cases found. Create some first with `alpha-loop eval capture`.');
    return;
  }

  const models = options.models?.split(',') ?? [config.model || 'default'];
  const agents = options.agents?.split(',') ?? [config.agent];
  const maxRuns = parseInt(options.maxRuns ?? '10', 10);

  log.step('Config Search');
  console.log(`  Models: ${models.join(', ')}`);
  console.log(`  Agents: ${agents.join(', ')}`);
  console.log(`  Eval cases: ${cases.length}`);
  console.log(`  Max runs: ${maxRuns}`);
  console.log('');

  // Generate config variants
  const variants: Array<{ agent: string; model: string }> = [];
  for (const agent of agents) {
    for (const model of models) {
      variants.push({ agent, model });
    }
  }

  log.info(`Generated ${variants.length} config variant(s).`);
  log.info('To execute: run `alpha-loop eval` with each config variant.');
  log.info('Results will be tracked in scores.jsonl for comparison.');
  console.log('');

  for (let i = 0; i < Math.min(variants.length, maxRuns); i++) {
    const v = variants[i];
    console.log(`  ${i + 1}. agent=${v.agent} model=${v.model}`);
  }

  // Show current best
  const configs = scoresByConfig(evalsDir(undefined, config.evalDir));
  if (configs.length > 0) {
    console.log('');
    log.step('Current Rankings:');
    for (const c of configs.slice(0, 5)) {
      const best = Math.max(...c.scores.map((s) => s.composite));
      console.log(`  ${c.configHash}: best=${best.toFixed(2)} (${c.scores.length} runs)`);
    }
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
      step: 'skill' as any,
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
