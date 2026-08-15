/**
 * GitHub Helpers — interact with GitHub via the `gh` CLI.
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec, shellQuote } from './shell.js';
import { ghExec, getProjectCache, setProjectCache } from './rate-limit.js';
import { log } from './logger.js';
import { labelName } from './labels.js';
import { DEFAULT_MERGE_GATE_CONFIG, type MergeGateConfig } from './config.js';
import {
  findUnparsedSubIssueChecklistLines,
  flipChecklistItem,
  parseSubIssues,
  type SubIssueRef,
} from './epics.js';

/** Max PR body length. GitHub supports 65536 but we leave room for metadata. */
const MAX_PR_BODY_CHARS = 60_000;
const CHECK_POLL_INTERVAL_MS = 5_000;
const CHECK_REGISTRATION_TIMEOUT_MS = 30_000;
const MIN_PR_AGE_BEFORE_MERGE_MS = 10_000;

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
  milestone?: string | null;
  state?: string;
  stateReason?: string | null;
};

export type RoadmapEpicChildContext = {
  issueNum: number;
  title: string;
  bodySummary: string;
  checked: boolean;
  labels?: string[];
  state?: string;
  milestone?: string | null;
};

export type RoadmapEpicContext = {
  issueNum: number;
  title: string;
  bodySummary: string;
  currentMilestone: string | null;
  completedChildCount: number;
  totalChildCount: number;
  openChildCount: number;
  children: RoadmapEpicChildContext[];
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

function compactLabelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => labelName(label))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

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

  // If project board is configured and no milestone filter, use it for ordering.
  // When a milestone is specified, skip the project board to avoid paginating
  // through all items (which can hit GraphQL rate limits on large boards).
  if (project && project > 0 && !milestone) {
    return pollIssuesByProject(repoOwner, project, limit, { repo });
  }

  // Poll by label (optionally filtered by milestone)
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
        labels?: unknown;
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
        labels: compactLabelNames(item.labels),
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
 * Optionally filters by milestone; the ready label remains authoritative
 * because milestones are scheduling metadata, not workflow state.
 */
