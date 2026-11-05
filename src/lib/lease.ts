/**
 * Leases — file-backed ownership records shared between processes.
 *
 * Factory mode runs several alpha-loop processes against one checkout: a
 * supervisor plus N developer workers. A lease is a small JSON file whose
 * existence means "this key is owned"; whoever creates it first wins, and a
 * lease whose owner died (or stopped refreshing past its TTL) can be
 * reclaimed by the next process that needs the key.
 *
 * Reclaiming is the dangerous part. The naive "read, decide it's stale,
 * unlink, re-create" sequence is a TOCTOU race: two reclaimers can both read
 * the same stale file, the first re-creates a fresh lock, and the second then
 * unlinks that *fresh* lock. Here a reclaimer instead renames the file aside
 * (atomic — only one rename of a given inode succeeds), re-reads what it
 * actually moved, and puts it back if it turns out not to be the stale file
 * it judged. `reclaimStaleLockFile` is shared with session-lock.ts and
 * daemon.ts so every lock in the repo reclaims the same way.
 *
 * `withFileLockSync` is the short-critical-section variant: a cross-process
 * mutex around synchronous work such as the git commands that mutate the
 * shared `.git` directory.
 */
import { randomUUID } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export type LeasePayload = {
  version: 1;
  key: string;
  owner: string;
  pid: number;
  hostname: string;
  token: string;
  acquiredAt: string;
  refreshedAt: string;
  ttlSeconds: number;
  /** The process actually doing the work (e.g. a spawned worker child). */
  workerPid?: number;
  /**
   * When true, a lease whose owner pid is alive on this host never expires by
   * TTL. For long-lived singletons (the factory supervisor) whose refresh can
   * be delayed by a long synchronous step such as preflight.
   */
  aliveOverridesTtl?: boolean;
  meta?: Record<string, unknown>;
};

export type LeaseHandle = { path: string; token: string; payload: LeasePayload };

export type LeaseOptions = {
  owner: string;
  /** Seconds without a refresh before the lease is stale. Default 3600; <= 0 disables TTL expiry. */
  ttlSeconds?: number;
  meta?: Record<string, unknown>;
  workerPid?: number;
  /** See LeasePayload.aliveOverridesTtl. */
  aliveOverridesTtl?: boolean;
  now?: Date;
  isPidAlive?: (pid: number) => boolean;
};

export type FileLockOptions = {
  /** Give up waiting after this long. Default 120000. */
  timeoutMs?: number;
  /** A held lock older than this is reclaimed. Default 600000. */
  staleMs?: number;
  /** Delay between attempts while the lock is held. Default 200. */
  pollMs?: number;
  /** Test seam: synchronous sleep. Defaults to Atomics.wait. */
  sleep?: (ms: number) => void;
  /** Test seam: wall clock in ms. Defaults to Date.now. */
  now?: () => number;
  /** Test seam: pid liveness probe. */
  isPidAlive?: (pid: number) => boolean;
};

type FileLockPayload = { version: 1; pid: number; hostname: string; token: string; acquiredAt: string };

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_STALE_MS = 600_000;
const DEFAULT_LOCK_POLL_MS = 200;

// --- Shared low-level helpers ---

export function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function readRaw(path: string, strict = false): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if (strict && errCode(err) !== 'ENOENT') throw err;
    return null;
  }
}

/**
 * Create `path` with `content` only if it does not exist. The content is
 * written to a temp file first and hard-linked into place, so the lock never
 * exists half-written (a reader seeing an empty file would judge it
 * unparseable and reclaim it). Returns false when the path already exists.
 */
function createLockFileSync(path: string, content: string): boolean {
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, content, { flag: 'wx' });
  try {
    linkSync(tmpPath, path);
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    // Filesystems without hard links: fall back to an exclusive create.
    if (['EPERM', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP'].includes(errCode(err) ?? '')) {
      try {
        writeFileSync(path, content, { flag: 'wx' });
        return true;
      } catch (wxErr) {
        if (errCode(wxErr) === 'EEXIST') return false;
        throw wxErr;
      }
    }
    throw err;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
  }
}

/**
 * Atomically move a stale lock file out of the way so the caller can retry
 * its exclusive create. `observedRaw` is the content the caller read and
 * judged stale: if the file that actually got renamed differs (another
 * process reclaimed and re-created it in between), the fresh lock is linked
 * back into place instead of being destroyed.
 *
 * Returns true when the path is now free (reclaimed, or already gone) and
 * the caller should retry its create once; false when nothing was reclaimed
 * (not a regular file, a live lock was restored, or the rename failed).
 * Never unlinks `path` directly.
 */
