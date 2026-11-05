jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(), success: jest.fn(), warn: jest.fn(), error: jest.fn(),
    step: jest.fn(), dry: jest.fn(), debug: jest.fn(), rate: jest.fn(),
  },
}));

// Guards: the supervisor must only reach GitHub / the shell through injected actions.
jest.mock('../../src/lib/github', () => ({
  pollIssues: jest.fn(() => { throw new Error('real pollIssues called'); }),
  getEpicSubIssues: jest.fn(() => { throw new Error('real getEpicSubIssues called'); }),
  commentIssue: jest.fn(() => { throw new Error('real commentIssue called'); }),
  labelIssue: jest.fn(() => { throw new Error('real labelIssue called'); }),
}));
jest.mock('../../src/lib/feedback', () => ({
  ingestFeedback: jest.fn(() => { throw new Error('real ingestFeedback called'); }),
}));
jest.mock('../../src/lib/rate-limit', () => ({
  ghExec: jest.fn(() => { throw new Error('real ghExec called'); }),
}));
jest.mock('../../src/lib/preflight', () => ({
  runPreflight: jest.fn(() => { throw new Error('real runPreflight called'); }),
}));

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DEFAULT_FACTORY_CONFIG, resolveFactoryPaths, type Config, type FactoryConfig, type FactoryPaths } from '../../src/lib/config.js';
import {
  answerEventId,
  applyIssueAnswer,
  createDefaultFactoryActions,
  resolveFactoryRun,
  runFactory,
  type FactoryActions,
  type FactoryMemory,
  type FactoryState,
  type FactoryRunOptions,
} from '../../src/lib/factory.js';
import { appendIdea, ensureInboxFile, readInbox, updateIdea } from '../../src/lib/factory-inbox.js';
import { answerQuestion, askQuestion, markQuestion, readQuestions, type FactoryQuestion } from '../../src/lib/factory-questions.js';
import type { ShipPr } from '../../src/lib/factory-ship.js';
import type { WorkerExit, WorkerHandle } from '../../src/lib/factory-workers.js';
import { acquireLease, listLeases, readLease } from '../../src/lib/lease.js';
import type { Issue } from '../../src/lib/github.js';
import { ingestFeedback } from '../../src/lib/feedback.js';
import { commentIssue, labelIssue } from '../../src/lib/github.js';
import { ghExec } from '../../src/lib/rate-limit.js';

const mockIngest = ingestFeedback as jest.Mock;
const mockComment = commentIssue as jest.Mock;
const mockLabel = labelIssue as jest.Mock;

const T0 = Date.parse('2026-11-05T10:00:00Z');
const TICK_MS = 30_000;

type FakeWorker = { handle: WorkerHandle; finish: (exit: WorkerExit) => void; kills: string[] };

function fakeWorker(
  id: string,
  role: 'developer' | 'pm',
  extra: { issue?: number; ideaId?: string },
  onKill?: (signal: string, finish: (exit: WorkerExit) => void) => void,
): FakeWorker {
  let finish!: (exit: WorkerExit) => void;
  const done = new Promise<WorkerExit>((resolve) => { finish = resolve; });
  const kills: string[] = [];
  const handle: WorkerHandle = {
    id,
    role,
    ...extra,
    pid: 900_000 + Math.floor(Math.random() * 1000),
    startedAt: new Date(T0).toISOString(),
    logPath: `/logs/${id}/worker.log`,
    resultPath: `/logs/${id}/result.json`,
    contextPath: `/logs/${id}/context.json`,
    done,
    kill: (signal = 'SIGTERM') => {
      kills.push(signal);
      onKill?.(signal, finish);
    },
  };
  return { handle, finish, kills };
}

function issue(n: number, opts: { labels?: string[]; body?: string; title?: string } = {}): Issue {
  return { number: n, title: opts.title ?? `Issue ${n}`, body: opts.body ?? '', labels: ['ready', ...(opts.labels ?? [])] };
}

function shipPr(n: number, over: Partial<ShipPr> = {}): ShipPr {
  return {
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/o/r/pull/${n}`,
    headRefName: `session/issue-${n}-x`,
    baseRefName: 'master',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    checks: 'success',
    failingChecks: [],
    createdAt: new Date(T0 - 60_000).toISOString(),
    closingIssues: [n * 10],
    ...over,
  };
}

type MockActions = { [K in keyof FactoryActions]: jest.Mock };

type Harness = {
  config: Config;
  paths: FactoryPaths;
  actions: MockActions;
  devs: FakeWorker[];
  pms: FakeWorker[];
  /** Hook run on each tick sleep (1-based count of tick sleeps). */
  onTick: (fn: (n: number) => void | Promise<void>) => void;
  clock: () => number;
  run: (options?: FactoryRunOptions) => ReturnType<typeof runFactory>;
  state: () => FactoryState;
  questions: () => FactoryQuestion[];
};

let root: string;

function harness(factory: Partial<Omit<FactoryConfig, 'pm' | 'ship'>> & { pm?: Partial<FactoryConfig['pm']>; ship?: Partial<FactoryConfig['ship']> } = {}): Harness {
  let clock = T0;
  let tickSleeps = 0;
  let tickHook: (n: number) => void | Promise<void> = () => {};
  const devs: FakeWorker[] = [];
  const pms: FakeWorker[] = [];
  const { pm, ship, ...rest } = factory;
  const factoryConfig: FactoryConfig = {
    ...DEFAULT_FACTORY_CONFIG,
    stateDir: join(root, 'factory'),
    spawnStaggerSeconds: 0,
    ...rest,
    pm: { ...DEFAULT_FACTORY_CONFIG.pm, ...(pm ?? {}) },
    ship: { ...DEFAULT_FACTORY_CONFIG.ship, ...(ship ?? {}) },
  };
  const config = {
    repo: 'o/r',
    labelReady: 'ready',
    baseBranch: 'master',
    testCommand: 'true',
    dryRun: false,
    factory: factoryConfig,
  } as unknown as Config;
  const paths = resolveFactoryPaths(config);

  const actions = {
    now: jest.fn(() => new Date(clock)),
    sleep: jest.fn(async (ms: number) => {
      clock += ms;
      if (ms === factoryConfig.tickSeconds * 1000) {
        tickSleeps += 1;
        await tickHook(tickSleeps);
      }
    }),
    pollReady: jest.fn((): Issue[] => []),
    isIssueClosed: jest.fn(() => true),
    getEpicChildren: jest.fn((): number[] => []),
    spawnDeveloper: jest.fn((req: { issue: number }) => {
      const w = fakeWorker(`dev-${req.issue}-${devs.length}`, 'developer', { issue: req.issue });
      devs.push(w);
      return w.handle;
    }),
    spawnPm: jest.fn((req: { idea: { id: string } }) => {
      const w = fakeWorker(`pm-${req.idea.id}-${pms.length}`, 'pm', { ideaId: req.idea.id });
      pms.push(w);
      return w.handle;
    }),
    listShippable: jest.fn((): ShipPr[] => []),
    merge: jest.fn(() => ({ merged: true })),
    applyAnswer: jest.fn(() => ({ applied: true, note: 'commented' })),
    preflight: jest.fn(async () => true),
    prepare: jest.fn(async () => {}),
    defaultBranch: jest.fn(() => 'master'),
    closeIssue: jest.fn(() => true),
  } as unknown as MockActions;

  return {
    config,
    paths,
    actions,
    devs,
    pms,
    onTick: (fn) => { tickHook = fn; },
    clock: () => clock,
    run: (options = {}) => runFactory(config, { handleSignals: false, ...options }, actions as unknown as FactoryActions),
    state: () => JSON.parse(readFileSync(paths.statePath, 'utf-8')) as FactoryState,
    questions: () => readQuestions(paths.questionsPath),
  };
}

/** Seed state.json memory: these PRs were finished by this factory's developers (so the shipper may act on them). */
function own(h: Harness, ...prs: number[]): void {
  mkdirSync(h.paths.stateDir, { recursive: true });
  const memory: FactoryMemory = {
    owned: prs.map((n) => ({ pr: n, url: `https://github.com/o/r/pull/${n}`, issue: n * 10 })),
    shipAsked: {},
    mergedIssues: [],
  };
  writeFileSync(h.paths.statePath, JSON.stringify({ memory }));
}