function pollIssuesByLabel(repo: string, label: string, limit: number, milestone?: string): Issue[] {
  const milestoneFlag = milestone ? ` --milestone "${milestone}"` : '';
  const labelFlag = label ? ` --label "${label}"` : '';
  const result = ghExec(
    `gh issue list --repo "${repo}"${labelFlag} --state open${milestoneFlag} --json number,title,body,labels --limit ${limit}`,
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
      labels?: unknown;
    }>;
    return raw
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        labels: compactLabelNames(issue.labels),
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
export function labelIssue(repo: string, issueNum: number, addLabel: string, removeLabel?: string): boolean {
  const args = [`gh issue edit ${issueNum} --repo "${repo}" --add-label "${addLabel}"`];
  if (removeLabel) {
    args[0] += ` --remove-label "${removeLabel}"`;
  }
  const result = ghExec(args[0], undefined, true);
  if (result.exitCode !== 0) {
    log.warn(`Failed to update labels on issue #${issueNum}: ${result.stderr}`);
    return false;
  }
  return true;
}

/**
 * Comment on an issue.
 * Uses --body-file to avoid shell escaping issues with newlines and special characters.
 */
export function commentIssue(repo: string, issueNum: number, body: string): boolean {
  const bodyFile = join(tmpdir(), `alpha-loop-comment-${Date.now()}`);
  // GitHub rejects comments over 65536 chars. Agent outputs (e.g. assumptions
  // notes) can balloon when they capture CLI banners/echoed prompts, so cap the
  // body rather than let the whole comment fail.
  writeFileSync(bodyFile, truncateBody(body), 'utf-8');
  try {
    const result = ghExec(
      `gh issue comment ${issueNum} --repo "${repo}" --body-file "${bodyFile}"`,
      undefined, true,
    );
    if (result.exitCode !== 0) {
      log.warn(`Failed to comment on issue #${issueNum}: ${result.stderr}`);
      return false;
    }
    return true;
  } finally {
    try { unlinkSync(bodyFile); } catch { /* cleanup best-effort */ }
  }
}

/**
 * Assign an issue to a user.
 */
export function assignIssue(repo: string, issueNum: number, assignee: string): boolean {
  const result = ghExec(
    `gh issue edit ${issueNum} --repo "${repo}" --add-assignee "${assignee}"`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to assign issue #${issueNum} to ${assignee}: ${result.stderr}`);
    return false;
  }
  return true;
}

export type CreatePROptions = {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  cwd?: string;
  /**
   * Skip pushing the head branch — the remote branch already holds the
   * content the PR should describe and local has diverged from it.
   */
  skipPush?: boolean;
};

/**
 * Recover from a rejected push without destroying remote commits.
 *
 * The remote branch may hold commits the local branch does not — e.g. child
 * PRs auto-merged into a session branch by GitHub. A force push here would
 * destroy them, and --force-with-lease does not protect against that when the
 * remote-tracking ref was just fetched. So instead: skip the push when the
 * remote already contains local, retry when it fast-forwards, force-push
 * (with lease) only when the trees are identical, and otherwise merge the
 * remote commits into local before a plain push. Throws when the branches
 * diverge with conflicting content — never force-pushes over it.
 */
function reconcilePushDivergence(head: string, cwd?: string): void {
  const quotedHead = shellQuote(head);
  const quotedRemoteRef = shellQuote(`origin/${head}`);
  exec(`git fetch origin ${quotedHead}`, { cwd });

  const remoteExists = exec(`git rev-parse --verify --quiet ${quotedRemoteRef}`, { cwd });
  if (remoteExists.exitCode !== 0) {
    // No remote branch — the push failure was not a divergence (auth, network,
    // ...). Retry once, then surface the error.
    const retry = exec(`git push -u origin ${quotedHead}`, { cwd });
    if (retry.exitCode !== 0) {
      throw new Error(`Failed to push branch ${head}: ${retry.stderr}`);
    }
    return;
  }

  const remoteContainsLocal = exec(
    `git merge-base --is-ancestor ${quotedHead} ${quotedRemoteRef}`, { cwd },
  );
  if (remoteContainsLocal.exitCode === 0) {
    log.info(`Remote branch ${head} already contains local commits — skipping push`);
    return;
  }

  const localContainsRemote = exec(
    `git merge-base --is-ancestor ${quotedRemoteRef} ${quotedHead}`, { cwd },
  );
  if (localContainsRemote.exitCode === 0) {
    const retry = exec(`git push -u origin ${quotedHead}`, { cwd });
    if (retry.exitCode !== 0) {
      throw new Error(`Failed to push branch ${head}: ${retry.stderr}`);
    }
    return;
  }

  // Histories diverged. Identical trees mean a pure history rewrite (e.g. a
  // rebase) — force-with-lease loses no content there.
  const sameTree = exec(`git diff --quiet ${quotedRemoteRef} ${quotedHead}`, { cwd });
  if (sameTree.exitCode === 0) {
    log.warn(`Branch ${head} diverged from remote with identical content — force pushing (with lease)`);
    const force = exec(`git push -u origin ${quotedHead} --force-with-lease`, { cwd });
    if (force.exitCode !== 0) {
      throw new Error(`Failed to push branch ${head}: ${force.stderr}`);
    }
    return;
  }

  // Content differs both ways — merge the remote commits into local and push
  // the union. git merge targets the current branch, so bail out rather than
  // merge into the wrong branch if the checkout is elsewhere.
  const currentBranch = exec('git rev-parse --abbrev-ref HEAD', { cwd }).stdout.trim();
  if (currentBranch !== head) {
    throw new Error(
      `Branch ${head} diverged from origin/${head} and is not checked out — ` +
      'refusing to force-push over remote commits. Reconcile manually.',
    );
  }
  log.warn(`Branch ${head} diverged from remote — merging remote commits before push`);
  const merge = exec(`git merge ${quotedRemoteRef} --no-edit`, { cwd });
  if (merge.exitCode !== 0) {
    exec('git merge --abort', { cwd });
    throw new Error(
      `Branch ${head} diverged from origin/${head} with conflicting content — ` +
      'refusing to force-push over remote commits. Reconcile manually.',
    );
  }
  const push = exec(`git push -u origin ${quotedHead}`, { cwd });
  if (push.exitCode !== 0) {
    throw new Error(`Failed to push branch ${head}: ${push.stderr}`);
  }
}

/**
 * Create a PR, or update an existing one if a PR already exists for the branch.
 * Returns the PR URL.
 */
export function createPR(options: CreatePROptions): string {
  const { repo, base, head, title, body, cwd, skipPush } = options;

  // Push the branch first
  const quotedHead = shellQuote(head);
  if (!skipPush) {
    const pushResult = exec(`git push -u origin ${quotedHead}`, { cwd });
    if (pushResult.exitCode !== 0) {
      log.warn('Push failed — reconciling with remote branch...');
      reconcilePushDivergence(head, cwd);
    }
  }

  // Write body to a temp file to avoid shell argument length/escaping issues
  const truncatedBody = truncateBody(body);
  const bodyFile = join(tmpdir(), `alpha-loop-pr-body-${Date.now()}`);
  writeFileSync(bodyFile, truncatedBody, 'utf-8');

  try {
    // Check if PR already exists for this branch
    const existingResult = ghExec(
      `gh pr list --repo ${shellQuote(repo)} --head ${quotedHead} --json number,url --limit 1`,
    );
    if (existingResult.exitCode === 0 && existingResult.stdout) {
      let existing: Array<{ number: number; url: string }> = [];
      try {
        existing = JSON.parse(existingResult.stdout) as Array<{ number: number; url: string }>;
      } catch {
        // Fall through to create
      }
      if (existing.length > 0) {
        const prUrl = existing[0].url;
        log.info(`PR already exists: ${prUrl}, updating...`);
        const editResult = ghExec(
          `gh pr edit ${existing[0].number} --repo ${shellQuote(repo)} --base ${shellQuote(base)} --title ${shellQuote(title)} --body-file ${shellQuote(bodyFile)}`,
          undefined,
          true,
        );
        if (editResult.exitCode !== 0) {
          throw new Error(`Failed to update PR #${existing[0].number}: ${editResult.stderr}`);
        }
        return prUrl;
      }
    }

    // Create new PR using --body-file to avoid shell escaping issues
    const createResult = ghExec(
      `gh pr create --repo ${shellQuote(repo)} --base ${shellQuote(base)} --head ${quotedHead} --title ${shellQuote(title)} --body-file ${shellQuote(bodyFile)}`,
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

type StatusCheck = {
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
};

type PRCheckSnapshot = {
  createdAt: number;
  checks: StatusCheck[];
};

type CheckState = 'success' | 'pending' | 'failure';

const SUCCESS_STATES = new Set(['SUCCESS']);
const PENDING_STATES = new Set(['EXPECTED', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'REQUESTED', 'WAITING']);
const FAILURE_STATES = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'ERROR',
  'FAILURE',
  'NEUTRAL',
  'SKIPPED',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkName(check: StatusCheck): string {
  return check.name || check.context || 'unnamed check';
}

function normalizeCheckState(check: StatusCheck): CheckState {
  const conclusion = check.conclusion?.toUpperCase();
  if (conclusion) {
    if (SUCCESS_STATES.has(conclusion)) return 'success';
    if (FAILURE_STATES.has(conclusion)) return 'failure';
    return 'pending';
  }

  const state = check.state?.toUpperCase();
  if (state) {
    if (SUCCESS_STATES.has(state)) return 'success';
    if (FAILURE_STATES.has(state)) return 'failure';
    if (PENDING_STATES.has(state)) return 'pending';
  }

  // CheckRun.status becomes COMPLETED before GitHub consistently exposes its
  // conclusion. A bare COMPLETED value is therefore inconclusive, not green.
  const status = check.status?.toUpperCase();
  if (status && FAILURE_STATES.has(status)) return 'failure';
  return 'pending';
}

function fetchPRCheckSnapshot(repo: string, prNum: number): PRCheckSnapshot | null {
  const result = ghExec(
    `gh pr view ${prNum} --repo ${shellQuote(repo)} --json createdAt,statusCheckRollup`,
  );
  if (result.exitCode !== 0 || !result.stdout) {
    const detail = result.stderr.trim();
    log.warn(`Could not read checks for PR #${prNum}${detail ? `: ${detail}` : ''}`);
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      createdAt?: string;
      statusCheckRollup?: unknown;
    };
    const createdAt = Date.parse(parsed.createdAt ?? '');
    if (!Number.isFinite(createdAt) || !Array.isArray(parsed.statusCheckRollup)) {
      log.warn(`Could not parse check status for PR #${prNum}`);
      return null;
    }
    return {
      createdAt,
      checks: parsed.statusCheckRollup.filter(
        (check): check is StatusCheck => Boolean(check) && typeof check === 'object',
      ),
    };
  } catch {
    log.warn(`Could not parse check status for PR #${prNum}`);
    return null;
  }
}

async function waitForMergeGate(
  repo: string,
  prNum: number,
  gate: MergeGateConfig,
): Promise<boolean> {
  const startedAt = Date.now();
  const deadline = startedAt + gate.timeoutSeconds * 1_000;
  const registrationDeadline = Math.min(deadline, startedAt + CHECK_REGISTRATION_TIMEOUT_MS);
  let sawChecks = false;
  let loggedWaiting = false;
  let loggedTimeoutAgeDelay = false;

  while (true) {
    const snapshot = fetchPRCheckSnapshot(repo, prNum);
    const now = Date.now();

    if (snapshot) {
      if (snapshot.checks.length === 0) {
        if (!gate.requireChecks) {
          const ageMs = now - snapshot.createdAt;
          if (ageMs >= MIN_PR_AGE_BEFORE_MERGE_MS) {
            log.warn(`PR #${prNum} has no checks; merging because merge_gate.require_checks is false`);
            return true;
          }
        } else if (now >= registrationDeadline) {
          log.error(
            `Blocking merge for PR #${prNum}: no checks appeared within ${Math.ceil((registrationDeadline - startedAt) / 1_000)}s and merge_gate.require_checks is true`,
          );
          return false;
        }
      } else {
        if (!sawChecks) {
          log.info(`Merge gate found ${snapshot.checks.length} check(s) for PR #${prNum}; waiting for completion`);
          sawChecks = true;
        }
        const states = snapshot.checks.map((check) => ({ check, state: normalizeCheckState(check) }));
        const failed = states.filter(({ state }) => state === 'failure');
        if (failed.length > 0) {
          const detail = failed.map(({ check }) => {
            const result = check.conclusion || check.state || check.status || 'UNKNOWN';
            return `${checkName(check)}=${result}`;
          }).join(', ');
          log.error(`Blocking merge for PR #${prNum}: checks did not pass (${detail})`);
          return false;
        }

        if (states.every(({ state }) => state === 'success')) {
          const ageMs = now - snapshot.createdAt;
          if (ageMs >= MIN_PR_AGE_BEFORE_MERGE_MS) {
            log.info(`All ${states.length} check(s) passed for PR #${prNum}`);
            return true;
          }
        }
      }
    }

    if (now >= deadline) {
      if (gate.onTimeout === 'warn') {
        // Even the explicit fail-open policy must not recreate the observable
        // single-digit merge signature. Continue polling during this short
        // delay so a terminal failure can still block the merge.
        const ageReference = Math.min(snapshot?.createdAt ?? startedAt, startedAt);
        const earliestMergeAt = ageReference + MIN_PR_AGE_BEFORE_MERGE_MS;
        if (now < earliestMergeAt) {
          if (!loggedTimeoutAgeDelay) {
            log.warn(
              `Merge gate timed out after ${gate.timeoutSeconds}s for PR #${prNum}; delaying the fail-open merge until the PR is at least ${MIN_PR_AGE_BEFORE_MERGE_MS / 1_000}s old`,
            );
            loggedTimeoutAgeDelay = true;
          }
          await sleep(Math.max(1, Math.min(CHECK_POLL_INTERVAL_MS, earliestMergeAt - now)));
          continue;
        }
        log.warn(
          `Merge gate timed out after ${gate.timeoutSeconds}s for PR #${prNum}; proceeding because merge_gate.on_timeout is warn`,
        );
        return true;
      }
      log.error(
        `Blocking merge for PR #${prNum}: checks did not conclude within ${gate.timeoutSeconds}s`,
      );
      return false;
    }

    if (!loggedWaiting) {
      log.info(`Waiting up to ${gate.timeoutSeconds}s for checks on PR #${prNum}`);
      loggedWaiting = true;
    }
    let nextBoundary = deadline;
    if (snapshot?.checks.length === 0 && gate.requireChecks) {
      nextBoundary = Math.min(nextBoundary, registrationDeadline);
    }
    if (snapshot && (
      snapshot.checks.length === 0 && !gate.requireChecks
      || snapshot.checks.length > 0 && snapshot.checks.every((check) => normalizeCheckState(check) === 'success')
    )) {
      nextBoundary = Math.min(nextBoundary, snapshot.createdAt + MIN_PR_AGE_BEFORE_MERGE_MS);
    }
    await sleep(Math.max(1, Math.min(CHECK_POLL_INTERVAL_MS, nextBoundary - now)));
  }
}

/**
 * Wait for GitHub checks, then merge a PR by branch name when the gate permits.
 */
export async function mergePR(
  repo: string,
  head: string,
  method: 'squash' | 'merge' = 'squash',
  gate: MergeGateConfig = DEFAULT_MERGE_GATE_CONFIG,
): Promise<boolean> {
  // Find the PR number by branch
  const listResult = ghExec(
    `gh pr list --repo ${shellQuote(repo)} --head ${shellQuote(head)} --json number --limit 1`,
  );
  if (listResult.exitCode !== 0 || !listResult.stdout) {
    const detail = listResult.stderr.trim();
    log.warn(`No PR found to merge for branch ${head}${detail ? `: ${detail}` : ''}`);
    return false;
  }

  let prNum: number;
  try {
    const prs = JSON.parse(listResult.stdout) as Array<{ number: number }>;
    if (prs.length === 0) {
      log.warn(`No PR found to merge for branch ${head}`);
      return false;
    }
    if (!Number.isInteger(prs[0]?.number)) {
      log.warn('Failed to parse PR list');
      return false;
    }
    prNum = prs[0].number;
  } catch {
    log.warn('Failed to parse PR list');
    return false;
  }

  if (!await waitForMergeGate(repo, prNum, gate)) {
    return false;
  }

  const mergeFlag = method === 'squash' ? '--squash' : '--merge';
  const result = ghExec(
    `gh pr merge ${prNum} --repo ${shellQuote(repo)} ${mergeFlag} --delete-branch`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to merge PR #${prNum}: ${result.stderr}`);
    return false;
  }
  log.info(`PR #${prNum} merged`);
  return true;
}

function projectFailureReason(message: string, detail?: string): string {
  const trimmed = detail?.trim();
  return trimmed ? `${message}: ${trimmed}` : message;
}

function disableProjectStatus(owner: string, projectNum: number, reason: string): void {
  const existing = getProjectCache(owner, projectNum);
  if (existing?.disabled) {
    return;
  }

  setProjectCache(owner, projectNum, { disabled: true, reason });
  log.warn(`Project board #${projectNum} disabled for this session: ${reason}`);
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
): boolean {
  if (!projectNum || projectNum <= 0) {
    return true;
  }

  // ── Resolve project metadata (cached on success, disabled on failure) ─
  let cache = getProjectCache(owner, projectNum);
  if (cache?.disabled) {
    return false;
  }

  if (!cache) {
    // Fetch field list (contains field IDs and option IDs)
    const fieldResult = ghExec(
      `gh project field-list ${projectNum} --owner "${owner}" --format json`,
    );
    if (fieldResult.exitCode !== 0) {
      disableProjectStatus(
        owner,
        projectNum,
        projectFailureReason('Could not list project fields', fieldResult.stderr),
      );
      return false;
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
      disableProjectStatus(owner, projectNum, 'Failed to parse project fields');
      return false;
    }

    if (!fieldId || optionMap.size === 0) {
      disableProjectStatus(owner, projectNum, 'Could not resolve project Status field');
      return false;
    }

    // Fetch project ID
    const projectResult = ghExec(
      `gh project view ${projectNum} --owner "${owner}" --format json`,
    );
    if (projectResult.exitCode !== 0) {
      disableProjectStatus(
        owner,
        projectNum,
        projectFailureReason('Could not view project', projectResult.stderr),
      );
      return false;
    }

    let projectId: string | undefined;
    try {
      const data = JSON.parse(projectResult.stdout) as { id: string };
      projectId = data.id;
    } catch {
      disableProjectStatus(owner, projectNum, 'Failed to parse project data');
      return false;
    }

    if (!projectId) {
      disableProjectStatus(owner, projectNum, 'Could not get project ID');
      return false;
    }

    cache = { projectId, fieldId, optionMap };
    setProjectCache(owner, projectNum, cache);
    log.debug(`Cached project metadata for ${owner}/${projectNum}`);
  }

  if (cache.disabled) {
    return false;
  }

  // ── Resolve option ID for the requested status ──────────────────────
  const optionId = cache.optionMap.get(status);
  if (!optionId) {
    disableProjectStatus(owner, projectNum, `Could not resolve project option for status '${status}'`);
    return false;
  }

  // ── Find the item ID for this issue ─────────────────────────────────
  // Use item-add which is idempotent: returns existing item ID if already
  // on the board, or adds it. This avoids paginating through all items
  // (which truncates on large boards with 200+ items).
  const repoName = repo.includes('/') ? repo : `${owner}/${repo}`;
  const issueUrl = `https://github.com/${repoName}/issues/${issueNum}`;
  const itemResult = ghExec(
    `gh project item-add ${projectNum} --owner "${owner}" --url "${issueUrl}" --format json`,
  );
  if (itemResult.exitCode !== 0) {
    disableProjectStatus(
      owner,
      projectNum,
      projectFailureReason(`Could not resolve project item for #${issueNum}`, itemResult.stderr),
    );
    return false;
  }

  let itemId: string | undefined;
  try {
    const data = JSON.parse(itemResult.stdout) as { id: string };
    itemId = data.id;
  } catch {
    disableProjectStatus(owner, projectNum, 'Failed to parse project item response');
    return false;
  }

  if (!itemId) {
    disableProjectStatus(owner, projectNum, `Could not find project item for issue #${issueNum}`);
    return false;
  }

  // ── Update the item ─────────────────────────────────────────────────
  const editResult = ghExec(
    `gh project item-edit --project-id "${cache.projectId}" --id "${itemId}" --field-id "${cache.fieldId}" --single-select-option-id "${optionId}"`,
    undefined, true,
  );
  if (editResult.exitCode !== 0) {
    disableProjectStatus(
      owner,
      projectNum,
      projectFailureReason(`Failed to update project status for #${issueNum}`, editResult.stderr),
    );
    return false;
  }

  log.info(`Project board: #${issueNum} -> ${status}`);
  return true;
}

/**
 * Create a new issue. Returns the created issue number.
 * Uses --body-file for shell safety (same pattern as commentIssue).
 */
export function createIssue(repo: string, title: string, body: string, labels: string[], milestone?: string): number {
  const bodyFile = join(tmpdir(), `alpha-loop-issue-body-${Date.now()}`);
  writeFileSync(bodyFile, body, 'utf-8');
  try {
    const labelFlags = labels.map((l) => `--label ${JSON.stringify(l)}`).join(' ');
    const milestoneFlag = milestone ? ` --milestone ${JSON.stringify(milestone)}` : '';
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
export function updateIssue(repo: string, issueNum: number, updates: { title?: string; body?: string }): boolean {
  if (!updates.title && updates.body === undefined) return true;
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
      return false;
    }
    return true;
  } finally {
    if (bodyFile) {
      try { unlinkSync(bodyFile); } catch { /* cleanup best-effort */ }
    }
  }
}

const CLI_REASON = {
  completed: 'completed',
  not_planned: 'not planned',
  duplicate: 'duplicate',
} as const;

/**
 * Close an issue with an optional reason and verify that it is closed.
 */
export function closeIssue(
  repo: string,
  issueNum: number,
  reason?: keyof typeof CLI_REASON,
  duplicateOf?: number,
): boolean {
  const reasonFlag = reason ? ` --reason "${CLI_REASON[reason]}"` : '';
  const duplicateFlag = duplicateOf != null ? ` --duplicate-of ${duplicateOf}` : '';
  const result = ghExec(
    `gh issue close ${issueNum} --repo "${repo}"${reasonFlag}${duplicateFlag}`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to close issue #${issueNum}: ${result.stderr}`);
    return false;
  }

  const stateResult = ghExec(
    `gh issue view ${issueNum} --repo "${repo}" --json state --jq .state`,
  );
  if (stateResult.exitCode !== 0) {
    log.warn(`Failed to verify issue #${issueNum} state after close: ${stateResult.stderr}`);
    return false;
  }

  const state = stateResult.stdout.trim().toUpperCase();
  if (state !== 'CLOSED') {
    log.warn(`Issue #${issueNum} remains ${state || 'in an unknown state'} after close command`);
    return false;
  }

  return true;
}

/**
 * List all labels for a repository.
 */
export function listLabels(repo: string): string[] {
  const result = ghExec(
    `gh label list --repo "${repo}" --json name --limit 200`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to list labels: ${result.stderr}`);
    return [];
  }
  try {
    return compactLabelNames(JSON.parse(result.stdout));
  } catch {
    log.warn('Failed to parse labels JSON');
    return [];
  }
}

/**
 * Create a label on a repository. Returns true on success.
 */
export function createLabel(repo: string, name: string, color?: string): boolean {
  const colorFlag = color ? ` --color "${color}"` : '';
  const result = ghExec(
    `gh label create ${JSON.stringify(name)} --repo "${repo}"${colorFlag} --force`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to create label "${name}": ${result.stderr}`);
    return false;
  }
  return true;
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
export function setIssueMilestone(repo: string, issueNum: number, milestoneTitle: string): boolean {
  const result = ghExec(
    `gh issue edit ${issueNum} --repo "${repo}" --milestone ${JSON.stringify(milestoneTitle)}`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to set milestone on issue #${issueNum}: ${result.stderr}`);
    return false;
  }
  return true;
}

/**
 * List all open issues (no label filter). Default limit 100.
 */
export function listOpenIssues(repo: string, limit = 100): Issue[] {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const result = ghExec(
    `gh issue list --repo "${repo}" --state open --json number,title,body,labels,milestone --limit ${safeLimit}`,
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
      labels?: unknown;
      milestone?: unknown;
    }>;
    return raw.map((issue) => {
      const msTitle = milestoneTitle(issue.milestone);
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        labels: compactLabelNames(issue.labels),
        ...(msTitle ? { milestone: msTitle } : {}),
      };
    });
  } catch {
    log.warn('Failed to parse open issues JSON');
    return [];
  }
}

function milestoneTitle(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null && 'title' in raw) {
    const title = (raw as { title?: unknown }).title;
    return typeof title === 'string' ? title : null;
  }
  return null;
}