export function reclaimStaleLockFile(path: string, observedRaw: string | null): boolean {
  try {
    if (!lstatSync(path).isFile()) return false; // never move directories/symlinks aside
  } catch (err) {
    return errCode(err) === 'ENOENT';
  }

  const asidePath = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, asidePath);
  } catch (err) {
    // ENOENT: another reclaimer won the rename — the path is free to retry.
    return errCode(err) === 'ENOENT';
  }

  const moved = readRaw(asidePath);
  if (observedRaw !== null && moved !== observedRaw) {
    // We moved somebody's freshly created lock. Put it back; link fails with
    // EEXIST (no clobber) if a third process already claimed the path.
    try { linkSync(asidePath, path); } catch { /* path re-claimed by someone else */ }
    try { unlinkSync(asidePath); } catch { /* best effort */ }
    return false;
  }

  try { unlinkSync(asidePath); } catch { /* best effort */ }
  return true;
}

/**
 * Remove `path` only if it still holds `token`. Rename-then-verify, for the
 * same reason as reclaim: a check-then-unlink could delete a lock that was
 * reclaimed and re-created between the check and the unlink.
 */
export function releaseLockFileIfOwned(path: string, token: string, tokenOf: (raw: string) => string | undefined): boolean {
  const raw = readRaw(path);
  if (raw === null || tokenOf(raw) !== token) return false;

  const asidePath = `${path}.release-${randomUUID()}`;
  try {
    renameSync(path, asidePath);
  } catch {
    return false;
  }
  const moved = readRaw(asidePath);
  if (moved === null || tokenOf(moved) !== token) {
    try { linkSync(asidePath, path); } catch { /* re-claimed meanwhile */ }
    try { unlinkSync(asidePath); } catch { /* best effort */ }
    return false;
  }
  try { unlinkSync(asidePath); } catch { /* best effort */ }
  return true;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- Leases ---

function safeKey(key: string): string {
  const cleaned = key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return cleaned || '_';
}

export function leasePath(dir: string, key: string): string {
  return join(dir, `${safeKey(key)}.lock`);
}

function parseLease(raw: string): LeasePayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LeasePayload>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.key !== 'string' || typeof parsed.owner !== 'string') return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    if (typeof parsed.refreshedAt !== 'string' || typeof parsed.ttlSeconds !== 'number') return null;
    return parsed as LeasePayload;
  } catch {
    return null;
  }
}

function tokenOfLease(raw: string): string | undefined {
  return parseLease(raw)?.token;
}

/** Strict reads propagate I/O errors so startup guards cannot mistake an unreadable lease for an absent one. */
export function readLease(dir: string, key: string, options: { strict?: boolean } = {}): LeasePayload | null {
  const raw = readRaw(leasePath(dir, key), options.strict);
  return raw === null ? null : parseLease(raw);
}

/**
 * A lease is stale when its owner (and its worker, if any) are dead, or it
 * has not been refreshed within its TTL. Pids can only be probed on this
 * host, so a lease from another hostname expires by TTL alone. A lease marked
 * `aliveOverridesTtl` whose owner is alive on this host is never stale.
 */
export function isLeaseStale(
  payload: LeasePayload,
  opts: { now?: Date; isPidAlive?: (pid: number) => boolean } = {},
): boolean {
  const now = opts.now ?? new Date();
  const isPidAlive = opts.isPidAlive ?? defaultPidAlive;
  const sameHost = !payload.hostname || payload.hostname === hostname();

  if (payload.aliveOverridesTtl === true && sameHost && isPidAlive(payload.pid)) return false;

  if (payload.ttlSeconds > 0) {
    const refreshed = Date.parse(payload.refreshedAt || payload.acquiredAt);
    if (!Number.isFinite(refreshed)) return true;
    if (now.getTime() - refreshed > payload.ttlSeconds * 1000) return true;
  }

  if (payload.hostname && payload.hostname !== hostname()) return false;
  if (isPidAlive(payload.pid)) return false;
  return payload.workerPid === undefined || !isPidAlive(payload.workerPid);
}

/**
 * Acquire `key` under `dir`. Returns null when a live owner holds it.
 * Unparseable and stale leases are reclaimed (see reclaimStaleLockFile).
 */
export function acquireLease(dir: string, key: string, opts: LeaseOptions): LeaseHandle | null {
  const path = leasePath(dir, key);
  const now = (opts.now ?? new Date()).toISOString();
  const payload: LeasePayload = {
    version: 1,
    key,
    owner: opts.owner,
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    acquiredAt: now,
    refreshedAt: now,
    ttlSeconds: opts.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    ...(opts.workerPid !== undefined ? { workerPid: opts.workerPid } : {}),
    ...(opts.aliveOverridesTtl ? { aliveOverridesTtl: true } : {}),
    ...(opts.meta ? { meta: opts.meta } : {}),
  };
  const content = JSON.stringify(payload, null, 2) + '\n';
  const handle = (): LeaseHandle => ({ path, token: payload.token, payload });

  mkdirSync(dir, { recursive: true });
  if (createLockFileSync(path, content)) return handle();

  const observed = readRaw(path);
  if (observed !== null) {
    const existing = parseLease(observed);
    if (existing && !isLeaseStale(existing, { now: opts.now, isPidAlive: opts.isPidAlive })) return null;
    if (!reclaimStaleLockFile(path, observed)) return null;
  }
  // Exactly one retry: if another reclaimer re-created it first, it is theirs.
  return createLockFileSync(path, content) ? handle() : null;
}

