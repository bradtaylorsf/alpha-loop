/**
 * Process Issue Pipeline — the 12-step orchestration for a single issue.
 */
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
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
} from './github.js';
import { buildImplementPrompt, buildReviewPrompt } from './prompts.js';
import { runTests } from './testing.js';
import { runVerify } from './verify.js';
import { extractLearnings, getLearningContext } from './learning.js';
import { saveResult, getPreviousResult } from './session.js';
import type { Config } from './config.js';
import type { SessionContext } from './session.js';

/** Max diff size to include in learning analysis. */
const MAX_DIFF_CHARS = 10_000;

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
  };
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

    return {
      summary: String(parsed.summary ?? ''),
      files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
      implementation: String(parsed.implementation ?? ''),
      testing: {
        needed: (parsed.testing as any)?.needed !== false,
        reason: String((parsed.testing as any)?.reason ?? 'No reason given'),
      },
      verification: {
        needed: (parsed.verification as any)?.needed === true,
        instructions: (parsed.verification as any)?.instructions || undefined,
        reason: String((parsed.verification as any)?.reason ?? 'No reason given'),
      },
    };
  } catch {
    return DEFAULT_PLAN;
  }
}

export type PipelineResult = {
  issueNum: number;
  title: string;
  status: 'success' | 'failure';
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
  } catch (err) {
    log.error(`Failed to set up worktree for issue #${issueNum}: ${err}`);
    if (!config.dryRun) {
      labelIssue(config.repo, issueNum, 'failed', 'in-progress');
      commentIssue(config.repo, issueNum, 'Agent loop failed: could not create worktree. Check logs.');
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
    "instructions": "If needed: specific playwright-cli steps to verify the feature. If not needed: omit this field.",
    "reason": "Why verification is or isn't needed (e.g. no UI changes, API-only, config change)"
  }
}

