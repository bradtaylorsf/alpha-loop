/**
 * GitHub Helpers — interact with GitHub via the `gh` CLI.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from './shell.js';
import * as logger from './logger.js';

export type Issue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
};

export type Milestone = {
  number: number;
  title: string;
  description: string;
  openIssues: number;
  closedIssues: number;
  dueOn: string | null;
  state: string;
};

/**
 * List open milestones for a repository.
 */
export function listMilestones(repo: string): Milestone[] {
  const result = exec(
    `gh api "repos/${repo}/milestones?state=open&sort=due_on&direction=asc" --jq '[.[] | {number, title, description, openIssues: .open_issues, closedIssues: .closed_issues, dueOn: .due_on, state}]'`,
  );
  if (result.exitCode !== 0) {
    logger.warn(`Failed to list milestones: ${result.stderr}`);
    return [];
  }
  try {
    return JSON.parse(result.stdout) as Milestone[];
  } catch {
    logger.warn('Failed to parse milestones JSON');
    return [];
  }
}

/**
 * Fetch issues to process. When a project board is configured, reads from
 * the board in display order (the order you set by dragging), filtered to
 * "Todo" status. Falls back to label-based polling when no project is set.
 *
 * When a milestone is specified, only issues in that milestone are returned.
 */
export function pollIssues(repo: string, label: string, limit = 10, options?: { project?: number; repoOwner?: string; milestone?: string }): Issue[] {
  const project = options?.project;
  const repoOwner = options?.repoOwner ?? repo.split('/')[0];
  const milestone = options?.milestone;

  // If project board is configured, use it for ordering
  if (project && project > 0) {
    return pollIssuesByProject(repoOwner, project, limit, { repo, milestone });
  }

  // Fallback: poll by label
  return pollIssuesByLabel(repo, label, limit, milestone);
}

/**
 * Poll from GitHub Project board — items come in the board's display order.
 * Filters to "Todo" status only. When a milestone is specified, cross-references
 * with the GitHub API to only include issues in that milestone.
 */
function pollIssuesByProject(owner: string, project: number, limit: number, options?: { repo?: string; milestone?: string }): Issue[] {
  const result = exec(
    `gh project item-list ${project} --owner "${owner}" --format json --limit 100`,
  );
  if (result.exitCode !== 0) {
    logger.warn(`Failed to poll project board: ${result.stderr}`);
    return [];
  }
  try {
    const data = JSON.parse(result.stdout) as {
      items: Array<{
        status: string;
        content: { type: string; number: number; title: string; body: string };
        labels?: Array<{ name: string }>;
      }>;
    };

    let items = data.items
      .filter((item) => item.status === 'Todo' && item.content?.type === 'Issue');

    // Filter by milestone if specified
    if (options?.milestone && options?.repo) {
      const milestoneIssues = getMilestoneIssueNumbers(options.repo, options.milestone);
      if (milestoneIssues) {
        items = items.filter((item) => milestoneIssues.has(item.content.number));
      }
    }

    return items
      .slice(0, limit)
      .map((item) => ({
        number: item.content.number,
        title: item.content.title,
        body: item.content.body ?? '',
        labels: (item.labels ?? []).map((l) => l.name),
      }));
  } catch {
    logger.warn('Failed to parse project board JSON');
    return [];
  }
}

/**
 * Get the set of open issue numbers belonging to a milestone.
 */
function getMilestoneIssueNumbers(repo: string, milestone: string): Set<number> | null {
  const result = exec(
    `gh issue list --repo "${repo}" --milestone "${milestone}" --state open --json number --limit 100`,
  );
  if (result.exitCode !== 0) return null;
  try {
    const issues = JSON.parse(result.stdout) as Array<{ number: number }>;
    return new Set(issues.map((i) => i.number));
  } catch {
    return null;
  }
}

/**
 * Fallback: poll issues by label when no project board is configured.
 * Optionally filters by milestone.
 */
