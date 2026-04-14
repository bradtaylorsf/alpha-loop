/**
 * Process Issue Pipeline — the 12-step orchestration for a single issue.
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';
import { exec } from './shell.js';
import { spawnAgent } from './agent.js';
import { setupWorktree, cleanupWorktree } from './worktree.js';
import {
  assignIssue,
  labelIssue,
  commentIssue,
  createPR,
  mergePR,
  updateProjectStatus,
  getIssueComments,
  type Comment,
} from './github.js';
import {
  buildImplementPrompt,
  buildReviewPrompt,
  buildAssumptionsPrompt,
  buildBatchPlanPrompt,
  buildBatchImplementPrompt,
  buildBatchReviewPrompt,
  type BatchIssue,
} from './prompts.js';
import { runTests } from './testing.js';
import { runVerify } from './verify.js';
import { extractLearnings, getLearningContext } from './learning.js';
import { saveResult, getPreviousResult } from './session.js';
import {
  writeTrace,
  writeTraceMetadata,
  writeTraceToSubdir,
  writeRunManifest,
  writeConfigSnapshot,
  writeScores,
  writeCosts,
  computeScores,
  computeCosts,
} from './traces.js';
import type { StepCost, PipelineResultForScores } from './traces.js';
import { estimateCost } from './config.js';
import type { Config } from './config.js';
import type { AgentResult } from './agent.js';
import type { SessionContext } from './session.js';

/** Max diff size to include in learning analysis. */
const MAX_DIFF_CHARS = 10_000;

/**
 * Build a StepCost entry from an AgentResult.
 * Uses parsed cost/tokens if available, otherwise estimates from output length.
 */
function buildStepCost(
  step: string,
  issueNum: number,
  agentResult: AgentResult,
  config: Config,
): StepCost {
  const model = agentResult.model || config.model;
  if (agentResult.costUsd != null && agentResult.inputTokens != null && agentResult.outputTokens != null) {
    return {
      step,
      issueNum,
      model,
      input_tokens: agentResult.inputTokens,
      output_tokens: agentResult.outputTokens,
      cost_usd: agentResult.costUsd,
    };
  }
  // Fallback: estimate tokens from output length (chars / 4 ≈ tokens)
  const estimatedOutputTokens = Math.round(agentResult.output.length / 4);
  const estimatedInputTokens = Math.round(estimatedOutputTokens * 1.3);
  const costUsd = estimateCost(model, estimatedInputTokens, estimatedOutputTokens, config.pricing);
  return {
    step,
    issueNum,
    model,
    input_tokens: estimatedInputTokens,
    output_tokens: estimatedOutputTokens,
    cost_usd: costUsd,
  };
}

/** Record a prompt trace to the prompts/ subdirectory. */
function tracePrompt(session: string, issueNum: number, step: string, prompt: string): void {
  try {
    writeTraceToSubdir(session, 'prompts', `issue-${issueNum}-${step}.md`, prompt);
  } catch { /* non-fatal */ }
}

/** Record an agent output trace to the outputs/ subdirectory. */
function traceOutput(session: string, issueNum: number, step: string, output: string): void {
  try {
    writeTraceToSubdir(session, 'outputs', `issue-${issueNum}-${step}.log`, output);
  } catch { /* non-fatal */ }
}

/** Record a diff trace to the diffs/ subdirectory. */
function traceDiff(session: string, issueNum: number, step: string, diff: string): void {
  try {
    writeTraceToSubdir(session, 'diffs', `issue-${issueNum}-${step}.patch`, diff);
  } catch { /* non-fatal */ }
}

/** Record a test output trace to the tests/ subdirectory. */
function traceTest(session: string, issueNum: number, attempt: number, output: string): void {
  try {
    writeTraceToSubdir(session, 'tests', `issue-${issueNum}-test-${attempt}.txt`, output);
  } catch { /* non-fatal */ }
}

/** Record a verify output trace to the verify/ subdirectory. */
function traceVerify(session: string, issueNum: number, attempt: number, output: string): void {
  try {
    writeTraceToSubdir(session, 'verify', `issue-${issueNum}-verify-${attempt}.txt`, output);
  } catch { /* non-fatal */ }
}

/** Patterns that indicate a transient agent error (re-queue, don't mark as failed). */
const TRANSIENT_ERROR_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /too many requests/i,
  /quota exceeded/i,
  /capacity/i,
  /try again/i,
];

/** Sentinel appended by agent.ts when the process is killed for exceeding the timeout. */
const TIMEOUT_SENTINEL = '[TIMEOUT]';

/**
 * Check if agent output indicates a transient error (usage limits, rate limits).
 * These issues should be re-queued, not marked as permanently failed.
 *
 * Only scans the last portion of the output to avoid false positives from
 * code the agent wrote (e.g. an exceptions.py containing "rate limit").
 * Timeouts are never classified as transient — they indicate the task
 * exceeded the configured time limit and should fail permanently.
 */
function isTransientError(output: string): boolean {
  // Timeouts are not transient — the agent ran out of time, not a rate limit
  if (output.includes(TIMEOUT_SENTINEL)) return false;

  // Only scan the last 2000 chars to avoid matching code the agent wrote
  const tail = output.slice(-2000);
  return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(tail));
}

/**
 * Structured plan output from the planning agent.
 * Controls which pipeline steps run and how.
 */
export type IssuePlan = {
  summary: string;
  files: string[];
  implementation: string;
  testing: {
    needed: boolean;
    reason: string;
  };
  verification: {
    needed: boolean;
    instructions?: string;
    reason: string;
    /** Verification method: playwright (default), cli, api, boot, or script. */
    method?: 'playwright' | 'cli' | 'api' | 'boot' | 'script';
    /** Shell command for script/cli/boot/api verification methods. */
    command?: string;
  };
};

/**
 * Structured gate result written by review/verify agents as JSON files.
 * The orchestrator reads these to decide: continue or loop back to implementer.
 */
export type GateResult = {
  passed: boolean;
  summary: string;
  findings: Array<{
    severity: 'critical' | 'warning' | 'info';
    description: string;
    fixed: boolean;
    file?: string;
  }>;
};

/** Default gate result when agent doesn't write one (assume pass). */
const DEFAULT_GATE: GateResult = {
  passed: true,
  summary: 'Gate agent did not write a result file — assuming pass',
  findings: [],
};

/** Default plan when planning fails or is skipped. */
const DEFAULT_PLAN: IssuePlan = {
  summary: '',
  files: [],
  implementation: '',
  testing: { needed: true, reason: 'Default: run project test command' },
  verification: { needed: false, reason: 'Default: skip verification unless plan requests it' },
};

/**
 * Read and validate a plan JSON file written by the planning agent.
 * Falls back to DEFAULT_PLAN if the file doesn't exist or is invalid.
 */