function successResult(n: number, prUrl = `https://github.com/o/r/pull/${n}`) {
  return { exitCode: 0, result: { issueNumber: n, status: 'success', failures: [], sessionPrUrl: prUrl } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-sup-'));
  mockIngest.mockReset();
  mockComment.mockReset();
  mockLabel.mockReset();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveFactoryRun', () => {
  it('lets options override config and clamps developers', () => {
    const h = harness({ developers: 3, epics: [9] });
    const r = resolveFactoryRun(h.config, { developers: 99, once: true, pm: false, shipMerge: true, baseBranch: 'feat/x' });
    expect(r.developers).toBe(16);
    expect(r.maxTicks).toBe(1);
    expect(r.epics).toEqual([9]);
    expect(r.pmEnabled).toBe(false);
    expect(r.shipEnabled).toBe(true);
    expect(r.shipMerge).toBe(true);
    expect(r.baseBranch).toBe('feat/x');
    expect(resolveFactoryRun(h.config, {}).shipMerge).toBe(false);
  });
});

describe('runFactory — startup', () => {
  it('refuses to start while another supervisor holds the lease', async () => {
    const h = harness();
    const held = acquireLease(h.paths.stateDir, 'factory', { owner: 'someone-else', now: new Date(T0) });
    expect(held).not.toBeNull();
    await expect(h.run({ maxTicks: 1 })).rejects.toThrow(/factory already running \(pid \d+/);
    expect(h.actions.preflight).not.toHaveBeenCalled();
  });

  it('runs preflight once, survives it throwing, and recovers stale taken ideas', async () => {
    const h = harness({ pm: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    const idea = appendIdea(h.paths.inboxPath, 'Stuck idea');
    updateIdea(h.paths.inboxPath, idea.id, { status: 'taken', meta: { taken: '2026-11-05T07:00:00Z' } });
    h.actions.preflight.mockRejectedValue(new Error('pnpm missing'));

    const summary = await h.run({ maxTicks: 2 });

    expect(h.actions.preflight).toHaveBeenCalledTimes(1);
    expect(summary.status).toBe('drained');
    expect(readInbox(h.paths.inboxPath).find((i) => i.id === idea.id)?.status).toBe('pending');
    expect(existsSync(h.paths.questionsPath)).toBe(true);
    // Supervisor lease released, final state written.
    expect(readLease(h.paths.stateDir, 'factory')).toBeNull();
    expect(h.state().status).toBe('stopped');
    const events = readFileSync(h.paths.eventsPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).type);
    expect(events[0]).toBe('factory.started');
    expect(events).toContain('ideas.recovered');
    expect(events[events.length - 1]).toBe('factory.stopped');
  });
});

describe('runFactory — shared GitHub budget', () => {
  let previousBudget: string | undefined;

  beforeEach(() => {
    previousBudget = process.env.ALPHA_LOOP_SHARED_GH_BUDGET;
  });

  afterEach(() => {
    if (previousBudget === undefined) delete process.env.ALPHA_LOOP_SHARED_GH_BUDGET;
    else process.env.ALPHA_LOOP_SHARED_GH_BUDGET = previousBudget;
  });

  describe.each([undefined, '/inherited/gh-budget.json'])('with inherited value %s', (inherited) => {
    beforeEach(() => {
      if (inherited === undefined) delete process.env.ALPHA_LOOP_SHARED_GH_BUDGET;
      else process.env.ALPHA_LOOP_SHARED_GH_BUDGET = inherited;
    });

    it('covers awaited preparation, answer application and shipping, then restores the environment', async () => {
      const h = harness({ pm: { enabled: false } });
      const observed: Array<[string, string | undefined]> = [];
      h.actions.prepare.mockImplementation(async () => {
        await Promise.resolve();
        observed.push(['prepare', process.env.ALPHA_LOOP_SHARED_GH_BUDGET]);
      });
      const q = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:5:failed', issue: 5, question: 'Retry?', context: '' }).question;
      answerQuestion(h.paths.questionsPath, q.id, 'retry');
      h.actions.applyAnswer.mockImplementation(() => {
        observed.push(['answer', process.env.ALPHA_LOOP_SHARED_GH_BUDGET]);
        return { applied: true, note: 'commented' };
      });
      own(h, 1);
      h.actions.listShippable.mockReturnValue([shipPr(1)]);
      h.actions.merge.mockImplementation(() => {
        observed.push(['merge', process.env.ALPHA_LOOP_SHARED_GH_BUDGET]);
        return { merged: true };
      });

      await h.run({ maxTicks: 1, shipMerge: true });

      const expected = join(h.paths.stateDir, 'gh-budget.json');
      expect(observed).toEqual([['prepare', expected], ['answer', expected], ['merge', expected]]);
      expect(process.env.ALPHA_LOOP_SHARED_GH_BUDGET).toBe(inherited);
    });

    it('restores the environment when startup fails before the main supervisor loop', async () => {
      const h = harness();
      acquireLease(h.paths.stateDir, 'factory', { owner: 'other', now: new Date(T0) });
      await expect(h.run({ maxTicks: 1 })).rejects.toThrow(/factory already running/);
      expect(process.env.ALPHA_LOOP_SHARED_GH_BUDGET).toBe(inherited);
    });

    it('restores the environment after an awaited action rejects', async () => {
      const h = harness();
      let observed: string | undefined;
      h.actions.prepare.mockImplementation(async () => {
        await Promise.resolve();
        observed = process.env.ALPHA_LOOP_SHARED_GH_BUDGET;
        throw new Error('prepare failed');
      });
      await expect(h.run({ maxTicks: 1 })).rejects.toThrow('prepare failed');
      expect(observed).toBe(join(h.paths.stateDir, 'gh-budget.json'));
      expect(process.env.ALPHA_LOOP_SHARED_GH_BUDGET).toBe(inherited);
    });

    it('leaves the environment and shared budget untouched for a dry run', async () => {
      const h = harness();
      const observed: Array<string | undefined> = [];
      h.actions.pollReady.mockImplementation(() => {
        observed.push(process.env.ALPHA_LOOP_SHARED_GH_BUDGET);
        return [];
      });
      await h.run({ dryRun: true });
      expect(observed).toEqual([inherited]);
      expect(process.env.ALPHA_LOOP_SHARED_GH_BUDGET).toBe(inherited);
      expect(existsSync(h.paths.stateDir)).toBe(false);
    });
  });
});

describe('runFactory — dispatch', () => {
  it('fills only free slots, skips leased issues, staggers spawns, and leases before spawning', async () => {
    const h = harness({ developers: 2, spawnStaggerSeconds: 15, ship: { enabled: false }, pm: { enabled: false } });
    const foreign = acquireLease(h.paths.leasesDir, 'issue-2', { owner: 'other-supervisor', now: new Date(T0) });
    expect(foreign).not.toBeNull();
    h.actions.pollReady.mockReturnValue([issue(1), issue(2), issue(3), issue(4)]);
    const leaseSnapshots: Array<number | undefined> = [];
    h.actions.spawnDeveloper.mockImplementation((req: { issue: number }) => {
      // The lease must exist before the worker is spawned.
      leaseSnapshots.push(readLease(h.paths.leasesDir, `issue-${req.issue}`)?.meta?.issue as number | undefined);
      const w = fakeWorker(`dev-${req.issue}`, 'developer', { issue: req.issue });
      h.devs.push(w);
      return w.handle;
    });
    h.onTick((n) => {
      if (n !== 1) return;
      const lease1 = readLease(h.paths.leasesDir, 'issue-1');
      expect(lease1?.workerPid).toBe(h.devs[0].handle.pid);
      expect(lease1?.meta).toEqual(expect.objectContaining({ workerId: 'dev-1' }));
      expect(lease1?.owner).toBe(`factory:${process.pid}`);
      expect(lease1?.ttlSeconds).toBe(120 * 60 + 600);
      expect(h.state().workers.map((w) => w.issue)).toEqual([1, 3]);
      for (const w of h.devs) w.finish(successResult(w.handle.issue!));
    });

    const summary = await h.run({ maxTicks: 1 });

    expect(h.actions.spawnDeveloper.mock.calls.map((c) => c[0].issue)).toEqual([1, 3]);
    expect(h.actions.spawnDeveloper).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'master', title: 'Issue 1' }));
    expect(leaseSnapshots).toEqual([1, 3]);
    expect(h.actions.sleep.mock.calls.filter((c) => c[0] === 15_000)).toHaveLength(1);
    const plan = h.state().lastPlan;
    expect(plan.dispatched).toEqual([1, 3]);
    expect(plan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ issue: 2, reason: 'claimed' })]));
    expect(summary.counts).toEqual(expect.objectContaining({ dispatched: 2, succeeded: 2 }));
    // Our leases are released; the foreign one is untouched.
    expect(listLeases(h.paths.leasesDir).map((l) => l.key)).toEqual(['issue-2']);
  });

  it('restricts dispatch to children of configured epics', async () => {
    const h = harness({ developers: 4, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(1), issue(2), issue(3)]);
    h.actions.getEpicChildren.mockReturnValue([3, 1]);
    h.onTick(() => { for (const w of h.devs) w.finish(successResult(w.handle.issue!)); });

    await h.run({ maxTicks: 1, epics: [50] });

    expect(h.actions.getEpicChildren).toHaveBeenCalledWith(50);
    expect(h.actions.spawnDeveloper.mock.calls.map((c) => c[0].issue)).toEqual([3, 1]);
    expect(h.state().lastPlan.skipped).toEqual([expect.objectContaining({ issue: 2, reason: 'out-of-scope' })]);
  });

  it('caches isIssueClosed per tick and holds issues with open deps', async () => {
    const h = harness({ developers: 4, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([
      issue(1, { body: 'Depends on #9' }),
      issue(2, { body: 'Depends on #9' }),
      issue(3, { body: 'Depends on #8' }),
    ]);
    h.actions.isIssueClosed.mockImplementation((n: number) => n === 8);
    h.onTick(() => { for (const w of h.devs) w.finish(successResult(w.handle.issue!)); });

    await h.run({ maxTicks: 1 });

    expect(h.actions.spawnDeveloper.mock.calls.map((c) => c[0].issue)).toEqual([3]);
    expect(h.actions.isIssueClosed.mock.calls.filter((c) => c[0] === 9)).toHaveLength(1);
  });
});

