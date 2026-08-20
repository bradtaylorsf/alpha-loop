import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSessionLock,
  releaseSessionLock,
  sessionLockPath,
  SessionLockError,
} from '../../src/lib/session-lock.js';

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn().mockReturnValue({ stdout: '', stderr: '', exitCode: 0 }),
  formatTimestamp: jest.fn().mockReturnValue('20260101-000000'),
}));

jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    step: jest.fn(),
    dry: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/lib/github', () => ({
  createPR: jest.fn(),
  updateProjectStatus: jest.fn(() => true),
}));

jest.mock('../../src/lib/learning', () => ({
  repairSessionLearningArtifacts: jest.fn(),
  repairSessionSummaryArtifact: jest.fn(),
}));

import { createSession } from '../../src/lib/session.js';
import type { Config } from '../../src/lib/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 0,
    agent: 'claude',
    model: 'opus',
    reviewModel: 'opus',
    pollInterval: 60,
    dryRun: false,
    baseBranch: 'master',
    logDir: 'logs',
    labelReady: 'ready',
    maxTestRetries: 3,
    testCommand: 'pnpm test',
    devCommand: 'pnpm dev',
    skipTests: false,
    skipReview: false,
    skipInstall: false,
    skipPreflight: false,
    skipVerify: false,
    skipQa: false,
    skipLearn: false,
    skipE2e: false,
    autoMerge: false,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    verbose: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    harnesses: [],
    setupCommand: '',
    evalDir: '.alpha-loop/evals',
    evalModel: '',
    skipEval: false,
    evalTimeout: 300,
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    sessionRetention: { pausedWorktreeDays: 0, completedWorktreeDays: 30 },
    preferEpics: false,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    quick: false,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    ...overrides,
  } as Config;
}

describe('session lock', () => {
  let tempDir: string;
  let sessionDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-session-lock-'));
    sessionDir = join(tempDir, 'sessions', 'session', 'epic-591-support');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('acquire writes a lock file recording the owning process', () => {
    const lock = acquireSessionLock(sessionDir, 'session/epic-591-support');

    expect(lock.path).toBe(sessionLockPath(sessionDir));
    expect(existsSync(lock.path)).toBe(true);
    const written = JSON.parse(readFileSync(lock.path, 'utf-8'));
    expect(written).toMatchObject({
      version: 1,
      sessionName: 'session/epic-591-support',
      pid: process.pid,
      token: lock.token,
    });
  });

  test('second acquire fails fast while the owning process is alive', () => {
    acquireSessionLock(sessionDir, 'session/epic-591-support');

    let thrown: unknown;
    try {
      acquireSessionLock(sessionDir, 'session/epic-591-support');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SessionLockError);
    const lockError = thrown as SessionLockError;
    expect(lockError.path).toBe(sessionLockPath(sessionDir));
    expect(lockError.message).toContain(`pid ${process.pid}`);
    expect(lockError.message).toContain('session/epic-591-support');
    expect(lockError.message).toContain(sessionLockPath(sessionDir));
  });

  test('release removes the lock so the session can be acquired again', () => {
    const lock = acquireSessionLock(sessionDir, 'session/epic-591-support');

    expect(releaseSessionLock(lock)).toBe(true);
    expect(existsSync(lock.path)).toBe(false);
    expect(() => acquireSessionLock(sessionDir, 'session/epic-591-support')).not.toThrow();
  });

  test('a lock held by a dead process is reclaimed', () => {
    const stale = acquireSessionLock(sessionDir, 'session/epic-591-support');

    const lock = acquireSessionLock(sessionDir, 'session/epic-591-support', {
      isPidAlive: () => false,
    });

    expect(lock.token).not.toBe(stale.token);
    const written = JSON.parse(readFileSync(lock.path, 'utf-8'));
    expect(written.token).toBe(lock.token);
  });

  test('an unparseable lock file is reclaimed', () => {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionLockPath(sessionDir), 'not json\n');

    expect(() => acquireSessionLock(sessionDir, 'session/epic-591-support')).not.toThrow();
  });

  test('a stale lock that cannot be reclaimed still fails with SessionLockError', () => {
    // A directory at the lock path defeats both unlink and the wx re-create,
    // simulating losing the reclaim race — the error contract must hold.
    mkdirSync(sessionLockPath(sessionDir), { recursive: true });

    let thrown: unknown;
    try {
      acquireSessionLock(sessionDir, 'session/epic-591-support', { isPidAlive: () => false });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SessionLockError);
    expect((thrown as SessionLockError).message).toContain('Could not reclaim');
  });

  test('release refuses when the lock was taken over by another run', () => {
    const lock = acquireSessionLock(sessionDir, 'session/epic-591-support');
    const takenOver = acquireSessionLock(sessionDir, 'session/epic-591-support', {
      isPidAlive: () => false,
    });

    expect(releaseSessionLock(lock)).toBe(false);
    expect(existsSync(lock.path)).toBe(true);
    expect(releaseSessionLock(takenOver)).toBe(true);
  });

  test('release tolerates a missing lock file and null handles', () => {
    const lock = acquireSessionLock(sessionDir, 'session/epic-591-support');
    rmSync(lock.path);

    expect(releaseSessionLock(lock)).toBe(false);
    expect(releaseSessionLock(null)).toBe(false);
    expect(releaseSessionLock(undefined)).toBe(false);
  });
});

describe('createSession locking', () => {
  let tempDir: string;
  let previousCwd: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-create-session-lock-'));
    previousCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('a second run of the same epic session fails fast with a clear message', () => {
    const config = makeConfig();
    const first = createSession(config, { epicNum: 591, epicTitle: 'Support Hub' });

    expect(first.lock).toBeDefined();
    expect(existsSync(sessionLockPath(first.resultsDir))).toBe(true);

    let thrown: unknown;
    try {
      createSession(config, { epicNum: 591, epicTitle: 'Support Hub' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SessionLockError);
    expect((thrown as SessionLockError).message).toContain('session/epic-591-support-hub');
    expect((thrown as SessionLockError).message).toContain('delete the lock file');
  });

  test('after releasing the lock the same epic session can be created again', () => {
    const config = makeConfig();
    const first = createSession(config, { epicNum: 591, epicTitle: 'Support Hub' });

    expect(releaseSessionLock(first.lock)).toBe(true);

    const second = createSession(config, { epicNum: 591, epicTitle: 'Support Hub' });
    expect(second.lock).toBeDefined();
    expect(second.name).toBe(first.name);
  });

  test('a stale lock from a dead process does not block a new run', () => {
    const config = makeConfig();
    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', 'epic-591-support-hub');
    mkdirSync(sessionDir, { recursive: true });
    // pid 0 is never a live process, so this lock is always stale.
    writeFileSync(sessionLockPath(sessionDir), JSON.stringify({
      version: 1,
      sessionName: 'session/epic-591-support-hub',
      pid: 0,
      hostname: 'gone-host',
      cwd: sessionDir,
      startedAt: '2026-08-07T03:12:11.000Z',
      token: 'stale-token',
    }, null, 2) + '\n');

    const session = createSession(config, { epicNum: 591, epicTitle: 'Support Hub' });
    expect(session.lock).toBeDefined();
    expect(session.lock?.token).not.toBe('stale-token');
  });

  test('dry-run sessions do not take a lock', () => {
    const config = makeConfig({ dryRun: true });
    const session = createSession(config, { epicNum: 591, epicTitle: 'Support Hub' });

    expect(session.lock).toBeUndefined();
    expect(existsSync(sessionLockPath(session.resultsDir))).toBe(false);
  });
});