/**
 * Bump refreshedAt (and optionally workerPid/meta). Returns false when the
 * lease file no longer carries our token — the lease was lost.
 */
export function refreshLease(
  handle: LeaseHandle,
  patch: { workerPid?: number; meta?: Record<string, unknown>; now?: Date } = {},
): boolean {
  const raw = readRaw(handle.path);
  const current = raw === null ? null : parseLease(raw);
  if (!current || current.token !== handle.token) return false;

  const next: LeasePayload = {
    ...current,
    refreshedAt: (patch.now ?? new Date()).toISOString(),
    ...(patch.workerPid !== undefined ? { workerPid: patch.workerPid } : {}),
    ...(patch.meta !== undefined ? { meta: patch.meta } : {}),
  };
  const tmpPath = `${handle.path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmpPath, handle.path);
  } catch {
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    return false;
  }
  handle.payload = next;
  return true;
}

/** Release a lease we hold. Never removes a lease someone else re-acquired. */
export function releaseLease(handle: LeaseHandle): boolean {
  return releaseLockFileIfOwned(handle.path, handle.token, tokenOfLease);
}

/** Every parseable lease in `dir` (missing dir → []). */
export function listLeases(dir: string): LeasePayload[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const leases: LeasePayload[] = [];
  for (const name of names.sort()) {
    // Skip temp, aside, and release files: only `<key>.lock` is a lease.
    if (!name.endsWith('.lock') || name.includes('.lock.')) continue;
    const raw = readRaw(join(dir, name));
    const parsed = raw === null ? null : parseLease(raw);
    if (parsed) leases.push(parsed);
  }
  return leases;
}

// --- Short cross-process mutex ---

/**
 * Repo-wide lock serializing git commands that mutate the shared `.git`
 * directory (fetch, worktree add/remove/prune, branch -D, push --delete), so
 * parallel workers don't collide on git's ref and index lock files.
 */
export function gitLockPath(projectDir: string): string {
  return join(projectDir, '.alpha-loop', 'locks', 'git.lock');
}

function parseFileLock(raw: string): FileLockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FileLockPayload>;
    if (parsed.version !== 1 || typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    if (typeof parsed.acquiredAt !== 'string') return null;
    return parsed as FileLockPayload;
  } catch {
    return null;
  }
}

function fileLockIsStale(
  raw: string,
  path: string,
  nowMs: number,
  staleMs: number,
  isPidAlive: (pid: number) => boolean,
): boolean {
  const lock = parseFileLock(raw);
  if (!lock) {
    // Our own locks are never half-written; an unparseable one is foreign
    // or corrupt. Only reclaim it once it has sat untouched for staleMs.
    try {
      return nowMs - lstatSync(path).mtimeMs > staleMs;
    } catch {
      return true;
    }
  }
  const acquired = Date.parse(lock.acquiredAt);
  if (!Number.isFinite(acquired) || nowMs - acquired > staleMs) return true;
  return lock.hostname === hostname() && !isPidAlive(lock.pid);
}

/** Locks this process currently holds, for re-entrancy (nested calls on one path). */
const heldFileLocks = new Map<string, number>();

/**
 * Run `fn` while holding the cross-process lock at `lockPath`. Waits with a
 * synchronous sleep (never a busy loop) while another live process holds it,
 * reclaims locks older than staleMs or whose pid is dead, and always releases
 * in finally. Re-entrant within one process. Throws after timeoutMs.
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const depth = heldFileLocks.get(lockPath) ?? 0;
  if (depth > 0) {
    heldFileLocks.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      heldFileLocks.set(lockPath, depth);
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = opts.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const sleep = opts.sleep ?? sleepSync;
  const clock = opts.now ?? Date.now;
  const isPidAlive = opts.isPidAlive ?? defaultPidAlive;

  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = clock();
  const token = randomUUID();

  for (;;) {
    const payload: FileLockPayload = {
      version: 1,
      pid: process.pid,
      hostname: hostname(),
      token,
      acquiredAt: new Date(clock()).toISOString(),
    };
    if (createLockFileSync(lockPath, JSON.stringify(payload) + '\n')) break;

    // null: released between our create and read, or unreadable (e.g. a
    // directory) — either way just wait a poll and try again.
    const observed = readRaw(lockPath);
    if (observed !== null
      && fileLockIsStale(observed, lockPath, clock(), staleMs, isPidAlive)
      && reclaimStaleLockFile(lockPath, observed)) {
      continue;
    }

    if (clock() - startedAt >= timeoutMs) {
      const holder = observed === null ? null : parseFileLock(observed);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for lock ${lockPath}`
        + (holder ? ` (held by pid ${holder.pid} on ${holder.hostname} since ${holder.acquiredAt})` : ''),
      );
    }
    sleep(pollMs);
  }

  heldFileLocks.set(lockPath, 1);
  try {
    return fn();
  } finally {
    heldFileLocks.delete(lockPath);
    releaseLockFileIfOwned(lockPath, token, (raw) => parseFileLock(raw)?.token);
  }
}