describe('runFactory — reaping developers', () => {
  it('handles success, failure, waiting, and a missing result', async () => {
    const h = harness({ developers: 4, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(1), issue(2), issue(3), issue(4)]);
    h.onTick((n) => {
      if (n !== 1) return;
      const byIssue = new Map(h.devs.map((w) => [w.handle.issue!, w]));
      byIssue.get(1)!.finish(successResult(1));
      byIssue.get(2)!.finish({ exitCode: 1, result: { issueNumber: 2, status: 'failure', failures: [{ code: 'x', message: 'tests failed' }], sessionPrUrl: null } });
      byIssue.get(3)!.finish({ exitCode: 1, result: { issueNumber: 3, status: 'waiting', failures: [{ code: 'y', message: 'needs a decision' }], sessionPrUrl: null } });
      byIssue.get(4)!.finish({ exitCode: 1, result: null, error: 'worker wrote no result file (/x/result.json)' });
    });

    const summary = await h.run({ maxTicks: 1 });

    expect(summary.counts).toEqual(expect.objectContaining({ dispatched: 4, succeeded: 1, failed: 2, waiting: 1 }));
    const qs = h.questions();
    const byKey = new Map(qs.map((q) => [q.key, q]));
    expect([...byKey.keys()].sort()).toEqual(['dev:2:failed', 'dev:3:waiting', 'dev:4:failed']);
    expect(byKey.get('dev:3:waiting')).toEqual(expect.objectContaining({
      role: 'developer', issue: 3, question: 'Issue #3 paused and needs your input',
    }));
    expect(byKey.get('dev:3:waiting')!.context).toContain('needs a decision');
    expect(byKey.get('dev:3:waiting')!.context).toContain('https://github.com/o/r/issues/3');
    expect(byKey.get('dev:2:failed')!.context).toContain('tests failed');
    expect(byKey.get('dev:2:failed')!.context).toContain('/logs/');
    expect(byKey.get('dev:4:failed')!.context).toContain('no result file');
    expect(summary.counts.questionsAsked).toBe(3);
    // Success triggers an immediate ship pass (initial pass + triggered pass).
    expect(h.actions.listShippable).toHaveBeenCalledTimes(2);
    expect(listLeases(h.paths.leasesDir)).toEqual([]);
  });

  it('does not re-dispatch an issue that failed earlier in this run', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(2)]);
    h.onTick((n) => {
      if (n === 1) h.devs[0].finish({ exitCode: 1, result: { issueNumber: 2, status: 'failure', failures: [], sessionPrUrl: null } });
    });

    await h.run({ maxTicks: 3 });

    expect(h.actions.spawnDeveloper).toHaveBeenCalledTimes(1);
    expect(h.state().lastPlan.skipped).toEqual([expect.objectContaining({ issue: 2, reason: 'failed' })]);
  });

  it('does not re-dispatch an issue that paused (waiting) earlier in this run', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(2)]);
    h.onTick((n) => {
      if (n === 1) h.devs[0].finish({ exitCode: 1, result: { issueNumber: 2, status: 'waiting', failures: [], sessionPrUrl: null } });
    });

    await h.run({ maxTicks: 3 });

    expect(h.actions.spawnDeveloper).toHaveBeenCalledTimes(1);
    expect(h.questions().map((q) => q.key)).toEqual(['dev:2:waiting']);
  });

  it('a waiting result from a worker stopped at shutdown raises no question', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(5)]);
    h.actions.spawnDeveloper.mockImplementation((req: { issue: number }) => {
      const w = fakeWorker(`dev-${req.issue}`, 'developer', { issue: req.issue }, (_signal, finish) =>
        finish({ exitCode: 1, result: { issueNumber: req.issue, status: 'waiting', failures: [], sessionPrUrl: null } }));
      h.devs.push(w);
      return w.handle;
    });
    const controller = new AbortController();
    h.onTick((n) => { if (n === 1) controller.abort(); });

    await runFactory(h.config, { signal: controller.signal }, h.actions as unknown as FactoryActions);

    expect(h.devs[0].kills).toEqual(['SIGTERM']);
    expect(h.questions()).toEqual([]);
  });

  it('kills a worker that exceeds the timeout (SIGTERM, then SIGKILL) and records a failure', async () => {
    const h = harness({ developers: 1, workerTimeoutMinutes: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValueOnce([issue(7)]).mockReturnValue([]);
    h.actions.spawnDeveloper.mockImplementation((req: { issue: number }) => {
      const w = fakeWorker('dev-7', 'developer', { issue: req.issue }, (signal, finish) => {
        if (signal === 'SIGKILL') finish({ exitCode: 1, result: null, error: 'worker terminated by SIGKILL' });
      });
      h.devs.push(w);
      return w.handle;
    });

    const summary = await h.run({ maxTicks: 1 });

    expect(h.devs[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(summary.counts.failed).toBe(1);
    const q = h.questions().find((x) => x.key === 'dev:7:failed');
    expect(q?.context).toContain('exceeding 1 minute');
    expect(summary.status).toBe('drained');
  });
});

describe('runFactory — questions', () => {
  it('asks a blocker once per key across repeated ship passes', async () => {
    const h = harness({ pm: { enabled: false }, ship: { intervalSeconds: 30 } });
    h.actions.listShippable.mockReturnValue([shipPr(7, { checks: 'failure', failingChecks: ['test'] })]);
    own(h, 7);

    const summary = await h.run({ maxTicks: 3 });

    expect(h.actions.listShippable).toHaveBeenCalledTimes(3);
    const qs = h.questions();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toEqual(expect.objectContaining({ key: 'ship:7:checks-failing', role: 'shipper', pr: 7, issue: 70 }));
    expect(summary.counts.questionsAsked).toBe(1);
  });

  it('applies answered issue, idea, and ship questions and marks them applied', async () => {
    const h = harness({ pm: { enabled: false }, ship: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    const idea = appendIdea(h.paths.inboxPath, 'Ambiguous idea');
    const qIssue = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:5:failed', issue: 5, question: 'Issue 5 failed', context: '' }).question;
    const qIdea = askQuestion(h.paths.questionsPath, { role: 'pm', key: `pm:${idea.id}`, idea: idea.id, question: 'Which API?', context: '' }).question;
    const qShip = askQuestion(h.paths.questionsPath, { role: 'shipper', key: 'ship:9:conflict', pr: 9, issue: 90, question: 'Conflict', context: '' }).question;
    const qOpen = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:6:failed', issue: 6, question: 'Unanswered', context: '' }).question;
    updateIdea(h.paths.inboxPath, idea.id, { status: 'question', note: qIdea.id, meta: { attempts: '1' } });
    answerQuestion(h.paths.questionsPath, qIssue.id, 'Use the v2 endpoint');
    answerQuestion(h.paths.questionsPath, qIdea.id, 'The REST one');
    answerQuestion(h.paths.questionsPath, qShip.id, 'I resolved it');

    const summary = await h.run({ maxTicks: 1 });

    expect(h.actions.applyAnswer).toHaveBeenCalledTimes(1);
    expect(h.actions.applyAnswer).toHaveBeenCalledWith(expect.objectContaining({ id: qIssue.id, answer: 'Use the v2 endpoint' }));
    const status = new Map(h.questions().map((q) => [q.id, q.status]));
    expect(status.get(qIssue.id)).toBe('applied');
    expect(status.get(qIdea.id)).toBe('applied');
    expect(status.get(qShip.id)).toBe('applied');
    expect(status.get(qOpen.id)).toBe('open');
    const requeued = readInbox(h.paths.inboxPath).find((i) => i.id === idea.id)!;
    expect(requeued.status).toBe('pending');
    expect(requeued.meta).toEqual({ answered: qIdea.id });
    expect(summary.counts.answersApplied).toBe(3);
  });

  it('keeps a question answered when applying fails, retries a bounded number of times, and isolates errors', async () => {
    const h = harness({ pm: { enabled: false }, ship: { enabled: false } });
    const qBad = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:1:failed', issue: 1, question: 'q1', context: '' }).question;
    const qGood = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:2:failed', issue: 2, question: 'q2', context: '' }).question;
    answerQuestion(h.paths.questionsPath, qBad.id, 'a1');
    answerQuestion(h.paths.questionsPath, qGood.id, 'a2');
    h.actions.applyAnswer.mockImplementation((q: FactoryQuestion) => {
      if (q.issue === 1) throw new Error('gh down');
      return { applied: true, note: 'ok' };
    });

    await h.run({ maxTicks: 5 });

    const status = new Map(h.questions().map((q) => [q.id, q.status]));
    expect(status.get(qBad.id)).toBe('answered');
    expect(status.get(qGood.id)).toBe('applied');
    expect(h.actions.applyAnswer.mock.calls.filter((c) => c[0].issue === 1)).toHaveLength(3);
  });

  it('re-dispatches a failed issue once its question is answered', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(2)]);
    h.onTick((n) => {
      if (n === 1) h.devs[0].finish({ exitCode: 1, result: { issueNumber: 2, status: 'failure', failures: [], sessionPrUrl: null } });
      if (n === 2) {
        const q = h.questions().find((x) => x.key === 'dev:2:failed')!;
        answerQuestion(h.paths.questionsPath, q.id, 'Try again with the new fixture');
      }
      if (n === 3) h.devs[1]?.finish(successResult(2));
    });

    await h.run({ maxTicks: 3 });

    expect(h.actions.spawnDeveloper).toHaveBeenCalledTimes(2);
    expect(h.actions.applyAnswer).toHaveBeenCalledTimes(1);
  });
});

describe('runFactory — PM', () => {
  function pmHarness() {
    const h = harness({ ship: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    return h;
  }

  it('takes one pending idea, passes prior answers, and marks it done on an issue decision', async () => {
    const h = pmHarness();
    const idea = appendIdea(h.paths.inboxPath, 'Let the shipper auto-rebase');
    appendIdea(h.paths.inboxPath, 'Second idea');
    const q = askQuestion(h.paths.questionsPath, { role: 'pm', key: `pm:${idea.id}`, idea: idea.id, question: 'Rebase or merge?', context: '' }).question;
    answerQuestion(h.paths.questionsPath, q.id, 'Rebase');
    let statusAtSpawn = '';
    h.actions.spawnPm.mockImplementation((req: { idea: { id: string } }) => {
      statusAtSpawn = readInbox(h.paths.inboxPath).find((i) => i.id === req.idea.id)!.status;
      const w = fakeWorker('pm-1', 'pm', { ideaId: req.idea.id });
      h.pms.push(w);
      return w.handle;
    });
    h.onTick((n) => {
      if (n === 1) {
        h.pms[0].finish({
          exitCode: 0,
          result: { status: 'success', decision: { decision: 'issue', reason: 'small', issues: [] }, createdIssues: [101], note: '#101' },
        });
      }
    });

    const summary = await h.run({ maxTicks: 1 });

    // The answered question is applied first (idea re-queued), then the PM takes it.
    expect(h.actions.spawnPm).toHaveBeenCalledTimes(1);
    expect(h.actions.spawnPm.mock.calls[0][0].idea.id).toBe(idea.id);
    expect(h.actions.spawnPm.mock.calls[0][0].priorAnswers).toEqual(['Rebase']);
    expect(statusAtSpawn).toBe('taken');
    const after = readInbox(h.paths.inboxPath);
    expect(after.find((i) => i.id === idea.id)).toEqual(expect.objectContaining({ status: 'done', note: '#101' }));
    expect(after.find((i) => i.text === 'Second idea')?.status).toBe('pending');
    expect(summary.counts.ideasIngested).toBe(1);
  });

  type Case = { name: string; exit: WorkerExit; meta?: Record<string, string>; expectStatus: string; expectNote?: RegExp; expectKey?: string; expectMeta?: Record<string, string> };
  const cases: Case[] = [
    {
      name: 'epic → done',
      exit: { exitCode: 0, result: { status: 'success', decision: { decision: 'epic', reason: 'r', issues: [] }, createdIssues: [1, 2], epic: 3, note: 'epic #3 (#1, #2)' } },
      expectStatus: 'done', expectNote: /epic #3/,
    },
    {
      name: 'question → question with the asked id',
      exit: { exitCode: 0, result: { status: 'success', decision: { decision: 'question', reason: 'r', questions: ['A?', 'B?'], issues: [] }, createdIssues: [], question: ['A?', 'B?'], note: 'needs answers' } },
      expectStatus: 'question', expectNote: /^Q-\d{8}-\d{3}$/, expectKey: 'pm:',
    },
    {
      name: 'duplicate → rejected',
      exit: { exitCode: 0, result: { status: 'success', decision: { decision: 'duplicate', reason: 'r', duplicateOf: 300, issues: [] }, createdIssues: [], duplicateOf: 300, note: 'dup of #300' } },
      expectStatus: 'rejected', expectNote: /dup of #300/,
    },
    {
      name: 'reject → rejected with the reason',
      exit: { exitCode: 0, result: { status: 'success', decision: { decision: 'reject', reason: 'out of scope', issues: [] }, createdIssues: [], note: 'out of scope' } },
      expectStatus: 'rejected', expectNote: /out of scope/,
    },
    {
      name: 'first failure → pending with attempts=1',
      exit: { exitCode: 1, result: { status: 'failure', createdIssues: [], note: '', error: 'agent exited' } },
      expectStatus: 'pending', expectMeta: { attempts: '1' },
    },
    {
      name: 'missing result → pending with attempts=1',
      exit: { exitCode: 1, result: null, error: 'worker wrote no result file' },
      expectStatus: 'pending', expectMeta: { attempts: '1' },
    },
    {
      name: 'second failure → question pm:<id>:failed',
      meta: { attempts: '1' },
      exit: { exitCode: 1, result: { status: 'failure', createdIssues: [], note: '', error: 'bad json' } },
      expectStatus: 'question', expectKey: ':failed', expectMeta: { attempts: '2' },
    },
    {
      name: 'partial failure → question noting created issues, never re-queued',
      exit: { exitCode: 1, result: { status: 'failure', createdIssues: [55, 56], note: '', error: 'epic create failed' } },
      expectStatus: 'question', expectNote: /partial #55, #56/, expectKey: ':partial',
    },
  ];

  it.each(cases)('$name', async (c) => {
    const h = pmHarness();
    const idea = appendIdea(h.paths.inboxPath, 'An idea');
    if (c.meta) updateIdea(h.paths.inboxPath, idea.id, { status: 'pending', meta: c.meta });
    h.onTick((n) => { if (n === 1) h.pms[0].finish(c.exit); });

    await h.run({ maxTicks: 1 });

    const after = readInbox(h.paths.inboxPath).find((i) => i.id === idea.id)!;
    expect(after.status).toBe(c.expectStatus);
    if (c.expectNote) expect(after.note).toMatch(c.expectNote);
    if (c.expectMeta) expect(after.meta).toEqual(c.expectMeta);
    expect(after.meta.taken).toBeUndefined();
    const qs = h.questions();
    if (c.expectKey) {
      expect(qs).toHaveLength(1);
      expect(qs[0].key.startsWith(`pm:${idea.id}`)).toBe(true);
      expect(qs[0].key.endsWith(c.expectKey === 'pm:' ? idea.id : c.expectKey)).toBe(true);
      expect(qs[0].idea).toBe(idea.id);
      if (c.expectStatus === 'question' && c.expectNote?.source.startsWith('^Q')) expect(after.note).toBe(qs[0].id);
    } else {
      expect(qs).toHaveLength(0);
    }
  });

  it('kills a PM worker that runs far past its timeout and counts it as a failed attempt', async () => {
    const h = harness({ ship: { enabled: false }, pm: { timeoutSeconds: 30 } });
    ensureInboxFile(h.paths.inboxPath);
    const idea = appendIdea(h.paths.inboxPath, 'Slow idea');
    h.actions.spawnPm.mockImplementation((req: { idea: { id: string } }) => {
      const w = fakeWorker('pm-slow', 'pm', { ideaId: req.idea.id }, (signal, finish) => finish({ exitCode: 1, result: null, error: `terminated by ${signal}` }));
      h.pms.push(w);
      return w.handle;
    });

    await h.run({ maxTicks: 1 });

    expect(h.pms[0].kills).toEqual(['SIGTERM']);
    expect(readInbox(h.paths.inboxPath).find((i) => i.id === idea.id)).toEqual(expect.objectContaining({ status: 'pending', meta: { attempts: '1' } }));
  });

  it('does not ingest ideas when the PM is disabled', async () => {
    const h = harness({ ship: { enabled: false }, pm: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    appendIdea(h.paths.inboxPath, 'Idea');
    await h.run({ maxTicks: 1 });
    expect(h.actions.spawnPm).not.toHaveBeenCalled();
  });
});

describe('runFactory — ship pass', () => {
  it('merges green PRs, asks about blockers and failed merges, and waits on pending checks', async () => {
    const h = harness({ pm: { enabled: false } });
    h.actions.listShippable.mockReturnValue([
      shipPr(1),
      shipPr(2, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      shipPr(3, { checks: 'pending' }),
      shipPr(4),
    ]);
    own(h, 1, 2, 3, 4);
    h.actions.merge.mockImplementation((pr: ShipPr) => (pr.number === 4 ? { merged: false, error: 'boom' } : { merged: true }));

    const summary = await h.run({ maxTicks: 1, shipMerge: true });

    expect(h.actions.merge).toHaveBeenCalledWith(expect.objectContaining({ number: 1 }), false);
    expect(summary.counts.merged).toBe(1);
    const decisions = h.state().ship.decisions;
    expect(decisions.map((d) => [d.pr, d.action])).toEqual([[1, 'merge'], [2, 'ask'], [3, 'wait'], [4, 'merge-failed']]);
    const keys = h.questions().map((q) => q.key).sort();
    expect(keys).toEqual(['ship:2:conflict', 'ship:4:merge-failed']);
    expect(h.questions().find((q) => q.key === 'ship:2:conflict')).toEqual(expect.objectContaining({ pr: 2, issue: 20 }));
  });

  it('only reports what it would merge when merging is disabled', async () => {
    const h = harness({ pm: { enabled: false } });
    h.actions.listShippable.mockReturnValue([shipPr(1)]);
    own(h, 1);
    await h.run({ maxTicks: 1 });
    expect(h.actions.merge).not.toHaveBeenCalled();
    expect(h.state().ship.decisions).toEqual([{ pr: 1, action: 'skip', reason: expect.stringContaining('ship.merge disabled') }]);
  });

  it('survives listShippable throwing and records the error', async () => {
    const h = harness({ pm: { enabled: false } });
    h.actions.listShippable.mockImplementation(() => { throw new Error('gh: HTTP 502'); });
    const summary = await h.run({ maxTicks: 1 });
    expect(summary.status).toBe('drained');
    expect(h.state().ship.error).toBe('gh: HTTP 502');
    expect(h.state().recent.map((e) => e.type)).toContain('ship.error');
  });

  it('runs on its interval, not every tick', async () => {
    const h = harness({ pm: { enabled: false }, ship: { intervalSeconds: 300 } });
    await h.run({ maxTicks: 5 });
    expect(h.actions.listShippable).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the shipper is disabled', async () => {
    const h = harness({ pm: { enabled: false } });
    await h.run({ maxTicks: 1, ship: false });
    expect(h.actions.listShippable).not.toHaveBeenCalled();
  });
});

describe('runFactory — termination', () => {
  it('untilIdle exits on the first tick when there is nothing to do', async () => {
    const h = harness();
    const summary = await h.run({ untilIdle: true });
    expect(summary).toEqual(expect.objectContaining({ status: 'idle', reason: 'until-idle', ticks: 1 }));
  });

  it('untilIdle waits for running work, then exits', async () => {
    const h = harness({ developers: 1 });
    h.actions.pollReady.mockReturnValueOnce([issue(1)]).mockReturnValue([]);
    h.onTick((n) => { if (n === 2) h.devs[0].finish(successResult(1)); });
    const summary = await h.run({ untilIdle: true });
    expect(summary.status).toBe('idle');
    expect(summary.ticks).toBe(3);
    expect(summary.counts.succeeded).toBe(1);
  });

  it('untilIdle keeps running while a PR awaits CI, capped at 30 minutes', async () => {
    const h = harness({ ship: { intervalSeconds: 30 } });
    h.actions.listShippable.mockReturnValue([shipPr(1, { checks: 'pending' })]);
    own(h, 1);
    const summary = await h.run({ untilIdle: true });
    expect(summary.status).toBe('idle');
    expect(h.clock() - T0).toBeGreaterThanOrEqual(30 * 60_000);
    expect(summary.ticks).toBeGreaterThan(50);
  });

  it('untilIdle does not exit while an answer is waiting to be applied', async () => {
    const h = harness({ pm: { enabled: false } });
    const q = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:1:failed', issue: 1, question: 'q', context: '' }).question;
    answerQuestion(h.paths.questionsPath, q.id, 'retry');
    h.actions.applyAnswer.mockReturnValue({ applied: false, note: 'gh down' });
    const summary = await h.run({ untilIdle: true });
    // Three failed attempts, then it stops blocking idle.
    expect(h.actions.applyAnswer).toHaveBeenCalledTimes(3);
    expect(summary.ticks).toBe(3);
  });

  it('maxTicks stops new work and drains running workers', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(1), issue(2)]);
    h.onTick((n) => { if (n === 3) h.devs[0].finish(successResult(1)); });

    const summary = await h.run({ maxTicks: 1 });

    expect(h.actions.spawnDeveloper).toHaveBeenCalledTimes(1);
    expect(summary).toEqual(expect.objectContaining({ status: 'drained', reason: 'max-ticks', ticks: 4 }));
    const states: string[] = readFileSync(h.paths.eventsPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).type);
    expect(states).toContain('factory.draining');
  });

  it('maxRuntimeMinutes drains after the runtime elapses', async () => {
    const h = harness({ ship: { enabled: false }, pm: { enabled: false } });
    const summary = await h.run({ maxRuntimeMinutes: 1 });
    expect(summary).toEqual(expect.objectContaining({ status: 'drained', reason: 'max-runtime', ticks: 3 }));
  });

  it('shutdown SIGTERMs children, releases every lease, re-queues the PM idea, and writes a stopped state', async () => {
    const h = harness({ developers: 2, ship: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    const idea = appendIdea(h.paths.inboxPath, 'In-flight idea');
    h.actions.pollReady.mockReturnValue([issue(1), issue(2)]);
    const exitOnKill = (signal: string, finish: (e: WorkerExit) => void) => finish({ exitCode: 1, result: null, error: signal });
    h.actions.spawnDeveloper.mockImplementation((req: { issue: number }) => {
      const w = fakeWorker(`dev-${req.issue}`, 'developer', { issue: req.issue }, exitOnKill);
      h.devs.push(w);
      return w.handle;
    });
    h.actions.spawnPm.mockImplementation((req: { idea: { id: string } }) => {
      const w = fakeWorker('pm-1', 'pm', { ideaId: req.idea.id }, exitOnKill);
      h.pms.push(w);
      return w.handle;
    });
    const controller = new AbortController();
    h.onTick((n) => {
      if (n !== 1) return;
      expect(listLeases(h.paths.leasesDir)).toHaveLength(2);
      controller.abort();
    });
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');

    const summary = await runFactory(h.config, { signal: controller.signal }, h.actions as unknown as FactoryActions);

    expect(summary).toEqual(expect.objectContaining({ status: 'stopped', reason: 'aborted' }));
    expect(h.devs.map((w) => w.kills)).toEqual([['SIGTERM'], ['SIGTERM']]);
    expect(h.pms[0].kills).toEqual(['SIGTERM']);
    expect(listLeases(h.paths.leasesDir)).toEqual([]);
    expect(readLease(h.paths.stateDir, 'factory')).toBeNull();
    expect(h.state().status).toBe('stopped');
    expect(h.state().workers).toEqual([]);
    expect(readInbox(h.paths.inboxPath).find((i) => i.id === idea.id)?.status).toBe('pending');
    // Interrupted workers are not failures and raise no questions.
    expect(summary.counts.failed).toBe(0);
    expect(h.questions()).toEqual([]);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
  });

  it('shutdown SIGKILLs workers that ignore SIGTERM after the grace period', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(1)]);
    h.actions.spawnDeveloper.mockImplementation((req: { issue: number }) => {
      const w = fakeWorker('dev-1', 'developer', { issue: req.issue }, (signal, finish) => {
        if (signal === 'SIGKILL') finish({ exitCode: 1, result: null, error: 'SIGKILL' });
      });
      h.devs.push(w);
      return w.handle;
    });
    const controller = new AbortController();
    h.onTick(() => controller.abort());

    await h.run({ signal: controller.signal });

    expect(h.devs[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(h.actions.sleep).toHaveBeenCalledWith(60_000, expect.anything());
    expect(listLeases(h.paths.leasesDir)).toEqual([]);
  });

  it('stops before the first tick when the signal is already aborted', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    const summary = await h.run({ signal: controller.signal });
    expect(summary).toEqual(expect.objectContaining({ status: 'stopped', ticks: 0 }));
    expect(h.actions.pollReady).not.toHaveBeenCalled();
  });
});

describe('runFactory — dry run', () => {
  function snapshot(dir: string): Record<string, number> {
    const out: Record<string, number> = {};
    const walk = (d: string): void => {
      if (!existsSync(d)) return;
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else out[relative(dir, p)] = st.mtimeMs;
      }
    };
    walk(dir);
    return out;
  }

  it('prints a plan and makes no writes, spawns, merges, or answers', async () => {
    const h = harness({ developers: 2 });
    ensureInboxFile(h.paths.inboxPath);
    appendIdea(h.paths.inboxPath, 'An idea');
    const q = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:3:failed', issue: 3, question: 'q', context: '' }).question;
    answerQuestion(h.paths.questionsPath, q.id, 'go');
    h.actions.pollReady.mockReturnValue([issue(1), issue(2, { labels: ['blocked'] }), issue(3)]);
    h.actions.listShippable.mockReturnValue([shipPr(9), shipPr(10, { checks: 'failure', failingChecks: ['lint'] }), shipPr(11)]);
    own(h, 9, 10);
    const before = snapshot(root);

    const summary = await h.run({ dryRun: true, shipMerge: true });

    expect(snapshot(root)).toEqual(before); // the seeded state.json is read, never rewritten
    expect(existsSync(h.paths.leasesDir)).toBe(false);
    for (const name of ['spawnDeveloper', 'spawnPm', 'merge', 'applyAnswer', 'preflight', 'sleep']) {
      expect(h.actions[name as keyof MockActions]).not.toHaveBeenCalled();
    }
    expect(summary.status).toBe('dry-run');
    expect(summary.dryRun?.ideas.map((i) => i.text)).toEqual(['An idea']);
    expect(summary.dryRun?.answers).toEqual([{ id: q.id, key: 'dev:3:failed' }]);
    expect(summary.dryRun?.dispatch.map((d) => d.issue)).toEqual([1, 3]);
    expect(summary.dryRun?.skipped).toEqual([expect.objectContaining({ issue: 2, reason: 'blocked' })]);
    expect(summary.dryRun?.ship.map((s) => [s.pr, s.action])).toEqual([[9, 'merge'], [10, 'ask'], [11, 'skip']]);
    expect(summary.dryRun?.ship[2].reason).toContain('not a session PR this factory finished');
    expect(summary.dryRun?.queued).toEqual([]);
  });

  it('accounts for slot overflow as queued and collapses out-of-scope skips', async () => {
    const { log } = jest.requireMock('../../src/lib/logger') as { log: { dry: jest.Mock } };
    log.dry.mockClear();
    const h = harness({ developers: 2, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(1), issue(2), issue(3), issue(4), issue(90), issue(91)]);
    h.actions.getEpicChildren.mockReturnValue([1, 2, 3, 4]);

    const summary = await h.run({ dryRun: true, epics: [50] });

    expect(summary.dryRun?.dispatch.map((d) => d.issue)).toEqual([1, 2]);
    expect(summary.dryRun?.queued.map((q) => q.issue)).toEqual([3, 4]);
    expect(summary.dryRun?.skipped.map((s) => [s.issue, s.reason])).toEqual([[90, 'out-of-scope'], [91, 'out-of-scope']]);
    const lines = log.dry.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain('Queued for a free slot (2): #3, #4');
    expect(lines).toContain('Skip 2 ready issue(s) outside the epic scope');
    expect(lines.some((l) => l.startsWith('Skip #90'))).toBe(false);
    expect(h.actions.spawnDeveloper).not.toHaveBeenCalled();
  });
});

describe('applyIssueAnswer (default applyAnswer)', () => {
  const config = { repo: 'o/r', labelReady: 'ready' } as unknown as Config;
  const q: FactoryQuestion = {
    id: 'Q-20261105-001', status: 'answered', role: 'developer', askedAt: '2026-11-05T10:00:00Z',
    key: 'dev:5:failed', issue: 5, question: 'q', context: '', answer: 'Use v2',
  };

  it('records the answer through feedback ingest and relabels the issue ready', () => {
    mockIngest.mockReturnValue({ status: 'processed' });
    mockLabel.mockReturnValue(undefined);
    const out = applyIssueAnswer(config, q);
    expect(out.applied).toBe(true);
    expect(mockIngest).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        repo: 'o/r', issueNumber: 5, body: 'Use v2', source: 'factory-questions', externalEventId: answerEventId(q), resumeRequested: true,
      }),
      readyLabel: 'ready',
    }));
    expect(mockComment).not.toHaveBeenCalled();
    expect(mockLabel).toHaveBeenCalledWith('o/r', 5, 'ready', 'needs-human-input');
    expect(mockLabel).toHaveBeenCalledWith('o/r', 5, 'ready', 'failed');
  });

  it('falls back to a marked issue comment when ingest throws', () => {
    mockIngest.mockImplementation(() => { throw new Error('no session'); });
    mockComment.mockReturnValue(true);
    mockLabel.mockReturnValue(undefined);
    const out = applyIssueAnswer(config, q);
    expect(out.applied).toBe(true);
    expect(mockComment).toHaveBeenCalledWith('o/r', 5, expect.stringContaining(`<!-- factory:answer=${q.id} -->`));
    expect(mockComment.mock.calls[0][2]).toContain('Use v2');
  });

  it('reports not applied when the fallback comment fails', () => {
    mockIngest.mockImplementation(() => { throw new Error('no session'); });
    mockComment.mockReturnValue(false);
    expect(applyIssueAnswer(config, q)).toEqual({ applied: false, note: 'could not comment on #5' });
    expect(mockLabel).not.toHaveBeenCalled();
  });
});

