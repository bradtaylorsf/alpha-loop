/**
 * Resume Command — pick up stranded work from a crashed or hung loop session.
 *
 * Finds local branches matching agent/issue-* that have commits ahead of
 * origin/<baseBranch> but no corresponding open PR, then pushes, reviews,
 * and opens a PR for each one.
 */
import { loadConfig } from '../lib/config.js';
import { log } from '../lib/logger.js';
import { exec } from '../lib/shell.js';
import { spawnAgent } from '../lib/agent.js';
import { buildReviewPrompt } from '../lib/prompts.js';
import {
  labelIssue,
  commentIssue,
  createPR,
  updateProjectStatus,
} from '../lib/github.js';

export type ResumeOptions = {
  issue?: string;
  session?: string;
};

type StrandedBranch = {
  branch: string;
  issueNum: number;
  commits: string[];
  filesChanged: string[];
};

/**
 * Find local branches matching agent/issue-* that have no open PR and have
 * commits ahead of the remote base branch.
 */
function findStrandedBranches(baseBranch: string, filterIssue?: number): StrandedBranch[] {
  const listResult = exec('git branch --list "agent/issue-*"');
  if (listResult.exitCode !== 0 || !listResult.stdout.trim()) {
    return [];
  }

  const branches = listResult.stdout
    .split('\n')
    .map((b) => b.trim().replace(/^\*\s*/, ''))
    .filter(Boolean);

  const stranded: StrandedBranch[] = [];

  for (const branch of branches) {
    // Parse issue number from branch name
    const match = branch.match(/^agent\/issue-(\d+)$/);
    if (!match) continue;

    const issueNum = parseInt(match[1], 10);

    // Apply --issue filter if provided
    if (filterIssue !== undefined && issueNum !== filterIssue) continue;

    // Check if there are commits ahead of the base branch
    const aheadResult = exec(
      `git log "origin/${baseBranch}..${branch}" --oneline`,
    );
    if (aheadResult.exitCode !== 0 || !aheadResult.stdout.trim()) {
      // No commits ahead — not stranded
      continue;
    }

    const commits = aheadResult.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Get files changed relative to base branch
    const filesResult = exec(
      `git diff --name-only "origin/${baseBranch}...${branch}"`,
    );
    const filesChanged = filesResult.exitCode === 0
      ? filesResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      : [];

    stranded.push({ branch, issueNum, commits, filesChanged });
  }

  return stranded;
}

/**
 * Return true if an open PR already exists for the given branch.
 */
