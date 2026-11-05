/**
 * GitHub API rate limit tracking and adaptive throttling.
 *
 * Wraps `exec()` to intercept all `gh` CLI calls, parse rate limit headers
 * from GH_DEBUG=api stderr output, and apply adaptive delays to avoid
 * hitting GitHub's primary (5,000 pts/hr) and secondary (80 mutations/min)
 * rate limits.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { exec, type ExecResult } from './shell.js';
import { withFileLockSync } from './lease.js';
import { log } from './logger.js';

// ── Rate limit state ────────────────────────────────────────────────────────

type RateLimitState = {
  remaining: number;
  limit: number;
  used: number;
  resetAt: number; // UTC epoch seconds
};

let rateLimitState: RateLimitState = {
  remaining: 5000,
  limit: 5000,
  used: 0,
  resetAt: 0,
};

let callCount = 0;
let lastMutationAt = 0;
let lastTier = '';

/** Minimum ms between mutation calls to stay under 80 mutations/min. */
const MUTATION_GAP_MS = 750;

/** How often (in calls) to log rate limit status. */
const LOG_INTERVAL = 10;

// ── Header parsing ──────────────────────────────────────────────────────────

/**
 * Parse rate limit headers from GH_DEBUG=api stderr output.
 * Returns null if headers are not found.
 */
export function parseRateLimitHeaders(stderr: string): RateLimitState | null {
  // A single gh command can produce multiple sets of rate limit headers
  // (e.g. REST + GraphQL, or paginated GraphQL). Take the last occurrence
  // which reflects the most recent response and lowest remaining budget.
  const allRemaining = [...stderr.matchAll(/X-Ratelimit-Remaining:\s*(\d+)/gi)];
  const allLimit = [...stderr.matchAll(/X-Ratelimit-Limit:\s*(\d+)/gi)];
  const allUsed = [...stderr.matchAll(/X-Ratelimit-Used:\s*(\d+)/gi)];
  const allReset = [...stderr.matchAll(/X-Ratelimit-Reset:\s*(\d+)/gi)];

  if (allRemaining.length === 0 || allLimit.length === 0) return null;

  const remaining = allRemaining[allRemaining.length - 1];
  const limit = allLimit[allLimit.length - 1];
  const used = allUsed.length > 0 ? allUsed[allUsed.length - 1] : null;
  const reset = allReset.length > 0 ? allReset[allReset.length - 1] : null;

  return {
    remaining: parseInt(remaining[1], 10),
    limit: parseInt(limit[1], 10),
    used: used ? parseInt(used[1], 10) : 0,
    resetAt: reset ? parseInt(reset[1], 10) : 0,
  };
}

/**
 * Strip GH_DEBUG=api debug lines from stderr so callers see clean errors.
 * Debug lines start with `*`, `>`, or `<` followed by a space.
 */
export function stripDebugOutput(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/^[*><] /.test(line))
    .join('\n')
    .trim();
}

// ── Throttle tiers ──────────────────────────────────────────────────────────

export function getThrottleTier(ratio: number): { tier: string; delayMs: number } {
  if (ratio > 0.5) return { tier: 'normal', delayMs: 0 };
  if (ratio > 0.2) return { tier: 'cautious', delayMs: 200 };
  if (ratio > 0.05) return { tier: 'slow', delayMs: 1000 };
  return { tier: 'critical', delayMs: 0 }; // handled specially — waits for reset
}

/** Maximum duration of one blocking sleep (60 seconds). */
const MAX_SLEEP_MS = 60_000;

function sleepChunk(ms: number): void {
  execSync(`sleep ${(ms / 1000).toFixed(3)}`, { stdio: 'ignore' });
}

/** Synchronous, CPU-friendly sleep, split into bounded chunks. */
function sleepSync(ms: number, sleep: (ms: number) => void = sleepChunk): void {
  for (let remaining = ms; remaining > 0;) {
    const chunk = Math.min(remaining, MAX_SLEEP_MS);
    sleep(chunk);
    remaining -= chunk;
  }
}

function readSharedMutationAt(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const state: unknown = JSON.parse(raw);
  const timestamp = state && typeof state === 'object' && !Array.isArray(state)
    ? (state as Record<string, unknown>).lastMutationAt
    : undefined;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('lastMutationAt must be a non-negative integer in epoch milliseconds');
  }
  return timestamp;
}