// Keep unused-import linting quiet for helpers only used in some paths.
void writeFileSync;

// ── Regressions from the adversarial QA round ────────────────────────────────

describe('runFactory — shutdown keeps finished work', () => {
  function pmWithResultDir(h: Harness, onKill?: (signal: string, finish: (exit: WorkerExit) => void) => void): string {
    const dir = join(root, 'pm-worker');
    mkdirSync(dir, { recursive: true });
    h.actions.spawnPm.mockImplementation((req: { idea: { id: string } }) => {
      const w = fakeWorker('pm-1', 'pm', { ideaId: req.idea.id }, onKill);
      w.handle.resultPath = join(dir, 'result.json');
      h.pms.push(w);
      return w.handle;
    });
    return dir;
  }

  it('reaps a PM result that finished in the same tick as the stop instead of re-queueing the idea', async () => {
    const h = harness({ ship: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    const idea = appendIdea(h.paths.inboxPath, 'Add dark mode');
    const controller = new AbortController();
    h.actions.pollReady.mockImplementation(() => {
      // The PM finishes after this tick's reap, then the stop arrives.
      h.pms[0].finish({
        exitCode: 0,
        result: { status: 'success', decision: { decision: 'issue', reason: 'r', issues: [] }, createdIssues: [101], note: '#101' },
      });
      controller.abort();
      return [];
    });

    const summary = await h.run({ signal: controller.signal });

    expect(readInbox(h.paths.inboxPath).find((i) => i.id === idea.id)?.status).toBe('done');
    expect(summary.counts.ideasIngested).toBe(1);
  });

  it('a PM killed by shutdown after creating issues becomes a partial question, never pending', async () => {
    const h = harness({ ship: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    const idea = appendIdea(h.paths.inboxPath, 'Big epic idea');
    const dir = pmWithResultDir(h, (signal, finish) => {
      // Killed mid-apply: no result.json, but the progress sidecar has #201.
      writeFileSync(join(dir, 'progress.json'), JSON.stringify({ phase: 'applying', createdIssues: [201] }));
      finish({ exitCode: 1, result: null, error: `terminated by ${signal}` });
    });
    const controller = new AbortController();
    h.onTick(() => controller.abort());

    await h.run({ signal: controller.signal });

    const after = readInbox(h.paths.inboxPath).find((i) => i.id === idea.id)!;
    expect(after.status).toBe('question');
    expect(h.questions().map((q) => q.key)).toEqual([`pm:${idea.id}:partial`]);
    expect(h.questions()[0].question).toContain('#201');
  });

  it('a PM killed while applying with nothing recorded asks (interrupted) instead of re-running', async () => {
    const h = harness({ ship: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    const idea = appendIdea(h.paths.inboxPath, 'Another idea');
    const dir = pmWithResultDir(h, (_signal, finish) => {
      writeFileSync(join(dir, 'progress.json'), JSON.stringify({ phase: 'applying', createdIssues: [] }));
      finish({ exitCode: 1, result: null });
    });
    const controller = new AbortController();
    h.onTick(() => controller.abort());

    await h.run({ signal: controller.signal });

    expect(readInbox(h.paths.inboxPath).find((i) => i.id === idea.id)?.status).toBe('question');
    expect(h.questions().map((q) => q.key)).toEqual([`pm:${idea.id}:interrupted`]);
  });

  it('counts a developer success that landed before the stop and remembers its PR as shippable', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValueOnce([issue(5)]).mockReturnValue([]);
    const controller = new AbortController();
    h.onTick(() => {
      h.devs[0].finish(successResult(5, 'https://github.com/o/r/pull/55'));
      controller.abort();
    });

    const summary = await h.run({ signal: controller.signal });

    expect(summary.counts.succeeded).toBe(1);
    expect(h.state().memory?.owned).toEqual([{ pr: 55, url: 'https://github.com/o/r/pull/55', issue: 5 }]);
  });

  it('keeps the lease of a worker that never exits, even after SIGKILL', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(1)]);
    h.actions.spawnDeveloper.mockImplementation((req: { issue: number }) => {
      const w = fakeWorker('dev-1', 'developer', { issue: req.issue }); // ignores every signal
      h.devs.push(w);
      return w.handle;
    });
    const controller = new AbortController();
    h.onTick(() => controller.abort());

    await h.run({ signal: controller.signal });

    expect(h.devs[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
    expect(listLeases(h.paths.leasesDir).map((l) => l.key)).toEqual(['issue-1']);
  });

  it('does not leave the 60 s grace timer pending once workers exit', async () => {
    const h = harness({ developers: 1, ship: { enabled: false }, pm: { enabled: false } });
    h.actions.pollReady.mockReturnValue([issue(1)]);
    h.actions.spawnDeveloper.mockImplementation((req: { issue: number }) => {
      const w = fakeWorker('dev-1', 'developer', { issue: req.issue }, (_s, finish) => finish({ exitCode: 1, result: null }));
      h.devs.push(w);
      return w.handle;
    });
    const signals: AbortSignal[] = [];
    const baseSleep = h.actions.sleep.getMockImplementation()!;
    h.actions.sleep.mockImplementation(async (ms: number, signal: AbortSignal) => {
      if (ms === 60_000) signals.push(signal);
      return baseSleep(ms, signal);
    });
    const controller = new AbortController();
    h.onTick(() => controller.abort());

    await h.run({ signal: controller.signal });

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
  });
});

describe('runFactory — inbox robustness', () => {
  it('two identical pending bullets are two ideas: each is taken once and untilIdle ends', async () => {
    const h = harness({ ship: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    writeFileSync(h.paths.inboxPath, '# Inbox\n\n- [ ] Add dark mode\n- [ ] Add dark mode\n');
    h.actions.spawnPm.mockImplementation((req: { idea: { id: string } }) => {
      const w = fakeWorker(`pm-${h.pms.length}`, 'pm', { ideaId: req.idea.id });
      h.pms.push(w);
      w.finish({ exitCode: 0, result: { status: 'success', decision: { decision: 'duplicate', reason: 'dup', duplicateOf: 1, issues: [] }, createdIssues: [], note: 'dup' } });
      return w.handle;
    });

    const summary = await h.run({ untilIdle: true, maxTicks: 20 });

    const ids = h.actions.spawnPm.mock.calls.map((c) => c[0].idea.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(readInbox(h.paths.inboxPath).map((i) => i.status)).toEqual(['rejected', 'rejected']);
    expect(summary.status).toBe('idle');
  });

  it('reaps an idea a crashed supervisor left taken once its recorded PM worker is dead', async () => {
    const h = harness({ ship: { enabled: false }, pm: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    const deadPid = 4_194_400;
    writeFileSync(h.paths.inboxPath, `# Inbox\n\n- [~] Orphaned idea  <!-- factory:id=I-aaaaaa taken=2026-11-05T09:55:00Z pid=${deadPid} host=${hostname()} worker=pm-old -->\n`);
    const workerDir = join(h.paths.workersDir, 'pm-old');
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, 'result.json'), JSON.stringify({
      status: 'success', decision: { decision: 'issue', reason: 'r', issues: [] }, createdIssues: [301], note: '#301',
    }));

    const summary = await h.run({ maxTicks: 1 });

    const idea = readInbox(h.paths.inboxPath)[0];
    expect(idea.status).toBe('done');
    expect(idea.meta.pid).toBeUndefined();
    expect(summary.counts.ideasIngested).toBe(1);
  });

  it('recovers a stale taken idea during the run, not only at startup', async () => {
    const h = harness({ ship: { enabled: false }, pm: { enabled: false } });
    ensureInboxFile(h.paths.inboxPath);
    // Taken 10 minutes before start (a quick restart): not stale yet at startup.
    writeFileSync(h.paths.inboxPath, '# Inbox\n\n- [~] Stuck idea  <!-- factory:id=I-bbbbbb taken=2026-11-05T09:50:00Z -->\n');

    await h.run({ maxTicks: 45 });

    expect(readInbox(h.paths.inboxPath)[0].status).toBe('pending');
    const events = readFileSync(h.paths.eventsPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const recovered = events.find((e) => e.type === 'ideas.recovered');
    expect(recovered).toBeDefined();
    expect(Date.parse(recovered.at)).toBeGreaterThan(T0 + 20 * 60_000);
  });
});

describe('runFactory — leases and idle detection', () => {
  it('a second supervisor cannot take the lease after its TTL while this one is alive', async () => {
    const h = harness({ pm: { enabled: false }, ship: { enabled: false } });
    let stolen: unknown = 'not tried';
    h.onTick(() => {
      stolen = acquireLease(h.paths.stateDir, 'factory', { owner: 'intruder', now: new Date(h.clock() + 3_600_000) });
    });
    const summary = await h.run({ maxTicks: 2 });
    expect(stolen).toBeNull();
    expect(summary.reason).toBe('max-ticks');
  });

  it('runs coordinator preparation once, before preflight', async () => {
    const h = harness({ pm: { enabled: false }, ship: { enabled: false } });
    await h.run({ maxTicks: 1 });
    expect(h.actions.prepare).toHaveBeenCalledTimes(1);
    expect(h.actions.prepare.mock.invocationCallOrder[0]).toBeLessThan(h.actions.preflight.mock.invocationCallOrder[0]);
  });

  it('untilIdle does not exit on a tick whose ready-issue poll failed', async () => {
    const h = harness({ pm: { enabled: false }, ship: { enabled: false } });
    h.actions.pollReady.mockImplementationOnce(() => { throw new Error('gh: rate limited'); }).mockReturnValue([]);
    const summary = await h.run({ untilIdle: true });
    expect(summary.status).toBe('idle');
    expect(summary.ticks).toBe(2);
  });

  it('untilIdle does not exit on a tick whose epic read failed', async () => {
    const h = harness({ pm: { enabled: false }, ship: { enabled: false }, epics: [454] });
    h.actions.getEpicChildren.mockImplementationOnce(() => { throw new Error('gh: 502'); }).mockReturnValue([]);
    const summary = await h.run({ untilIdle: true });
    expect(summary.ticks).toBe(2);
  });
});

describe('runFactory — answers are applied once', () => {
  it('does not re-apply an answer whose applied status an editor reverted', async () => {
    const h = harness({ pm: { enabled: false }, ship: { enabled: false } });
    const q = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:1:failed', issue: 1, question: 'q', context: '' }).question;
    answerQuestion(h.paths.questionsPath, q.id, 'retry with v2');
    const staleBuffer = readFileSync(h.paths.questionsPath, 'utf-8');
    h.onTick((n) => { if (n === 1) writeFileSync(h.paths.questionsPath, staleBuffer); });

    await h.run({ maxTicks: 3 });

    expect(h.actions.applyAnswer).toHaveBeenCalledTimes(1);
    expect(h.questions().find((x) => x.id === q.id)?.status).toBe('applied');
  });

  it('defers an answer for an issue a developer is building until the worker is done', async () => {
    const h = harness({ developers: 1, pm: { enabled: false }, ship: { enabled: false } });
    h.actions.pollReady.mockReturnValueOnce([issue(1)]).mockReturnValue([]);
    h.onTick((n) => {
      if (n === 1) {
        const q = askQuestion(h.paths.questionsPath, { role: 'developer', key: 'dev:1:note', issue: 1, question: 'q', context: '' }).question;
        answerQuestion(h.paths.questionsPath, q.id, 'note');
      }
      if (n === 2) {
        expect(h.actions.applyAnswer).not.toHaveBeenCalled();
        h.devs[0].finish(successResult(1));
      }
    });

    await h.run({ maxTicks: 4 });

    expect(h.actions.applyAnswer).toHaveBeenCalledTimes(1);
  });

  it('answer event ids include the issue and the answer, so a reused question id is a new event', () => {
    const base = { id: 'Q-20261105-001', issue: 10, answer: 'x' };
    expect(answerEventId(base)).not.toBe(answerEventId({ ...base, issue: 20 }));
    expect(answerEventId(base)).not.toBe(answerEventId({ ...base, answer: 'y' }));
    expect(answerEventId(base)).toBe(answerEventId({ ...base, answer: ' x ' }));
  });

  it('does not relabel the issue when the same answer was already ingested', () => {
    const config = { repo: 'o/r', labelReady: 'ready' } as unknown as Config;
    mockIngest.mockReturnValue({ status: 'already_processed' });
    const out = applyIssueAnswer(config, {
      id: 'Q-20261105-001', status: 'answered', role: 'developer', askedAt: '', key: 'dev:5:failed', issue: 5, question: 'q', context: '', answer: 'Use v2',
    });
    expect(out.applied).toBe(true);
    expect(mockLabel).not.toHaveBeenCalled();
  });
});

describe('runFactory — shipper only ships what this factory finished', () => {
  it('merges the finished worker PR, skips foreign PRs, closes the issue off the default branch, and unblocks dependents', async () => {
    const h = harness({ developers: 2, pm: { enabled: false }, ship: { intervalSeconds: 30 } });
    h.actions.pollReady
      .mockReturnValueOnce([issue(5)])
      .mockReturnValue([issue(7, { body: '## Dependencies\n- Depends on #5' })]);
    h.actions.isIssueClosed.mockReturnValue(false);
    h.actions.listShippable.mockReturnValue([
      shipPr(55, { headRefName: 'session/issue-5-x', baseRefName: 'feat/x', closingIssues: [] }),
      shipPr(56, { headRefName: 'session/issue-9-y', baseRefName: 'feat/x' }),
    ]);
    h.onTick((n) => {
      if (n === 1) h.devs[0].finish(successResult(5, 'https://github.com/o/r/pull/55'));
      if (n === 3) h.devs[1].finish(successResult(7, 'https://github.com/o/r/pull/77'));
    });

    await h.run({ maxTicks: 3, shipMerge: true, baseBranch: 'feat/x' });

    expect(h.actions.merge).toHaveBeenCalledTimes(1);
    expect(h.actions.merge.mock.calls[0][0].number).toBe(55);
    expect(h.actions.closeIssue).toHaveBeenCalledWith(5);
    expect(h.actions.spawnDeveloper.mock.calls.map((c) => c[0].issue)).toEqual([5, 7]);
    expect(h.state().memory?.mergedIssues).toEqual([5]);
    const foreign = h.state().ship.decisions.find((d) => d.pr === 56);
    expect(foreign).toEqual(expect.objectContaining({ action: 'skip', reason: expect.stringContaining('not a session PR this factory finished') }));
    expect(h.questions()).toEqual([]);
  });

  it('does not close issues itself when the PR merged into the default branch', async () => {
    const h = harness({ pm: { enabled: false } });
    h.actions.listShippable.mockReturnValue([shipPr(1)]);
    own(h, 1);
    await h.run({ maxTicks: 1, shipMerge: true });
    expect(h.actions.merge).toHaveBeenCalledTimes(1);
    expect(h.actions.closeIssue).not.toHaveBeenCalled();
  });

  it('never touches the PR of an issue a developer is still working on', async () => {
    const h = harness({ developers: 1, pm: { enabled: false } });
    own(h, 6);
    h.actions.pollReady.mockReturnValueOnce([issue(6)]).mockReturnValue([]);
    h.actions.listShippable.mockReturnValue([shipPr(6, { headRefName: 'session/issue-6-z', checks: 'failure', failingChecks: ['t'] })]);
    let whileRunning: FactoryState['ship']['decisions'] = [];
    let questionsWhileRunning: FactoryQuestion[] = [];
    h.onTick(() => {
      whileRunning = h.state().ship.decisions;
      questionsWhileRunning = h.questions();
      h.devs[0].finish(successResult(6, 'https://github.com/o/r/pull/6'));
    });
    await h.run({ maxTicks: 1, shipMerge: true });
    expect(whileRunning).toEqual([{ pr: 6, action: 'skip', reason: expect.stringContaining('still being worked on') }]);
    expect(questionsWhileRunning).toEqual([]);
    expect(h.actions.merge).not.toHaveBeenCalled();
  });

  it('does not re-ask a dismissed ship question until the PR state changes', async () => {
    const h = harness({ pm: { enabled: false }, ship: { intervalSeconds: 30 } });
    own(h, 7);
    let head = 'aaa';
    h.actions.listShippable.mockImplementation(() => [shipPr(7, { checks: 'failure', failingChecks: ['test'], headRefOid: head })]);
    h.onTick((n) => {
      if (n === 1) markQuestion(h.paths.questionsPath, h.questions()[0].id, 'dismissed');
      if (n === 3) head = 'bbb';
    });

    await h.run({ maxTicks: 4 });

    expect(h.questions().map((q) => q.status).sort()).toEqual(['dismissed', 'open']);
  });
});

describe('default actions', () => {
  it('treats a MERGED dependency (a PR number) as closed', () => {
    const mockGh = ghExec as jest.Mock;
    mockGh.mockReturnValueOnce({ exitCode: 0, stdout: '{"state":"MERGED"}', stderr: '' });
    const config = { repo: 'o/r', labelReady: 'ready', factory: DEFAULT_FACTORY_CONFIG } as unknown as Config;
    const actions = createDefaultFactoryActions(config, { paths: resolveFactoryPaths(config), baseBranch: 'master', shipMerge: false, dryRun: false });
    expect(actions.isIssueClosed(399)).toBe(true);
  });
});
