import { execSync } from "node:child_process";
import type Database from "better-sqlite3";
import type { AgentRunner, RunOptions } from "./runner.js";
import type { GitHubClient, GitHubIssue } from "./github.js";
import { createWorktree, removeWorktree, branchName } from "./worktree.js";
import { loopEmitter } from "../server/sse.js";
import type { LoopEvent } from "../server/sse.js";
import { createRun, updateRun } from "../server/db.js";
import { extractLearnings } from "../learning/extractor.js";

// --- Types ---

export type PipelineStage =
  | "setup"
  | "implement"
  | "test"
  | "fix"
  | "review"
  | "pr"
  | "cleanup"
  | "done"
  | "failed";

export interface LoopConfig {
  owner: string;
  repo: string;
  baseBranch: string;
  model: string;
  reviewModel?: string;
  maxTurns: number;
  maxTestRetries: number;
  pollInterval: number;
  label: string;
  skipTests: boolean;
  skipReview: boolean;
  dryRun: boolean;
  autoCleanup: boolean;
}

export interface PipelineResult {
  issueNumber: number;
  stage: PipelineStage;
  success: boolean;
  prNumber?: number;
  error?: string;
  duration: number;
}

export interface StageEvent {
  issueNumber: number;
  from: PipelineStage;
  to: PipelineStage;
  message?: string;
}

type StageListener = (event: StageEvent) => void;

// --- Default config ---

export function defaultConfig(
  overrides: Partial<LoopConfig> = {},
): LoopConfig {
  return {
    owner: overrides.owner ?? "owner",
    repo: overrides.repo ?? "repo",
    baseBranch: overrides.baseBranch ?? "master",
    model: overrides.model ?? "opus",
    reviewModel: overrides.reviewModel,
    maxTurns: overrides.maxTurns ?? 30,
    maxTestRetries: overrides.maxTestRetries ?? 3,
    pollInterval: overrides.pollInterval ?? 60,
    label: overrides.label ?? "ready",
    skipTests: overrides.skipTests ?? false,
    skipReview: overrides.skipReview ?? false,
    dryRun: overrides.dryRun ?? false,
    autoCleanup: overrides.autoCleanup ?? true,
  };
}

// --- Helpers ---

function log(stage: PipelineStage, issueNumber: number, msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${stage}] #${issueNumber}: ${msg}`);
}

function runTests(cwd: string): { success: boolean; output: string } {
  try {
    const output = execSync("pnpm test", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 120_000,
    });
    return { success: true, output };
  } catch (err: unknown) {
    const output =
      (err as { stdout?: string }).stdout ??
      (err as { stderr?: string }).stderr ??
      String(err);
    return { success: false, output };
  }
}

