/**
 * GitHub Helpers — interact with GitHub via the `gh` CLI.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from './shell.js';
import { ghExec, getProjectCache, setProjectCache } from './rate-limit.js';
import { log } from './logger.js';

/** Max PR body length. GitHub supports 65536 but we leave room for metadata. */
const MAX_PR_BODY_CHARS = 60_000;

export type Comment = {
  author: string;
  body: string;
  createdAt: string;
};

export type Issue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments?: Comment[];
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
  const result = ghExec(
    `gh api "repos/${repo}/milestones?state=open&sort=due_on&direction=asc" --jq '[.[] | {number, title, description, openIssues: .open_issues, closedIssues: .closed_issues, dueOn: .due_on, state}]'`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to list milestones: ${result.stderr}`);
    return [];
  }
  try {
    return JSON.parse(result.stdout) as Milestone[];
  } catch {
    log.warn('Failed to parse milestones JSON');
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
 *
 * Uses --jq to filter out Done items server-side, keeping the response small
 * even for large project boards.
 */
function pollIssuesByProject(owner: string, project: number, limit: number, options?: { repo?: string; milestone?: string }): Issue[] {
  // Fetch all project items but filter to only Todo issues via jq to avoid
  // truncating results when Done items fill the limit.
  const jqFilter = `{items: [.items[] | select(.status == "Todo" and .content.type == "Issue")]}`;
  const result = ghExec(
    `gh project item-list ${project} --owner "${owner}" --format json --limit 200 --jq '${jqFilter}'`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to poll project board: ${result.stderr}`);
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

    let items = data.items;

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
    log.warn('Failed to parse project board JSON');
    return [];
  }
}

/**
 * Get the set of open issue numbers belonging to a milestone.
 */
