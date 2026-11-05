/**
 * Factory Shipper — merge green session PRs, ask a human about stuck ones.
 *
 * `decideShip` is pure: given a PR snapshot and policy it returns merge / wait /
 * update-branch / skip / ask. Failing, pending or unrecognized checks never
 * merge. Updates always require successful checks; unknown mergeability waits.
 *
 * GitHub reads and mutations use ghExec (rate-limited), following github.ts
 * conventions. Branch updates always merge the base into the PR branch.
 */
import { shellQuote } from './shell.js';
import { ghExec } from './rate-limit.js';
import { log } from './logger.js';

export type PrCheckState = 'success' | 'pending' | 'failure' | 'none';

export type ShipPr = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  checks: PrCheckState;
  failingChecks: string[];
  createdAt: string;
  closingIssues: number[];
  /** Head commit the checks ran against; when set, merges pin to it (`--match-head-commit`). */
  headRefOid?: string;
  /**
   * Required status checks for the base branch that have not reported success
   * on this head. Only filled when listing with `requiredChecks: true`;
   * undefined means unknown (not fetched, or the protection API failed).
   */
  requiredChecksMissing?: string[];
};

export type ShipPolicy = {
  merge: boolean;
  adminMerge: boolean;
  requireChecks: boolean;
  checksTimeoutMinutes: number;
  mergeMethod: 'squash' | 'merge' | 'rebase';
  /** Default ['session/issue-'] (factory developer session branches). */
  headPrefixes: string[];
  /** Pass --delete-branch on merge. Default false. */
  deleteBranch?: boolean;
};

export type ShipDecision =
  | { action: 'merge'; admin: boolean; reason: string }
  | { action: 'update-branch'; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'ask'; key: string; question: string; context: string };

/** Factory developer workers open `session/issue-<N>-<slug>` branches. */
export const DEFAULT_HEAD_PREFIX = 'session/issue-';

const FAILURE_STATES = new Set([
  'FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE',
]);
// Everything else — QUEUED, IN_PROGRESS, PENDING, EXPECTED, WAITING, REQUESTED,
// and any state we don't recognize — counts as pending.
const SUCCESS_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

const PR_LIST_FIELDS = [
  'number', 'title', 'url', 'headRefName', 'headRefOid', 'baseRefName', 'isDraft', 'mergeable',
  'mergeStateStatus', 'reviewDecision', 'statusCheckRollup', 'createdAt', 'closingIssuesReferences',
].join(',');

