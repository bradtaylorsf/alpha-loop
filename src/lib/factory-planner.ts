/**
 * Factory Planner — decide which `ready` issues the factory builds next.
 *
 * Pure and deterministic: every piece of GitHub state arrives through
 * `DispatchInput` (issue lists, lease set, an injected `isIssueClosed`), so the
 * supervisor owns all I/O and this module is trivially testable.
 *
 * An issue is dispatched only when it is a real work item (not an epic), not
 * blocked/failed/waiting on a human, not already claimed or in flight, every
 * explicit dependency is known to be closed, and (optionally) its likely files
 * don't overlap with work already running or already chosen this tick.
 */
import type { Issue } from './github.js';
import { hasLabel } from './labels.js';
import { extractFilePaths, parseDependencies } from './validation.js';

export type DispatchCandidate = {
  issue: Issue;
  priority: number;
  epic?: number;
  epicIndex?: number;
  touches: string[];
  deps: number[];
};

export type DispatchSkip = {
  issue: number;
  reason:
    | 'claimed'
    | 'in-flight'
    | 'epic'
    | 'blocked'
    | 'needs-human'
    | 'open-deps'
    | 'overlap'
    | 'out-of-scope'
    | 'failed'
    | 'not-ready';
  detail?: string;
};

export type DispatchPlan = { dispatch: DispatchCandidate[]; skipped: DispatchSkip[] };

export type DispatchInput = {
  /** From pollIssues(label ready). */
  readyIssues: Issue[];
  /** Free developer slots. */
  slots: number;
  inFlight: Array<{ issue: number; touches: string[] }>;
  /** Live leases from listLeases. */
  leasedIssues: Set<number>;
  /** null = unknown → treated as open (conservative). */
  isIssueClosed: (n: number) => boolean | null;
  /** Epic → ordered child issue numbers. When given, only children dispatch. */
  epicScope?: Map<number, number[]>;
  avoidOverlap: boolean;
  labels: { ready: string; blocked?: string; needsHuman?: string; failed?: string };
};

const DEFAULT_PRIORITY = 2;
const EPIC_LABEL = 'epic';
const DEFAULT_BLOCKED_LABEL = 'blocked';
const DEFAULT_NEEDS_HUMAN_LABEL = 'needs-human-input';
const DEFAULT_FAILED_LABEL = 'failed';

const PRIORITY_BY_LABEL: Record<string, number> = {
  'p0': 0, 'priority:p0': 0, 'priority:critical': 0, 'critical': 0,
  'p1': 1, 'priority:p1': 1, 'priority:high': 1, 'high': 1,
  'p2': 2, 'priority:p2': 2, 'priority:medium': 2, 'medium': 2,
  'p3': 3, 'priority:p3': 3, 'priority:low': 3, 'low': 3,
};

/**
 * Map priority labels to a rank (0 = highest). Unlabelled issues are p2.
 * When several priority labels are present the most urgent one wins.
 */
export function issuePriority(labels: string[]): number {
  let best: number | null = null;
  for (const label of labels) {
    const key = label.toLowerCase().replace(/\s+/g, '');
    const rank = PRIORITY_BY_LABEL[key];
    if (rank !== undefined && (best === null || rank < best)) best = rank;
  }
  return best ?? DEFAULT_PRIORITY;
}

/** Normalize a path-ish token: strip quotes/punctuation, `./`, globs, backslashes. */
function normalizeTouch(raw: string): string | null {
  let path = raw.trim().replace(/\\/g, '/');
  path = path.replace(/^['"(<]+|['")>,;:]+$/g, '');
  path = path.replace(/^\.\//, '');
  // A glob like `src/lib/*.ts` narrows nothing useful for overlap — treat it as its directory.
  const star = path.indexOf('*');
  if (star >= 0) path = path.slice(0, star);
  // Trailing sentence period ("src/x.ts.") — but keep dotfiles and extensions intact.
  path = path.replace(/\.+$/, '');
  if (!path || !/^[\w@.\-/]+$/.test(path)) return null;
  if (!path.includes('/') && !path.includes('.')) return null;
  if (path === '.' || path === '/') return null;
  return path;
}

/** Return the body lines under a `## Touches` heading (up to the next heading). */
function touchesSection(body: string): string[] | null {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^#{2,6}\s*touches\b/i.test(line.trim()));
  if (start < 0) return null;
  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i].trim())) break;
    section.push(lines[i]);
  }
  return section;
}