function getMilestoneIssueNumbers(repo: string, milestone: string): Set<number> | null {
  const result = ghExec(
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
  const result = ghExec(
    `gh issue list --repo "${repo}" --label "${label}" --state open${milestoneFlag} --json number,title,body,labels --limit ${limit}`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to poll issues: ${result.stderr}`);
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
    log.warn('Failed to parse issues JSON');
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
  const result = ghExec(args[0], undefined, true);
  if (result.exitCode !== 0) {
    log.warn(`Failed to update labels on issue #${issueNum}: ${result.stderr}`);
  }
}

/**
 * Comment on an issue.
 * Uses --body-file to avoid shell escaping issues with newlines and special characters.
 */
export function commentIssue(repo: string, issueNum: number, body: string): void {
  const bodyFile = join(tmpdir(), `alpha-loop-comment-${Date.now()}`);
  writeFileSync(bodyFile, body, 'utf-8');
  try {
    const result = ghExec(
      `gh issue comment ${issueNum} --repo "${repo}" --body-file "${bodyFile}"`,
      undefined, true,
    );
    if (result.exitCode !== 0) {
      log.warn(`Failed to comment on issue #${issueNum}: ${result.stderr}`);
    }
  } finally {
    try { unlinkSync(bodyFile); } catch { /* cleanup best-effort */ }
  }
}

/**
 * Assign an issue to a user.
 */
export function assignIssue(repo: string, issueNum: number, assignee: string): void {
  const result = ghExec(
    `gh issue edit ${issueNum} --repo "${repo}" --add-assignee "${assignee}"`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to assign issue #${issueNum} to ${assignee}: ${result.stderr}`);
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
    log.warn('Push failed, trying force push...');
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
    const existingResult = ghExec(
      `gh pr list --repo "${repo}" --head "${head}" --json number,url --limit 1`,
    );
    if (existingResult.exitCode === 0 && existingResult.stdout) {
      try {
        const existing = JSON.parse(existingResult.stdout) as Array<{ number: number; url: string }>;
        if (existing.length > 0) {
          const prUrl = existing[0].url;
          log.info(`PR already exists: ${prUrl}, updating...`);
          ghExec(`gh pr edit ${existing[0].number} --repo "${repo}" --base "${base}" --title ${JSON.stringify(title)} --body-file "${bodyFile}"`, undefined, true);
          return prUrl;
        }
      } catch {
        // Fall through to create
      }
    }

    // Create new PR using --body-file to avoid shell escaping issues
    const createResult = ghExec(
      `gh pr create --repo "${repo}" --base "${base}" --head "${head}" --title ${JSON.stringify(title)} --body-file "${bodyFile}"`,
      undefined, true,
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
  const listResult = ghExec(
    `gh pr list --repo "${repo}" --head "${head}" --json number --limit 1`,
  );
  if (listResult.exitCode !== 0 || !listResult.stdout) {
    log.warn(`No PR found to merge for branch ${head}`);
    return;
  }

  let prNum: number;
  try {
    const prs = JSON.parse(listResult.stdout) as Array<{ number: number }>;
    if (prs.length === 0) {
      log.warn(`No PR found to merge for branch ${head}`);
      return;
    }
    prNum = prs[0].number;
  } catch {
    log.warn('Failed to parse PR list');
    return;
  }

  const mergeFlag = method === 'squash' ? '--squash' : '--merge';
  const result = ghExec(
    `gh pr merge ${prNum} --repo "${repo}" ${mergeFlag} --delete-branch`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to merge PR #${prNum}: ${result.stderr}`);
  }
  log.info(`PR #${prNum} merged`);
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
  // ── Resolve project metadata (cached after first call) ────────────────
  let cache = getProjectCache(owner, projectNum);
  if (!cache) {
    // Fetch field list (contains field IDs and option IDs)
    const fieldResult = ghExec(
      `gh project field-list ${projectNum} --owner "${owner}" --format json`,
    );
    if (fieldResult.exitCode !== 0) {
      log.warn(`Could not list project fields: ${fieldResult.stderr}`);
      return;
    }

    let fieldId: string | undefined;
    const optionMap = new Map<string, string>();
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
        for (const opt of statusField.options ?? []) {
          optionMap.set(opt.name, opt.id);
        }
      }
    } catch {
      log.warn('Failed to parse project fields');
      return;
    }

    if (!fieldId || optionMap.size === 0) {
      log.warn('Could not resolve project Status field');
      return;
    }

    // Fetch project ID
    const projectResult = ghExec(
      `gh project view ${projectNum} --owner "${owner}" --format json`,
    );
    if (projectResult.exitCode !== 0) {
      log.warn(`Could not view project: ${projectResult.stderr}`);
      return;
    }

    let projectId: string | undefined;
    try {
      const data = JSON.parse(projectResult.stdout) as { id: string };
      projectId = data.id;
    } catch {
      log.warn('Failed to parse project data');
      return;
    }

    if (!projectId) {
      log.warn('Could not get project ID');
      return;
    }

    cache = { projectId, fieldId, optionMap };
    setProjectCache(owner, projectNum, cache);
    log.debug(`Cached project metadata for ${owner}/${projectNum}`);
  }

  // ── Resolve option ID for the requested status ──────────────────────
  const optionId = cache.optionMap.get(status);
  if (!optionId) {
    log.warn(`Could not resolve project option for status '${status}'`);
    return;
  }

  // ── Find the item ID for this issue (not cached — items change) ─────
  const jqFilter = `{items: [.items[] | select(.content.number == ${issueNum})]}`;
  const itemResult = ghExec(
    `gh project item-list ${projectNum} --owner "${owner}" --format json --limit 200 --jq '${jqFilter}'`,
  );
  if (itemResult.exitCode !== 0) {
    log.warn(`Could not list project items: ${itemResult.stderr}`);
    return;
  }

  let itemId: string | undefined;
  try {
    const data = JSON.parse(itemResult.stdout) as {
      items: Array<{ id: string; content: { number: number } }>;
    };
    itemId = data.items[0]?.id;
  } catch {
    log.warn('Failed to parse project items');
    return;
  }

  if (!itemId) {
    log.warn(`Could not find project item for issue #${issueNum}`);
    return;
  }

  // ── Update the item ─────────────────────────────────────────────────
  const editResult = ghExec(
    `gh project item-edit --project-id "${cache.projectId}" --id "${itemId}" --field-id "${cache.fieldId}" --single-select-option-id "${optionId}"`,
    undefined, true,
  );
  if (editResult.exitCode !== 0) {
    log.warn(`Failed to update project status for #${issueNum}: ${editResult.stderr}`);
    return;
  }

  log.info(`Project board: #${issueNum} -> ${status}`);
}

/**
 * Create a new issue. Returns the created issue number.
 * Uses --body-file for shell safety (same pattern as commentIssue).
 */
export function createIssue(repo: string, title: string, body: string, labels: string[], milestone?: number): number {
  const bodyFile = join(tmpdir(), `alpha-loop-issue-body-${Date.now()}`);
  writeFileSync(bodyFile, body, 'utf-8');
  try {
    const labelFlags = labels.map((l) => `--label ${JSON.stringify(l)}`).join(' ');
    const milestoneFlag = milestone ? ` --milestone ${milestone}` : '';
    const result = ghExec(
      `gh issue create --repo "${repo}" --title ${JSON.stringify(title)} --body-file "${bodyFile}" ${labelFlags}${milestoneFlag}`,
      undefined, true,
    );
    if (result.exitCode !== 0) {
      log.warn(`Failed to create issue: ${result.stderr}`);
      return 0;
    }
    // gh issue create returns the URL, e.g. https://github.com/owner/repo/issues/42
    const match = result.stdout.trim().match(/(\d+)\s*$/);
    return match ? parseInt(match[1], 10) : 0;
  } finally {
    try { unlinkSync(bodyFile); } catch { /* cleanup best-effort */ }
  }
}

/**
 * Update an existing issue's title and/or body.
 */
export function updateIssue(repo: string, issueNum: number, updates: { title?: string; body?: string }): void {
  if (!updates.title && updates.body === undefined) return;
  let bodyFile: string | undefined;
  try {
    let cmd = `gh issue edit ${issueNum} --repo "${repo}"`;
    if (updates.title) {
      cmd += ` --title ${JSON.stringify(updates.title)}`;
    }
    if (updates.body !== undefined) {
      bodyFile = join(tmpdir(), `alpha-loop-issue-body-${Date.now()}`);
      writeFileSync(bodyFile, updates.body, 'utf-8');
      cmd += ` --body-file "${bodyFile}"`;
    }
    const result = ghExec(cmd, undefined, true);
    if (result.exitCode !== 0) {
      log.warn(`Failed to update issue #${issueNum}: ${result.stderr}`);
    }
  } finally {
    if (bodyFile) {
      try { unlinkSync(bodyFile); } catch { /* cleanup best-effort */ }
    }
  }
}

/**
 * Close an issue with an optional reason.
 */
export function closeIssue(repo: string, issueNum: number, reason?: 'completed' | 'not_planned'): void {
  const reasonFlag = reason ? ` --reason "${reason}"` : '';
  const result = ghExec(
    `gh issue close ${issueNum} --repo "${repo}"${reasonFlag}`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to close issue #${issueNum}: ${result.stderr}`);
  }
}

/**
 * Create a milestone. Returns the milestone number.
 */
export function createMilestone(repo: string, title: string, description: string, dueOn?: string): number {
  const dueOnIso = dueOn && !dueOn.includes('T') ? `${dueOn}T00:00:00Z` : dueOn;
  const dueOnFlag = dueOnIso ? ` -f due_on=${JSON.stringify(dueOnIso)}` : '';
  const result = ghExec(
    `gh api "repos/${repo}/milestones" -X POST -f title=${JSON.stringify(title)} -f description=${JSON.stringify(description)}${dueOnFlag}`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to create milestone: ${result.stderr}`);
    return 0;
  }
  try {
    const data = JSON.parse(result.stdout) as { number: number };
    return data.number;
  } catch {
    log.warn('Failed to parse milestone response');
    return 0;
  }
}

/**
 * Assign an issue to a milestone by title.
 */
export function setIssueMilestone(repo: string, issueNum: number, milestoneTitle: string): void {
  const result = ghExec(
    `gh issue edit ${issueNum} --repo "${repo}" --milestone ${JSON.stringify(milestoneTitle)}`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to set milestone on issue #${issueNum}: ${result.stderr}`);
  }
}