function upper(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/**
 * Resolve one statusCheckRollup item to a single state word.
 * CheckRun: the conclusion once completed, otherwise its status.
 * StatusContext: its state.
 */
function checkItemState(item: Record<string, unknown>): string {
  const conclusion = upper(item.conclusion);
  if (conclusion) return conclusion;
  const state = upper(item.state);
  if (state) return state;
  const status = upper(item.status);
  // A completed run with no conclusion is not evidence of success.
  if (status === 'COMPLETED') return 'PENDING';
  return status;
}

function checkItemName(item: Record<string, unknown>): string {
  for (const key of ['name', 'context', 'workflowName']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '(unnamed check)';
}

/**
 * Collapse a PR's statusCheckRollup into one state. Failure beats pending beats
 * success. Unrecognized states count as pending (fail closed: never merge on
 * evidence we don't understand). An empty rollup is 'none'.
 */
/** Names of rollup items that resolved to a success state. */
export function passedCheckNames(rollup: unknown[]): string[] {
  if (!Array.isArray(rollup)) return [];
  const names: string[] = [];
  for (const raw of rollup) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (SUCCESS_STATES.has(checkItemState(item))) names.push(checkItemName(item));
  }
  return names;
}

export function summarizeChecks(rollup: unknown[]): { state: PrCheckState; failing: string[] } {
  if (!Array.isArray(rollup) || rollup.length === 0) return { state: 'none', failing: [] };
  const failing: string[] = [];
  let pending = false;
  for (const raw of rollup) {
    if (!raw || typeof raw !== 'object') {
      pending = true;
      continue;
    }
    const item = raw as Record<string, unknown>;
    const state = checkItemState(item);
    if (FAILURE_STATES.has(state)) {
      failing.push(checkItemName(item));
    } else if (!SUCCESS_STATES.has(state)) {
      // Pending states and anything unrecognized (STALE, '', …).
      pending = true;
    }
  }
  if (failing.length > 0) return { state: 'failure', failing };
  return { state: pending ? 'pending' : 'success', failing: [] };
}

function prContext(pr: ShipPr, extra: string[] = []): string {
  const lines = [
    `PR: #${pr.number} ${pr.title}`,
    `URL: ${pr.url}`,
    `Branch: ${pr.headRefName} → ${pr.baseRefName}`,
  ];
  if (pr.closingIssues.length > 0) {
    lines.push(`Closes: ${pr.closingIssues.map((n) => `#${n}`).join(', ')}`);
  }
  lines.push(`Mergeable: ${pr.mergeable || 'UNKNOWN'} · merge state: ${pr.mergeStateStatus || 'UNKNOWN'} · review: ${pr.reviewDecision ?? 'none'} · checks: ${pr.checks}`);
  return [...lines, ...extra].join('\n');
}

function ageMinutes(createdAt: string, now: Date): number {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) ? (now.getTime() - created) / 60_000 : Number.NaN;
}

/** The decision before applying `policy.merge`. */
function decideShipRaw(pr: ShipPr, policy: ShipPolicy, now: Date): ShipDecision {
  if (pr.isDraft) return { action: 'skip', reason: 'draft PR' };

  const prefixes = policy.headPrefixes.length > 0 ? policy.headPrefixes : [DEFAULT_HEAD_PREFIX];
  if (!prefixes.some((prefix) => pr.headRefName.startsWith(prefix))) {
    return { action: 'skip', reason: `head branch ${pr.headRefName} is not a factory branch (${prefixes.join(', ')})` };
  }

  if (pr.checks === 'failure') {
    const failing = pr.failingChecks.length > 0 ? pr.failingChecks : ['(unknown)'];
    return {
      action: 'ask',
      key: `ship:${pr.number}:checks-failing`,
      question: `PR #${pr.number} has failing CI checks (${failing.join(', ')}). Fix and re-run, or close it?`,
      context: prContext(pr, ['Failing checks:', ...failing.map((name) => `- ${name}`)]),
    };
  }

  if (pr.checks === 'none') {
    if (policy.requireChecks) {
      const age = ageMinutes(pr.createdAt, now);
      if (Number.isFinite(age) && age > policy.checksTimeoutMinutes) {
        return {
          action: 'ask',
          key: `ship:${pr.number}:no-checks`,
          question: `PR #${pr.number} has reported no CI checks after ${Math.round(age)} minutes. Is CI configured for ${pr.baseRefName}, or should it merge without checks?`,
          context: prContext(pr),
        };
      }
      return { action: 'wait', reason: 'no CI checks reported yet' };
    }
  } else if (pr.checks === 'pending') {
    return { action: 'wait', reason: 'CI checks pending' };
  }

  const mergeable = upper(pr.mergeable);
  const mergeState = upper(pr.mergeStateStatus);

  if (mergeable === 'CONFLICTING' || mergeState === 'DIRTY') {
    return {
      action: 'ask',
      key: `ship:${pr.number}:conflict`,
      question: `PR #${pr.number} has merge conflicts with ${pr.baseRefName}. Resolve them, or close and re-queue the issue?`,
      context: prContext(pr),
    };
  }
  if (mergeable !== 'MERGEABLE') return { action: 'wait', reason: 'mergeability not yet computed' };

  const review = upper(pr.reviewDecision);
  if (review === 'CHANGES_REQUESTED') {
    // A human asked for changes: never override that, not even with admin merge.
    return {
      action: 'ask',
      key: `ship:${pr.number}:review-required`,
      question: `PR #${pr.number} is green but has changes requested. Address the review, or approve it?`,
      context: prContext(pr),
    };
  }
  if (review === 'REVIEW_REQUIRED') {
    // admin_merge exists only to get past the approving-review requirement the
    // loop cannot satisfy. Use it only when every required check is known to
    // have passed on this head — BLOCKED can also mean a required check has
    // not reported yet, and statusCheckRollup cannot show an absent check.
    if (policy.adminMerge) {
      const missing = pr.requiredChecksMissing;
      if (missing === undefined) {
        return {
          action: 'ask',
          key: `ship:${pr.number}:review-required`,
          question: `PR #${pr.number} is green but ${pr.baseRefName} requires an approving review, and the factory could not verify the required checks for an admin merge. Approve it, or merge it by hand?`,
          context: prContext(pr),
        };
      }
      if (missing.length > 0) {
        const age = ageMinutes(pr.createdAt, now);
        if (Number.isFinite(age) && age > policy.checksTimeoutMinutes) {
          return {
            action: 'ask',
            key: `ship:${pr.number}:required-checks`,
            question: `PR #${pr.number} is still missing required checks (${missing.join(', ')}) after ${Math.round(age)} minutes. Is CI running for ${pr.baseRefName}?`,
            context: prContext(pr, ['Missing required checks:', ...missing.map((name) => `- ${name}`)]),
          };
        }
        return { action: 'wait', reason: `required checks not reported yet: ${missing.join(', ')}` };
      }
      // A review bypass must not also bypass updating a stale branch and its CI.
      if (mergeState !== 'BEHIND') {
        return { action: 'merge', admin: true, reason: `checks ${pr.checks}; every required check passed; review required — admin merge` };
      }
    } else {
      return {
        action: 'ask',
        key: `ship:${pr.number}:review-required`,
        question: `PR #${pr.number} is green but ${pr.baseRefName} requires an approving review the loop cannot give. Approve it, or allow admin merge?`,
        context: prContext(pr),
      };
    }
  }
  if (mergeState === 'BLOCKED') {
    // Blocked by something other than reviews (a required check that has not
    // reported, signatures, conversation resolution, ...). Never admin-merge.
    const age = ageMinutes(pr.createdAt, now);
    if (Number.isFinite(age) && age > policy.checksTimeoutMinutes) {
      return {
        action: 'ask',
        key: `ship:${pr.number}:blocked`,
        question: `PR #${pr.number} is green but ${pr.baseRefName} branch protection still blocks it after ${Math.round(age)} minutes. What is missing?`,
        context: prContext(pr),
      };
    }
    return { action: 'wait', reason: 'blocked by branch protection (not a review requirement)' };
  }

  if (mergeState === 'BEHIND') {
    if (pr.checks !== 'success') return { action: 'wait', reason: 'branch update requires successful CI checks' };
    return { action: 'update-branch', reason: `branch behind ${pr.baseRefName}; merge base into PR branch and re-wait for CI` };
  }
  if (mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS') {
    return { action: 'merge', admin: false, reason: `checks ${pr.checks}; merge state ${mergeState}` };
  }
  if (mergeState === 'UNSTABLE' && pr.checks === 'success') {
    return { action: 'merge', admin: false, reason: 'checks success; merge state UNSTABLE (non-required checks)' };
  }
  return { action: 'wait', reason: `merge state ${mergeState || 'UNKNOWN'}` };
}

/**
 * Decide what the shipper does with one PR. Fails closed: anything not
 * positively green and mergeable waits, skips, or asks a human.
 * `policy.merge === false` turns merges and branch updates into report-only skips.
 */
export function decideShip(pr: ShipPr, policy: ShipPolicy, now: Date): ShipDecision {
  const decision = decideShipRaw(pr, policy, now);
  if (decision.action === 'merge' && !policy.merge) {
    return { action: 'skip', reason: 'would merge (ship.merge disabled)' };
  }
  if (decision.action === 'update-branch' && !policy.merge) {
    return { action: 'skip', reason: 'would update branch (ship.merge disabled)' };
  }
  return decision;
}

type RawPr = {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: unknown[] | null;
  createdAt?: string;
  closingIssuesReferences?: Array<{
    number?: number;
    repository?: { name?: string; owner?: { login?: string } } | null;
  }> | null;
};

/** Closing issue numbers that live in `repo` (references to other repos are dropped). */
function closingIssueNumbers(repo: string, refs: RawPr['closingIssuesReferences']): number[] {
  const [owner, name] = repo.toLowerCase().split('/');
  const numbers: number[] = [];
  for (const ref of refs ?? []) {
    if (typeof ref?.number !== 'number') continue;
    const refName = ref.repository?.name?.toLowerCase();
    const refOwner = ref.repository?.owner?.login?.toLowerCase();
    if ((refName && refName !== name) || (refOwner && refOwner !== owner)) continue;
    if (!numbers.includes(ref.number)) numbers.push(ref.number);
  }
  return numbers;
}

function toShipPr(repo: string, raw: RawPr): ShipPr | null {
  if (typeof raw.number !== 'number' || typeof raw.headRefName !== 'string') return null;
  const checks = summarizeChecks(raw.statusCheckRollup ?? []);
  return {
    number: raw.number,
    title: raw.title ?? '',
    url: raw.url ?? '',
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName ?? '',
    isDraft: raw.isDraft === true,
    mergeable: raw.mergeable ?? 'UNKNOWN',
    mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: raw.reviewDecision ? raw.reviewDecision : null,
    checks: checks.state,
    failingChecks: checks.failing,
    createdAt: raw.createdAt ?? '',
    closingIssues: closingIssueNumbers(repo, raw.closingIssuesReferences),
    ...(raw.headRefOid ? { headRefOid: raw.headRefOid } : {}),
  };
}

/**
 * Required status check names for `baseBranch` from the branch-protection API.
 * [] when the branch is unprotected or has no required checks; null when the
 * protection could not be read (permissions, network) — callers fail closed.
 */
export function requiredStatusContexts(repo: string, baseBranch: string): string[] | null {
  const result = ghExec(
    `gh api ${shellQuote(`repos/${repo}/branches/${baseBranch}/protection/required_status_checks`)}`,
  );
  if (result.exitCode !== 0) {
    const text = `${result.stderr} ${result.stdout}`;
    if (/not protected|required status checks not enabled|HTTP 404|Not Found/i.test(text)) return [];
    return null;
  }
  try {
    const data = JSON.parse(result.stdout || '{}') as { contexts?: unknown; checks?: Array<{ context?: unknown }> };
    const names = new Set<string>();
    if (Array.isArray(data.contexts)) {
      for (const c of data.contexts) if (typeof c === 'string' && c.trim()) names.add(c.trim());
    }
    for (const check of data.checks ?? []) {
      if (typeof check?.context === 'string' && check.context.trim()) names.add(check.context.trim());
    }
    return [...names];
  } catch {
    return null;
  }
}

/**
 * Open PRs into `baseBranch` whose head branch starts with one of
 * `headPrefixes`, oldest first. Throws when gh fails or returns unparseable
 * output so the supervisor can log a ship-tick failure instead of silently
 * believing there is nothing to ship. With `requiredChecks`, each PR also gets
 * `requiredChecksMissing` (needed before any admin merge).
 */
export function listShippablePrs(
  repo: string,
  baseBranch: string,
  headPrefixes: string[],
  opts: { requiredChecks?: boolean } = {},
): ShipPr[] {
  const result = ghExec(
    `gh pr list --repo ${shellQuote(repo)} --base ${shellQuote(baseBranch)} --state open --json ${PR_LIST_FIELDS} --limit 100`,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to list PRs into ${baseBranch}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch {
    throw new Error(`Failed to parse PR list for ${baseBranch}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Unexpected PR list shape for ${baseBranch}`);

  const prefixes = headPrefixes.length > 0 ? headPrefixes : [DEFAULT_HEAD_PREFIX];
  const matching = (parsed as RawPr[])
    .filter((raw) => typeof raw.headRefName === 'string' && prefixes.some((prefix) => raw.headRefName!.startsWith(prefix)));
  const required = opts.requiredChecks && matching.length > 0 ? requiredStatusContexts(repo, baseBranch) : undefined;
  return matching
    .map((raw) => {
      const pr = toShipPr(repo, raw);
      if (pr && opts.requiredChecks && required) {
        const passed = new Set(passedCheckNames(raw.statusCheckRollup ?? []));
        pr.requiredChecksMissing = required.filter((name) => !passed.has(name));
      }
      return pr;
    })
    .filter((pr): pr is ShipPr => pr !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
}

/**
 * Merge the base into a PR branch using gh's default strategy, never rebase or force-push.
 * An already-current branch returns updated: false without an error.
 */
export function updateShippablePrBranch(repo: string, pr: ShipPr): { updated: boolean; conflict: boolean; error?: string } {
  const result = ghExec(`gh pr update-branch ${pr.number} --repo ${shellQuote(repo)}`, undefined, true);
  if (result.exitCode === 0) {
    return { updated: !/\bPR branch (?:is )?already up-to-date\b/i.test(result.stdout), conflict: false };
  }

  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  // Match explicit merge conflicts, not a generic HTTP 409 (e.g. a changed head SHA).
  const conflict = /\bmerge conflicts?\b|\bcannot update PR branch due to conflicts\b/i.test(detail);
  return { updated: false, conflict, error: `gh pr update-branch #${pr.number} failed: ${detail || `exit ${result.exitCode}`}` };
}

/**
 * Merge one PR, then re-read it and require state MERGED (fail closed — a
 * zero exit that queued an auto-merge, or an exit that lied, is not a merge).
 * Never throws; failures come back as { merged: false, error }.
 */
export function mergeShippablePr(repo: string, pr: ShipPr, policy: ShipPolicy, admin: boolean): { merged: boolean; error?: string } {
  const flags = [`--${policy.mergeMethod}`];
  if (admin) flags.push('--admin');
  if (policy.deleteBranch) flags.push('--delete-branch');
  if (pr.headRefOid) flags.push(`--match-head-commit ${shellQuote(pr.headRefOid)}`);

  const mergeResult = ghExec(
    `gh pr merge ${pr.number} --repo ${shellQuote(repo)} ${flags.join(' ')}`,
    undefined, true,
  );
  if (mergeResult.exitCode !== 0) {
    const error = `gh pr merge #${pr.number} failed: ${mergeResult.stderr.trim() || `exit ${mergeResult.exitCode}`}`;
    log.warn(error);
    return { merged: false, error };
  }

  const viewResult = ghExec(`gh pr view ${pr.number} --repo ${shellQuote(repo)} --json state,mergedAt`);
  if (viewResult.exitCode !== 0) {
    const error = `Could not confirm merge of PR #${pr.number}: ${viewResult.stderr.trim() || `exit ${viewResult.exitCode}`}`;
    log.warn(error);
    return { merged: false, error };
  }
  try {
    const view = JSON.parse(viewResult.stdout) as { state?: string; mergedAt?: string | null };
    if (upper(view.state) !== 'MERGED') {
      const error = `PR #${pr.number} is ${view.state ?? 'UNKNOWN'} after merge command, not MERGED`;
      log.warn(error);
      return { merged: false, error };
    }
  } catch {
    const error = `Could not parse state of PR #${pr.number} after merge`;
    log.warn(error);
    return { merged: false, error };
  }

  log.info(`PR #${pr.number} merged${admin ? ' (admin)' : ''}`);
  return { merged: true };
}
