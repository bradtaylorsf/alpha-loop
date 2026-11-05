import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLease,
  gitLockPath,
  isLeaseStale,
  leasePath,
  listLeases,
  readLease,
  reclaimStaleLockFile,
  refreshLease,
  releaseLease,
  withFileLockSync,
  type LeasePayload,
} from '../../src/lib/lease.js';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const alive = (): boolean => true;
const dead = (): boolean => false;

function payload(overrides: Partial<LeasePayload> = {}): LeasePayload {
  return {
    version: 1,
    key: 'issue-7',
    owner: 'factory',
    pid: 4242,
    hostname: hostname(),
    token: 'tok',
    acquiredAt: NOW.toISOString(),
    refreshedAt: NOW.toISOString(),
    ttlSeconds: 3600,
    ...overrides,
  };
}

function writeLeaseFile(dir: string, key: string, data: LeasePayload | string): string {
  mkdirSync(dir, { recursive: true });
  const path = leasePath(dir, key);
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
  return path;
}

describe('lease', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alpha-loop-lease-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('leasePath sanitizes keys into one file per key', () => {
    expect(leasePath('/x/leases', 'issue-12')).toBe('/x/leases/issue-12.lock');
    expect(leasePath('/x', 'a/../b c')).toBe('/x/a_.._b_c.lock');
    expect(leasePath('/x', '..')).toBe('/x/_.lock');
  });

  test('acquire creates the lease file with owner, pid, token, and options', () => {
    const handle = acquireLease(dir, 'issue-7', {
      owner: 'factory', ttlSeconds: 60, workerPid: 99, meta: { title: 'x' }, now: NOW,
    });

    expect(handle).not.toBeNull();
    expect(handle!.path).toBe(leasePath(dir, 'issue-7'));
    expect(readLease(dir, 'issue-7')).toEqual({
      version: 1,
      key: 'issue-7',
      owner: 'factory',
      pid: process.pid,
      hostname: hostname(),
      token: handle!.token,
      acquiredAt: NOW.toISOString(),
      refreshedAt: NOW.toISOString(),
      ttlSeconds: 60,
      workerPid: 99,
      meta: { title: 'x' },
    });
    // No temp files left behind by the link-based create.
    expect(readdirSync(dir)).toEqual(['issue-7.lock']);
  });

  test('acquire returns null while a live owner holds the key', () => {
    const first = acquireLease(dir, 'issue-7', { owner: 'a', now: NOW });
    const second = acquireLease(dir, 'issue-7', { owner: 'b', now: NOW, isPidAlive: alive });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(readLease(dir, 'issue-7')?.token).toBe(first!.token);
  });

  test('a lease whose owner pid is dead is reclaimed', () => {
    writeLeaseFile(dir, 'issue-7', payload({ token: 'old' }));

    const handle = acquireLease(dir, 'issue-7', { owner: 'b', now: NOW, isPidAlive: dead });

    expect(handle).not.toBeNull();
    expect(readLease(dir, 'issue-7')?.token).toBe(handle!.token);
    expect(readdirSync(dir)).toEqual(['issue-7.lock']);
  });

  test('a dead owner with a live worker pid keeps the lease', () => {
    writeLeaseFile(dir, 'issue-7', payload({ pid: 1, workerPid: 2 }));

    const handle = acquireLease(dir, 'issue-7', { owner: 'b', now: NOW, isPidAlive: (pid) => pid === 2 });

    expect(handle).toBeNull();
  });

  test('a lease not refreshed within its TTL is reclaimed even if the pid is alive', () => {
    writeLeaseFile(dir, 'issue-7', payload({ refreshedAt: '2026-11-04T10:00:00.000Z', ttlSeconds: 60 }));

    const handle = acquireLease(dir, 'issue-7', { owner: 'b', now: NOW, isPidAlive: alive });

    expect(handle).not.toBeNull();
  });

  test('an unparseable lease file is reclaimed', () => {
    writeLeaseFile(dir, 'issue-7', 'not json\n');

    expect(readLease(dir, 'issue-7')).toBeNull();
    expect(acquireLease(dir, 'issue-7', { owner: 'b', now: NOW })).not.toBeNull();
  });

  test('a directory at the lease path is never moved aside', () => {
    mkdirSync(leasePath(dir, 'issue-7'), { recursive: true });

    expect(acquireLease(dir, 'issue-7', { owner: 'b', now: NOW, isPidAlive: dead })).toBeNull();
    expect(existsSync(leasePath(dir, 'issue-7'))).toBe(true);
  });

  describe('isLeaseStale', () => {
    it('aliveOverridesTtl: a live owner on this host never expires by TTL (regression)', () => {
      const old = payload({ refreshedAt: '2026-11-04T10:00:00.000Z', ttlSeconds: 300, aliveOverridesTtl: true });
      expect(isLeaseStale(old, { now: NOW, isPidAlive: alive })).toBe(false);
      expect(isLeaseStale(old, { now: NOW, isPidAlive: dead })).toBe(true);
      expect(isLeaseStale({ ...old, hostname: 'elsewhere' }, { now: NOW, isPidAlive: alive })).toBe(true);
    });

    test('live pid on this host within TTL is fresh', () => {
      expect(isLeaseStale(payload(), { now: NOW, isPidAlive: alive })).toBe(false);
    });

    test('dead pid and no worker is stale', () => {
      expect(isLeaseStale(payload(), { now: NOW, isPidAlive: dead })).toBe(true);
    });

    test('dead pid and dead worker is stale; live worker is fresh', () => {
      expect(isLeaseStale(payload({ workerPid: 5 }), { now: NOW, isPidAlive: dead })).toBe(true);
      expect(isLeaseStale(payload({ workerPid: 5 }), { now: NOW, isPidAlive: (p) => p === 5 })).toBe(false);
    });

    test('another hostname is judged by TTL only', () => {
      const remote = payload({ hostname: 'some-other-host' });
      expect(isLeaseStale(remote, { now: NOW, isPidAlive: dead })).toBe(false);
      expect(isLeaseStale({ ...remote, refreshedAt: '2026-11-04T10:00:00.000Z' }, { now: NOW, isPidAlive: dead })).toBe(true);
    });

    test('TTL expiry applies even with a live pid; ttlSeconds <= 0 disables it', () => {
      const old = payload({ refreshedAt: '2026-11-01T00:00:00.000Z' });
      expect(isLeaseStale(old, { now: NOW, isPidAlive: alive })).toBe(true);
      expect(isLeaseStale({ ...old, ttlSeconds: 0 }, { now: NOW, isPidAlive: alive })).toBe(false);
    });

    test('an unparseable refreshedAt is stale', () => {
      expect(isLeaseStale(payload({ refreshedAt: 'garbage', acquiredAt: 'garbage' }), { now: NOW, isPidAlive: alive })).toBe(true);
    });
  });

  describe('reclaim race', () => {
    test('a second reclaimer that judged the same stale file does not destroy the winner\'s fresh lease', () => {
      const path = writeLeaseFile(dir, 'issue-7', payload({ token: 'stale' }));
      // Both reclaimers read the same stale content...
      const observedByBoth = readFileSync(path, 'utf-8');

      // ...reclaimer A wins: moves the stale file aside and creates its lease.
      expect(reclaimStaleLockFile(path, observedByBoth)).toBe(true);
      const winner = acquireLease(dir, 'issue-7', { owner: 'a', now: NOW });
      expect(winner).not.toBeNull();

      // Reclaimer B now acts on its outdated observation. It must notice it
      // moved a different file and put the winner's lease back.
      expect(reclaimStaleLockFile(path, observedByBoth)).toBe(false);
      expect(readLease(dir, 'issue-7')?.token).toBe(winner!.token);
      expect(readdirSync(dir)).toEqual(['issue-7.lock']);
      expect(releaseLease(winner!)).toBe(true);
    });

    test('a reclaimer that loses the rename treats the path as free', () => {
      const path = join(dir, 'gone.lock');
      expect(reclaimStaleLockFile(path, 'whatever')).toBe(true);
    });

    test('only one of two acquirers wins a stale lease', () => {
      writeLeaseFile(dir, 'issue-7', payload({ token: 'stale' }));

      const a = acquireLease(dir, 'issue-7', { owner: 'a', now: NOW, isPidAlive: (pid) => pid !== 4242 });
      const b = acquireLease(dir, 'issue-7', { owner: 'b', now: NOW, isPidAlive: (pid) => pid !== 4242 });

      expect(a).not.toBeNull();
      expect(b).toBeNull();
      expect(readLease(dir, 'issue-7')?.token).toBe(a!.token);
    });
  });

  test('refresh bumps refreshedAt and patches worker pid/meta while the token is ours', () => {
    const handle = acquireLease(dir, 'issue-7', { owner: 'a', now: NOW })!;
    const later = new Date('2026-11-04T12:30:00.000Z');

    expect(refreshLease(handle, { workerPid: 321, meta: { stage: 'build' }, now: later })).toBe(true);

    const current = readLease(dir, 'issue-7');
    expect(current).toMatchObject({ refreshedAt: later.toISOString(), workerPid: 321, meta: { stage: 'build' }, acquiredAt: NOW.toISOString() });
    expect(handle.payload.refreshedAt).toBe(later.toISOString());
    expect(readdirSync(dir)).toEqual(['issue-7.lock']);
  });

  test('refresh and release fail once the lease was taken over', () => {
    const lost = acquireLease(dir, 'issue-7', { owner: 'a', now: NOW })!;
    const taker = acquireLease(dir, 'issue-7', { owner: 'b', now: NOW, isPidAlive: dead })!;

    expect(taker).not.toBeNull();
    expect(refreshLease(lost)).toBe(false);
    expect(releaseLease(lost)).toBe(false);
    expect(readLease(dir, 'issue-7')?.token).toBe(taker.token);
    expect(releaseLease(taker)).toBe(true);
    expect(existsSync(taker.path)).toBe(false);
  });

  test('release is token-checked and tolerates a missing file', () => {
    const handle = acquireLease(dir, 'issue-7', { owner: 'a', now: NOW })!;
    rmSync(handle.path);

    expect(releaseLease(handle)).toBe(false);
    expect(refreshLease(handle)).toBe(false);
  });

  test('listLeases returns parseable leases and ignores temp/aside files', () => {
    acquireLease(dir, 'issue-1', { owner: 'a', now: NOW });
    acquireLease(dir, 'issue-2', { owner: 'a', now: NOW });
    writeFileSync(join(dir, 'broken.lock'), '{');
    writeFileSync(join(dir, 'issue-3.lock.stale-abc'), JSON.stringify(payload({ key: 'issue-3' })));
    writeFileSync(join(dir, 'notes.txt'), 'hi');

    expect(listLeases(dir).map((l) => l.key)).toEqual(['issue-1', 'issue-2']);
    expect(listLeases(join(dir, 'missing'))).toEqual([]);
  });
});

