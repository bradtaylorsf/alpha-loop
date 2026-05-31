import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  acquireDaemonLock,
  createDaemonScheduler,
  daemonLockPath,
  enabledDaemonTickKinds,
  refreshDaemonLock,
  releaseDaemonLock,
  runDaemonLoop,
  runDaemonTick,
  type DaemonActions,
} from '../../src/lib/daemon.js';
import { DEFAULT_DAEMON_CONFIG, type Config, type DaemonConfig } from '../../src/lib/config.js';
import { sessionManifestPath, type DurableSessionManifest } from '../../src/lib/session.js';

function makeDaemon(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    ...DEFAULT_DAEMON_CONFIG,
    ...overrides,
    lock: {
      ...DEFAULT_DAEMON_CONFIG.lock,
      ...(overrides.lock ?? {}),
    },
  };
}

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
    skipLearn: false,
    skipE2e: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    autoMerge: true,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    verbose: false,
    harnesses: [],
    setupCommand: '',
    evalDir: '.alpha-loop/evals',
    evalModel: '',
    skipEval: false,
    evalTimeout: 300,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    sessionRetention: { pausedWorktreeDays: 0, completedWorktreeDays: 30 },
    events: { includePromptText: false, redact: [], destinations: {} },
    automationPolicy: {
      requireLabels: [],
      blockLabels: ['do-not-automate', 'needs-human-input'],
      allowedPaths: [],
      protectedPaths: [],
      allowedCommands: [],
      requireHumanFor: [],
      maxActiveSessions: 1,
      maxPausedSessions: 10,
      maxIssuesPerSession: 0,
      maxSessionMinutes: 0,
      maxSessionCostUsd: 0,
      maxIssueCostUsd: 0,
    },
    preferEpics: false,
    daemon: makeDaemon(),
    ...overrides,
  };
}

function makeManifest(overrides: Partial<DurableSessionManifest> = {}): DurableSessionManifest {
  const now = '2026-05-30T12:00:00.000Z';
  return {
    version: 1,
    sessionId: 'session-waiting',
    name: 'session/waiting',
    issueNumber: 1,
    issueNumbers: [1],
    parentEpicNumber: null,
    branch: 'session/waiting',
    baseBranch: 'master',
    prUrl: null,
    sessionPrUrl: null,
    status: 'human_input_requested',
    stage: 'human_input_requested',
    labels: ['ready'],
    feedback: {
      currentStatus: 'human_input_requested',
      question: 'Which CTA?',
      resumeInstructions: 'Reply with the selected CTA.',
      qaChecklist: [],
      prUrl: null,
      previewUrl: null,
      classification: null,
      followUpIssueNumber: null,
      followUpIssueUrl: null,
      transitionHistory: [],
      events: [],
      updatedAt: now,
    },
    harness: {
      agent: 'claude',
      model: 'opus',
      reviewModel: 'opus',
      command: 'claude',
      testCommand: 'pnpm test',
    },
    command: 'claude',
    worktree: null,
    lastKnownBranch: 'session/waiting',
    currentIssue: { issueNum: 1, title: 'Waiting issue' },
    issues: [{ issueNum: 1, title: 'Waiting issue', status: 'human_input_requested', stage: 'human_input_requested' }],
    prompts: [],
    promptPath: null,
    promptHash: null,
    transcripts: [],
    transcriptPath: null,
    logs: {
      sessionDir: '.alpha-loop/sessions/session/waiting',
      logsDir: '.alpha-loop/sessions/session/waiting/logs',
      traceDir: '.alpha-loop/traces/session-waiting',
      files: [],
    },
    screenshots: [],
    previewUrl: null,
    timestamps: {
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    },
    lastEventId: null,
    policyDecisions: [],
    errors: [],
    ...overrides,
  };
}

function writeManifest(root: string, manifest: DurableSessionManifest): string {
  const dir = join(root, '.alpha-loop', 'sessions', manifest.name);
  const path = sessionManifestPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
  return path;
}

function makeActions(overrides: Partial<DaemonActions> = {}): DaemonActions {
  return {
    triage: jest.fn().mockResolvedValue(undefined),
    pollFeedback: jest.fn().mockResolvedValue({ status: 'processed', processed: 0 }),
    pollIssues: jest.fn().mockReturnValue([]),
    runIssue: jest.fn().mockResolvedValue({ status: 'success', issueNumber: 1 }),
    resumeIssue: jest.fn().mockResolvedValue(false),
    emitEvent: jest.fn().mockResolvedValue({ event: {}, deliveries: [] }),
    ...overrides,
  };
}

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-daemon-'));
  process.chdir(tempDir);
});