function summarizeBody(body: string, maxChars: number): string {
  const text = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function summarizeEpicBody(body: string, maxChars: number): string {
  const checklistLines = new Set(parseSubIssues(body).map((ref) => ref.lineIndex));
  const text = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((_, index) => !checklistLines.has(index))
    .join('\n');
  return summarizeBody(text, maxChars);
}

function warnForUnparsedSubIssueChecklistLines(epicNum: number, body: string): void {
  const unparsedLines = findUnparsedSubIssueChecklistLines(body);
  for (const { line, lineIndex } of unparsedLines) {
    log.warn(
      [
        `Checklist line did not parse in epic #${epicNum} at line ${lineIndex + 1}: ${line}`,
        "Hint: expected '- [ ] #N - title' format, with #N immediately after the checkbox; common markdown wrappers around #N are supported.",
      ].join('\n'),
    );
  }
}

/**
 * List open epics with ordered child issue summaries for roadmap planning.
 * Known open issues are used first; missing child issue details are fetched
 * individually so checked/closed child refs can still provide context.
 */
export function listRoadmapEpics(repo: string, knownOpenIssues: Issue[] = []): RoadmapEpicContext[] {
  const epics = listEpics(repo);
  const issueMap = new Map<number, Issue>();
  for (const issue of knownOpenIssues) {
    issueMap.set(issue.number, issue);
  }

  return epics.map((epic) => {
    const refs = parseSubIssues(epic.body);
    const children = refs.map((ref) => {
      let child = issueMap.get(ref.number);
      if (!child) {
        child = getIssueWithComments(repo, ref.number) ?? undefined;
        if (child) issueMap.set(child.number, child);
      }
      return {
        issueNum: ref.number,
        title: child?.title ?? '(issue details unavailable)',
        bodySummary: child ? summarizeBody(child.body, 220) : '',
        checked: ref.checked,
        labels: child?.labels ?? [],
        state: child?.state ?? (child ? 'OPEN' : undefined),
        milestone: child?.milestone ?? null,
      };
    });

    return {
      issueNum: epic.number,
      title: epic.title,
      bodySummary: summarizeEpicBody(epic.body, 500),
      currentMilestone: epic.milestone ?? null,
      completedChildCount: refs.filter((ref) => ref.checked).length,
      totalChildCount: refs.length,
      openChildCount: refs.filter((ref) => !ref.checked).length,
      children,
    };
  });
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
      labels?: unknown;
      comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
    }>;
    return raw.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: compactLabelNames(issue.labels),
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
    `gh issue view ${issueNum} --repo "${repo}" --json number,title,body,labels,comments,state,stateReason,milestone`,
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
      labels?: unknown;
      comments: Array<{ author: { login: string }; body: string; createdAt: string }>;
      state?: string;
      stateReason?: string | null;
      milestone?: unknown;
    };
    const issue: Issue = {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      labels: compactLabelNames(data.labels),
      comments: (data.comments ?? []).map((c) => ({
        author: c.author?.login ?? 'unknown',
        body: c.body ?? '',
        createdAt: c.createdAt ?? '',
      })),
    };
    if (data.state !== undefined) issue.state = data.state;
    if (data.stateReason !== undefined) issue.stateReason = data.stateReason;
    if (data.milestone !== undefined) issue.milestone = milestoneTitle(data.milestone);
    return issue;
  } catch {
    log.warn(`Failed to parse issue #${issueNum}`);
    return null;
  }
}

