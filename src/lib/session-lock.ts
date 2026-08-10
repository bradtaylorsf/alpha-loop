/**
 * Session Lock — guards a session directory against concurrent runs.
 *
 * Session names are deterministic per epic/milestone (e.g. session/epic-42-slug),
 * so two concurrently started runs of the same target would share the same
 * manifest, logs dir, and session branch and silently clobber each other. The
 * lock is a file next to the manifest recording the owning process; a second
 * run fails fast unless that process is no longer alive.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

export type SessionLockPayload = {
  version: 1;
  sessionName: string;
  pid: number;
  hostname: string;
  cwd: string;
  startedAt: string;
  token: string;
};

export type SessionLockHandle = {
  path: string;
  token: string;
  payload: SessionLockPayload;
};

export class SessionLockError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'SessionLockError';
    this.path = path;
  }
}

export function sessionLockPath(sessionDir: string): string {
  return join(sessionDir, 'session.lock');
}

function parseLock(raw: string): SessionLockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionLockPayload>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    if (typeof parsed.sessionName !== 'string' || typeof parsed.startedAt !== 'string') return null;
    return parsed as SessionLockPayload;
  } catch {
    return null;
  }
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export type AcquireSessionLockOptions = {
  now?: Date;
  isPidAlive?: (pid: number) => boolean;
  cwd?: string;
};

/**
 * Acquire the lock for one session directory, or throw SessionLockError if a
 * live process already holds it. Unparseable locks and locks whose recorded
 * process is dead are reclaimed.
 */
export function acquireSessionLock(
  sessionDir: string,
  sessionName: string,
  options: AcquireSessionLockOptions = {},
): SessionLockHandle {
  const lockPath = sessionLockPath(sessionDir);
  const now = options.now ?? new Date();
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;
  const payload: SessionLockPayload = {
    version: 1,
    sessionName,
    pid: process.pid,
    hostname: hostname(),
    cwd: options.cwd ?? process.cwd(),
    startedAt: now.toISOString(),
    token: randomUUID(),
  };

  mkdirSync(sessionDir, { recursive: true });
  try {
    writeFileSync(lockPath, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
    return { path: lockPath, token: payload.token, payload };
  } catch {
    let existing: SessionLockPayload | null = null;
    try {
      existing = parseLock(readFileSync(lockPath, 'utf-8'));
    } catch {
      existing = null;
    }

    if (!existing || !isPidAlive(existing.pid)) {
      try { unlinkSync(lockPath); } catch { /* best effort */ }
      try {
        writeFileSync(lockPath, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
        return { path: lockPath, token: payload.token, payload };
      } catch {
        // Lost the reclaim race to another process, or the stale lock cannot
        // be replaced — keep the "handle or SessionLockError" contract.
        throw new SessionLockError(
          lockPath,
          `Could not reclaim the stale lock for session ${sessionName} — another alpha-loop run `
          + `may have just acquired it. Retry, or inspect the lock file: ${lockPath}`,
        );
      }
    }

    throw new SessionLockError(
      lockPath,
      `Another alpha-loop run (pid ${existing.pid} on ${existing.hostname || 'unknown host'}, started ${existing.startedAt}) `
      + `is already processing session ${existing.sessionName}. Wait for it to finish, `
      + `or delete the lock file if that process is gone: ${lockPath}`,
    );
  }
}

/**
 * Release a held lock. Returns false if the lock file is missing or was
 * taken over by another process (token mismatch) — never throws.
 */
export function releaseSessionLock(lock: SessionLockHandle | null | undefined): boolean {
  if (!lock) return false;
  try {
    const current = parseLock(readFileSync(lock.path, 'utf-8'));
    if (current?.token !== lock.token) return false;
    unlinkSync(lock.path);
    return true;
  } catch {
    return false;
  }
}