Rules:
- testing.needed: true if ANY code changes could affect behavior. false only for docs, config, or comments.
- verification.needed: true ONLY if the issue changes user-visible UI that can be tested in a browser.
- verification.instructions: if needed, list the exact playwright-cli commands to verify (open URL, click elements, check content).
- implementation: be concise and actionable. List files to modify and what to change in each.
- Write ONLY the JSON file. Do not create any other files or make any code changes.`;

      await spawnAgent({
        agent: config.agent,
        model: config.model,
        prompt: planPrompt,
        cwd: worktreePath,
        logFile: join(session.logsDir, `issue-${issueNum}-plan.log`),
        verbose: config.verbose,
      });

      plan = readPlan(planFileInWorktree);
      if (plan.summary) {
        // Move plan from worktree to sessions dir for inspection, clean up worktree
        try {
          const planContent = readFileSync(planFileInWorktree, 'utf-8');
          const { writeFileSync, unlinkSync } = await import('node:fs');
          writeFileSync(planFileInSession, planContent);
          unlinkSync(planFileInWorktree);
        } catch { /* non-fatal */ }
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

  // --- Step 4: Implement ---
  log.step('Step 4: Implementing');
  if (!config.dryRun) {
    // Load vision and project context
    const visionContext = loadFileIfExists(join(projectDir, '.alpha-loop', 'vision.md'));
    const projectContext = loadFileIfExists(join(projectDir, '.alpha-loop', 'context.md'));
    const previousResult = getPreviousResult(session);
    const learningContext = getLearningContext(join(projectDir, '.alpha-loop', 'learnings'));

    const implementPrompt = buildImplementPrompt({
      issueNum,
      title,
      body,
      planContent: plan.implementation || undefined,
      visionContext: visionContext ?? undefined,
      projectContext: projectContext ?? undefined,
      previousResult: previousResult ?? undefined,
      learningContext: learningContext || undefined,
    });

    const implResult = await spawnAgent({
      agent: config.agent,
      model: config.model,
      prompt: implementPrompt,
      cwd: worktreePath,

      logFile: join(session.logsDir, `issue-${issueNum}-implement.log`),
      verbose: config.verbose,
    });

    if (implResult.exitCode !== 0) {
      log.error(`Implementation failed for issue #${issueNum}`);
      labelIssue(config.repo, issueNum, 'failed', 'in-progress');
      commentIssue(config.repo, issueNum, 'Agent loop failed during implementation. See logs for details.');
      await cleanupWorktree({ issueNum, projectDir, autoCleanup: config.autoCleanup });
      return failureResult(issueNum, title, startTime);
    }

    // Auto-commit if agent didn't
    const statusResult = exec('git status --porcelain', { cwd: worktreePath });
    if (statusResult.stdout.trim()) {
      exec('git add -A', { cwd: worktreePath });
      exec(`git commit -m "feat: implement issue #${issueNum} - ${title}"`, { cwd: worktreePath });
    }
  } else {
    log.dry('Would run implementation agent');
  }

  // --- Step 5: Test + retry loop ---
  log.step('Step 5: Running tests');
  let testOutput = '';
  let testsPassing = false;

  if (!plan.testing.needed) {
    log.info(`Tests skipped by plan: ${plan.testing.reason}`);
    testsPassing = true;
    testOutput = `Tests skipped by plan: ${plan.testing.reason}`;
  }

  for (let attempt = 1; testsPassing ? false : attempt <= config.maxTestRetries; attempt++) {
    log.info(`Test attempt ${attempt} of ${config.maxTestRetries}`);

    const testResult = runTests(worktreePath, config, logFile);
    testOutput = testResult.output;

    if (testResult.passed) {
      testsPassing = true;
      log.success(`All tests passed on attempt ${attempt}`);
      break;
    }

    if (attempt < config.maxTestRetries) {
      log.warn(`Tests failed on attempt ${attempt}, invoking agent to fix...`);
      if (!config.dryRun) {
        const fixPrompt = `Tests are failing for issue #${issueNum} (attempt ${attempt} of ${config.maxTestRetries}). Fix the failing tests.\n\nTest output:\n${testOutput}\n\nInstructions:\n1. Read the failing test output carefully and identify the ROOT CAUSE\n2. Fix ONLY code related to issue #${issueNum} — do NOT modify test infrastructure, build scripts, or unrelated files\n3. If tests fail due to environment issues (missing venv, wrong port, missing deps), fix only YOUR code — do NOT rewrite the test runner or package.json scripts\n4. Run the tests again to verify\n5. Commit your fixes with a DESCRIPTIVE message that explains WHAT you fixed and WHY it failed.\n   Format: fix(#${issueNum}): <what you changed> — <why it was failing>\n   Example: fix(#${issueNum}): use port 5435 for postgres — default 5432 conflicts with host service\n   DO NOT use generic messages like "fix: resolve test failures"`;

        await spawnAgent({
          agent: config.agent,
          model: config.model,
          prompt: fixPrompt,
          cwd: worktreePath,
          resume: true,
          logFile: join(session.logsDir, `issue-${issueNum}-fix-${attempt}.log`),
          verbose: config.verbose,
        });

        // Auto-commit fixes
        const fixStatus = exec('git status --porcelain', { cwd: worktreePath });
        if (fixStatus.stdout.trim()) {
          exec('git add -A', { cwd: worktreePath });
          exec(`git commit -m "fix(#${issueNum}): resolve test failures (attempt ${attempt})"`, { cwd: worktreePath });
        }
      }
    } else {
      log.warn(`Tests still failing after ${config.maxTestRetries} attempts`);
      testOutput = `TESTS FAILED after ${config.maxTestRetries} fix attempts. Latest output:\n${testOutput}`;
    }
  }

  // --- Step 6: Live verification with playwright-cli ---
  log.step('Step 6: Live verification');
  let verifyOutput = '';
  let verifyPassing = false;
  let verifySkipped = false;

  if (!plan.verification.needed) {
    log.info(`Verification skipped by plan: ${plan.verification.reason}`);
    verifyPassing = true;
    verifySkipped = true;
    verifyOutput = `Verification skipped by plan: ${plan.verification.reason}`;
  }

  for (let attempt = 1; verifySkipped ? false : attempt <= config.maxTestRetries; attempt++) {
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
    });
    verifyOutput = verifyResult.output;

    if (verifyResult.skipped) {
      verifyPassing = true;
      verifySkipped = true;
      break;
    }

    if (verifyResult.passed) {
      verifyPassing = true;
      log.success(`Verification passed on attempt ${attempt}`);
      break;
    }

    if (attempt < config.maxTestRetries) {
      // If the agent timed out, retrying with a fix agent won't help — just retry verification
      const timedOut = verifyOutput.includes('[TIMEOUT]');
      if (timedOut) {
        log.warn(`Verification timed out on attempt ${attempt}, retrying without fix agent...`);
      } else {
        log.warn(`Verification failed on attempt ${attempt}, invoking agent to fix...`);
        const verifyFixPrompt = `Build verification failed after implementing issue #${issueNum} (attempt ${attempt} of ${config.maxTestRetries}).\nThe app was started and tested with playwright-cli, but verification failed.\n\nVerification output:\n${verifyOutput}\n\nInstructions:\n1. Read the verification output above and identify the ROOT CAUSE of each failure\n2. Fix ONLY code related to issue #${issueNum} — do NOT modify dev server config, build tools, fonts, styling, or unrelated files\n3. If the app fails to start, that is an environment issue — do NOT rewrite the dev server or its dependencies\n4. Run the test command to make sure unit tests still pass\n5. Commit your fixes with a DESCRIPTIVE message that explains WHAT you fixed and WHY it failed.\n   Format: fix(#${issueNum}): <what you changed> — <why verification failed>\n   Example: fix(#${issueNum}): add ENCRYPTION_KEY to langfuse config — service requires 32+ char secret\n   DO NOT use generic messages like "fix: resolve verification failures"`;

        await spawnAgent({
          agent: config.agent,
          model: config.model,
          prompt: verifyFixPrompt,
          cwd: worktreePath,
          resume: true,
          logFile: join(session.logsDir, `issue-${issueNum}-verify-fix-${attempt}.log`),
          verbose: config.verbose,
        });
      }

      // Auto-commit fixes
      const fixStatus = exec('git status --porcelain', { cwd: worktreePath });
      if (fixStatus.stdout.trim()) {
        exec('git add -A', { cwd: worktreePath });
        exec(`git commit -m "fix(#${issueNum}): resolve verification failures (attempt ${attempt})"`, { cwd: worktreePath });
      }
    } else {
      log.warn(`Verification still failing after ${config.maxTestRetries} attempts`);
    }
  }

  // --- Step 7: Review ---
  log.step('Step 7: Code review');
  let reviewOutput = '';

  if (config.skipReview) {
    log.info('Code review skipped');
  } else if (config.dryRun) {
    log.dry('Would run code review');
  } else {
    try {
      const reviewPrompt = buildReviewPrompt({
        issueNum,
        title,
        body,
        baseBranch: config.baseBranch,
        visionContext: loadFileIfExists(join(projectDir, '.alpha-loop', 'vision.md')) ?? undefined,
      });

      const reviewResult = await spawnAgent({
        agent: config.agent,
        model: config.reviewModel,
        prompt: reviewPrompt,
        cwd: worktreePath,
  
        logFile: join(session.logsDir, `issue-${issueNum}-review.log`),
        verbose: config.verbose,
      });

      reviewOutput = reviewResult.output;
    } catch {
      log.warn('Code review failed, continuing without review');
      reviewOutput = 'Code review could not be completed';
    }
  }

  // --- Step 8: Create PR ---
  log.step('Step 8: Creating PR');
  let prUrl: string | undefined;

  if (!config.dryRun) {
    const prBase = config.autoMerge ? session.branch : config.baseBranch;
    const prBody = buildPRBody(issueNum, title, reviewOutput, testOutput, testsPassing, verifyPassing, verifySkipped, body);

    try {
      prUrl = createPR({
        repo: config.repo,
        base: prBase,
        head: worktreeBranch,
        title: `feat: ${title} (closes #${issueNum})`,
        body: prBody,
        cwd: worktreePath,
      });
      log.success(`PR created: ${prUrl}`);
    } catch (err) {
      log.error(`Failed to create PR for issue #${issueNum}: ${err}`);
      labelIssue(config.repo, issueNum, 'failed', 'in-progress');
      commentIssue(config.repo, issueNum, `Agent loop failed: could not create PR. Branch: ${worktreeBranch}`);
      await cleanupWorktree({ issueNum, projectDir, autoCleanup: config.autoCleanup });
      return failureResult(issueNum, title, startTime);
    }
  } else {
    log.dry('Would create PR');
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

  await extractLearnings({
    issueNum,
    title,
    status: testsPassing ? 'success' : 'failure',
    retries: config.maxTestRetries,
    duration,
    diff: runDiff,
    testOutput,
    reviewOutput,
    verifyOutput,
    body,
    config,
  });

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
  if (config.autoMerge && !config.dryRun && prUrl) {
    log.step('Step 11: Auto-merging PR');
    try {
      mergePR(config.repo, worktreeBranch);

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
  } else if (config.dryRun) {
    log.dry('Would auto-merge PR');
  }

  // --- Step 12: Cleanup ---
  log.step('Step 12: Cleanup');
  await cleanupWorktree({
    issueNum,
    projectDir,
    autoCleanup: config.autoCleanup,
    dryRun: config.dryRun,
  });

  // Count files changed
  let filesChanged = 0;
  if (runDiff) {
    filesChanged = (runDiff.match(/^diff --git/gm) ?? []).length;
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

function failureResult(issueNum: number, title: string, startTime: number): PipelineResult {
  return {
    issueNum,
    title,
    status: 'failure',
    testsPassing: false,
    verifyPassing: false,
    verifySkipped: false,
    duration: Math.round((Date.now() - startTime) / 1000),
    filesChanged: 0,
  };
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
 * Extract just the review summary from the full agent output.
 * Looks for the structured report section the reviewer agent produces.
 */
function extractReviewSummary(reviewOutput: string): string {
  if (!reviewOutput) return 'No review available';

  // Look for structured review sections — capture only markdown content,
  // stop at agent tool call output (lines starting with "exec", "codex", "tokens used", etc.)
  const patterns = [
    /### Review Summary\n([\s\S]*?)(?=\n(?:exec|codex|claude|tokens used|\d{4}-\d{2}-\d{2}T)|$)/,
    /### Findings Fixed\n([\s\S]*?)(?=\n(?:exec|codex|claude|tokens used|\d{4}-\d{2}-\d{2}T)|$)/,
    /## Review Report\n([\s\S]*?)(?=\n(?:exec|codex|claude|tokens used|\d{4}-\d{2}-\d{2}T)|$)/,
  ];

  for (const pattern of patterns) {
    const match = reviewOutput.match(pattern);
    if (match) {
      const content = match[0].trim();
      // Sanity check: don't return if it's mostly tool calls
      if (content.length > 20 && !content.startsWith('exec')) return content;
    }
  }

  // No structured review section found — don't dump raw agent output
  return 'Review completed — see logs for details';
}

/**
 * Extract a one-line test summary from raw test output.
 * e.g., "30 passed, 0 failed" from Jest/Vitest output.
 */
function extractTestSummary(testOutput: string): string {
  if (!testOutput) return '';

  // Jest: "Tests:  30 passed, 30 total"
  const jestMatch = testOutput.match(/Tests:\s+(.+total)/);
  if (jestMatch) return jestMatch[1].trim();

  // Vitest: "Tests  30 passed (30)"
  const vitestMatch = testOutput.match(/Tests\s+(.+\(\d+\))/);
  if (vitestMatch) return vitestMatch[1].trim();

  // Fallback: count "passed" and "failed" lines
  const passed = (testOutput.match(/passed/gi) || []).length;
  const failed = (testOutput.match(/failed/gi) || []).length;
  if (passed > 0 || failed > 0) return `${passed} passed, ${failed} failed`;

  return '';
}

function buildPRBody(
  issueNum: number,
  title: string,
  reviewOutput: string,
  testOutput: string,
  testsPassing: boolean,
  verifyPassing: boolean,
  verifySkipped: boolean,
  body: string,
): string {
  const testSummary = extractTestSummary(testOutput);
  const reviewSummary = extractReviewSummary(reviewOutput);

  const verifyStatus = verifySkipped ? 'SKIPPED' : verifyPassing ? 'PASS' : 'FAIL';

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
    `| Verification | ${verifyStatus} |`,
  ];

  if (testSummary) {
    lines.push(`| Details | ${testSummary} |`);
  }

  lines.push('');

  // Code review — just the summary, not the full agent output
  lines.push(
    '## Code Review',
    '',
    reviewSummary,
    '',
  );

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