/**
 * Fetch only the current body for an issue.
 */
export function getIssueBody(repo: string, issueNum: number): string | null {
  const issue = getIssueWithComments(repo, issueNum);
  return issue?.body ?? null;
}

/**
 * Update the body for an epic issue.
 */
export function updateEpicIssueBody(repo: string, epicNum: number, body: string): boolean {
  return updateIssue(repo, epicNum, { body });
}

/**
 * Add a lightweight backlink comment from a child issue to its parent epic.
 */
export function commentChildEpicBacklink(repo: string, childIssueNum: number, epicNum: number): boolean {
  return commentIssue(
    repo,
    childIssueNum,
    `Grouped under parent epic #${epicNum}.\n\n_Triaged by alpha-loop._`,
  );
}

/**
 * Add an issue to a GitHub Project v2.
 */
export function addIssueToProject(owner: string, projectNum: number, repo: string, issueNum: number): boolean {
  const issueUrl = `https://github.com/${repo}/issues/${issueNum}`;
  const result = ghExec(
    `gh project item-add ${projectNum} --owner "${owner}" --url "${issueUrl}"`,
    undefined, true,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to add issue #${issueNum} to project: ${result.stderr}`);
    return false;
  }
  return true;
}

/**
 * Truncate PR body at 30k chars to stay within GitHub limits.
 */
