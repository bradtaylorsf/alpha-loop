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
  formatEvalCase,
  evalsDir,
} from '../lib/eval.js';
import type { EvalCase, ExpectedOutcome } from '../lib/eval.js';
import {
  readScores,
  latestScore,
  scoresByConfig,
  paretoFrontier,
  formatScoreEntry,
} from '../lib/score.js';
import {
  listTraceSessions,
  listTraceIssues,
  readTraceMetadata,
  readTrace,
} from '../lib/traces.js';

export type EvalOptions = {
  tags?: string;
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
  const cases = loadEvalCases({
    tags: options.tags?.split(','),
    type: options.type,
    step: options.step as any,
  });

  if (cases.length === 0) {
    log.warn('No eval cases found. Use `alpha-loop eval capture` to create some.');
    log.info(`Eval cases directory: ${evalsDir()}`);
    return;
  }

  log.step(`Running ${cases.length} eval case(s)...`);
  console.log('');

  for (const evalCase of cases) {
    console.log(`  ${formatEvalCase(evalCase)}`);
  }

  console.log('');
  log.info('Eval execution requires fixture repos and agent invocation.');
  log.info('Use `alpha-loop eval search` for automated config comparison.');
  log.info('');

  // Show current scores
  const latest = latestScore(evalsDir());
  if (latest) {
    log.info(`Latest score: ${formatScoreEntry(latest)}`);
  } else {
    log.info('No scores recorded yet. Run evals to generate scores.');
  }
}

/**
 * Capture a failure as an eval case — interactive walkthrough.
 */
export async function evalCaptureCommand(options: EvalCaptureOptions): Promise<void> {
  const config = loadConfig();

  if (options.issue) {
    // Capture a specific issue
    await captureSpecificIssue(parseInt(options.issue, 10), config);
    return;
  }

  // Walk through recent failures from sessions
  const sessionsDir = join(process.cwd(), '.alpha-loop', 'sessions');
  if (!existsSync(sessionsDir)) {
    log.warn('No sessions found. Run `alpha-loop run` first to generate session data.');
    return;
  }

  // Find session directories with results
  const sessionDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  if (sessionDirs.length === 0) {
    log.warn('No session data found.');
    return;
  }

  // Collect failures from recent sessions
  const failures: Array<{ session: string; issueNum: number; title: string; file: string }> = [];

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
          });
        }
      } catch {
        // Skip malformed result files
      }
    }
  }

  if (failures.length === 0) {
    log.info('No failures found in recent sessions. Nothing to capture.');
    return;
  }

  log.step(`Found ${failures.length} failure(s) in recent sessions:`);
  console.log('');

  for (let i = 0; i < failures.length; i++) {
    const f = failures[i];
    console.log(`  ${i + 1}. #${f.issueNum}: ${f.title} (${f.session})`);
  }

  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const choice = await ask(rl, 'Capture which failure? (number, or "all", or "q" to quit): ');

    if (choice === 'q' || choice === '') {
      log.info('Cancelled.');
      return;
    }

    if (choice === 'all') {
      for (const failure of failures) {
        await captureFailure(rl, failure, config);
      }
    } else {
      const idx = parseInt(choice, 10) - 1;
      if (idx >= 0 && idx < failures.length) {
        await captureFailure(rl, failures[idx], config);
      } else {
        log.warn('Invalid choice.');
      }
    }
  } finally {
    rl.close();
  }
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

  console.log(`\n  Issue: #${issueNum} — ${metadata.title}`);
  console.log(`  Status: ${metadata.status}`);
  console.log(`  Duration: ${metadata.duration}s, Retries: ${metadata.retries}`);
  if (plan) console.log(`  Plan: available`);
  if (diff) console.log(`  Diff: ${diff.length} chars`);
  console.log('');

  const description = await ask(rl, 'Description (what this eval tests): ');
  const shouldSucceed = await ask(rl, 'Should the agent succeed? (y/n): ');
  const tagsInput = await ask(rl, 'Tags (comma-separated, e.g. typescript,refactor): ');

  const evalCase: EvalCase = {
    id: `issue-${issueNum}`,
    description: description || `Eval case captured from issue #${issueNum}`,
    type: 'full',
    fixtureRepo: config.repo,
    fixtureRef: 'main',
    issueTitle: metadata.title,
    issueBody: `Captured from issue #${issueNum} (session: ${session})`,
    expected: {
      success: shouldSucceed.toLowerCase() === 'y',
      testsPassing: shouldSucceed.toLowerCase() === 'y',
    },
    tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean),
    timeout: 0,
    source: 'auto-capture',
  };

  const filePath = saveEvalCase(evalCase);
  log.success(`Eval case saved: ${filePath}`);
}