function readPlan(planFile: string): IssuePlan {
  try {
    if (!existsSync(planFile)) return DEFAULT_PLAN;

    const raw = readFileSync(planFile, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const verificationRaw = parsed.verification as any;
    const validMethods = ['playwright', 'cli', 'api', 'boot', 'script'];
    const verifyMethod = validMethods.includes(verificationRaw?.method) ? verificationRaw.method : undefined;

    return {
      summary: String(parsed.summary ?? ''),
      files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
      implementation: String(parsed.implementation ?? ''),
      testing: {
        needed: (parsed.testing as any)?.needed !== false,
        reason: String((parsed.testing as any)?.reason ?? 'No reason given'),
      },
      verification: {
        needed: verificationRaw?.needed === true,
        instructions: verificationRaw?.instructions || undefined,
        reason: String(verificationRaw?.reason ?? 'No reason given'),
        method: verifyMethod,
        command: verificationRaw?.command ? String(verificationRaw.command) : undefined,
      },
    };
  } catch {
    return DEFAULT_PLAN;
  }
}

/**
 * Read and validate a gate result JSON file written by review/verify agents.
 * Falls back to DEFAULT_GATE if the file doesn't exist or is invalid.
 */
export function readGateResult(gateFile: string): GateResult {
  try {
    if (!existsSync(gateFile)) return DEFAULT_GATE;

    const raw = readFileSync(gateFile, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return {
      passed: parsed.passed === true,
      summary: String(parsed.summary ?? ''),
      findings: Array.isArray(parsed.findings)
        ? (parsed.findings as Array<Record<string, unknown>>).map((f) => ({
            severity: (['critical', 'warning', 'info'].includes(String(f.severity)) ? f.severity : 'info') as 'critical' | 'warning' | 'info',
            description: String(f.description ?? ''),
            fixed: f.fixed === true,
            file: f.file ? String(f.file) : undefined,
          }))
        : [],
    };
  } catch {
    return DEFAULT_GATE;
  }
}

/**
 * Move a JSON file from worktree to session logs dir (for inspection).
 * Deletes the source file from the worktree. Non-fatal on failure.
 */
function moveToSessionLogs(src: string, dest: string): void {
  try {
    if (!existsSync(src)) return;
    const content = readFileSync(src, 'utf-8');
    writeFileSync(dest, content);
    unlinkSync(src);
  } catch { /* non-fatal */ }
}

/**
 * Format gate findings into a prompt section for the implementer.
 */
export function formatGateFindings(gate: GateResult, gateType: string): string {
  const unfixed = gate.findings.filter((f) => !f.fixed);
  if (unfixed.length === 0) return '';

  const lines = [`## ${gateType} Findings (MUST FIX)`, '', gate.summary, ''];
  for (const f of unfixed) {
    const fileRef = f.file ? ` (${f.file})` : '';
    lines.push(`- [${f.severity.toUpperCase()}]${fileRef} ${f.description}`);
  }
  return lines.join('\n');
}

export type PipelineResult = {
  issueNum: number;
  title: string;
  status: 'success' | 'failure';
  /** Why the issue failed — 'transient' means re-queue (e.g. usage limit), 'permanent' means label failed. */
  failureReason?: 'transient' | 'permanent';
  prUrl?: string;
  testsPassing: boolean;
  verifyPassing: boolean;
  verifySkipped: boolean;
  duration: number;
  filesChanged: number;
};

/**
 * Process a single issue through the full pipeline.
 * Steps: status → worktree → plan → implement → test+retry → verify+retry →
 *        review → PR → learnings → update → auto-merge → cleanup
 */
export async function processIssue(
  issueNum: number,
  title: string,
  body: string,
  config: Config,
  session: SessionContext,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const projectDir = process.cwd();
  const stepCosts: StepCost[] = [];
  const stepsCompleted: string[] = [];

  // Setup logging
  mkdirSync(session.logsDir, { recursive: true });
  const logFile = join(session.logsDir, `issue-${issueNum}.log`);

  log.step(`Processing Issue #${issueNum}: ${title}`);

  // --- Step 1: Update status ---
  log.step('Step 1: Updating issue status');
  if (!config.dryRun) {
    updateProjectStatus(config.repo, config.project, config.repoOwner, issueNum, 'In progress');
    labelIssue(config.repo, issueNum, 'in-progress', config.labelReady);
    assignIssue(config.repo, issueNum, '@me');
  } else {
    log.dry('Would update issue status to in-progress');
  }

  // --- Step 2: Setup worktree ---
  log.step('Step 2: Setting up worktree');
  let worktreePath: string;
  let worktreeBranch: string;
  let worktreeResumed = false;

  try {
    const wt = await setupWorktree({
      issueNum,
      projectDir,
      baseBranch: config.baseBranch,
      sessionBranch: session.branch,
      autoMerge: config.autoMerge,
      skipInstall: config.skipInstall,
      setupCommand: config.setupCommand,
      dryRun: config.dryRun,
    });
    worktreePath = wt.path;
    worktreeBranch = wt.branch;
    worktreeResumed = wt.resumed;
  } catch (err) {
    log.error(`Failed to set up worktree for issue #${issueNum}: ${err}`);
    if (!config.dryRun) {
      // Re-queue instead of marking failed — this is a setup issue, not an implementation failure
      requeueIssue(config, issueNum);
    }
    return failureResult(issueNum, title, startTime);
  }

  // --- Step 3: Plan (structured JSON — controls test/verify steps) ---
  log.step('Step 3: Planning');
  let plan: IssuePlan = DEFAULT_PLAN;
  // Write plan inside the worktree (agents sandbox to their CWD), then move to sessions dir
  const planFileInWorktree = join(worktreePath, `plan-issue-${issueNum}.json`);
  const planFileInSession = join(session.logsDir, `plan-issue-${issueNum}.json`);
  if (!config.dryRun) {
    try {
      const planPrompt = `Analyze this GitHub issue and produce a structured implementation plan.

Issue #${issueNum}: ${title}

${body}

Write a JSON file to: plan-issue-${issueNum}.json

The file must contain ONLY valid JSON with this exact schema:

{
  "summary": "One-line description of what needs to be done",
  "files": ["src/path/to/file.ts", "..."],
  "implementation": "Concise step-by-step plan. What to create, modify, wire up. No issue restatement.",
  "testing": {
    "needed": true,
    "reason": "Why tests are or aren't needed for this change"
  },
  "verification": {
    "needed": false,
    "method": "playwright",
    "command": "optional shell command for script/cli/boot/api methods",
    "instructions": "If needed: specific steps to verify the feature. If not needed: omit this field.",
    "reason": "Why verification is or isn't needed"
  }
}

Rules:
- testing.needed: true if ANY code changes could affect behavior. false only for docs, config, or comments.
- verification.needed: true if the issue changes behavior that can be validated at runtime.
- verification.method: "playwright" for UI changes, "script" for validation scripts, "boot" for service startup checks, "cli" for CLI testing, "api" for API endpoint testing.
- verification.command: required for script/cli/boot/api methods — the shell command to run. Exit code 0 = pass.
- verification.instructions: for playwright method, list the exact playwright-cli commands to verify.
- implementation: be concise and actionable. List files to modify and what to change in each.
- Write ONLY the JSON file. Do not create any other files or make any code changes.`;

      // Trace the plan prompt
      tracePrompt(session.name, issueNum, 'plan', planPrompt);

      const planResult = await spawnAgent({
        agent: config.agent,
        model: config.model,
        prompt: planPrompt,
        cwd: worktreePath,
        logFile: join(session.logsDir, `issue-${issueNum}-plan.log`),
        verbose: config.verbose,
        timeout: config.agentTimeout * 1000,
      });

      // Trace the plan output and costs
      traceOutput(session.name, issueNum, 'plan', planResult.output);
      stepCosts.push(buildStepCost('plan', issueNum, planResult, config));

      // Detect transient errors (usage limits) during planning
      if (planResult.exitCode !== 0 && isTransientError(planResult.output)) {
        log.warn(`Agent hit a transient error during planning for #${issueNum} — re-queuing`);
        requeueIssue(config, issueNum);
        await cleanupWorktree({ issueNum, projectDir, autoCleanup: config.autoCleanup });
        return failureResult(issueNum, title, startTime, 'transient');
      }

      plan = readPlan(planFileInWorktree);
      stepsCompleted.push('plan');
      if (plan.summary) {
        // Move plan from worktree to sessions dir for inspection, clean up worktree
        moveToSessionLogs(planFileInWorktree, planFileInSession);
        log.success(`Plan: ${plan.summary} | Tests: ${plan.testing.needed ? 'yes' : 'skip'} | Verify: ${plan.verification.needed ? 'yes' : 'skip'}`);
      } else {
        log.warn('Planning agent did not write plan file, using defaults (run all tests, skip verify)');
      }
    } catch {
      log.warn('Planning stage failed, using defaults');
    }
  } else {
    log.dry('Would run planning agent');
  }

  // --- Step 3b: Fetch issue comments for full context ---
  let issueComments: Comment[] = [];
  if (!config.dryRun) {
    issueComments = getIssueComments(config.repo, issueNum);
    if (issueComments.length > 0) {
      log.info(`Loaded ${issueComments.length} comment(s) from issue #${issueNum}`);
    }
  }

  // --- Step 4: Implement ---
  log.step('Step 4: Implementing');
  // Build resume context if worktree was recovered from a previous session
  const resumeNote = worktreeResumed
    ? `**IMPORTANT: This worktree contains work from a previous session that was interrupted.**
Run \`git log --oneline -10\` to see what has already been done.
Do NOT redo work that is already committed. Build on top of existing progress.\n\n`
    : '';

  if (!config.dryRun) {
    // Load vision and project context
    const visionContext = loadFileIfExists(join(projectDir, '.alpha-loop', 'vision.md'));
    const projectContext = loadFileIfExists(join(projectDir, '.alpha-loop', 'context.md'));
    const previousResult = getPreviousResult(session);
    const learningContext = getLearningContext(join(projectDir, '.alpha-loop', 'learnings'));

    const implementPrompt = resumeNote + buildImplementPrompt({
      issueNum,
      title,
      body,
      comments: issueComments.length > 0 ? issueComments : undefined,
      planContent: plan.implementation || undefined,
      visionContext: visionContext ?? undefined,
      projectContext: projectContext ?? undefined,
      previousResult: previousResult ?? undefined,
      learningContext: learningContext || undefined,
    });

    // Trace the implement prompt
    tracePrompt(session.name, issueNum, 'implement', implementPrompt);

    const implResult = await spawnAgent({
      agent: config.agent,
      model: config.model,
      prompt: implementPrompt,
      cwd: worktreePath,

      logFile: join(session.logsDir, `issue-${issueNum}-implement.log`),
      verbose: config.verbose,
      timeout: config.agentTimeout * 1000,
    });

    // Trace the implement output and costs
    traceOutput(session.name, issueNum, 'implement', implResult.output);
    stepCosts.push(buildStepCost('implement', issueNum, implResult, config));

    if (implResult.exitCode !== 0) {
      // Auto-commit any uncommitted work before deciding on cleanup
      const dirtyCheck = exec('git status --porcelain', { cwd: worktreePath });
      if (dirtyCheck.stdout.trim()) {
        exec('git add -A', { cwd: worktreePath });
        exec(`git commit -m "wip: partial implementation of #${issueNum} (agent timed out or failed)"`, { cwd: worktreePath });
      }

      if (isTransientError(implResult.output)) {
        log.warn(`Agent hit a transient error during implementation for #${issueNum} — re-queuing`);
        requeueIssue(config, issueNum);
        await cleanupWorktree({ issueNum, projectDir, autoCleanup: config.autoCleanup, preserveIfCommits: true });
        return failureResult(issueNum, title, startTime, 'transient');
      }
      log.error(`Implementation failed for issue #${issueNum}`);
      labelIssue(config.repo, issueNum, 'failed', 'in-progress');
      commentIssue(config.repo, issueNum, 'Agent loop failed during implementation. See logs for details.');
      await cleanupWorktree({ issueNum, projectDir, autoCleanup: config.autoCleanup, preserveIfCommits: true });
      return failureResult(issueNum, title, startTime, 'permanent');
    }

    // Auto-commit if agent didn't
    const statusResult = exec('git status --porcelain', { cwd: worktreePath });
    if (statusResult.stdout.trim()) {
      exec('git add -A', { cwd: worktreePath });
      exec(`git commit -m "feat: implement issue #${issueNum} - ${title}"`, { cwd: worktreePath });
    }

    stepsCompleted.push('implement');

    // Capture implement diff
    try {
      const implDiff = exec(`git diff "origin/${config.baseBranch}...HEAD"`, { cwd: worktreePath });
      if (implDiff.stdout) traceDiff(session.name, issueNum, 'implement', implDiff.stdout);
    } catch { /* non-fatal */ }
  } else {
    log.dry('Would run implementation agent');
  }

  // --- Step 5: Test + retry loop ---
  log.step('Step 5: Running tests');
  let testOutput = '';
  let testsPassing = false;
  let testRetries = 0;

  if (!plan.testing.needed) {
    log.info(`Tests skipped by plan: ${plan.testing.reason}`);
    testsPassing = true;
    testOutput = `Tests skipped by plan: ${plan.testing.reason}`;
  }

  for (let attempt = 1; testsPassing ? false : attempt <= config.maxTestRetries; attempt++) {
    log.info(`Test attempt ${attempt} of ${config.maxTestRetries}`);

    const testResult = runTests(worktreePath, config, logFile);
    testOutput = testResult.output;

    // Trace test output
    traceTest(session.name, issueNum, attempt, testOutput);

    if (testResult.passed) {
      testsPassing = true;
      stepsCompleted.push('test');
      log.success(`All tests passed on attempt ${attempt}`);
      break;
    }

    if (attempt < config.maxTestRetries) {
      testRetries++;
      log.warn(`Tests failed on attempt ${attempt}, invoking agent to fix...`);
      if (!config.dryRun) {
        const fixPrompt = `Tests are failing for issue #${issueNum} (attempt ${attempt} of ${config.maxTestRetries}). Fix the failing tests.\n\nTest output:\n${testOutput}\n\nInstructions:\n1. Read the failing test output carefully and identify the ROOT CAUSE\n2. Fix ONLY code related to issue #${issueNum} — do NOT modify test infrastructure, build scripts, or unrelated files\n3. If tests fail due to environment issues (missing venv, wrong port, missing deps), fix only YOUR code — do NOT rewrite the test runner or package.json scripts\n4. Run the tests again to verify\n5. Commit your fixes with a DESCRIPTIVE message that explains WHAT you fixed and WHY it failed.\n   Format: fix(#${issueNum}): <what you changed> — <why it was failing>\n   Example: fix(#${issueNum}): use port 5435 for postgres — default 5432 conflicts with host service\n   DO NOT use generic messages like "fix: resolve test failures"`;

        // Trace fix prompt
        tracePrompt(session.name, issueNum, `fix-${attempt}`, fixPrompt);

        const fixResult = await spawnAgent({
          agent: config.agent,
          model: config.model,
          prompt: fixPrompt,
          cwd: worktreePath,
          resume: true,
          logFile: join(session.logsDir, `issue-${issueNum}-fix-${attempt}.log`),
          verbose: config.verbose,
          timeout: config.agentTimeout * 1000,
        });

        // Trace fix output and costs
        traceOutput(session.name, issueNum, `fix-${attempt}`, fixResult.output);
        stepCosts.push(buildStepCost('test_fix', issueNum, fixResult, config));
        stepsCompleted.push(`fix-${attempt}`);

        // Auto-commit fixes
        const fixStatus = exec('git status --porcelain', { cwd: worktreePath });
        if (fixStatus.stdout.trim()) {
          exec('git add -A', { cwd: worktreePath });
          exec(`git commit -m "fix(#${issueNum}): resolve test failures (attempt ${attempt})"`, { cwd: worktreePath });
        }

        // Capture fix diff
        try {
          const fixDiffResult = exec(`git diff "origin/${config.baseBranch}...HEAD"`, { cwd: worktreePath });
          if (fixDiffResult.stdout) traceDiff(session.name, issueNum, `fix-${attempt}`, fixDiffResult.stdout);
        } catch { /* non-fatal */ }
      }
    } else {
      log.warn(`Tests still failing after ${config.maxTestRetries} attempts`);
      testOutput = `TESTS FAILED after ${config.maxTestRetries} fix attempts. Latest output:\n${testOutput}`;
    }
  }

  // --- Step 6: Review gate (JSON-based) ---
  log.step('Step 6: Code review');
  let reviewOutput = '';
  let reviewGate: GateResult = DEFAULT_GATE;

  if (config.skipReview) {
    log.info('Code review skipped');
  } else if (config.dryRun) {
    log.dry('Would run code review');
  } else {
    const reviewFileInWorktree = join(worktreePath, `review-issue-${issueNum}.json`);
    const reviewFileInSession = join(session.logsDir, `review-issue-${issueNum}.json`);

    for (let attempt = 1; attempt <= config.maxTestRetries; attempt++) {
      log.info(`Review attempt ${attempt} of ${config.maxTestRetries}`);

      try {
        const reviewPrompt = buildReviewPrompt({
          issueNum,
          title,
          body,
          comments: issueComments.length > 0 ? issueComments : undefined,
          baseBranch: config.baseBranch,
          visionContext: loadFileIfExists(join(projectDir, '.alpha-loop', 'vision.md')) ?? undefined,
        });

        // Trace review prompt
        tracePrompt(session.name, issueNum, `review${attempt > 1 ? `-${attempt}` : ''}`, reviewPrompt);

        const reviewResult = await spawnAgent({
          agent: config.agent,
          model: config.reviewModel,
          prompt: reviewPrompt,
          cwd: worktreePath,
          logFile: join(session.logsDir, `issue-${issueNum}-review${attempt > 1 ? `-${attempt}` : ''}.log`),
          verbose: config.verbose,
          timeout: config.agentTimeout * 1000,
        });

        // Trace review output and costs
        traceOutput(session.name, issueNum, `review${attempt > 1 ? `-${attempt}` : ''}`, reviewResult.output);
        stepCosts.push(buildStepCost('review', issueNum, reviewResult, config));

        reviewOutput = reviewResult.output;
      } catch {
        log.warn('Code review failed, continuing without review');
        reviewOutput = 'Code review could not be completed';
        break;
      }

      // Read the gate JSON
      reviewGate = readGateResult(reviewFileInWorktree);
      moveToSessionLogs(reviewFileInWorktree, reviewFileInSession);

      if (reviewGate.passed) {
        stepsCompleted.push('review');
        log.success(`Review passed: ${reviewGate.summary || 'no issues found'}`);
        break;
      }

      // Review found unfixed issues — loop back to implementer
      const unfixedCount = reviewGate.findings.filter((f) => !f.fixed).length;
      log.warn(`Review found ${unfixedCount} unfixed issue(s), sending back to implementer...`);

      if (attempt < config.maxTestRetries) {
        const findings = formatGateFindings(reviewGate, 'Code Review');
        const fixPrompt = `The code review for issue #${issueNum} found problems that need to be fixed.\n\n${findings}\n\nInstructions:\n1. Address each finding listed above\n2. Run tests to make sure nothing is broken\n3. Commit your fixes with: git commit -m "fix(#${issueNum}): address review findings"`;

        // Trace review-fix prompt
        tracePrompt(session.name, issueNum, `review-fix-${attempt}`, fixPrompt);

        const reviewFixResult = await spawnAgent({
          agent: config.agent,
          model: config.model,
          prompt: fixPrompt,
          cwd: worktreePath,
          resume: true,
          logFile: join(session.logsDir, `issue-${issueNum}-review-fix-${attempt}.log`),
          verbose: config.verbose,
          timeout: config.agentTimeout * 1000,
        });

        // Trace review-fix output and costs
        traceOutput(session.name, issueNum, `review-fix-${attempt}`, reviewFixResult.output);
        stepCosts.push(buildStepCost('review', issueNum, reviewFixResult, config));

        // Auto-commit if agent didn't
        const fixStatus = exec('git status --porcelain', { cwd: worktreePath });
        if (fixStatus.stdout.trim()) {
          exec('git add -A', { cwd: worktreePath });
          exec(`git commit -m "fix(#${issueNum}): address review findings (attempt ${attempt})"`, { cwd: worktreePath });
        }

        // Re-run tests before next review attempt
        const retest = runTests(worktreePath, config, logFile);
        if (!retest.passed) {
          log.warn('Tests failed after review fixes — will be caught in final status');
          testOutput = retest.output;
          testsPassing = false;
        }
      } else {
        log.warn(`Review still failing after ${config.maxTestRetries} attempts`);
      }
    }
  }

  // --- Step 7: Verify gate (JSON-based) ---
  log.step('Step 7: Live verification');
  let verifyOutput = '';
  let verifyPassing = false;
  let verifySkipped = false;

  if (!plan.verification.needed) {
    log.info(`Verification skipped by plan: ${plan.verification.reason}`);
    verifyPassing = true;
    verifySkipped = true;
    verifyOutput = `Verification skipped by plan: ${plan.verification.reason}`;
  }

  if (!verifySkipped && !config.dryRun) {
    const verifyFileInWorktree = join(worktreePath, `verify-issue-${issueNum}.json`);
    const verifyFileInSession = join(session.logsDir, `verify-issue-${issueNum}.json`);

    for (let attempt = 1; attempt <= config.maxTestRetries; attempt++) {
      log.info(`Verification attempt ${attempt} of ${config.maxTestRetries}`);

      const verifyResult = await runVerify({
        worktree: worktreePath,
        logFile,
        issueNum,
        title,
        body,
        config,
        sessionDir: session.resultsDir,
        verifyInstructions: plan.verification.instructions,
        verifyMethod: plan.verification.method,
        verifyCommand: plan.verification.command,
      });
      verifyOutput = verifyResult.output;

      // Trace verify output
      traceVerify(session.name, issueNum, attempt, verifyOutput);

      if (verifyResult.skipped) {
        verifyPassing = true;
        verifySkipped = true;
        break;
      }

      // Read verify gate JSON (if the verify agent wrote one)
      const verifyGate = readGateResult(verifyFileInWorktree);
      moveToSessionLogs(verifyFileInWorktree, verifyFileInSession);

      // Use gate JSON if available, otherwise fall back to runVerify's pass/fail
      const passed = verifyGate !== DEFAULT_GATE ? verifyGate.passed : verifyResult.passed;

      if (passed) {
        verifyPassing = true;
        stepsCompleted.push('verify');
        log.success(`Verification passed on attempt ${attempt}`);
        break;
      }

      if (attempt < config.maxTestRetries) {
        const timedOut = verifyOutput.includes('[TIMEOUT]');
        if (timedOut) {
          log.warn(`Verification timed out on attempt ${attempt}, retrying...`);
        } else {
          log.warn(`Verification failed on attempt ${attempt}, sending back to implementer...`);

          // Use gate findings if available, otherwise use raw verify output
          const findings = verifyGate !== DEFAULT_GATE
            ? formatGateFindings(verifyGate, 'Verification')
            : `## Verification Findings (MUST FIX)\n\n${verifyOutput}`;

          const fixPrompt = `Live verification failed for issue #${issueNum} (attempt ${attempt} of ${config.maxTestRetries}).\n\n${findings}\n\nInstructions:\n1. Read the verification findings and identify the ROOT CAUSE\n2. Fix ONLY code related to issue #${issueNum}\n3. Run tests to make sure nothing is broken\n4. Commit your fixes with: git commit -m "fix(#${issueNum}): address verification findings"`;

          // Trace verify-fix prompt
          tracePrompt(session.name, issueNum, `verify-fix-${attempt}`, fixPrompt);

          const verifyFixResult = await spawnAgent({
            agent: config.agent,
            model: config.model,
            prompt: fixPrompt,
            cwd: worktreePath,
            resume: true,
            logFile: join(session.logsDir, `issue-${issueNum}-verify-fix-${attempt}.log`),
            verbose: config.verbose,
            timeout: config.agentTimeout * 1000,
          });

          // Trace verify-fix output and costs
          traceOutput(session.name, issueNum, `verify-fix-${attempt}`, verifyFixResult.output);
          stepCosts.push(buildStepCost('verify', issueNum, verifyFixResult, config));

          // Auto-commit if agent didn't
          const fixStatus = exec('git status --porcelain', { cwd: worktreePath });
          if (fixStatus.stdout.trim()) {
            exec('git add -A', { cwd: worktreePath });
            exec(`git commit -m "fix(#${issueNum}): address verification findings (attempt ${attempt})"`, { cwd: worktreePath });
          }

          // Re-run tests before next verify attempt
          const retest = runTests(worktreePath, config, logFile);
          if (!retest.passed) {
            log.warn('Tests failed after verify fixes');
            testOutput = retest.output;
            testsPassing = false;
          }
        }
      } else {
        log.warn(`Verification still failing after ${config.maxTestRetries} attempts`);
      }
    }
  } else if (config.dryRun && !verifySkipped) {
    log.dry('Would run live verification');
    verifyPassing = true;
    verifySkipped = true;
  }

  // --- Step 7b: Smoke test (if configured) ---
  if (config.smokeTest && !config.dryRun) {
    log.step('Step 7b: Running smoke test');
    const smokeResult = exec(config.smokeTest, { cwd: worktreePath, timeout: 60_000 });
    if (smokeResult.exitCode === 0) {
      log.success('Smoke test passed');
    } else {
      log.warn(`Smoke test failed (exit ${smokeResult.exitCode}): ${smokeResult.stderr || smokeResult.stdout}`);
    }
  }

  // --- Step 8: Create PR ---
  log.step('Step 8: Creating PR');
  let prUrl: string | undefined;

  if (!config.dryRun) {
    const prBase = config.autoMerge ? session.branch : config.baseBranch;
    const prBody = buildPRBody(issueNum, title, reviewGate, testOutput, testsPassing, verifyPassing, verifySkipped, body);

    try {
      prUrl = createPR({
        repo: config.repo,
        base: prBase,
        head: worktreeBranch,
        title: `feat: ${title} (closes #${issueNum})`,
        body: prBody,
        cwd: worktreePath,
      });
      stepsCompleted.push('pr');
      log.success(`PR created: ${prUrl}`);
    } catch (err) {
      log.error(`Failed to create PR for issue #${issueNum}: ${err}`);
      labelIssue(config.repo, issueNum, 'failed', 'in-progress');
      commentIssue(config.repo, issueNum, `Agent loop failed: could not create PR. Branch: ${worktreeBranch}`);
      log.warn(`Worktree preserved at ${worktreePath} — use "alpha-loop resume --issue ${issueNum}" to retry`);
      return failureResult(issueNum, title, startTime);
    }
  } else {
    log.dry('Would create PR');
  }

  // --- Step 8b: Post assumptions/decisions comment ---
  if (!config.dryRun && prUrl) {
    try {
      const assumptionsDiff = exec(`git diff "origin/${config.baseBranch}...HEAD"`, { cwd: worktreePath });
      const reviewSummary = reviewGate.summary || 'No review findings';
      const assumptionsPrompt = buildAssumptionsPrompt({
        issueNum,
        title,
        body,
        diff: assumptionsDiff.stdout,
        reviewSummary,
      });

      tracePrompt(session.name, issueNum, 'assumptions', assumptionsPrompt);

      const assumptionsResult = await spawnAgent({
        agent: config.agent,
        model: config.model,
        prompt: assumptionsPrompt,
        cwd: worktreePath,
        logFile: join(session.logsDir, `issue-${issueNum}-assumptions.log`),
        verbose: config.verbose,
        timeout: config.agentTimeout * 1000,
      });

      traceOutput(session.name, issueNum, 'assumptions', assumptionsResult.output);
      stepCosts.push(buildStepCost('assumptions', issueNum, assumptionsResult, config));

      if (assumptionsResult.exitCode === 0 && assumptionsResult.output.trim()) {
        commentIssue(config.repo, issueNum,
          `## AI Implementation Notes\n\n${assumptionsResult.output.trim()}\n\n---\n_Posted by alpha-loop for user validation._`,
        );
        log.success('Posted assumptions/decisions comment');
      }
    } catch (err) {
      log.warn(`Failed to post assumptions comment: ${err}`);
    }
  }

  // --- Step 9: Extract learnings ---
  log.step('Step 9: Extracting learnings');
  const duration = Math.round((Date.now() - startTime) / 1000);

  // Get diff for learning analysis
  let runDiff = '';
  if (!config.dryRun) {
    const diffResult = exec(`git diff "origin/${config.baseBranch}...HEAD"`, { cwd: worktreePath });
    runDiff = diffResult.stdout.slice(0, MAX_DIFF_CHARS);
  }

  // Format review gate for learnings
  const reviewForLearnings = reviewGate.findings.length > 0
    ? `Review: ${reviewGate.summary}\n${reviewGate.findings.map((f) => `- [${f.severity}] ${f.description} (${f.fixed ? 'fixed' : 'unfixed'})`).join('\n')}`
    : `Review: ${reviewGate.summary || 'passed'}`;

  await extractLearnings({
    issueNum,
    title,
    status: testsPassing ? 'success' : 'failure',
    retries: testRetries,
    duration,
    diff: runDiff,
    testOutput,
    reviewOutput: reviewForLearnings,
    verifyOutput,
    body,
    config,
    sessionLogsDir: session.logsDir,
    sessionName: session.name,
  });

  // --- Step 9b: Write full traces (Meta-Harness style) ---
  stepsCompleted.push('learn');
  const filesChanged = runDiff ? (runDiff.match(/^diff --git/gm) ?? []).length : 0;

  if (!config.dryRun) {
    try {
      // Per-issue metadata (backward compat)
      writeTraceMetadata(session.name, issueNum, {
        issueNum,
        title,
        status: testsPassing ? 'success' : 'failure',
        duration,
        retries: testRetries,
        testsPassing,
        verifyPassing,
        verifySkipped,
        filesChanged,
        prUrl,
        timestamp: new Date().toISOString(),
        agent: config.agent,
        model: config.model,
      });
      if (runDiff) writeTrace(session.name, issueNum, 'diff.patch', runDiff);
      if (testOutput) writeTrace(session.name, issueNum, 'test-output.txt', testOutput);
      if (reviewForLearnings) writeTrace(session.name, issueNum, 'review-output.json', reviewForLearnings);
      if (verifyOutput) writeTrace(session.name, issueNum, 'verify-output.json', verifyOutput);
      if (plan.summary) writeTrace(session.name, issueNum, 'plan.json', JSON.stringify(plan, null, 2));

      // Config snapshot (written once per run, idempotent)
      try {
        const configPath = join(projectDir, '.alpha-loop.yaml');
        if (existsSync(configPath)) {
          writeConfigSnapshot(session.name, readFileSync(configPath, 'utf-8'));
        }
      } catch { /* non-fatal */ }

      // Run-level scores and costs for this issue
      const issueScoreResult: PipelineResultForScores = {
        issueNum,
        status: testsPassing ? 'success' : 'failure',
        testsPassing,
        verifyPassing,
        verifySkipped,
        retries: testRetries,
        duration,
        filesChanged,
        stepsCompleted,
      };
      writeScores(session.name, computeScores([issueScoreResult]));
      writeCosts(session.name, computeCosts(stepCosts));
    } catch (err) {
      log.warn(`Failed to write traces for #${issueNum}: ${err}`);
    }
  }

  // --- Step 10: Update issue status ---
  log.step('Step 10: Updating issue status');
  if (!config.dryRun) {
    const testsStatus = testsPassing ? 'PASSING' : 'FAILING';
    updateProjectStatus(config.repo, config.project, config.repoOwner, issueNum, 'In Review');
    labelIssue(config.repo, issueNum, 'in-review', 'in-progress');
    commentIssue(config.repo, issueNum,
      `Automated implementation complete.\n\n**PR**: ${prUrl ?? 'N/A'}\n**Tests**: ${testsStatus}\n**Review**: Attached to PR body.\n\n---\n*Processed by alpha-loop in ${duration}s*`,
    );
  } else {
    log.dry('Would update issue status to in-review');
  }

  // --- Step 11: Auto-merge ---
  let mergeSucceeded = false;
  if (config.autoMerge && !config.dryRun && prUrl) {
    if (!testsPassing) {
      log.warn('Skipping auto-merge: tests are not passing');
    } else {
      log.step('Step 11: Auto-merging PR');
      try {
        mergePR(config.repo, worktreeBranch);
        mergeSucceeded = true;

        // Update local repo to include merged changes
        exec('git fetch origin', { cwd: projectDir });
        const currentBranch = exec('git rev-parse --abbrev-ref HEAD', { cwd: projectDir }).stdout;
        if (currentBranch !== session.branch) {
          exec(`git checkout "${session.branch}"`, { cwd: projectDir });
        }
        exec(`git pull origin "${session.branch}"`, { cwd: projectDir });
      } catch (err) {
        log.warn(`Auto-merge failed: ${err}`);
      }
    }
  } else if (config.dryRun) {
    log.dry('Would auto-merge PR');
  }

  // --- Step 12: Cleanup ---
  log.step('Step 12: Cleanup');
  if (!mergeSucceeded && config.autoMerge && prUrl) {
    // Merge was expected but didn't happen (tests failing or merge failed) — preserve worktree for recovery
    await cleanupWorktree({
      issueNum,
      projectDir,
      autoCleanup: config.autoCleanup,
      preserveIfCommits: true,
      dryRun: config.dryRun,
    });
  } else {
    await cleanupWorktree({
      issueNum,
      projectDir,
      autoCleanup: config.autoCleanup,
      dryRun: config.dryRun,
    });
  }

  const result: PipelineResult = {
    issueNum,
    title,
    status: testsPassing ? 'success' : 'failure',
    prUrl,
    testsPassing,
    verifyPassing,
    verifySkipped,
    duration,
    filesChanged,
  };

  // Save result to session
  saveResult(session, result);

  log.success(`Issue #${issueNum} processed in ${duration}s`);
  if (prUrl) log.info(`PR: ${prUrl}`);

  return result;
}

/**
 * Process a batch of issues through a single plan → implement → test → review cycle.
 * Instead of spawning separate agents per issue, combines all issues into one prompt
 * for each stage, dramatically reducing agent spin-up and context loading overhead.
 *
 * After the batch completes, each issue is individually updated with labels, comments, and PR.
 */
export async function processBatch(
  issues: Array<{ number: number; title: string; body: string }>,
  config: Config,
  session: SessionContext,
): Promise<PipelineResult[]> {
  const startTime = Date.now();
  const projectDir = process.cwd();
  const stepCosts: StepCost[] = [];
  const stepsCompleted: string[] = [];
  const issueNums = issues.map((i) => i.number);

  mkdirSync(session.logsDir, { recursive: true });
  const logFile = join(session.logsDir, `batch-${issueNums.join('-')}.log`);

  log.step(`Batch processing ${issues.length} issues: ${issueNums.map((n) => `#${n}`).join(', ')}`);

  // --- Step 1: Update all issue statuses ---
  log.step('Batch Step 1: Updating issue statuses');
  if (!config.dryRun) {
    for (const issue of issues) {
      updateProjectStatus(config.repo, config.project, config.repoOwner, issue.number, 'In progress');
      labelIssue(config.repo, issue.number, 'in-progress', config.labelReady);
      assignIssue(config.repo, issue.number, '@me');
    }
  }

  // --- Step 2: Setup single worktree for the batch ---
  log.step('Batch Step 2: Setting up worktree');
  const batchId = issueNums.join('-');
  let worktreePath: string;
  let worktreeBranch: string;

  let worktreeResumed = false;
  try {
    const wt = await setupWorktree({
      issueNum: issues[0].number, // Use first issue number for branch naming
      projectDir,
      baseBranch: config.baseBranch,
      sessionBranch: session.branch,
      autoMerge: config.autoMerge,
      skipInstall: config.skipInstall,
      setupCommand: config.setupCommand,
      dryRun: config.dryRun,
    });
    worktreePath = wt.path;
    worktreeBranch = wt.branch;
    worktreeResumed = wt.resumed;
  } catch (err) {
    log.error(`Failed to set up worktree for batch: ${err}`);
    // Re-queue issues back to ready state so they aren't stuck as "In Progress"
    for (const issue of issues) requeueIssue(config, issue.number);
    return issues.map((i) => failureResult(i.number, i.title, startTime, 'permanent'));
  }

  // --- Step 3: Fetch comments for all issues ---
  const issueComments = new Map<number, Comment[]>();
  if (!config.dryRun) {
    for (const issue of issues) {
      const comments = getIssueComments(config.repo, issue.number);
      if (comments.length > 0) {
        issueComments.set(issue.number, comments);
        log.info(`Loaded ${comments.length} comment(s) from issue #${issue.number}`);
      }
    }
  }

  // Build BatchIssue array with comments
  const batchIssues: BatchIssue[] = issues.map((i) => ({
    issueNum: i.number,
    title: i.title,
    body: i.body,
    comments: issueComments.get(i.number)?.map((c) => ({
      author: c.author,
      body: c.body,
      createdAt: c.createdAt,
    })),
  }));

  // --- Step 4: Batch plan ---
  log.step('Batch Step 3: Planning all issues');
  const plans = new Map<number, IssuePlan>();

  // Build resume context if worktree was recovered from a previous session
  const resumeNote = worktreeResumed
    ? `**IMPORTANT: This worktree contains work from a previous session that was interrupted.**
Run \`git log --oneline -10\` to see what has already been done.
Do NOT redo work that is already committed. Build on top of existing progress.\n\n`
    : '';

  if (!config.dryRun) {
    try {
      const planPrompt = resumeNote + buildBatchPlanPrompt({ issues: batchIssues });
      tracePrompt(session.name, issues[0].number, 'batch-plan', planPrompt);

      const planResult = await spawnAgent({
        agent: config.agent,
        model: config.model,
        prompt: planPrompt,
        cwd: worktreePath,
        logFile: join(session.logsDir, `batch-plan.log`),
        verbose: config.verbose,
        timeout: config.agentTimeout * 1000,
      });

      traceOutput(session.name, issues[0].number, 'batch-plan', planResult.output);
      stepCosts.push(buildStepCost('plan', issues[0].number, planResult, config));

      if (planResult.exitCode !== 0 && isTransientError(planResult.output)) {
        log.warn('Agent hit a transient error during batch planning — re-queuing all issues');
        for (const issue of issues) requeueIssue(config, issue.number);
        await cleanupWorktree({ issueNum: issues[0].number, projectDir, autoCleanup: config.autoCleanup });
        return issues.map((i) => failureResult(i.number, i.title, startTime, 'transient'));
      }

      // Read plan files for each issue
      for (const issue of issues) {
        const planFile = join(worktreePath, `plan-issue-${issue.number}.json`);
        const planFileSession = join(session.logsDir, `plan-issue-${issue.number}.json`);
        const plan = readPlan(planFile);
        plans.set(issue.number, plan);
        moveToSessionLogs(planFile, planFileSession);
        if (plan.summary) {
          log.success(`Plan #${issue.number}: ${plan.summary}`);
        }
      }
      stepsCompleted.push('plan');
    } catch {
      log.warn('Batch planning failed, using defaults for all issues');
    }
  }

  // --- Step 5: Batch implement ---
  log.step('Batch Step 4: Implementing all issues');
  if (!config.dryRun) {
    const visionContext = loadFileIfExists(join(projectDir, '.alpha-loop', 'vision.md'));
    const projectContext = loadFileIfExists(join(projectDir, '.alpha-loop', 'context.md'));
    const learningContext = getLearningContext(join(projectDir, '.alpha-loop', 'learnings'));

    // Combine all plans into one content block
    const allPlans = issues.map((i) => {
      const plan = plans.get(i.number) ?? DEFAULT_PLAN;
      return `### Plan for #${i.number}: ${i.title}\n${plan.implementation || '(no plan)'}`;
    }).join('\n\n');

    const implementPrompt = resumeNote + buildBatchImplementPrompt({
      issues: batchIssues,
      planContent: allPlans,
      visionContext: visionContext ?? undefined,
      projectContext: projectContext ?? undefined,
      learningContext: learningContext || undefined,
    });

    tracePrompt(session.name, issues[0].number, 'batch-implement', implementPrompt);

    const implResult = await spawnAgent({
      agent: config.agent,
      model: config.model,
      prompt: implementPrompt,
      cwd: worktreePath,
      logFile: join(session.logsDir, `batch-implement.log`),
      verbose: config.verbose,
      timeout: config.agentTimeout * 1000,
    });

    traceOutput(session.name, issues[0].number, 'batch-implement', implResult.output);
    stepCosts.push(buildStepCost('implement', issues[0].number, implResult, config));

    if (implResult.exitCode !== 0) {
      // Auto-commit any uncommitted work before deciding on cleanup
      const dirtyCheck = exec('git status --porcelain', { cwd: worktreePath });
      if (dirtyCheck.stdout.trim()) {
        exec('git add -A', { cwd: worktreePath });
        const issueRefs = issues.map((i) => `#${i.number}`).join(', ');
        exec(`git commit -m "wip: partial batch implementation of ${issueRefs} (agent timed out or failed)"`, { cwd: worktreePath });
      }

      if (isTransientError(implResult.output)) {
        log.warn('Agent hit a transient error during batch implementation — re-queuing');
        for (const issue of issues) requeueIssue(config, issue.number);
        await cleanupWorktree({ issueNum: issues[0].number, projectDir, autoCleanup: config.autoCleanup, preserveIfCommits: true });
        return issues.map((i) => failureResult(i.number, i.title, startTime, 'transient'));
      }
      log.error('Batch implementation failed');
      for (const issue of issues) {
        labelIssue(config.repo, issue.number, 'failed', 'in-progress');
        commentIssue(config.repo, issue.number, 'Agent loop failed during batch implementation. See logs.');
      }
      await cleanupWorktree({ issueNum: issues[0].number, projectDir, autoCleanup: config.autoCleanup, preserveIfCommits: true });
      return issues.map((i) => failureResult(i.number, i.title, startTime, 'permanent'));
    }

    // Auto-commit if agent didn't
    const statusResult = exec('git status --porcelain', { cwd: worktreePath });
    if (statusResult.stdout.trim()) {
      exec('git add -A', { cwd: worktreePath });
      const issueRefs = issues.map((i) => `#${i.number}`).join(', ');
      exec(`git commit -m "feat: batch implement issues ${issueRefs}"`, { cwd: worktreePath });
    }

    stepsCompleted.push('implement');

    // Capture implement diff
    try {
      const implDiff = exec(`git diff "origin/${config.baseBranch}...HEAD"`, { cwd: worktreePath });
      if (implDiff.stdout) traceDiff(session.name, issues[0].number, 'batch-implement', implDiff.stdout);
    } catch { /* non-fatal */ }
  }

  // --- Step 6: Test + retry loop ---
  log.step('Batch Step 5: Running tests');
  let testOutput = '';
  let testsPassing = false;

  // Check if any plan says testing is needed
  const anyTestsNeeded = issues.some((i) => (plans.get(i.number) ?? DEFAULT_PLAN).testing.needed);
  if (!anyTestsNeeded) {
    log.info('Tests skipped by all plans');
    testsPassing = true;
    testOutput = 'Tests skipped by plan';
  }

  for (let attempt = 1; testsPassing ? false : attempt <= config.maxTestRetries; attempt++) {
    log.info(`Test attempt ${attempt} of ${config.maxTestRetries}`);

    const testResult = runTests(worktreePath, config, logFile);
    testOutput = testResult.output;
    traceTest(session.name, issues[0].number, attempt, testOutput);

    if (testResult.passed) {
      testsPassing = true;
      stepsCompleted.push('test');
      log.success(`All tests passed on attempt ${attempt}`);
      break;
    }

    if (attempt < config.maxTestRetries) {
      log.warn(`Tests failed on attempt ${attempt}, invoking agent to fix...`);
      if (!config.dryRun) {
        const issueRefs = issues.map((i) => `#${i.number}`).join(', ');
        const fixPrompt = `Tests are failing for batch implementation (issues ${issueRefs}, attempt ${attempt} of ${config.maxTestRetries}). Fix the failing tests.\n\nTest output:\n${testOutput}\n\nInstructions:\n1. Read the failing test output carefully and identify the ROOT CAUSE\n2. Fix ONLY code related to the batch issues — do NOT modify test infrastructure\n3. Run the tests again to verify\n4. Commit your fixes with a descriptive message`;

        tracePrompt(session.name, issues[0].number, `batch-fix-${attempt}`, fixPrompt);

        const fixResult = await spawnAgent({
          agent: config.agent,
          model: config.model,
          prompt: fixPrompt,
          cwd: worktreePath,
          resume: true,
          logFile: join(session.logsDir, `batch-fix-${attempt}.log`),
          verbose: config.verbose,
          timeout: config.agentTimeout * 1000,
        });

        traceOutput(session.name, issues[0].number, `batch-fix-${attempt}`, fixResult.output);
        stepCosts.push(buildStepCost('test_fix', issues[0].number, fixResult, config));

        const fixStatus = exec('git status --porcelain', { cwd: worktreePath });
        if (fixStatus.stdout.trim()) {
          exec('git add -A', { cwd: worktreePath });
          exec(`git commit -m "fix: resolve batch test failures (attempt ${attempt})"`, { cwd: worktreePath });
        }
      }
    } else {
      log.warn(`Tests still failing after ${config.maxTestRetries} attempts`);
    }
  }

  // --- Step 7: Batch review ---
  log.step('Batch Step 6: Code review');
  let reviewOutput = '';
  let reviewGate: GateResult = DEFAULT_GATE;

  if (config.skipReview) {
    log.info('Code review skipped');
  } else if (!config.dryRun) {
    const reviewFileInWorktree = join(worktreePath, 'review-batch.json');
    const reviewFileInSession = join(session.logsDir, 'review-batch.json');

    for (let attempt = 1; attempt <= config.maxTestRetries; attempt++) {
      log.info(`Review attempt ${attempt} of ${config.maxTestRetries}`);

      try {
        const reviewPrompt = buildBatchReviewPrompt({
          issues: batchIssues,
          baseBranch: config.baseBranch,
          visionContext: loadFileIfExists(join(projectDir, '.alpha-loop', 'vision.md')) ?? undefined,
        });

        tracePrompt(session.name, issues[0].number, `batch-review${attempt > 1 ? `-${attempt}` : ''}`, reviewPrompt);

        const reviewResult = await spawnAgent({
          agent: config.agent,
          model: config.reviewModel,
          prompt: reviewPrompt,
          cwd: worktreePath,
          logFile: join(session.logsDir, `batch-review${attempt > 1 ? `-${attempt}` : ''}.log`),
          verbose: config.verbose,
          timeout: config.agentTimeout * 1000,
        });

        traceOutput(session.name, issues[0].number, `batch-review${attempt > 1 ? `-${attempt}` : ''}`, reviewResult.output);
        stepCosts.push(buildStepCost('review', issues[0].number, reviewResult, config));
        reviewOutput = reviewResult.output;
      } catch {
        log.warn('Batch review failed, continuing without review');
        break;
      }

      reviewGate = readGateResult(reviewFileInWorktree);
      moveToSessionLogs(reviewFileInWorktree, reviewFileInSession);

      if (reviewGate.passed) {
        stepsCompleted.push('review');
        log.success(`Batch review passed: ${reviewGate.summary || 'no issues found'}`);
        break;
      }

      const unfixedCount = reviewGate.findings.filter((f) => !f.fixed).length;
      log.warn(`Review found ${unfixedCount} unfixed issue(s), sending back to implementer...`);

      if (attempt < config.maxTestRetries) {
        const findings = formatGateFindings(reviewGate, 'Code Review');
        const fixPrompt = `The code review for the batch found problems that need to be fixed.\n\n${findings}\n\nInstructions:\n1. Address each finding listed above\n2. Run tests to make sure nothing is broken\n3. Commit your fixes`;

        tracePrompt(session.name, issues[0].number, `batch-review-fix-${attempt}`, fixPrompt);

        const reviewFixResult = await spawnAgent({
          agent: config.agent,
          model: config.model,
          prompt: fixPrompt,
          cwd: worktreePath,
          resume: true,
          logFile: join(session.logsDir, `batch-review-fix-${attempt}.log`),
          verbose: config.verbose,
          timeout: config.agentTimeout * 1000,
        });

        traceOutput(session.name, issues[0].number, `batch-review-fix-${attempt}`, reviewFixResult.output);
        stepCosts.push(buildStepCost('review', issues[0].number, reviewFixResult, config));

        const fixStatus = exec('git status --porcelain', { cwd: worktreePath });
        if (fixStatus.stdout.trim()) {
          exec('git add -A', { cwd: worktreePath });
          exec(`git commit -m "fix: address batch review findings (attempt ${attempt})"`, { cwd: worktreePath });
        }

        const retest = runTests(worktreePath, config, logFile);
        if (!retest.passed) {
          log.warn('Tests failed after review fixes');
          testOutput = retest.output;
          testsPassing = false;
        }
      }
    }
  }

  // --- Step 8: Create single PR for the batch ---
  log.step('Batch Step 7: Creating PR');
  let prUrl: string | undefined;

  if (!config.dryRun) {
    const prBase = config.autoMerge ? session.branch : config.baseBranch;
    const issueRefs = issues.map((i) => `#${i.number}`).join(', ');
    const prBody = buildBatchPRBody(
      issues.map((i) => ({ issueNum: i.number, title: i.title })),
      reviewGate,
      testOutput,
      testsPassing,
    );

    try {
      prUrl = createPR({
        repo: config.repo,
        base: prBase,
        head: worktreeBranch,
        title: `feat: batch implementation (${issueRefs})`,
        body: prBody,
        cwd: worktreePath,
      });
      stepsCompleted.push('pr');
      log.success(`Batch PR created: ${prUrl}`);
    } catch (err) {
      log.error(`Failed to create batch PR: ${err}`);
      for (const issue of issues) {
        labelIssue(config.repo, issue.number, 'failed', 'in-progress');
        commentIssue(config.repo, issue.number, `Agent loop failed: could not create PR. Branch: ${worktreeBranch}`);
      }
      log.warn(`Worktree preserved at ${worktreePath} — use "alpha-loop resume" to retry`);
      return issues.map((i) => failureResult(i.number, i.title, startTime, 'permanent'));
    }
  }

  // --- Step 9: Update each issue individually ---
  log.step('Batch Step 8: Updating individual issues');
  const duration = Math.round((Date.now() - startTime) / 1000);
  const perIssueDuration = Math.round(duration / issues.length);

  // Get diff for traces
  let runDiff = '';
  if (!config.dryRun) {
    const diffResult = exec(`git diff "origin/${config.baseBranch}...HEAD"`, { cwd: worktreePath });
    runDiff = diffResult.stdout.slice(0, MAX_DIFF_CHARS);
  }

  const filesChanged = runDiff ? (runDiff.match(/^diff --git/gm) ?? []).length : 0;
  const results: PipelineResult[] = [];

  for (const issue of issues) {
    if (!config.dryRun) {
      const testsStatus = testsPassing ? 'PASSING' : 'FAILING';
      updateProjectStatus(config.repo, config.project, config.repoOwner, issue.number, 'In Review');
      labelIssue(config.repo, issue.number, 'in-review', 'in-progress');
      commentIssue(config.repo, issue.number,
        `Automated batch implementation complete.\n\n**PR**: ${prUrl ?? 'N/A'}\n**Tests**: ${testsStatus}\n**Batch**: ${issues.length} issues processed together\n\n---\n*Processed by alpha-loop batch mode in ${duration}s total*`,
      );
    }

    const result: PipelineResult = {
      issueNum: issue.number,
      title: issue.title,
      status: testsPassing ? 'success' : 'failure',
      prUrl,
      testsPassing,
      verifyPassing: true,
      verifySkipped: true,
      duration: perIssueDuration,
      filesChanged,
    };

    results.push(result);
    saveResult(session, result);

    // Write per-issue traces
    if (!config.dryRun) {
      try {
        const issueScoreResult: PipelineResultForScores = {
          issueNum: issue.number,
          status: testsPassing ? 'success' : 'failure',
          testsPassing,
          verifyPassing: true,
          verifySkipped: true,
          retries: 0,
          duration: perIssueDuration,
          filesChanged,
          stepsCompleted,
        };

        writeTraceMetadata(session.name, issue.number, {
          issueNum: issue.number,
          title: issue.title,
          status: testsPassing ? 'success' : 'failure',
          duration: perIssueDuration,
          retries: 0,
          testsPassing,
          verifyPassing: true,
          verifySkipped: true,
          filesChanged,
          prUrl,
          timestamp: new Date().toISOString(),
          agent: config.agent,
          model: config.model,
          batchMode: true,
          batchSize: issues.length,
        });
      } catch (err) {
        log.warn(`Failed to write traces for #${issue.number}: ${err}`);
      }
    }

    log.success(`Issue #${issue.number} updated`);
  }

  // Write aggregate scores and costs
  if (!config.dryRun) {
    try {
      const scoreResults: PipelineResultForScores[] = results.map((r) => ({
        issueNum: r.issueNum,
        status: r.status,
        testsPassing: r.testsPassing,
        verifyPassing: r.verifyPassing,
        verifySkipped: r.verifySkipped,
        retries: 0,
        duration: r.duration,
        filesChanged: r.filesChanged,
        stepsCompleted,
      }));
      writeScores(session.name, computeScores(scoreResults));
      writeCosts(session.name, computeCosts(stepCosts));

      // Config snapshot
      try {
        const configPath = join(projectDir, '.alpha-loop.yaml');
        if (existsSync(configPath)) {
          writeConfigSnapshot(session.name, readFileSync(configPath, 'utf-8'));
        }
      } catch { /* non-fatal */ }
    } catch (err) {
      log.warn(`Failed to write batch traces: ${err}`);
    }
  }

  // --- Step 10: Auto-merge ---
  let mergeSucceeded = false;
  if (config.autoMerge && !config.dryRun && prUrl) {
    if (!testsPassing) {
      log.warn('Skipping auto-merge: tests are not passing');
    } else {
      log.step('Batch Step 9: Auto-merging PR');
      try {
        mergePR(config.repo, worktreeBranch);
        mergeSucceeded = true;
        exec('git fetch origin', { cwd: projectDir });
        const currentBranch = exec('git rev-parse --abbrev-ref HEAD', { cwd: projectDir }).stdout;
        if (currentBranch !== session.branch) {
          exec(`git checkout "${session.branch}"`, { cwd: projectDir });
        }
        exec(`git pull origin "${session.branch}"`, { cwd: projectDir });
      } catch (err) {
        log.warn(`Auto-merge failed: ${err}`);
      }
    }
  }

  // --- Step 11: Cleanup ---
  log.step('Batch Step 10: Cleanup');
  if (!mergeSucceeded && config.autoMerge && prUrl) {
    // Merge was expected but didn't happen (tests failing or merge failed) — preserve worktree for recovery
    await cleanupWorktree({
      issueNum: issues[0].number,
      projectDir,
      autoCleanup: config.autoCleanup,
      preserveIfCommits: true,
      dryRun: config.dryRun,
    });
  } else {
    await cleanupWorktree({
      issueNum: issues[0].number,
      projectDir,
      autoCleanup: config.autoCleanup,
      dryRun: config.dryRun,
    });
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  log.success(`Batch complete: ${successCount}/${issues.length} issues succeeded in ${duration}s`);
  if (prUrl) log.info(`PR: ${prUrl}`);

  return results;
}

function failureResult(issueNum: number, title: string, startTime: number, reason?: 'transient' | 'permanent'): PipelineResult {
  return {
    issueNum,
    title,
    status: 'failure',
    failureReason: reason,
    testsPassing: false,
    verifyPassing: false,
    verifySkipped: false,
    duration: Math.round((Date.now() - startTime) / 1000),
    filesChanged: 0,
  };
}

/**
 * Re-queue an issue back to ready state after a transient failure.
 * Restores the label to ready and project status to Todo.
 */
function requeueIssue(config: Config, issueNum: number): void {
  if (config.dryRun) return;
  labelIssue(config.repo, issueNum, config.labelReady, 'in-progress');
  updateProjectStatus(config.repo, config.project, config.repoOwner, issueNum, 'Todo');
  log.info(`Issue #${issueNum} re-queued for next run`);
}

function loadFileIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}


/**
 * Extract a one-line test summary from raw test output.
 * Aggregates results across multiple test runners (pytest, Jest, Vitest).
 * Handles concurrent output like: [pytest] 189 passed, [frontend] Tests 6 passed, etc.
 */
function extractTestSummary(testOutput: string): string {
  if (!testOutput) return '';

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  // Pytest summary line: "189 passed, 1 skipped in 7.05s" or "5 failed, 184 passed"
  // Match the "=== ... ===" summary line format
  for (const match of testOutput.matchAll(/=+\s*(.*?)\s*=+/g)) {
    const line = match[1];
    const passed = line.match(/(\d+) passed/);
    const failed = line.match(/(\d+) failed/);
    const skipped = line.match(/(\d+) skipped/);
    if (passed) totalPassed += parseInt(passed[1], 10);
    if (failed) totalFailed += parseInt(failed[1], 10);
    if (skipped) totalSkipped += parseInt(skipped[1], 10);
  }

  // Jest summary: "Tests:  30 passed, 30 total" or "Tests:  2 failed, 28 passed, 30 total"
  for (const match of testOutput.matchAll(/Tests:\s+(?:(\d+) failed,\s+)?(\d+) passed/g)) {
    if (match[1]) totalFailed += parseInt(match[1], 10);
    totalPassed += parseInt(match[2], 10);
  }

  // Vitest summary: "Tests  6 passed (6)" — uses spaces not colon, has parens
  for (const match of testOutput.matchAll(/Tests\s+(?:(\d+) failed\s+)?(\d+) passed\s+\(\d+\)/g)) {
    if (match[1]) totalFailed += parseInt(match[1], 10);
    totalPassed += parseInt(match[2], 10);
  }

  if (totalPassed === 0 && totalFailed === 0) return '';

  const parts: string[] = [];
  parts.push(`${totalPassed} passed`);
  if (totalFailed > 0) parts.push(`${totalFailed} failed`);
  if (totalSkipped > 0) parts.push(`${totalSkipped} skipped`);
  return parts.join(', ');
}

function buildBatchPRBody(
  issues: Array<{ issueNum: number; title: string }>,
  reviewGate: GateResult,
  testOutput: string,
  testsPassing: boolean,
): string {
  const testSummary = extractTestSummary(testOutput);
  const reviewStatus = reviewGate.passed ? 'PASS' : 'FAIL';
  const closesRefs = issues.map((i) => `Closes #${i.issueNum}`).join('\n');

  const lines: string[] = [
    closesRefs,
    '',
    '## Summary',
    '',
    `Batch implementation of ${issues.length} issues:`,
    ...issues.map((i) => `- **#${i.issueNum}**: ${i.title}`),
    '',
    '## Test Results',
    '',
    `| Check | Status |`,
    `|-------|--------|`,
    `| Unit tests | ${testsPassing ? 'PASS' : 'FAIL'} |`,
    `| Code review | ${reviewStatus} |`,
  ];

  if (testSummary) {
    lines.push(`| Details | ${testSummary} |`);
  }

  lines.push('');

  if (reviewGate.findings.length > 0) {
    lines.push('## Code Review', '');
    lines.push(reviewGate.summary || 'Review completed');
    lines.push('');
    for (const f of reviewGate.findings) {
      const status = f.fixed ? 'FIXED' : 'OPEN';
      const fileRef = f.file ? ` \`${f.file}\`` : '';
      lines.push(`- **${f.severity.toUpperCase()}** [${status}]${fileRef}: ${f.description}`);
    }
    lines.push('');
  } else {
    lines.push('## Code Review', '', reviewGate.summary || 'No issues found', '');
  }

  lines.push(
    '---',
    `*Automated by [alpha-loop](https://github.com/bradtaylorsf/alpha-loop) · Batch mode · Full logs in \`.alpha-loop/sessions/\`*`,
  );

  return lines.join('\n');
}

function buildPRBody(
  issueNum: number,
  title: string,
  reviewGate: GateResult,
  testOutput: string,
  testsPassing: boolean,
  verifyPassing: boolean,
  verifySkipped: boolean,
  body: string,
): string {
  const testSummary = extractTestSummary(testOutput);

  const verifyStatus = verifySkipped ? 'SKIPPED' : verifyPassing ? 'PASS' : 'FAIL';
  const reviewStatus = reviewGate.passed ? 'PASS' : 'FAIL';

  const lines: string[] = [
    `Closes #${issueNum}`,
    '',
    `## Summary`,
    '',
    `Automated implementation of **${title}**`,
    '',
    '## Test Results',
    '',
    `| Check | Status |`,
    `|-------|--------|`,
    `| Unit tests | ${testsPassing ? 'PASS' : 'FAIL'} |`,
    `| Code review | ${reviewStatus} |`,
    `| Verification | ${verifyStatus} |`,
  ];

  if (testSummary) {
    lines.push(`| Details | ${testSummary} |`);
  }

  lines.push('');

  // Code review — structured from gate result
  if (reviewGate.findings.length > 0) {
    lines.push('## Code Review', '');
    lines.push(reviewGate.summary || 'Review completed');
    lines.push('');
    for (const f of reviewGate.findings) {
      const status = f.fixed ? 'FIXED' : 'OPEN';
      const fileRef = f.file ? ` \`${f.file}\`` : '';
      lines.push(`- **${f.severity.toUpperCase()}** [${status}]${fileRef}: ${f.description}`);
    }
    lines.push('');
  } else {
    lines.push('## Code Review', '', reviewGate.summary || 'No issues found', '');
  }

  // What to test — from issue body or generic
  const whatToTestMatch = body.match(/## Test Requirements[\s\S]*?(?=\n## |$)/);
  if (whatToTestMatch) {
    lines.push(whatToTestMatch[0].trim(), '');
  }

  // Session log reference
  lines.push(
    '---',
    `*Automated by [alpha-loop](https://github.com/bradtaylorsf/alpha-loop) · Full logs in \`.alpha-loop/sessions/\`*`,
  );

  return lines.join('\n');
}