function truncateBody(body: string): string {
  if (body.length <= MAX_PR_BODY_CHARS) return body;
  return body.slice(0, MAX_PR_BODY_CHARS) + '\n\n... (body truncated, see full log)';
}

/**
 * List open issues labeled `epic`.
 */
export function listEpics(repo: string, options?: { milestone?: string }): Issue[] {
  const milestoneFlag = options?.milestone ? ` --milestone ${JSON.stringify(options.milestone)}` : '';
  const result = ghExec(
    `gh issue list --repo "${repo}" --label "epic" --state open${milestoneFlag} --json number,title,body,labels,milestone --limit 100`,
  );
  if (result.exitCode !== 0) {
    log.warn(`Failed to list epics: ${result.stderr}`);
    return [];
  }
  try {
    const raw = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      body: string;
      labels?: unknown;
      milestone?: unknown;
    }>;
    return raw.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      labels: compactLabelNames(issue.labels),
      milestone: milestoneTitle(issue.milestone),
    }));
  } catch {
    log.warn('Failed to parse epics JSON');
    return [];
  }
}

/**
 * Fetch an epic and return its parsed sub-issue refs in checklist order.
 * Returns empty array if the epic cannot be fetched.
 */
export function getEpicSubIssues(repo: string, epicNum: number): SubIssueRef[] {
  const epic = getIssueWithComments(repo, epicNum);
  if (!epic) return [];
  warnForUnparsedSubIssueChecklistLines(epicNum, epic.body);
  return parseSubIssues(epic.body);
}