afterEach(() => {
  jest.useRealTimers();
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('daemon mode selection', () => {
  it('enables the expected ticks for each daemon mode', () => {
    expect(enabledDaemonTickKinds('triage-only')).toEqual(['triage', 'health']);
    expect(enabledDaemonTickKinds('feedback-only')).toEqual(['feedback', 'resume', 'health']);
    expect(enabledDaemonTickKinds('run-only')).toEqual(['run', 'health']);
    expect(enabledDaemonTickKinds('full')).toEqual(['triage', 'feedback', 'resume', 'run', 'health']);
  });
});

describe('daemon locking', () => {
  it('prevents a second live daemon from acquiring the same repo lock', () => {
    const daemon = makeDaemon({ lock: { ...DEFAULT_DAEMON_CONFIG.lock, path: join(tempDir, '.alpha-loop', 'daemon.lock') } });
    const config = makeConfig({ daemon });
    const lock = acquireDaemonLock(config, daemon, {
      now: new Date('2026-05-30T12:00:00.000Z'),
      isPidAlive: () => true,
    });

    expect(() => acquireDaemonLock(config, daemon, {
      now: new Date('2026-05-30T12:00:01.000Z'),
      isPidAlive: () => true,
    })).toThrow(/already running/);

    expect(releaseDaemonLock(lock)).toBe(true);
    expect(existsSync(daemonLockPath(daemon))).toBe(false);
  });

  it('replaces stale repo locks before starting', () => {
    const daemon = makeDaemon({ lock: { ...DEFAULT_DAEMON_CONFIG.lock, path: join(tempDir, '.alpha-loop', 'daemon.lock') } });
    const lockPath = daemonLockPath(daemon);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      version: 1,
      repo: 'owner/repo',
      cwd: tempDir,
      pid: 999999,
      hostname: 'host',
      startedAt: '2026-05-29T12:00:00.000Z',
      updatedAt: '2026-05-29T12:00:00.000Z',
      token: 'stale',
    }, null, 2) + '\n');

    const lock = acquireDaemonLock(makeConfig({ daemon }), daemon, {
      now: new Date('2026-05-30T12:00:00.000Z'),
      isPidAlive: () => false,
    });

    expect(lock.token).not.toBe('stale');
    expect(JSON.parse(readFileSync(lockPath, 'utf-8')).token).toBe(lock.token);
  });

  it('refreshes held repo locks so active daemons are not treated as stale', () => {
    const daemon = makeDaemon({ lock: { ...DEFAULT_DAEMON_CONFIG.lock, path: join(tempDir, '.alpha-loop', 'daemon.lock') } });
    const config = makeConfig({ daemon });
    const lock = acquireDaemonLock(config, daemon, {
      now: new Date('2026-05-30T12:00:00.000Z'),
      isPidAlive: () => true,
    });

    expect(refreshDaemonLock(lock, new Date('2026-05-30T12:05:00.000Z'))).toBe(true);

    const payload = JSON.parse(readFileSync(daemonLockPath(daemon), 'utf-8'));
    expect(payload.token).toBe(lock.token);
    expect(payload.updatedAt).toBe('2026-05-30T12:05:00.000Z');
  });
});

describe('daemon scheduling', () => {
  it('waits for configured intervals using fake timers', async () => {
    jest.useFakeTimers();
    let nowMs = 0;
    const daemon = makeDaemon({
      mode: 'triage-only',
      triageIntervalSeconds: 10,
      healthIntervalSeconds: 100,
      idleSleepSeconds: 1,
      lock: { ...DEFAULT_DAEMON_CONFIG.lock, enabled: false },
    });
    const config = makeConfig({ daemon });
    const scheduler = createDaemonScheduler(daemon, nowMs, { markEnabledTicksRun: true });
    const actions = makeActions();

    const promise = runDaemonLoop(config, daemon, actions, {
      maxTicks: 1,
      now: () => new Date(nowMs),
      nowMs: () => nowMs,
      scheduler,
      acquireLock: false,
      installSignalHandlers: false,
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(actions.triage).not.toHaveBeenCalled();
    expect(actions.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'daemon.idle' }));

    nowMs = 10_000;
    await jest.advanceTimersByTimeAsync(1000);
    await promise;

    expect(actions.triage).toHaveBeenCalledTimes(1);
  });
});

