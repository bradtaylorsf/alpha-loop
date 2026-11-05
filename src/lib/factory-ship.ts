/**
 * Factory Shipper — merge green session PRs, ask a human about stuck ones.
 *
 * `decideShip` is pure: given a PR snapshot and policy it returns merge / wait /
 * skip / ask. It fails closed — a PR with failing, pending, missing or
 * unrecognized checks never merges, and an unknown mergeability waits.
 *
 * `listShippablePrs` and `mergeShippablePr` are the only gh calls, both via
 * ghExec (rate-limited), following github.ts conventions.
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
};

export type ShipPolicy = {
  merge: boolean;
  adminMerge: boolean;
  requireChecks: boolean;
  checksTimeoutMinutes: number;
  mergeMethod: 'squash' | 'merge' | 'rebase';
  /** Default ['session/']. */
  headPrefixes: string[];
  /** Pass --delete-branch on merge. Default false. */
  deleteBranch?: boolean;
};

export type ShipDecision =
  | { action: 'merge'; admin: boolean; reason: string }
  | { action: 'wait'; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'ask'; key: string; question: string; context: string };

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

  const prefixes = policy.headPrefixes.length > 0 ? policy.headPrefixes : ['session/'];
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
  if (review === 'REVIEW_REQUIRED' || review === 'CHANGES_REQUESTED' || mergeState === 'BLOCKED') {
    if (policy.adminMerge) {
      return { action: 'merge', admin: true, reason: `checks ${pr.checks}; branch protection blocks a normal merge — admin merge` };
    }
    const why = review === 'CHANGES_REQUESTED'
      ? 'has changes requested'
      : review === 'REVIEW_REQUIRED'
        ? 'requires an approving review the loop cannot give'
        : 'is blocked by branch protection';
    return {
      action: 'ask',
      key: `ship:${pr.number}:review-required`,
      question: `PR #${pr.number} is green but ${pr.baseRefName} ${why}. Approve it, or allow admin merge?`,
      context: prContext(pr),
    };
  }

  if (mergeState === 'BEHIND') {
    return { action: 'wait', reason: `branch behind ${pr.baseRefName}; needs update (future auto-rebase)` };
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
 * `policy.merge === false` turns every merge into a skip (dry-run shipping).
 */
export function decideShip(pr: ShipPr, policy: ShipPolicy, now: Date): ShipDecision {
  const decision = decideShipRaw(pr, policy, now);
  if (decision.action === 'merge' && !policy.merge) {
    return { action: 'skip', reason: 'would merge (ship.merge disabled)' };
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
 * Open PRs into `baseBranch` whose head branch starts with one of
 * `headPrefixes`, oldest first. Throws when gh fails or returns unparseable
 * output so the supervisor can log a ship-tick failure instead of silently
 * believing there is nothing to ship.
 */
export function listShippablePrs(repo: string, baseBranch: string, headPrefixes: string[]): ShipPr[] {
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

  const prefixes = headPrefixes.length > 0 ? headPrefixes : ['session/'];
  return (parsed as RawPr[])
    .map((raw) => toShipPr(repo, raw))
    .filter((pr): pr is ShipPr => pr !== null)
    .filter((pr) => prefixes.some((prefix) => pr.headRefName.startsWith(prefix)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
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