/**
 * List all open issues (no label filter). Default limit 100.
 */
export function listOpenIssues(repo: string, limit = 100): Issue[] {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const result = ghExec(
    `gh issue list --repo "${repo}" --state open --json number,title,body,labels --limit ${safeLimit}`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to list open issues: ${result.stderr}`);
    return [];
  }
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
    }>;
    return raw.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: (issue.labels ?? []).map((l) => l.name),
    }));
  } catch {
    log.warn('Failed to parse open issues JSON');
    return [];
  }
}

/**
 * List all open issues with their comments in a single API call.
 * Avoids the N+1 problem of fetching comments per-issue.
 */
export function listOpenIssuesWithComments(repo: string, limit = 100): Issue[] {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const result = ghExec(
    `gh issue list --repo "${repo}" --state open --json number,title,body,labels,comments --limit ${safeLimit}`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to list open issues with comments: ${result.stderr}`);
    return [];
  }
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
      comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
    }>;
    return raw.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: (issue.labels ?? []).map((l) => l.name),
      comments: (issue.comments ?? []).map((c) => ({
        author: c.author?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.createdAt ?? '',
      })),
    }));
  } catch {
    log.warn('Failed to parse open issues with comments JSON');
    return [];
  }
}

/**
 * Fetch comments for a specific issue.
 */