function dedupe(paths: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (path && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * Likely files an issue will touch. Prefers the PM-authored `## Touches`
 * section (backticked or bare bullets); falls back to any file paths mentioned
 * anywhere in the body when that section is absent or yields nothing.
 */
export function extractTouches(body: string): string[] {
  const section = touchesSection(body ?? '');
  if (section) {
    const found: Array<string | null> = [];
    for (const line of section) {
      const bullet = /^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
      if (!bullet) continue;
      const text = bullet[1];
      const backticked = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      if (backticked.length > 0) {
        found.push(...backticked.map(normalizeTouch));
      } else {
        found.push(normalizeTouch(text.split(/\s+/)[0] ?? ''));
      }
    }
    const touches = dedupe(found);
    if (touches.length > 0) return touches;
  }
  return dedupe(extractFilePaths(body ?? '').map(normalizeTouch));
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

function pathsOverlap(a: string, b: string): boolean {
  const left = stripTrailingSlash(a);
  const right = stripTrailingSlash(b);
  if (!left || !right) return false;
  return left === right || right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}

/**
 * True when any path in `a` equals, contains, or is contained by a path in `b`
 * (`src/lib/` overlaps `src/lib/x.ts`). Empty lists never overlap — an issue
 * with no known footprint is not serialized against everything.
 */
export function touchesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return a.some((left) => b.some((right) => pathsOverlap(left, right)));
}

function overlapDetail(touches: string[], others: Array<{ issue: number; touches: string[] }>): string | null {
  const hit = others.find((other) => touchesOverlap(touches, other.touches));
  return hit ? `overlaps #${hit.issue}` : null;
}

/** Epic membership lookup: child → { epic, index, epicOrder }. First epic listing a child wins. */
function epicMembership(scope: Map<number, number[]>): Map<number, { epic: number; index: number; order: number }> {
  const membership = new Map<number, { epic: number; index: number; order: number }>();
  let order = 0;
  for (const [epic, children] of scope) {
    children.forEach((child, index) => {
      if (!membership.has(child)) membership.set(child, { epic, index, order });
    });
    order++;
  }
  return membership;
}

/**
 * Choose up to `slots` issues to dispatch, in priority order, recording why
 * every other ready issue was passed over.
 *
 * Order: priority asc → epic order (as given in epicScope) → checklist index
 * asc → issue number asc.
 */
export function planDispatch(input: DispatchInput): DispatchPlan {
  const skipped: DispatchSkip[] = [];
  const scoped = input.epicScope !== undefined && input.epicScope.size > 0;
  const membership = scoped ? epicMembership(input.epicScope!) : new Map();
  const inFlightNumbers = new Set(input.inFlight.map((work) => work.issue));
  const blockedLabel = input.labels.blocked ?? DEFAULT_BLOCKED_LABEL;
  const needsHumanLabel = input.labels.needsHuman ?? DEFAULT_NEEDS_HUMAN_LABEL;
  const failedLabel = input.labels.failed ?? DEFAULT_FAILED_LABEL;

  type Ranked = DispatchCandidate & { epicOrder: number };
  const eligible: Ranked[] = [];
  const seen = new Set<number>();

  for (const issue of input.readyIssues) {
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    const labels = issue.labels ?? [];
    const skip = (reason: DispatchSkip['reason'], detail?: string) => {
      skipped.push(detail ? { issue: issue.number, reason, detail } : { issue: issue.number, reason });
    };

    if (!hasLabel(labels, input.labels.ready)) { skip('not-ready'); continue; }
    if (hasLabel(labels, EPIC_LABEL)) { skip('epic'); continue; }
    if (hasLabel(labels, blockedLabel)) { skip('blocked'); continue; }
    if (hasLabel(labels, needsHumanLabel)) { skip('needs-human'); continue; }
    if (hasLabel(labels, failedLabel)) { skip('failed'); continue; }
    if (inFlightNumbers.has(issue.number)) { skip('in-flight'); continue; }
    if (input.leasedIssues.has(issue.number)) { skip('claimed'); continue; }

    const member = membership.get(issue.number);
    if (scoped && !member) { skip('out-of-scope'); continue; }

    const deps = parseDependencies(issue.body ?? '').filter((dep) => dep !== issue.number);
    const openDeps = deps.filter((dep) => input.isIssueClosed(dep) !== true);
    if (openDeps.length > 0) {
      skip('open-deps', openDeps.map((dep) => `#${dep}`).join(', '));
      continue;
    }

    eligible.push({
      issue,
      priority: issuePriority(labels),
      ...(member ? { epic: member.epic, epicIndex: member.index } : {}),
      touches: extractTouches(issue.body ?? ''),
      deps,
      epicOrder: member?.order ?? 0,
    });
  }

  eligible.sort((a, b) =>
    a.priority - b.priority
    || a.epicOrder - b.epicOrder
    || (a.epicIndex ?? 0) - (b.epicIndex ?? 0)
    || a.issue.number - b.issue.number);

  const dispatch: DispatchCandidate[] = [];
  const slots = Math.max(0, Math.floor(input.slots));
  for (const { epicOrder: _epicOrder, ...candidate } of eligible) {
    if (dispatch.length >= slots) break;
    if (input.avoidOverlap) {
      const detail = overlapDetail(candidate.touches, input.inFlight)
        ?? overlapDetail(candidate.touches, dispatch.map((chosen) => ({ issue: chosen.issue.number, touches: chosen.touches })));
      if (detail) {
        skipped.push({ issue: candidate.issue.number, reason: 'overlap', detail });
        continue;
      }
    }
    dispatch.push(candidate);
  }

  return { dispatch, skipped };
}
