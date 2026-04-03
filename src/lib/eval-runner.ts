/**
 * Eval Runner — executes eval cases against the pipeline or individual steps.
 *
 * For e2e cases: clones fixture repo, runs processIssue(), runs acceptance checks.
 * For step cases: loads input, runs a single pipeline step, checks output.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { log } from './logger.js';
import { exec } from './shell.js';
import { spawnAgent } from './agent.js';
import { buildImplementPrompt, buildReviewPrompt, buildLearnPrompt } from './prompts.js';
import { processIssue } from './pipeline.js';
import { runChecks } from './eval-checks.js';
import { computeCompositeScore, appendScore, hashConfig } from './score.js';
import {
  writeTrace,
  writeTraceMetadata,
  writeRunManifest,
  writeConfigSnapshot,
  writeScores as writeTraceScores,
  computeScores as computeTraceScores,
} from './traces.js';
import {
  loadEvalConfig,
  cloneOrCacheFixtureRepo,
  extractFixture,
  setupFixture as runFixtureSetup,
  cleanupFixture,
} from './eval-fixtures.js';
import { estimateCost, resolveStepConfig } from './config.js';
import type { Config, PipelineConfig, PipelineStepName } from './config.js';
import type { CheckDefinition } from './eval-checks.js';
import type { EvalCase, EvalResult, EvalSuiteResult } from './eval.js';
import type { CaseResult, ScoreEntry } from './score.js';
import type { SessionContext } from './session.js';
import type { PipelineResult } from './pipeline.js';

/** Options for running the eval suite. */
export type EvalRunOptions = {
  /** Only run this specific case ID (prefix match). */
  caseId?: string;
  /** Verbose output. */
  verbose?: boolean;
  /** Pipeline config overrides to merge into config before running. */
  configOverrides?: PipelineConfig;
};

/** Extended eval case with parsed check definitions. */
export type EvalCaseWithChecks = EvalCase & {
  checks?: CheckDefinition[];
  /** For step cases: raw input text. */
  inputText?: string;
};

/**
 * Run a full eval suite: iterate over cases, execute, collect results.
 */
