import { execSync } from "node:child_process";
import type { AgentRunner, RunOptions } from "./runner.js";
import type { GitHubClient, GitHubIssue } from "./github.js";
import { createWorktree, removeWorktree, branchName } from "./worktree.js";

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
    model: overrides.model ?? "sonnet",
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
  execSync(`git push -u origin ${branch}`, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

// --- Pipeline ---

export async function processIssue(
  issue: GitHubIssue,
  config: LoopConfig,
  runner: AgentRunner,
  github: GitHubClient,
  onStage?: StageListener,
): Promise<PipelineResult> {
  const start = Date.now();
  let currentStage: PipelineStage = "setup";
  let worktreePath: string | undefined;

  function transition(to: PipelineStage, message?: string): void {
    const from = currentStage;
    currentStage = to;
    log(to, issue.number, message ?? `Entering ${to}`);
    onStage?.({ issueNumber: issue.number, from, to, message });
  }

  function fail(error: string): PipelineResult {
    transition("failed", error);
    return {
      issueNumber: issue.number,
      stage: currentStage,
      success: false,
      error,
      duration: Date.now() - start,
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

    let prNumber: number;
    try {
      const pr = await github.createPR({
        branch,
        base: config.baseBranch,
        title: `feat: ${issue.title} (closes #${issue.number})`,
        body: `## Summary\n\nAutomated implementation of #${issue.number}: **${issue.title}**\n\n---\nAutomated by alpha-loop`,
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
    return {
      issueNumber: issue.number,
      stage: "done",
      success: true,
      prNumber,
      duration: Date.now() - start,
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

export async function startLoop(
  config: LoopConfig,
  runner: AgentRunner,
  github: GitHubClient,
  onStage?: StageListener,
): Promise<void> {
  let running = true;

  function shutdown(): void {
    console.log("\nShutting down gracefully...");
    running = false;
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    while (running) {
      const issues = await github.listIssues({
        labels: [config.label],
        state: "open",
      });

      if (issues.length === 0) {
        log("setup", 0, `No issues labeled '${config.label}', sleeping ${config.pollInterval}s`);
        await sleep(config.pollInterval * 1000);
        continue;
      }

      for (const issue of issues) {
        if (!running) break;

        log("setup", issue.number, `Processing: ${issue.title}`);
        const result = await processIssue(issue, config, runner, github, onStage);

        if (result.success) {
          log("done", issue.number, `Completed in ${result.duration}ms`);
        } else {
          log("failed", issue.number, `Failed at ${result.stage}: ${result.error}`);
        }
      }

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