function pollIssuesByLabel(repo: string, label: string, limit: number, milestone?: string): Issue[] {
  const milestoneFlag = milestone ? ` --milestone "${milestone}"` : '';
  const result = exec(
    `gh issue list --repo "${repo}" --label "${label}" --state open${milestoneFlag} --json number,title,body,labels --limit ${limit}`,
  );
  if (result.exitCode !== 0) {
    logger.warn(`Failed to poll issues: ${result.stderr}`);
    return [];
  }
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
    }>;
    return raw
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        labels: (issue.labels ?? []).map((l) => l.name),
      }))
      .sort((a, b) => a.number - b.number)
      .slice(0, limit);
  } catch {
    logger.warn('Failed to parse issues JSON');
    return [];
  }
}

/**
 * Add/remove labels on an issue.
 */
export function labelIssue(repo: string, issueNum: number, addLabel: string, removeLabel?: string): void {
  const args = [`gh issue edit ${issueNum} --repo "${repo}" --add-label "${addLabel}"`];
  if (removeLabel) {
    args[0] += ` --remove-label "${removeLabel}"`;
  }
  const result = exec(args[0]);
  if (result.exitCode !== 0) {
    logger.warn(`Failed to update labels on issue #${issueNum}: ${result.stderr}`);
  }
}

/**
 * Comment on an issue.
 */
export function commentIssue(repo: string, issueNum: number, body: string): void {
  const result = exec(
    `gh issue comment ${issueNum} --repo "${repo}" --body ${JSON.stringify(body)}`,
  );
  if (result.exitCode !== 0) {
    logger.warn(`Failed to comment on issue #${issueNum}: ${result.stderr}`);
  }
}

export type CreatePROptions = {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  cwd?: string;
};

/**
 * Create a PR, or update an existing one if a PR already exists for the branch.
 * Returns the PR URL.
 */
export function createPR(options: CreatePROptions): string {
  const { repo, base, head, title, body, cwd } = options;

  // Push the branch first
  const pushResult = exec(`git push -u origin "${head}"`, { cwd });
  if (pushResult.exitCode !== 0) {
    // Try force push if branch exists from previous attempt
    logger.warn('Push failed, trying force push...');
    const forceResult = exec(`git push -u origin "${head}" --force`, { cwd });
    if (forceResult.exitCode !== 0) {
      throw new Error(`Failed to push branch ${head}: ${forceResult.stderr}`);
    }
  }

  // Write body to a temp file to avoid shell argument length/escaping issues
  const truncatedBody = truncateBody(body);
  const bodyFile = join(tmpdir(), `alpha-loop-pr-body-${Date.now()}`);
  writeFileSync(bodyFile, truncatedBody, 'utf-8');

  try {
    // Check if PR already exists for this branch
    const existingResult = exec(
      `gh pr list --repo "${repo}" --head "${head}" --json number,url --limit 1`,
    );
    if (existingResult.exitCode === 0 && existingResult.stdout) {
      try {
        const existing = JSON.parse(existingResult.stdout) as Array<{ number: number; url: string }>;
        if (existing.length > 0) {
          const prUrl = existing[0].url;
          logger.info(`PR already exists: ${prUrl}, updating...`);
          exec(`gh pr edit ${existing[0].number} --repo "${repo}" --body-file "${bodyFile}"`);
          return prUrl;
        }
      } catch {
        // Fall through to create
      }
    }

    // Create new PR using --body-file to avoid shell escaping issues
    const createResult = exec(
      `gh pr create --repo "${repo}" --base "${base}" --head "${head}" --title ${JSON.stringify(title)} --body-file "${bodyFile}"`,
    );
    if (createResult.exitCode !== 0) {
      throw new Error(`Failed to create PR: ${createResult.stderr}`);
    }

    return createResult.stdout.trim();
  } finally {
    try { unlinkSync(bodyFile); } catch { /* cleanup best-effort */ }
  }
}

/**
 * Merge a PR by branch name.
 */