export function getIssueComments(repo: string, issueNum: number): Comment[] {
  const result = ghExec(
    `gh issue view ${issueNum} --repo "${repo}" --json comments`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to fetch comments for issue #${issueNum}: ${result.stderr}`);
    return [];
  }
  try {
    const data = JSON.parse(result.stdout) as {
      comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
    };
    return (data.comments ?? []).map((c) => ({
      author: c.author?.login ?? 'unknown',
      body: c.body ?? '',
      createdAt: c.createdAt ?? '',
    }));
  } catch {
    log.warn(`Failed to parse comments for issue #${issueNum}`);
    return [];
  }
}

/**
 * Fetch a single issue with its full body and comments.
 */
export function getIssueWithComments(repo: string, issueNum: number): Issue | null {
  const result = ghExec(
    `gh issue view ${issueNum} --repo "${repo}" --json number,title,body,labels,comments`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to fetch issue #${issueNum}: ${result.stderr}`);
    return null;
  }
  try {
    const data = JSON.parse(result.stdout) as {
      number: number;
      title: string;
      body: string;
      labels: Array<{ name: string }>;
      comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
    };
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      labels: (data.labels ?? []).map((l) => l.name),
      comments: (data.comments ?? []).map((c) => ({
        author: c.author?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.createdAt ?? '',
      })),
    };
  } catch {
    log.warn(`Failed to parse issue #${issueNum}`);
    return null;
  }
}

/**
 * Add an issue to a GitHub Project v2.
 */
export function addIssueToProject(owner: string, projectNum: number, repo: string, issueNum: number): void {
  const issueUrl = `https://github.com/${repo}/issues/${issueNum}`;
  const result = ghExec(
    `gh project item-add ${projectNum} --owner "${owner}" --url "${issueUrl}"`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to add issue #${issueNum} to project: ${result.stderr}`);
  }
}

/**
 * Truncate PR body at 30k chars to stay within GitHub limits.
 */
function truncateBody(body: string): string {
  if (body.length <= MAX_PR_BODY_CHARS) return body;
  return body.slice(0, MAX_PR_BODY_CHARS) + '\n\n... (body truncated, see full log)';
}