/**
 * Flip the checklist box for `subIssueNum` in the epic's body.
 *
 * Throws if the expected `- [?] #<subIssueNum>` line is not present in the
 * fetched body. One-agent-per-epic is the contract; a missing line means
 * either external mutation since this session started or a bug — either way,
 * loud failure, not silent drift.
 */
export function updateEpicChecklist(repo: string, epicNum: number, subIssueNum: number, checked: boolean): boolean {
  const epic = getIssueWithComments(repo, epicNum);
  if (!epic) {
    throw new Error(`updateEpicChecklist: could not fetch epic #${epicNum}`);
  }
  const refs = parseSubIssues(epic.body);
  if (!refs.some((r) => r.number === subIssueNum)) {
    throw new Error(
      `updateEpicChecklist: epic #${epicNum} body no longer contains a checklist line for sub-issue #${subIssueNum}`,
    );
  }
  const newBody = flipChecklistItem(epic.body, subIssueNum, checked);
  if (newBody === epic.body) {
    // Already in the requested state — no-op.
    return true;
  }
  return updateIssue(repo, epicNum, { body: newBody });
}

type ClosingPullRequest = {
  url: string;
  body: string;
  mergedAt: string;
};

type TimelinePage = Array<{
  event?: string;
  source?: {
    issue?: {
      html_url?: string;
      body?: string | null;
      pull_request?: {
        html_url?: string;
        merged_at?: string | null;
      } | null;
    } | null;
  } | null;
}>;