function pushBranch(cwd: string, branch: string): void {
  // Validate branch name to prevent command injection
  if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
  execSync(`git push -u origin '${branch}'`, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

// --- Pipeline ---

export interface ProcessIssueOptions {
  db?: Database.Database;
}

export async function processIssue(
  issue: GitHubIssue,
  config: LoopConfig,
  runner: AgentRunner,
  github: GitHubClient,
  onStage?: StageListener,
  options?: ProcessIssueOptions,
): Promise<PipelineResult> {
  const start = Date.now();
  let currentStage: PipelineStage = "setup";
  let worktreePath: string | undefined;
  const db = options?.db;
  const stages: string[] = [];
  const stageDurations: Record<string, number> = {};
  let stageStart = Date.now();
  let testOutput = "";
  let reviewOutput = "";

  // Create run record in DB
  const run = db
    ? createRun(db, {
        issue_number: issue.number,
        issue_title: issue.title,
        agent: runner.name,
        model: config.model,
      })
    : undefined;

  function emitSSE(event: LoopEvent): void {
    loopEmitter.emit("loopEvent", event);
  }

  function transition(to: PipelineStage, message?: string): void {
    const from = currentStage;
    const now = Date.now();

    // Record duration for the stage we're leaving
    if (from !== to) {
      const duration = Math.round((now - stageStart) / 1000);
      stageDurations[from] = (stageDurations[from] ?? 0) + duration;

      // Emit stage_complete for the stage we're leaving
      emitSSE({
        type: "stage_complete",
        data: { issue: issue.number, stage: from, duration, timestamp: new Date().toISOString() },
      });
    }

    currentStage = to;
    stages.push(to);
    stageStart = now;
    log(to, issue.number, message ?? `Entering ${to}`);
    onStage?.({ issueNumber: issue.number, from, to, message });

    // Emit stage event (backward compat)
    emitSSE({
      type: "stage",
      data: { issue: issue.number, stage: to, timestamp: new Date().toISOString() },
    });

    // Emit stage_start for the new stage
    emitSSE({
      type: "stage_start",
      data: { issue: issue.number, stage: to, timestamp: new Date().toISOString() },
    });
  }

  function fail(error: string): PipelineResult {
    const failedAtStage = currentStage;
    transition("failed", error);
    emitSSE({
      type: "error",
      data: { message: error, stage: failedAtStage, timestamp: new Date().toISOString() },
    });
    const duration = Date.now() - start;
    if (run && db) {
      updateRun(db, run.id, {
        status: "failure",
        stages_json: JSON.stringify(stages),
        stage_durations_json: JSON.stringify(stageDurations),
        duration_seconds: Math.round(duration / 1000),
        test_output: testOutput || undefined,
        review_output: reviewOutput || undefined,
      });
    }
    return {
      issueNumber: issue.number,
      stage: currentStage,
      success: false,
      error,
      duration,
    };
  }

  try {
    // --- Setup ---
    transition("setup", "Creating worktree");
    await github.updateLabels(issue.number, ["in-progress"], [config.label]);

    let worktreeResult;
    try {
      worktreeResult = createWorktree(issue.number, {
        baseBranch: config.baseBranch,
      });
      worktreePath = worktreeResult.path;
    } catch (err) {
      await github.addComment(
        issue.number,
        `Agent loop failed: could not create worktree.\n\n\`\`\`\n${String(err)}\n\`\`\``,
      );
      return fail(`Worktree creation failed: ${String(err)}`);
    }

    // --- Implement ---
    transition("implement", "Running agent for implementation");
    const implementPrompt = buildImplementPrompt(issue);
    const implementOpts: RunOptions = {
      prompt: implementPrompt,
      model: config.model,
      maxTurns: config.maxTurns,
      cwd: worktreePath,
    };

    const implementResult = await runner.run(implementOpts);
    if (!implementResult.success) {
      await github.updateLabels(issue.number, ["failed"], ["in-progress"]);
      await github.addComment(
        issue.number,
        `Agent loop failed during implementation (exit code ${implementResult.exitCode}).`,
      );
      return fail(`Implementation failed (exit ${implementResult.exitCode})`);
    }

    // --- Test (with retry) ---
    if (!config.skipTests) {
      let testsPassed = false;

      for (let attempt = 1; attempt <= config.maxTestRetries; attempt++) {
        transition("test", `Test attempt ${attempt}/${config.maxTestRetries}`);
        const testResult = runTests(worktreePath);
        testOutput = testResult.output;

        // Emit structured test result
        emitSSE({
          type: "test_result",
          data: {
            passed: testResult.success ? 1 : 0,
            failed: testResult.success ? 0 : 1,
            attempt,
            maxAttempts: config.maxTestRetries,
            timestamp: new Date().toISOString(),
          },
        });

        if (testResult.success) {
          testsPassed = true;
          break;
        }

        if (attempt < config.maxTestRetries) {
          transition("fix", `Fixing test failures (attempt ${attempt})`);
          const fixPrompt = buildFixPrompt(issue.number, testResult.output);
          const fixResult = await runner.run({
            prompt: fixPrompt,
            model: config.model,
            maxTurns: 20,
            cwd: worktreePath,
          });
          if (!fixResult.success) {
            log("fix", issue.number, "Fix agent failed, will retry tests anyway");
          }
        }
      }

      if (!testsPassed) {
        log("test", issue.number, "Tests still failing after all retries");
        // Continue to PR with failing tests — reviewer and humans can assess
      }
    }

    // --- Review ---
    if (!config.skipReview) {
      transition("review", "Running code review");
      const reviewPrompt = buildReviewPrompt(issue, config.baseBranch);
      const reviewResult = await runner.run({
        prompt: reviewPrompt,
        model: config.reviewModel ?? config.model,
        maxTurns: 15,
        cwd: worktreePath,
      });
      reviewOutput = reviewResult.output;

      // Emit structured review result
      emitSSE({
        type: "review_result",
        data: {
          issue: issue.number,
          success: reviewResult.success,
          timestamp: new Date().toISOString(),
        },
      });

      if (!reviewResult.success) {
        log("review", issue.number, "Review agent failed, continuing");
      }
    }

    // --- PR ---
    transition("pr", "Pushing branch and creating PR");
    const branch = branchName(issue.number);

    try {
      pushBranch(worktreePath, branch);
    } catch (err) {
      await github.updateLabels(issue.number, ["failed"], ["in-progress"]);
      return fail(`Failed to push branch: ${String(err)}`);
    }

    // Capture diff stat for "What to Test" section
    let diffStat = "";
    try {
      diffStat = execSync(`git diff ${config.baseBranch}...HEAD --stat`, {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch {
      // Best-effort
    }

    const whatToTest = buildWhatToTest(issue, diffStat);

    let prNumber: number;
    try {
      const pr = await github.createPR({
        branch,
        base: config.baseBranch,
        title: `feat: ${issue.title} (closes #${issue.number})`,
        body: `## Summary\n\nAutomated implementation of #${issue.number}: **${issue.title}**\n\n## What to Test\n\n${whatToTest}\n\n---\nAutomated by alpha-loop | [Issue #${issue.number}](https://github.com/${config.owner}/${config.repo}/issues/${issue.number})`,
      });
      prNumber = pr.number;
    } catch (err) {
      await github.updateLabels(issue.number, ["failed"], ["in-progress"]);
      await github.addComment(
        issue.number,
        `Agent loop failed: could not create PR. Branch: ${branch}`,
      );
      return fail(`PR creation failed: ${String(err)}`);
    }

    await github.updateLabels(issue.number, ["in-review"], ["in-progress"]);
    await github.addComment(
      issue.number,
      `Implementation complete. PR: #${prNumber}`,
    );

    // Capture diff before cleanup for learnings context
    let diffOutput = "";
    try {
      diffOutput = execSync(`git diff ${config.baseBranch}...HEAD`, {
        cwd: worktreePath,
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch {
      // Best-effort — diff may not be available
    }

    // --- Cleanup ---
    transition("cleanup", "Removing worktree");
    if (config.autoCleanup) {
      try {
        removeWorktree(issue.number);
      } catch {
        log("cleanup", issue.number, "Worktree cleanup failed (non-fatal)");
      }
      worktreePath = undefined;
    }

    transition("done", "Pipeline complete");
    const duration = Date.now() - start;
    const prUrl = `https://github.com/${config.owner}/${config.repo}/pull/${prNumber}`;

    // Update run record with all details
    if (run && db) {
      updateRun(db, run.id, {
        status: "success",
        stages_json: JSON.stringify(stages),
        stage_durations_json: JSON.stringify(stageDurations),
        pr_url: prUrl,
        duration_seconds: Math.round(duration / 1000),
        test_output: testOutput || undefined,
        review_output: reviewOutput || undefined,
        diff_stat: diffStat || undefined,
      });
    }

    // Emit complete SSE event
    emitSSE({
      type: "complete",
      data: { issue: issue.number, prUrl, duration },
    });

    // Extract learnings
    if (run && db) {
      try {
        const result = await extractLearnings(
          { ...run, status: "success", duration_seconds: Math.round(duration / 1000), pr_url: prUrl },
          { issueBody: issue.body ?? "", diff: diffOutput, testOutput: "", reviewOutput: "", retryCount: 0 },
          runner,
          db,
        );
        if (result.learnings.length > 0) {
          emitSSE({
            type: "output",
            data: { line: `Extracted ${result.learnings.length} learnings`, timestamp: new Date().toISOString() },
          });
        }
      } catch (err) {
        log("done", issue.number, `Learning extraction failed (non-fatal): ${String(err)}`);
      }
    }

    return {
      issueNumber: issue.number,
      stage: "done",
      success: true,
      prNumber,
      duration,
    };
  } catch (err) {
    return fail(`Unexpected error: ${String(err)}`);
  } finally {
    // Ensure cleanup on unexpected failure
    if (worktreePath && config.autoCleanup) {
      try {
        removeWorktree(issue.number);
      } catch {
        // Best-effort
      }
    }
  }
}

// --- Loop ---

export interface StartLoopOptions {
  db?: Database.Database;
  once?: boolean;
  selectedIssues?: number[];
}

export async function startLoop(
  config: LoopConfig,
  runner: AgentRunner,
  github: GitHubClient,
  onStage?: StageListener,
  options?: StartLoopOptions,
): Promise<void> {
  let running = true;
  const db = options?.db;

  function shutdown(): void {
    console.log("\nShutting down gracefully...");
    running = false;
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    while (running) {
      let issues: GitHubIssue[];

      if (options?.selectedIssues && options.selectedIssues.length > 0) {
        // Use pre-selected issues (from interactive selection or --issues flag)
        const allIssues = await github.listIssues({
          labels: [config.label],
          state: "open",
          limit: 100,
        });
        const issueMap = new Map(allIssues.map((i) => [i.number, i]));
        issues = options.selectedIssues
          .map((n) => issueMap.get(n))
          .filter((i): i is GitHubIssue => i !== undefined);
      } else {
        issues = await github.listIssues({
          labels: [config.label],
          state: "open",
        });
      }

      if (issues.length === 0) {
        log("setup", 0, `No issues labeled '${config.label}', sleeping ${config.pollInterval}s`);
        if (options?.once) break;
        await sleep(config.pollInterval * 1000);
        continue;
      }

      for (const issue of issues) {
        if (!running) break;

        log("setup", issue.number, `Processing: ${issue.title}`);
        const result = await processIssue(issue, config, runner, github, onStage, { db });

        if (result.success) {
          log("done", issue.number, `Completed in ${result.duration}ms`);
        } else {
          log("failed", issue.number, `Failed at ${result.stage}: ${result.error}`);
        }
      }

      if (options?.once) break;

      if (running) {
        log("setup", 0, `Cycle complete. Sleeping ${config.pollInterval}s`);
        await sleep(config.pollInterval * 1000);
      }
    }
  } finally {
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
}

// --- Prompt builders ---

function buildImplementPrompt(issue: GitHubIssue): string {
  return `Implement GitHub issue #${issue.number}: ${issue.title}

${issue.body ?? ""}

After implementing, write tests, run pnpm test to verify, and commit with: git commit -m "feat: ${issue.title} (closes #${issue.number})"`;
}

function buildFixPrompt(issueNumber: number, testOutput: string): string {
  return `The following tests are failing after implementing issue #${issueNumber}.
Fix the test failures. Only fix tests that are actually broken by your changes.

Test errors:
${testOutput}

Instructions:
1. Read the failing test files to understand what they expect
2. Fix the implementation code OR the tests as appropriate
3. Run pnpm test to verify fixes
4. Commit your fixes with message: fix: resolve test failures for issue #${issueNumber}`;
}

export function buildWhatToTest(issue: GitHubIssue, diffStat?: string): string {
  const body = issue.body ?? "";

  // Try to extract manual test instructions from the issue body
  const manualTestMatch = body.match(
    /### Manual Test Instructions\s*\n([\s\S]*?)(?=\n### |\n$|$)/,
  );
  if (manualTestMatch) {
    const instructions = manualTestMatch[1].trim();
    if (instructions.length > 0) {
      return instructions;
    }
  }

  // Fallback: generate from diff stat and issue content
  const lines: string[] = [
    "_Auto-generated — no manual test instructions were provided in the issue._",
    "",
  ];

  if (diffStat) {
    lines.push("**Changed files:**", "```", diffStat.trim(), "```", "");
  }

  // Extract acceptance criteria for verification hints
  const acMatch = body.match(
    /### Acceptance Criteria\s*\n([\s\S]*?)(?=\n### |\n$|$)/,
  );
  if (acMatch) {
    const criteria = acMatch[1].trim();
    if (criteria.length > 0) {
      lines.push("**Verify acceptance criteria:**", criteria, "");
    }
  }

  return lines.join("\n");
}

function buildReviewPrompt(issue: GitHubIssue, baseBranch: string): string {
  return `Review the code changes for issue #${issue.number}: ${issue.title}

Run git diff origin/${baseBranch}...HEAD to see what changed.

Original requirements:
${issue.body ?? ""}

Review for: correctness vs requirements, security issues, missing tests, code quality.

For any issues you find:
- CRITICAL or WARNING issues: fix them directly, run tests, and commit with "fix: address review findings for #${issue.number}"
- Issues you cannot fix: note them for the output

After fixing, output a brief review summary.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