describe('daemon manifest behavior', () => {
  it('skips a waiting issue and runs the next eligible ready issue', async () => {
    writeManifest(tempDir, makeManifest());
    const daemon = makeDaemon({ mode: 'run-only' });
    const config = makeConfig({ daemon });
    const actions = makeActions({
      pollIssues: jest.fn().mockReturnValue([
        { number: 1, title: 'Waiting issue', body: 'Body', labels: ['ready'] },
        { number: 2, title: 'Eligible issue', body: 'Body', labels: ['ready'] },
      ]),
    });

    await runDaemonTick(config, daemon, 'run', actions);

    expect(actions.runIssue).toHaveBeenCalledTimes(1);
    expect(actions.runIssue).toHaveBeenCalledWith(config, expect.objectContaining({ number: 2 }));
    expect(actions.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'daemon.work.skipped',
      context: expect.objectContaining({
        metadata: expect.objectContaining({ issueNumber: 1 }),
      }),
    }));
    expect(actions.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'daemon.work.selected',
      context: expect.objectContaining({
        metadata: expect.objectContaining({ issueNumber: 2 }),
      }),
    }));
  });

  it('recovers resume-requested sessions from durable manifests', async () => {
    writeManifest(tempDir, makeManifest({
      sessionId: 'session-resume',
      name: 'session/resume',
      issueNumber: 5,
      issueNumbers: [5],
      status: 'resume_requested',
      stage: 'resume_requested',
      feedback: {
        ...makeManifest().feedback,
        currentStatus: 'resume_requested',
      },
      currentIssue: { issueNum: 5, title: 'Resume issue' },
      issues: [{ issueNum: 5, title: 'Resume issue', status: 'resume_requested', stage: 'resume_requested' }],
    }));
    const daemon = makeDaemon({ mode: 'feedback-only' });
    const config = makeConfig({ daemon });
    const actions = makeActions({
      resumeIssue: jest.fn().mockResolvedValue(true),
    });

    await runDaemonTick(config, daemon, 'resume', actions);

    expect(actions.resumeIssue).toHaveBeenCalledWith(config, 5, expect.arrayContaining(['resume_requested']));
    expect(actions.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'daemon.resume.requested',
    }));
  });

  it('checks automation policy before resuming a manifest session', async () => {
    writeManifest(tempDir, makeManifest({
      sessionId: 'session-blocked-resume',
      name: 'session/blocked-resume',
      issueNumber: 6,
      issueNumbers: [6],
      status: 'resume_requested',
      stage: 'resume_requested',
      feedback: {
        ...makeManifest().feedback,
        currentStatus: 'resume_requested',
      },
      currentIssue: { issueNum: 6, title: 'Blocked resume' },
      issues: [{ issueNum: 6, title: 'Blocked resume', status: 'resume_requested', stage: 'resume_requested' }],
    }));
    const daemon = makeDaemon({ mode: 'feedback-only' });
    const config = makeConfig({ daemon });
    const actions = makeActions({
      getIssue: jest.fn().mockReturnValue({ number: 6, title: 'Blocked resume', body: '', labels: ['ready', 'do-not-automate'] }),
      resumeIssue: jest.fn().mockResolvedValue(true),
    });

    await runDaemonTick(config, daemon, 'resume', actions);

    expect(actions.resumeIssue).not.toHaveBeenCalled();
    expect(actions.emitEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'daemon.work.skipped',
      context: expect.objectContaining({
        metadata: expect.objectContaining({
          issueNumber: 6,
          reason: expect.stringContaining('blocked label'),
        }),
      }),
    }));
  });
});

describe('daemon graceful shutdown', () => {
  it('records stopped state and releases the repo lock without mutating paused manifests', async () => {
    const manifestPath = writeManifest(tempDir, makeManifest());
    const before = readFileSync(manifestPath, 'utf-8');
    const daemon = makeDaemon({
      mode: 'run-only',
      lock: { ...DEFAULT_DAEMON_CONFIG.lock, enabled: true, path: join(tempDir, '.alpha-loop', 'daemon.lock') },
    });
    const config = makeConfig({ daemon });
    const actions = makeActions();

    const result = await runDaemonLoop(config, daemon, actions, {
      maxTicks: 1,
      installSignalHandlers: false,
    });

    expect(result.ticksRun).toBe(1);
    expect(existsSync(daemonLockPath(daemon))).toBe(false);
    const state = JSON.parse(readFileSync(join(tempDir, '.alpha-loop', 'daemon-state.json'), 'utf-8'));
    expect(state.status).toBe('stopped');
    expect(readFileSync(manifestPath, 'utf-8')).toBe(before);
  });
});