/** Claim only an eligible slot; never hold the lock during throttle waits or gh execution. */
function claimSharedMutation(path: string, now: () => number, sleep: (ms: number) => void): void {
  try {
    for (;;) {
      const waitMs = withFileLockSync(`${path}.lock`, () => {
        const sharedMutationAt = readSharedMutationAt(path);
        const current = now();
        const wait = Math.max(
          sharedMutationAt === null ? 0 : sharedMutationAt + MUTATION_GAP_MS - current,
          lastMutationAt > 0 ? lastMutationAt + MUTATION_GAP_MS - current : 0,
        );
        if (wait > 0) return wait;

        // The lock creates the parent directory. Publish the complete state
        // before executing, so failed mutations still consume their slot.
        const tmpPath = `${path}.tmp-${randomUUID()}`;
        try {
          writeFileSync(tmpPath, JSON.stringify({ lastMutationAt: current }) + '\n', { flag: 'wx' });
          renameSync(tmpPath, path);
        } finally {
          rmSync(tmpPath, { force: true });
        }
        return 0;
      }, { now, sleep });
      if (waitMs <= 0) return;
      sleep(waitMs);
      // Another process may claim a slot during our wait: reread under the lock.
    }
  } catch (err) {
    throw new Error(`Shared GitHub mutation budget ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Get current rate limit status. */
export function getRateLimitStatus(): RateLimitState & { ratio: number } {
  const ratio = rateLimitState.limit > 0
    ? rateLimitState.remaining / rateLimitState.limit
    : 1;
  return { ...rateLimitState, ratio };
}

/**
 * Rate-limit-aware exec wrapper for all GitHub CLI calls.
 *
 * - Sets GH_DEBUG=api to capture rate limit headers from stderr
 * - Applies adaptive delay based on remaining budget
 * - Enforces 750ms gap between mutation calls
 * - Strips debug output from stderr before returning
 *
 * @param command - The gh CLI command to execute
 * @param options - Optional cwd/timeout overrides
 * @param mutation - Whether this is a write/mutation call (default false)
 * @param deps - Optional wall clock and synchronous sleep primitive for tests
 */
export function ghExec(
  command: string,
  options?: { cwd?: string; timeout?: number },
  mutation = false,
  deps: { now?: () => number; sleep?: (ms: number) => void } = {},
): ExecResult {
  const now = deps.now ?? Date.now;
  const sleep = (ms: number): void => sleepSync(ms, deps.sleep);
  callCount++;

  // ── Pre-call throttle ───────────────────────────────────────────────────
  const { ratio } = getRateLimitStatus();
  const { tier, delayMs } = getThrottleTier(ratio);

  // Log tier transitions
  if (tier !== lastTier && lastTier !== '') {
    log.rate(`Throttle tier: ${lastTier} → ${tier} (${rateLimitState.remaining}/${rateLimitState.limit} remaining)`);
  }
  lastTier = tier;

  // Critical: wait for reset window or apply fallback delay
  if (tier === 'critical') {
    if (rateLimitState.resetAt > 0) {
      const waitMs = (rateLimitState.resetAt * 1000) - now();
      if (waitMs > 0) {
        const waitSec = Math.ceil(waitMs / 1000);
        log.rate(`Rate limit critical (${rateLimitState.remaining}/${rateLimitState.limit}). Waiting ${waitSec}s for reset...`);
        sleep(waitMs);
      }
    } else {
      // No reset time known yet — apply a conservative fallback delay
      const CRITICAL_FALLBACK_MS = 5000;
      log.rate(`Rate limit critical (${rateLimitState.remaining}/${rateLimitState.limit}). No reset time known, waiting ${CRITICAL_FALLBACK_MS / 1000}s...`);
      sleep(CRITICAL_FALLBACK_MS);
    }
  } else if (delayMs > 0) {
    sleep(delayMs);
  }

  // Enforce mutation gap (secondary rate limit: 80 mutations/min)
  if (mutation) {
    const budgetPath = process.env.ALPHA_LOOP_SHARED_GH_BUDGET;
    if (budgetPath) {
      claimSharedMutation(budgetPath, now, sleep);
    } else if (lastMutationAt > 0) {
      const elapsed = now() - lastMutationAt;
      if (elapsed < MUTATION_GAP_MS) sleep(MUTATION_GAP_MS - elapsed);
    }
  }

  // ── Execute ─────────────────────────────────────────────────────────────
  const result = exec(command, {
    cwd: options?.cwd,
    timeout: options?.timeout,
    env: { GH_DEBUG: 'api' },
  });

  if (mutation) {
    lastMutationAt = now();
  }

  // ── Parse rate limit headers from stderr ────────────────────────────────
  const parsed = parseRateLimitHeaders(result.stderr);
  if (parsed) {
    rateLimitState = parsed;
  }

  // Strip debug lines so callers see clean error messages
  result.stderr = stripDebugOutput(result.stderr);

  // ── Periodic logging ────────────────────────────────────────────────────
  if (callCount % LOG_INTERVAL === 0) {
    const currentRatio = rateLimitState.limit > 0
      ? rateLimitState.remaining / rateLimitState.limit
      : 1;
    log.rate(`${rateLimitState.remaining}/${rateLimitState.limit} remaining (${Math.round(currentRatio * 100)}%)`);
  }

  return result;
}

// ── Project metadata cache ──────────────────────────────────────────────────

type ResolvedProjectCache = {
  disabled?: false;
  projectId: string;
  fieldId: string;
  optionMap: Map<string, string>; // status name → option ID
};

type DisabledProjectCache = {
  disabled: true;
  reason: string;
};

type ProjectCache = ResolvedProjectCache | DisabledProjectCache;

const projectCacheMap = new Map<string, ProjectCache>();

function projectCacheKey(owner: string, projectNum: number): string {
  return `${owner}/${projectNum}`;
}

/** Get cached project metadata, or null if not yet cached. */
export function getProjectCache(owner: string, projectNum: number): ProjectCache | null {
  return projectCacheMap.get(projectCacheKey(owner, projectNum)) ?? null;
}

/** Store project metadata in cache. */
export function setProjectCache(owner: string, projectNum: number, cache: ProjectCache): void {
  projectCacheMap.set(projectCacheKey(owner, projectNum), cache);
}

/** Clear all cached project metadata (for testing). */
export function clearProjectCache(): void {
  projectCacheMap.clear();
}

/** Reset rate limit state (for testing). */
export function resetRateLimitState(): void {
  rateLimitState = { remaining: 5000, limit: 5000, used: 0, resetAt: 0 };
  callCount = 0;
  lastMutationAt = 0;
  lastTier = '';
}