export async function runEvalSuite(
  cases: EvalCaseWithChecks[],
  config: Config,
  options: EvalRunOptions = {},
): Promise<EvalSuiteResult> {
  // Apply pipeline config overrides if provided
  if (options.configOverrides) {
    const mergedPipeline: PipelineConfig = { ...config.pipeline };
    for (const [step, override] of Object.entries(options.configOverrides)) {
      mergedPipeline[step as PipelineStepName] = {
        ...(mergedPipeline[step as PipelineStepName] ?? {}),
        ...override,
      };
    }
    config = { ...config, pipeline: mergedPipeline };
  }

  const session = `eval-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const results: EvalResult[] = [];
  let totalCost = 0;

  // Snapshot harness for tracking
  const harnessHash = snapshotHarness(config);

  log.step(`Eval run: ${session} (${cases.length} cases, harness=${harnessHash})`);

  // Write config snapshot to traces
  try {
    writeConfigSnapshot(session, JSON.stringify(config, null, 2));
  } catch { /* non-fatal */ }

  for (const evalCase of cases) {
    if (options.caseId && !evalCase.id.startsWith(options.caseId)) continue;

    log.step(`Running: ${evalCase.id} — ${evalCase.description}`);
    const startTime = Date.now();

    try {
      const result = evalCase.type === 'step'
        ? await runStepEval(evalCase, config, session, options)
        : await runE2eEval(evalCase, config, session, options);

      results.push(result);
      if (options.verbose) {
        const icon = result.passed ? 'PASS' : 'FAIL';
        log.info(`  ${icon}: ${evalCase.id} (${result.duration}s, credit=${result.partialCredit})`);
      }
    } catch (err) {
      const duration = Math.round((Date.now() - startTime) / 1000);
      results.push({
        caseId: evalCase.id,
        passed: false,
        partialCredit: 0,
        retries: 0,
        duration,
        error: err instanceof Error ? err.message : String(err),
        details: { successMatch: false, filesMatch: false, testsMatch: false, diffMatch: false, outputMatch: false },
      });
      log.warn(`  ERROR: ${evalCase.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Compute composite score
  const caseResults: CaseResult[] = results.map((r) => ({
    caseId: r.caseId,
    passed: r.passed,
    partialCredit: r.partialCredit,
    retries: r.retries,
    duration: r.duration,
    error: r.error,
  }));

  const composite = computeCompositeScore(caseResults);
  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.length - passCount;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  // Record to score history
  const configObj: Record<string, unknown> = {
    agent: config.agent,
    model: config.model,
    reviewModel: config.reviewModel,
    maxTestRetries: config.maxTestRetries,
    testCommand: config.testCommand,
    harnessHash,
    pipeline: config.pipeline,
  };

  const entry: ScoreEntry = {
    timestamp: new Date().toISOString(),
    configHash: hashConfig(configObj),
    config: configObj,
    cases: caseResults,
    composite,
    totalCost,
  };

  appendScore(join(process.cwd(), config.evalDir), entry);

  // Write trace scores
  try {
    const traceResults = results.map((r) => ({
      issueNum: parseInt(r.caseId.match(/\d+/)?.[0] ?? '0') || 0,
      status: r.passed ? 'success' as const : 'failure' as const,
      testsPassing: r.details.testsMatch,
      verifyPassing: false,
      verifySkipped: true,
      retries: r.retries,
      duration: r.duration,
      filesChanged: 0,
      stepsCompleted: [],
    }));
    writeTraceScores(session, computeTraceScores(traceResults));
  } catch { /* non-fatal */ }

  // Write run manifest
  try {
    const gitState = getGitState();
    writeRunManifest(session, {
      runId: session,
      startedAt: new Date(Date.now() - totalDuration * 1000).toISOString(),
      completedAt: new Date().toISOString(),
      issues: results.map((r) => parseInt(r.caseId.replace(/\D/g, '')) || 0),
      config: {
        agent: String(config.agent),
        model: String(config.model),
        reviewModel: String(config.reviewModel),
        testCommand: String(config.testCommand),
        baseBranch: String(config.baseBranch),
      },
      gitState: {
        branch: gitState.branch,
        commit: gitState.commit,
      },
      totalDuration,
    });
  } catch { /* non-fatal */ }

  return { cases: results, composite, totalDuration, passCount, failCount };
}

/**
 * Run a single e2e eval case.
 * Clones/resets the fixture repo, runs processIssue, checks results.
 */
async function runE2eEval(
  evalCase: EvalCaseWithChecks,
  config: Config,
  session: string,
  options: EvalRunOptions,
): Promise<EvalResult> {
  const startTime = Date.now();
  const projectDir = process.cwd();
  const fixtureDir = prepareFixture(evalCase, projectDir);

  try {
    // Create a minimal session context for the pipeline
    const evalSession: SessionContext = {
      name: session,
      branch: `eval/${evalCase.id}`,
      resultsDir: join(projectDir, '.alpha-loop', 'sessions', session),
      logsDir: join(projectDir, '.alpha-loop', 'sessions', session, 'logs'),
      results: [],
    };
    mkdirSync(evalSession.resultsDir, { recursive: true });
    mkdirSync(evalSession.logsDir, { recursive: true });

    // Override config for eval context
    const evalConfig: Config = {
      ...config,
      skipReview: config.skipReview,
      autoMerge: false,
      evalTimeout: evalCase.timeout || config.evalTimeout,
    };

    // Run the pipeline
    const issueNum = parseInt(evalCase.id.replace(/\D/g, '')) || 9999;
    const pipelineResult = await processIssue(
      issueNum,
      evalCase.issueTitle,
      evalCase.issueBody,
      evalConfig,
      evalSession,
    );

    // Collect actual results for evaluation
    const diff = getDiff(fixtureDir);
    const filesChanged = getFilesChanged(fixtureDir);
    const duration = Math.round((Date.now() - startTime) / 1000);

    // Run checks if defined
    if (evalCase.checks && evalCase.checks.length > 0) {
      const checkResults = await runChecks(evalCase.checks, {
        cwd: fixtureDir,
        testCommand: config.testCommand,
        diff,
        filesChanged,
        output: '',
      });

      return {
        caseId: evalCase.id,
        passed: checkResults.allPassed,
        partialCredit: checkResults.avgScore,
        retries: 0,
        duration,
        details: {
          successMatch: pipelineResult.status === 'success' === evalCase.expected.success,
          filesMatch: checkResults.results.some((r) => r.passed),
          testsMatch: pipelineResult.testsPassing === (evalCase.expected.testsPassing ?? true),
          diffMatch: checkResults.allPassed,
          outputMatch: true,
        },
      };
    }

    // Fall back to legacy evaluation
    const { evaluateResult } = await import('./eval.js');
    return evaluateResult(evalCase, {
      success: pipelineResult.status === 'success',
      testsPassing: pipelineResult.testsPassing,
      diff,
      filesChanged,
      output: '',
      retries: 0,
      duration,
    });
  } finally {
    // Clean up fixture
    try {
      if (fixtureDir.includes('.worktrees/eval-')) {
        rmSync(fixtureDir, { recursive: true, force: true });
      }
    } catch { /* non-fatal */ }
  }
}

/**
 * Run a single step-level eval case.
 * Loads input, runs the targeted step, checks output.
 */
async function runStepEval(
  evalCase: EvalCaseWithChecks,
  config: Config,
  session: string,
  options: EvalRunOptions,
): Promise<EvalResult> {
  const startTime = Date.now();
  const input = evalCase.inputText ?? evalCase.issueBody;
  const step = evalCase.step ?? 'review';

  // Map eval step names to PipelineStepName for resolveStepConfig
  const pipelineStepMap: Record<string, PipelineStepName> = {
    plan: 'plan',
    implement: 'implement',
    'test-fix': 'test_fix',
    review: 'review',
    verify: 'verify',
    learn: 'learn',
  };

  // Resolve per-step agent/model from pipeline config (falls back to top-level)
  const pipelineStep = pipelineStepMap[step];
  const resolved = pipelineStep
    ? resolveStepConfig(config, pipelineStep)
    : { agent: config.agent as string, model: config.model };
  const resolvedAgent = resolved.agent as Config['agent'];

  let output = '';

  try {
    // Run the targeted pipeline step
    switch (step) {
      case 'plan': {
        const result = await spawnAgent({
          agent: resolvedAgent,
          model: resolved.model,
          prompt: `Plan the implementation for the following issue:\n\n${input}`,
          cwd: process.cwd(),
          timeout: (evalCase.timeout || 60) * 1000,
        });
        output = result.output;
        break;
      }
      case 'implement': {
        const prompt = buildImplementPrompt({
          issueNum: 0,
          title: evalCase.issueTitle,
          body: input,
        });
        const result = await spawnAgent({
          agent: resolvedAgent,
          model: resolved.model,
          prompt,
          cwd: process.cwd(),
          timeout: (evalCase.timeout || 120) * 1000,
        });
        output = result.output;
        break;
      }
      case 'review': {
        const prompt = buildReviewPrompt({
          issueNum: 0,
          title: evalCase.issueTitle,
          body: input,
          baseBranch: config.baseBranch,
        });
        const result = await spawnAgent({
          agent: resolvedAgent,
          model: resolved.model,
          prompt,
          cwd: process.cwd(),
          timeout: (evalCase.timeout || 60) * 1000,
        });
        output = result.output;
        break;
      }
      case 'test': {
        const result = exec(config.testCommand || 'npm test', {
          cwd: process.cwd(),
          timeout: (evalCase.timeout || 120) * 1000,
        });
        output = result.stdout + '\n' + result.stderr;
        break;
      }
      case 'verify': {
        output = 'Verify step eval not yet supported';
        break;
      }
      case 'learn': {
        const prompt = buildLearnPrompt({
          issueNum: 0,
          title: evalCase.issueTitle || 'Eval learn case',
          status: 'failure',
          retries: 0,
          duration: 0,
          diff: '',
          testOutput: '',
          reviewOutput: '',
          verifyOutput: '',
          body: input,
        });
        const result = await spawnAgent({
          agent: resolvedAgent,
          model: config.evalModel || resolved.model,
          prompt,
          cwd: process.cwd(),
          timeout: (evalCase.timeout || 60) * 1000,
          maxTurns: 1,
        });
        output = result.output;
        break;
      }
      case 'skill': {
        // Skill evals: spawn agent with the skill context from input
        const result = await spawnAgent({
          agent: config.agent,
          model: config.evalModel || config.model,
          prompt: input,
          cwd: process.cwd(),
          timeout: (evalCase.timeout || 60) * 1000,
        });
        output = result.output;
        break;
      }
      case 'test-fix': {
        // Test-fix evals: provide failing test output + code, ask agent to fix
        const prompt = `The following test is failing. Diagnose the root cause and fix it.\n\n${input}`;
        const result = await spawnAgent({
          agent: resolvedAgent,
          model: resolved.model,
          prompt,
          cwd: process.cwd(),
          timeout: (evalCase.timeout || 120) * 1000,
        });
        output = result.output;
        break;
      }
    }
  } catch (err) {
    output = `Step ${step} failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const duration = Math.round((Date.now() - startTime) / 1000);

  // Run checks
  if (evalCase.checks && evalCase.checks.length > 0) {
    const checkResults = await runChecks(evalCase.checks, {
      cwd: process.cwd(),
      output,
      judgeModel: config.evalModel || undefined,
    });

    return {
      caseId: evalCase.id,
      passed: checkResults.allPassed,
      partialCredit: checkResults.avgScore,
      retries: 0,
      duration,
      details: {
        successMatch: true,
        filesMatch: true,
        testsMatch: true,
        diffMatch: checkResults.allPassed,
        outputMatch: true,
      },
    };
  }

  // Fall back to legacy output-contains check
  const outputMatch = evalCase.expected.outputContains
    ? evalCase.expected.outputContains.every((s) => output.includes(s))
    : true;

  return {
    caseId: evalCase.id,
    passed: outputMatch,
    partialCredit: outputMatch ? 1 : 0,
    retries: 0,
    duration,
    details: {
      successMatch: true,
      filesMatch: true,
      testsMatch: true,
      diffMatch: true,
      outputMatch,
    },
  };
}

/**
 * Prepare a fixture directory for an e2e eval case.
 *
 * Supports three modes:
 *   1. Monorepo fixture — fixtureRepo matches a name in config.yaml fixture_repo.fixtures
 *   2. Remote/local repo — fixtureRepo is a GitHub owner/repo or local path
 *   3. Current project — fixtureRepo is empty, uses the current project as fixture
 */
export function prepareFixture(evalCase: EvalCase, projectDir: string): string {
  const fixtureDir = resolve(projectDir, '.worktrees', `eval-${evalCase.id}`);
  const evalDir = join(projectDir, '.alpha-loop', 'evals');
  const evalConfig = loadEvalConfig(evalDir);

  // Clean up any existing fixture
  if (existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
  mkdirSync(fixtureDir, { recursive: true });

  const repo = evalCase.fixtureRepo;
  const ref = evalCase.fixtureRef || 'main';

  // Mode 1: Monorepo fixture — repo name matches a configured fixture
  if (evalConfig.fixture_repo && evalConfig.fixture_repo.fixtures[repo]) {
    const repoDir = cloneOrCacheFixtureRepo(evalConfig.fixture_repo, projectDir);
    extractFixture(repoDir, repo, evalConfig.fixture_repo, fixtureDir);
    const entry = evalConfig.fixture_repo.fixtures[repo];
    runFixtureSetup(fixtureDir, entry);
    return fixtureDir;
  }

  // Mode 1b: SWE-bench repo — look up base_commit from config
  if (evalConfig.swebench_repos && evalCase.source === 'swe-bench') {
    const repoConfig = evalConfig.swebench_repos[repo];
    if (repoConfig) {
      // Clone the repo at the base commit
      const url = `https://github.com/${repo}.git`;
      log.info(`Cloning SWE-bench repo ${repo}...`);
      const cloneResult = exec(`git clone ${url} ${fixtureDir}`, { timeout: 120_000 });
      if (cloneResult.exitCode !== 0) {
        throw new Error(`Failed to clone SWE-bench repo ${repo}: ${cloneResult.stderr}`);
      }
      // Checkout base commit
      const checkout = exec(`git checkout ${ref}`, { cwd: fixtureDir, timeout: 30_000 });
      if (checkout.exitCode !== 0) {
        throw new Error(`Failed to checkout ${ref}: ${checkout.stderr}`);
      }
      return fixtureDir;
    }
  }

  // Mode 2: Remote or local repo
  if (repo.includes('/') && !existsSync(repo)) {
    // Remote repo — clone it
    const cloneResult = exec(
      `git clone --depth 1 --branch ${ref} https://github.com/${repo}.git ${fixtureDir}`,
      { timeout: 120_000 },
    );
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Failed to clone fixture repo ${repo}: ${cloneResult.stderr}`);
    }
  } else if (existsSync(repo)) {
    // Local repo — copy via git worktree or clone
    const cloneResult = exec(
      `git clone --local --branch ${ref} ${repo} ${fixtureDir}`,
      { timeout: 30_000 },
    );
    if (cloneResult.exitCode !== 0) {
      throw new Error(`Failed to clone local fixture ${repo}: ${cloneResult.stderr}`);
    }
  } else {
    // Mode 3: Use current project as fixture
    const result = exec(`git worktree add ${fixtureDir} ${ref} --detach`, {
      cwd: projectDir,
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      // Worktree might already exist, try direct clone
      exec(`git clone --local --branch ${ref} ${projectDir} ${fixtureDir}`, { timeout: 30_000 });
    }
  }

  return fixtureDir;
}

/** Read all files in a directory recursively, sorted, and concatenate contents. */
function readDirContentsSorted(dirPath: string): string {
  const entries = readdirSync(dirPath, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath ?? d.path, d.name))
    .sort();
  return files.map((f) => readFileSync(f, 'utf-8')).join('\n');
}

/**
 * Snapshot the current harness state (prompts + skills + config) as a hash.
 */
export function snapshotHarness(config: Config): string {
  const parts: string[] = [];

  // Hash config
  parts.push(JSON.stringify({
    agent: config.agent,
    model: config.model,
    reviewModel: config.reviewModel,
    testCommand: config.testCommand,
    maxTestRetries: config.maxTestRetries,
  }));

  // Hash skills directory
  const skillsDir = join(process.cwd(), '.alpha-loop', 'templates', 'skills');
  if (existsSync(skillsDir)) {
    try {
      parts.push(readDirContentsSorted(skillsDir));
    } catch { /* non-fatal */ }
  }

  // Hash agent prompts
  const agentsDir = join(process.cwd(), '.alpha-loop', 'templates', 'agents');
  if (existsSync(agentsDir)) {
    try {
      parts.push(readDirContentsSorted(agentsDir));
    } catch { /* non-fatal */ }
  }

  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
}

/** Get the current git diff in a directory. */
function getDiff(cwd: string): string {
  try {
    const result = exec('git diff HEAD', { cwd, timeout: 10_000 });
    return result.stdout;
  } catch {
    return '';
  }
}

/** Get list of changed files in a directory. */
function getFilesChanged(cwd: string): string[] {
  try {
    const result = exec('git diff HEAD --name-only', { cwd, timeout: 10_000 });
    return result.stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Get current git state for manifest. */
function getGitState(): Record<string, string> {
  try {
    const branch = exec('git rev-parse --abbrev-ref HEAD', { timeout: 5000 }).stdout.trim();
    const commit = exec('git rev-parse HEAD', { timeout: 5000 }).stdout.trim();
    return { branch, commit };
  } catch {
    return { branch: 'unknown', commit: 'unknown' };
  }
}

/** Default average token estimates per pipeline step (input, output). */
const DEFAULT_TOKEN_ESTIMATES: Record<PipelineStepName, { input: number; output: number }> = {
  plan: { input: 5000, output: 2000 },
  implement: { input: 30000, output: 15000 },
  test_fix: { input: 20000, output: 10000 },
  review: { input: 25000, output: 5000 },
  verify: { input: 15000, output: 3000 },
  learn: { input: 10000, output: 3000 },
};

/** Estimate per-step token averages from historical score data. */
function historicalTokenAverages(
  evalsDir: string,
): Record<string, { input: number; output: number }> | null {
  // Token-level tracking isn't in scores.jsonl today, so return null
  // to fall back to defaults. This hook exists for future enhancement.
  return null;
}

export type CostEstimate = {
  steps: Array<{
    step: PipelineStepName;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costPerCase: number;
  }>;
  totalPerCase: number;
  totalForSuite: number;
  caseCount: number;
};

/**
 * Estimate the cost of running an eval suite with a given config.
 * Uses average token counts from previous runs if available,
 * otherwise falls back to default estimates.
 */
export function estimateRunCost(
  caseCount: number,
  config: Config,
): CostEstimate {
  const steps: CostEstimate['steps'] = [];
  const pipelineSteps: PipelineStepName[] = ['plan', 'implement', 'test_fix', 'review', 'verify', 'learn'];

  // Try historical averages first
  const historical = historicalTokenAverages(join(process.cwd(), config.evalDir));

  for (const step of pipelineSteps) {
    const { model } = resolveStepConfig(config, step);
    const tokens = (historical && historical[step]) ?? DEFAULT_TOKEN_ESTIMATES[step];
    const costPerCase = estimateCost(model, tokens.input, tokens.output, config.pricing);

    steps.push({
      step,
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      costPerCase,
    });
  }

  const totalPerCase = steps.reduce((sum, s) => sum + s.costPerCase, 0);

  return {
    steps,
    totalPerCase,
    totalForSuite: totalPerCase * caseCount,
    caseCount,
  };
}
