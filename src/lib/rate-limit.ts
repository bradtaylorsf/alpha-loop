/**
 * GitHub API rate limit tracking and adaptive throttling.
 *
 * Wraps `exec()` to intercept all `gh` CLI calls, parse rate limit headers
 * from GH_DEBUG=api stderr output, and apply adaptive delays to avoid
 * hitting GitHub's primary (5,000 pts/hr) and secondary (80 mutations/min)
 * rate limits.
 */
import { execSync } from 'node:child_process';
import { exec, type ExecResult } from './shell.js';
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
  const remaining = stderr.match(/X-Ratelimit-Remaining:\s*(\d+)/i);
  const limit = stderr.match(/X-Ratelimit-Limit:\s*(\d+)/i);
  const used = stderr.match(/X-Ratelimit-Used:\s*(\d+)/i);
  const reset = stderr.match(/X-Ratelimit-Reset:\s*(\d+)/i);

  if (!remaining || !limit) return null;

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

/** Maximum time sleepSync will wait before throwing (60 seconds). */
const MAX_SLEEP_MS = 60_000;

/**
 * Synchronous sleep that does NOT busy-wait.
 * Uses child_process.execSync('sleep') for CPU-friendly blocking.
 * Throws if requested duration exceeds MAX_SLEEP_MS.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  if (ms > MAX_SLEEP_MS) {
    throw new Error(
      `Rate limit sleep of ${Math.ceil(ms / 1000)}s exceeds maximum ${MAX_SLEEP_MS / 1000}s. ` +
      `GitHub rate limit is likely exhausted — wait for reset or increase your limit.`,
    );
  }
  // Use execSync('sleep') to block without pegging CPU
  const seconds = ms / 1000;
  execSync(`sleep ${seconds.toFixed(3)}`, { stdio: 'ignore' });
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
 */
export function ghExec(
  command: string,
  options?: { cwd?: string; timeout?: number },
  mutation = false,
): ExecResult {
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
      const waitMs = (rateLimitState.resetAt * 1000) - Date.now();
      if (waitMs > 0) {
        const waitSec = Math.ceil(waitMs / 1000);
        log.rate(`Rate limit critical (${rateLimitState.remaining}/${rateLimitState.limit}). Waiting ${waitSec}s for reset...`);
        sleepSync(waitMs); // throws if > MAX_SLEEP_MS
      }
    } else {
      // No reset time known yet — apply a conservative fallback delay
      const CRITICAL_FALLBACK_MS = 5000;
      log.rate(`Rate limit critical (${rateLimitState.remaining}/${rateLimitState.limit}). No reset time known, waiting ${CRITICAL_FALLBACK_MS / 1000}s...`);
      sleepSync(CRITICAL_FALLBACK_MS);
    }
  } else if (delayMs > 0) {
    sleepSync(delayMs);
  }

  // Enforce mutation gap (secondary rate limit: 80 mutations/min)
  if (mutation && lastMutationAt > 0) {
    const elapsed = Date.now() - lastMutationAt;
    if (elapsed < MUTATION_GAP_MS) {
      sleepSync(MUTATION_GAP_MS - elapsed);
    }
  }

  // ── Execute ─────────────────────────────────────────────────────────────
  const result = exec(command, {
    cwd: options?.cwd,
    timeout: options?.timeout,
    env: { GH_DEBUG: 'api' },
  });

  if (mutation) {
    lastMutationAt = Date.now();
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

type ProjectCache = {
  projectId: string;
  fieldId: string;
  optionMap: Map<string, string>; // status name → option ID
};

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