function prExists(repo: string, branch: string): boolean {
  const result = exec(
    `gh pr list --repo "${repo}" --head "${branch}" --state open --json number --limit 1`,
  );
  if (result.exitCode !== 0) return false;
  try {
    const prs = JSON.parse(result.stdout) as Array<{ number: number }>;
    return prs.length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch the issue title from GitHub.
 */
function getIssueTitle(repo: string, issueNum: number): string {
  const result = exec(
    `gh issue view ${issueNum} --repo "${repo}" --json title`,
  );
  if (result.exitCode !== 0) return `Issue #${issueNum}`;
  try {
    const data = JSON.parse(result.stdout) as { title: string };
    return data.title;
  } catch {
    return `Issue #${issueNum}`;
  }
}

/**
 * Get the diff between the base branch and the given branch.
 */
function getBranchDiff(baseBranch: string, branch: string): string {
  const result = exec(`git diff "origin/${baseBranch}...${branch}"`);
  if (result.exitCode !== 0) return '';
  // Cap at 50k chars to avoid bloating the review prompt
  const MAX = 50_000;
  if (result.stdout.length > MAX) {
    return result.stdout.slice(0, MAX) + '\n... (diff truncated)';
  }
  return result.stdout;
}

/**
 * Print what was found for a stranded branch.
 */
function printStrandedSummary(item: StrandedBranch): void {
  log.step(`Found stranded branch: ${item.branch}`);
  log.info(`  Issue:   #${item.issueNum}`);
  log.info(`  Commits: ${item.commits.length}`);
  for (const commit of item.commits) {
    log.info(`    ${commit}`);
  }
  log.info(`  Files changed: ${item.filesChanged.length}`);
  for (const file of item.filesChanged.slice(0, 10)) {
    log.info(`    ${file}`);
  }
  if (item.filesChanged.length > 10) {
    log.info(`    ... and ${item.filesChanged.length - 10} more`);
  }
}

/**
 * Resume a single stranded branch — push, review, open PR, update labels.
 */
async function resumeBranch(
  item: StrandedBranch,
  config: ReturnType<typeof loadConfig>,
): Promise<{ issueNum: number; prUrl: string } | null> {
  const { branch, issueNum } = item;
  const repo = config.repo;
  const baseBranch = config.baseBranch;

  const title = getIssueTitle(repo, issueNum);
  log.step(`Resuming issue #${issueNum}: ${title}`);

  // Push the branch so createPR can work with it.
  // createPR also pushes internally, but we do it first here for explicit
  // feedback and to fail fast if the push is going to be a problem.
  log.info(`Pushing ${branch} to origin...`);
  const pushResult = exec(`git push -u origin "${branch}"`);
  if (pushResult.exitCode !== 0) {
    log.warn(`Push failed: ${pushResult.stderr}. Attempting force push...`);
    const forceResult = exec(`git push -u origin "${branch}" --force`);
    if (forceResult.exitCode !== 0) {
      log.error(`Could not push ${branch}: ${forceResult.stderr}`);
      return null;
    }
  }

  // Run code review
  let reviewOutput = '';
  if (!config.skipReview) {
    log.step(`Running code review for #${issueNum}...`);

    const diff = getBranchDiff(baseBranch, branch);

    // buildReviewPrompt expects body and baseBranch; we pass the diff as body
    // context so the reviewer can see the changes inline.
    const reviewPrompt = buildReviewPrompt({
      issueNum,
      title,
      body: diff ? `## Diff\n\`\`\`diff\n${diff}\n\`\`\`` : '(no diff available)',
      baseBranch,
    });

    // Determine the cwd for the review — use the repo root (git toplevel).
    const toplevelResult = exec('git rev-parse --show-toplevel');
    const cwd = toplevelResult.exitCode === 0 ? toplevelResult.stdout : process.cwd();

    // Switch to the branch so the agent can run git commands against it.
    exec(`git checkout "${branch}"`);

    const reviewResult = await spawnAgent({
      agent: 'claude',
      model: config.reviewModel,
      prompt: reviewPrompt,
      cwd,
      verbose: config.verbose,
      timeout: 10 * 60 * 1000, // 10 minutes for a review
      maxTurns: 20,
    });

    reviewOutput = reviewResult.output;

    if (reviewResult.exitCode !== 0) {
      log.warn(`Review agent exited with code ${reviewResult.exitCode}`);
    } else {
      log.success(`Review complete for #${issueNum}`);
    }
  }

  // Build PR body
  const prBody = reviewOutput
    ? `## Code Review\n\n${reviewOutput}`
    : `Resumes stranded work for issue #${issueNum}.`;

  // Create PR (createPR handles push internally as well; that is idempotent)
  log.step(`Creating PR for #${issueNum}...`);
  let prUrl: string;
  try {
    prUrl = createPR({
      repo,
      base: baseBranch,
      head: branch,
      title: `feat: ${title} (closes #${issueNum})`,
      body: prBody,
    });
  } catch (err) {
    log.error(`Failed to create PR for #${issueNum}: ${String(err)}`);
    return null;
  }

  log.success(`PR created: ${prUrl}`);

  // Update issue labels: add in-review, remove in-progress
  labelIssue(repo, issueNum, 'in-review', 'in-progress');

  // Update project board status to Done
  if (config.project && config.project > 0) {
    updateProjectStatus(repo, config.project, config.repoOwner, issueNum, 'Done');
  }

  // Comment on the issue with the PR link
  commentIssue(
    repo,
    issueNum,
    `Resumed by alpha-loop. PR ready for review: ${prUrl}`,
  );

  return { issueNum, prUrl };
}

/**
 * Main entry point for `alpha-loop resume`.
 */
export async function resumeCommand(options: ResumeOptions): Promise<void> {
  const config = loadConfig();

  if (!config.repo) {
    log.error('No repo configured. Set `repo` in .alpha-loop.yaml or the REPO env var.');
    process.exit(1);
  }

  const filterIssue = options.issue ? parseInt(options.issue, 10) : undefined;

  if (options.issue && isNaN(filterIssue!)) {
    log.error(`Invalid issue number: ${options.issue}`);
    process.exit(1);
  }

  log.step('Scanning for stranded branches...');

  // Find local branches with unpushed/unreviewed work
  const stranded = findStrandedBranches(config.baseBranch, filterIssue);

  // Filter out branches that already have an open PR
  const withoutPR = stranded.filter((item) => !prExists(config.repo, item.branch));

  if (withoutPR.length === 0) {
    if (stranded.length > 0) {
      log.info('All stranded branches already have open PRs — nothing to resume.');
    } else {
      log.info('No stranded branches found — nothing to resume.');
    }
    return;
  }

  log.info(`Found ${withoutPR.length} stranded branch(es) without a PR:`);
  for (const item of withoutPR) {
    printStrandedSummary(item);
  }

  // Process each stranded branch
  const results: Array<{ issueNum: number; prUrl: string }> = [];
  const failed: number[] = [];

  for (const item of withoutPR) {
    const result = await resumeBranch(item, config);
    if (result) {
      results.push(result);
    } else {
      failed.push(item.issueNum);
    }
  }

  // Print summary
  console.error('');
  log.step('Resume summary');

  if (results.length > 0) {
    log.success(`Resumed ${results.length} issue(s):`);
    for (const r of results) {
      log.info(`  #${r.issueNum} -> ${r.prUrl}`);
    }
  }

  if (failed.length > 0) {
    log.warn(`Failed to resume ${failed.length} issue(s): ${failed.map((n) => `#${n}`).join(', ')}`);
  }
}