describe('withFileLockSync', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alpha-loop-file-lock-'));
    lockPath = join(dir, 'locks', 'git.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function holdLock(overrides: Record<string, unknown> = {}): void {
    mkdirSync(join(dir, 'locks'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      version: 1, pid: 4242, hostname: hostname(), token: 'other', acquiredAt: new Date().toISOString(), ...overrides,
    }));
  }

  test('gitLockPath points at the repo-wide lock under .alpha-loop/locks', () => {
    expect(gitLockPath('/repo')).toBe('/repo/.alpha-loop/locks/git.lock');
  });

  test('runs fn while holding the lock and releases it afterwards', () => {
    const sleep = jest.fn();
    const result = withFileLockSync(lockPath, () => {
      expect(existsSync(lockPath)).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
      return 42;
    }, { sleep });

    expect(result).toBe(42);
    expect(sleep).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('releases the lock when fn throws', () => {
    expect(() => withFileLockSync(lockPath, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('waits (synchronous sleep, no busy loop) while another live process holds it', () => {
    holdLock();
    const events: string[] = [];
    const sleep = jest.fn((ms: number) => {
      events.push(`sleep:${ms}`);
      if (sleep.mock.calls.length === 2) rmSync(lockPath); // holder finishes
    });

    withFileLockSync(lockPath, () => { events.push('critical'); }, { sleep, pollMs: 50, isPidAlive: alive });

    expect(events).toEqual(['sleep:50', 'sleep:50', 'critical']);
    expect(existsSync(lockPath)).toBe(false);
  });

  test('is re-entrant within one process', () => {
    const sleep = jest.fn();
    const result = withFileLockSync(lockPath, () => withFileLockSync(lockPath, () => 'inner', { sleep }), { sleep });

    expect(result).toBe('inner');
    expect(sleep).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('reclaims a lock whose pid is dead on this host', () => {
    holdLock();
    const sleep = jest.fn();

    expect(withFileLockSync(lockPath, () => 'ran', { sleep, isPidAlive: dead })).toBe('ran');
    expect(sleep).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, 'locks'))).toEqual([]);
  });

  test('reclaims a lock older than staleMs even if its pid is alive', () => {
    holdLock({ acquiredAt: new Date(Date.now() - 60_000).toISOString() });

    expect(withFileLockSync(lockPath, () => 'ran', { staleMs: 1000, isPidAlive: alive, sleep: jest.fn() })).toBe('ran');
  });

  test('does not reclaim a live lock from another host until it is stale', () => {
    holdLock({ hostname: 'elsewhere' });
    let clock = 0;
    const sleep = jest.fn((ms: number) => { clock += ms; });

    expect(() => withFileLockSync(lockPath, () => 'never', {
      sleep, now: () => clock, timeoutMs: 1000, pollMs: 200, isPidAlive: dead,
    })).toThrow(/Timed out after 1000ms waiting for lock .*held by pid 4242 on elsewhere/);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).token).toBe('other');
  });
});