function closingKeywordPattern(issueNum: number): RegExp {
  return new RegExp(
    `(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s*:?\\s*#${issueNum}(?!\\d)`,
    'i',
  );
}

function earliestClosingPullRequest(
  candidates: ClosingPullRequest[],
  issueNum: number,
): string | null {
  const pattern = closingKeywordPattern(issueNum);
  return candidates
    .filter((candidate) => candidate.url && candidate.mergedAt && pattern.test(candidate.body))
    .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt) || a.url.localeCompare(b.url))[0]?.url ?? null;
}

function closingPullRequestsFromTimeline(stdout: string): ClosingPullRequest[] {
  const parsed = JSON.parse(stdout) as TimelinePage[] | TimelinePage;
  const pages = Array.isArray(parsed[0]) ? parsed as TimelinePage[] : [parsed as TimelinePage];
  return pages.flat().flatMap((event): ClosingPullRequest[] => {
    const issue = event.event === 'cross-referenced' ? event.source?.issue : null;
    const pullRequest = issue?.pull_request;
    const url = pullRequest?.html_url ?? issue?.html_url;
    if (!url || !pullRequest?.merged_at) return [];
    return [{ url, body: issue?.body ?? '', mergedAt: pullRequest.merged_at }];
  });
}

/**
 * Find the merged PR URL that declared it would close `issueNum`, or null if
 * none exists. GitHub's issue timeline is authoritative for cross-references;
 * the earliest merged closing PR is the focused implementation PR when a later
 * session PR repeats the same closing keyword.
 *
 * Search is retained as a compatibility fallback, but its fuzzy results are
 * fetched in bulk and filtered by an exact closing-keyword match. Never trust
 * an arbitrary `--limit 1` search hit.
 */