/** Capture a failure from session result as an eval case. */
async function captureFailure(
  rl: readline.Interface,
  failure: { session: string; issueNum: number; title: string; file: string },
  config: Config,
): Promise<void> {
  log.step(`\nCapturing: #${failure.issueNum} — ${failure.title}`);

  const result = JSON.parse(readFileSync(failure.file, 'utf-8'));

  console.log(`  Status: ${result.status}`);
  console.log(`  Tests: ${result.testsPassing ? 'passing' : 'failing'}`);
  console.log(`  Duration: ${result.duration}s`);
  console.log(`  Files changed: ${result.filesChanged}`);
  console.log('');

  const description = await ask(rl, '  Description (what this eval tests): ');
  const shouldSucceed = await ask(rl, '  Expected: should succeed? (y/n): ');
  const tagsInput = await ask(rl, '  Tags (comma-separated): ');

  const evalCase: EvalCase = {
    id: `issue-${failure.issueNum}`,
    description: description || `Captured from failed issue #${failure.issueNum}`,
    type: 'full',
    fixtureRepo: config.repo,
    fixtureRef: 'main',
    issueTitle: failure.title,
    issueBody: `Captured from session ${failure.session}, issue #${failure.issueNum}`,
    expected: {
      success: shouldSucceed.toLowerCase() === 'y',
      testsPassing: shouldSucceed.toLowerCase() === 'y',
    },
    tags: tagsInput.split(',').map((t) => t.trim()).filter(Boolean),
    timeout: 0,
    source: 'auto-capture',
  };

  const filePath = saveEvalCase(evalCase);
  log.success(`Eval case saved: ${filePath}`);
}

/**
 * List eval cases and recent scores.
 */
export function evalListCommand(): void {
  const cases = loadEvalCases();
  const dir = evalsDir();

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
  const scores = readScores(evalsDir());

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
  const frontier = paretoFrontier(evalsDir());

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
  const configs = scoresByConfig(evalsDir());
  if (configs.length > 0) {
    console.log('');
    log.step('Current Rankings:');
    for (const c of configs.slice(0, 5)) {
      const best = Math.max(...c.scores.map((s) => s.composite));
      console.log(`  ${c.configHash}: best=${best.toFixed(2)} (${c.scores.length} runs)`);
    }
  }
}

/**
 * Import SWE-bench cases (placeholder — requires HuggingFace download).
 */
export async function evalImportSwebenchCommand(): Promise<void> {
  log.step('SWE-bench Import');
  log.info('');
  log.info('SWE-bench integration imports real GitHub issues with validated patches.');
  log.info('');
  log.info('Setup:');
  log.info('  1. Clone the alpha-loop-evals fixture monorepo');
  log.info('  2. Download SWE-bench dataset from HuggingFace:');
  log.info('     princeton-nlp/SWE-bench');
  log.info('  3. Run: alpha-loop eval import-swebench --dataset <path>');
  log.info('');
  log.info('Each SWE-bench instance becomes an eval case with:');
  log.info('  - fixture_repo: the target repo at the specific commit');
  log.info('  - issue_body: the original GitHub issue description');
  log.info('  - expected: validated patch as ground truth');
  log.info('');
  log.info('This is planned for M2 (Eval Content). See issue #95.');
}