export function mergePR(repo: string, head: string, method: 'squash' | 'merge' = 'squash'): void {
  // Find the PR number by branch
  const listResult = exec(
    `gh pr list --repo "${repo}" --head "${head}" --json number --limit 1`,
  );
  if (listResult.exitCode !== 0 || !listResult.stdout) {
    logger.warn(`No PR found to merge for branch ${head}`);
    return;
  }

  let prNum: number;
  try {
    const prs = JSON.parse(listResult.stdout) as Array<{ number: number }>;
    if (prs.length === 0) {
      logger.warn(`No PR found to merge for branch ${head}`);
      return;
    }
    prNum = prs[0].number;
  } catch {
    logger.warn('Failed to parse PR list');
    return;
  }

  const mergeFlag = method === 'squash' ? '--squash' : '--merge';
  const result = exec(
    `gh pr merge ${prNum} --repo "${repo}" ${mergeFlag} --delete-branch`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to merge PR #${prNum}: ${result.stderr}`);
  }
  logger.info(`PR #${prNum} merged`);
}

/**
 * Update project board status for an issue.
 * This is a multi-step operation using gh project commands.
 */
export function updateProjectStatus(
  repo: string,
  projectNum: number,
  owner: string,
  issueNum: number,
  status: string,
): void {
  // Find the item ID for this issue in the project
  const itemResult = exec(
    `gh project item-list ${projectNum} --owner "${owner}" --format json --limit 100`,
  );
  if (itemResult.exitCode !== 0) {
    logger.warn(`Could not list project items: ${itemResult.stderr}`);
    return;
  }

  let itemId: string | undefined;
  try {
    const data = JSON.parse(itemResult.stdout) as {
      items: Array<{ id: string; content: { number: number } }>;
    };
    const item = data.items.find((i) => i.content?.number === issueNum);
    itemId = item?.id;
  } catch {
    logger.warn('Failed to parse project items');
    return;
  }

  if (!itemId) {
    logger.warn(`Could not find project item for issue #${issueNum}`);
    return;
  }

  // Get the Status field ID and option ID
  const fieldResult = exec(
    `gh project field-list ${projectNum} --owner "${owner}" --format json`,
  );
  if (fieldResult.exitCode !== 0) {
    logger.warn(`Could not list project fields: ${fieldResult.stderr}`);
    return;
  }

  let fieldId: string | undefined;
  let optionId: string | undefined;
  try {
    const data = JSON.parse(fieldResult.stdout) as {
      fields: Array<{
        id: string;
        name: string;
        options?: Array<{ id: string; name: string }>;
      }>;
    };
    const statusField = data.fields.find((f) => f.name === 'Status');
    if (statusField) {
      fieldId = statusField.id;
      const option = statusField.options?.find((o) => o.name === status);
      optionId = option?.id;
    }
  } catch {
    logger.warn('Failed to parse project fields');
    return;
  }

  if (!fieldId || !optionId) {
    logger.warn(`Could not resolve project field/option for status '${status}'`);
    return;
  }

  // Get project ID
  const projectResult = exec(
    `gh project view ${projectNum} --owner "${owner}" --format json`,
  );
  if (projectResult.exitCode !== 0) {
    logger.warn(`Could not view project: ${projectResult.stderr}`);
    return;
  }

  let projectId: string | undefined;
  try {
    const data = JSON.parse(projectResult.stdout) as { id: string };
    projectId = data.id;
  } catch {
    logger.warn('Failed to parse project data');
    return;
  }

  if (!projectId) {
    logger.warn('Could not get project ID');
    return;
  }

  // Update the item
  const editResult = exec(
    `gh project item-edit --project-id "${projectId}" --id "${itemId}" --field-id "${fieldId}" --single-select-option-id "${optionId}"`,
  );
  if (editResult.exitCode !== 0) {
    logger.warn(`Failed to update project status for #${issueNum}: ${editResult.stderr}`);
    return;
  }

  logger.info(`Project board: #${issueNum} -> ${status}`);
}

/**
 * Truncate PR body at 30k chars to stay within GitHub limits.
 */
function truncateBody(body: string): string {
  if (body.length <= 30000) return body;
  return body.slice(0, 30000) + '\n\n... (body truncated, see full log)';
}