export function getMergedPRForIssue(repo: string, issueNum: number): string | null {
  const timeline = ghExec(
    `gh api --paginate --slurp -H "Accept: application/vnd.github+json" "repos/${repo}/issues/${issueNum}/timeline?per_page=100"`,
  );
  if (timeline.exitCode === 0) {
    try {
      const url = earliestClosingPullRequest(closingPullRequestsFromTimeline(timeline.stdout), issueNum);
      if (url) return url;
    } catch {
      log.warn(`Failed to parse issue #${issueNum} timeline while resolving its merged PR`);
    }
  }

  const fallback = ghExec(
    `gh pr list --repo "${repo}" --search "closes:#${issueNum}" --state merged --json url,body,mergedAt --limit 100`,
  );
  if (fallback.exitCode !== 0) return null;
  try {
    const prs = JSON.parse(fallback.stdout) as Array<{
      url?: string;
      body?: string | null;
      mergedAt?: string | null;
    }>;
    return earliestClosingPullRequest(
      prs.flatMap((pr): ClosingPullRequest[] => (
        pr.url && pr.mergedAt
          ? [{ url: pr.url, body: pr.body ?? '', mergedAt: pr.mergedAt }]
          : []
      )),
      issueNum,
    );
  } catch {
    return null;
  }
}
