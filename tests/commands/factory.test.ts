jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(), success: jest.fn(), warn: jest.fn(), error: jest.fn(),
    step: jest.fn(), dry: jest.fn(), debug: jest.fn(), rate: jest.fn(),
  },
}));

// Guard: no command here may reach GitHub except through injected fakes.
jest.mock('../../src/lib/github', () => ({
  listOpenIssues: jest.fn(() => { throw new Error('real listOpenIssues called'); }),
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  factoryAnswerCommand,
  factoryIdeaCommand,
  factoryPmWorkerCommand,
  factoryQuestionsCommand,
  factoryRunCommand,
  factoryStatusCommand,
  formatAge,
  parseEpicList,
  toFactoryRunOptions,
} from '../../src/commands/factory.js';
import { DEFAULT_FACTORY_CONFIG, resolveFactoryPaths, type Config, type FactoryPaths } from '../../src/lib/config.js';
import type { FactoryState } from '../../src/lib/factory.js';
import * as factoryStatus from '../../src/lib/factory-status.js';
import { readInbox } from '../../src/lib/factory-inbox.js';
import { answerQuestion, askQuestion, markQuestion, readQuestions } from '../../src/lib/factory-questions.js';
import { acquireLease } from '../../src/lib/lease.js';
import { log } from '../../src/lib/logger.js';

const mockError = log.error as jest.Mock;

let root: string;
let config: Config;
let paths: FactoryPaths;
let logSpy: jest.SpyInstance;
let savedExitCode: typeof process.exitCode;

function output(): string {
  return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-cmd-'));
  config = {
    repo: 'o/r',
    labelReady: 'ready',
    baseBranch: 'master',
    agent: 'claude',
    model: '',
    dryRun: false,
    factory: { ...DEFAULT_FACTORY_CONFIG, stateDir: join(root, 'factory') },
  } as unknown as Config;
  paths = resolveFactoryPaths(config);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  mockError.mockReset();
  savedExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  logSpy.mockRestore();
  process.exitCode = savedExitCode;
  rmSync(root, { recursive: true, force: true });
});

describe('flag mapping', () => {
  it('parses epic lists and rejects junk', () => {
    expect(parseEpicList(undefined)).toBeUndefined();
    expect(parseEpicList('12, #34 56')).toEqual([12, 34, 56]);
    expect(() => parseEpicList('12,abc')).toThrow(/Invalid epic number "abc"/);
  });

  it('only forwards flags that were set; --no-pm/--no-ship map to false', () => {
    // Commander defaults pm/ship to true because of --no-pm/--no-ship.
    expect(toFactoryRunOptions({ pm: true, ship: true })).toEqual({});
    expect(toFactoryRunOptions({
      developers: 3, epic: '7,8', once: true, untilIdle: true, maxTicks: 5, maxRuntime: 90,
      pm: false, ship: false, shipMerge: true, base: 'feat/x', dryRun: true, verbose: true,
    })).toEqual({
      developers: 3, epics: [7, 8], once: true, untilIdle: true, maxTicks: 5, maxRuntimeMinutes: 90,
      pm: false, ship: false, shipMerge: true, baseBranch: 'feat/x', dryRun: true, verbose: true,
    });
    expect(toFactoryRunOptions({ developers: Number.NaN, maxTicks: 0 })).toEqual({});
  });

  it('formats ages compactly', () => {
    expect(formatAge(5_000)).toBe('5s');
    expect(formatAge(12 * 60_000)).toBe('12m');
    expect(formatAge(185 * 60_000)).toBe('3h 5m');
    expect(formatAge(72 * 3_600_000)).toBe('3d');
    expect(formatAge(-1)).toBe('?');
  });
});

describe('factory run', () => {
  it('passes mapped options to runFactory', async () => {
    const run = jest.fn().mockResolvedValue({ status: 'idle' });
    await factoryRunCommand({ developers: 2, epic: '9', untilIdle: true, pm: true }, { config, runFactory: run });
    expect(run).toHaveBeenCalledWith(config, { developers: 2, epics: [9], untilIdle: true });
    expect(process.exitCode).toBeUndefined();
  });

  it('fails clearly without a repo, and with exit code 2 when already running', async () => {
    await factoryRunCommand({}, { config: { ...config, repo: '' }, runFactory: jest.fn() });
    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringMatching(/No repository configured/));

    process.exitCode = undefined;
    const run = jest.fn().mockRejectedValue(new Error('factory already running (pid 123)'));
    await factoryRunCommand({}, { config, runFactory: run });
    expect(process.exitCode).toBe(2);
  });
});

describe('factory idea', () => {
  it('appends the idea and prints its id and the inbox path', () => {
    factoryIdeaCommand(['Let', 'the', 'shipper', 'rebase'], { config });
    const ideas = readInbox(paths.inboxPath);
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toEqual(expect.objectContaining({ status: 'pending', text: 'Let the shipper rebase' }));
    expect(output()).toBe(`Added idea ${ideas[0].id} to ${paths.inboxPath}`);
  });

  it('rejects empty text', () => {
    factoryIdeaCommand(['  '], { config });
    expect(process.exitCode).toBe(1);
    expect(existsSync(paths.inboxPath)).toBe(false);
  });
});

describe('factory questions and answer', () => {
  function seed() {
    const open = askQuestion(paths.questionsPath, { role: 'shipper', key: 'ship:5:conflict', pr: 5, question: 'PR #5 conflicts', context: '' }).question;
    const answered = askQuestion(paths.questionsPath, { role: 'developer', key: 'dev:6:failed', issue: 6, question: 'Issue 6 failed', context: '' }).question;
    const applied = askQuestion(paths.questionsPath, { role: 'pm', key: 'pm:I-1', idea: 'I-1', question: 'Old one', context: '' }).question;
    answerQuestion(paths.questionsPath, answered.id, 'retry it');
    answerQuestion(paths.questionsPath, applied.id, 'done');
    markQuestion(paths.questionsPath, applied.id, 'applied');
    return { open, answered, applied };
  }

  it('lists open and answered-unapplied questions by default, everything with --all', () => {
    const { open, answered, applied } = seed();
    factoryQuestionsCommand({}, { config });
    let out = output();
    expect(out).toContain(`${open.id} · open · shipper · PR #5`);
    expect(out).toContain(`${answered.id} · answered · developer · issue #6`);
    expect(out).toContain('answer: retry it');
    expect(out).not.toContain(applied.id);

    logSpy.mockClear();
    factoryQuestionsCommand({ all: true }, { config });
    out = output();
    expect(out).toContain(applied.id);
  });

  it('says so when there are no open questions', () => {
    factoryQuestionsCommand({}, { config });
    expect(output()).toContain('No open questions.');
  });

  it('answers a question by id', () => {
    const { open } = seed();
    factoryAnswerCommand(open.id, ['Rebase', 'it'], { config });
    expect(process.exitCode).toBeUndefined();
    const q = readQuestions(paths.questionsPath).find((x) => x.id === open.id)!;
    expect(q).toEqual(expect.objectContaining({ status: 'answered', answer: 'Rebase it' }));
    expect(output()).toContain(`Answered ${open.id}`);
  });

  it('errors clearly on an unknown id, a closed question, and an empty answer', () => {
    const { open, applied } = seed();
    factoryAnswerCommand('Q-19990101-001', ['x'], { config });
    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenLastCalledWith(expect.stringMatching(/Unknown question id "Q-19990101-001"/));

    process.exitCode = undefined;
    factoryAnswerCommand(applied.id, ['x'], { config });
    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenLastCalledWith(expect.stringMatching(/already applied/));

    process.exitCode = undefined;
    factoryAnswerCommand(open.id, ['TODO'], { config });
    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenLastCalledWith(expect.stringMatching(/Answer is empty/));
  });
});

describe('factory status', () => {
  const NOW = new Date('2026-11-05T12:00:00Z');

  function writeState(over: Partial<FactoryState> = {}): FactoryState {
    const state: FactoryState = {
      version: 1,
      pid: process.pid,
      startedAt: '2026-11-05T11:00:00Z',
      updatedAt: '2026-11-05T11:59:30Z',
      tick: 12,
      status: 'running',
      baseBranch: 'feat/x',
      developers: 2,
      epics: [454],
      workers: [{ id: 'dev-7-abc', role: 'developer', issue: 7, pid: 5555, startedAt: '2026-11-05T11:48:00Z', logPath: '/logs/dev-7/worker.log' }],
      lastPlan: { dispatched: [7], skipped: [{ issue: 8, reason: 'overlap', detail: 'src/lib/x.ts with #7' }] },
      ship: { lastRunAt: '2026-11-05T11:55:00Z', decisions: [{ pr: 12, action: 'wait', reason: 'checks pending' }] },
      counts: { dispatched: 3, succeeded: 1, failed: 1, waiting: 0, merged: 1, ideasIngested: 2, questionsAsked: 1, answersApplied: 0 },
      openQuestions: 1,
      pendingIdeas: 0,
      recent: [],
      ...over,
    };
    mkdirSync(paths.stateDir, { recursive: true });
    writeFileSync(paths.statePath, JSON.stringify(state));
    return state;
  }

  it('reports not running when there is no supervisor lease', async () => {
    await factoryStatusCommand({}, { config, now: () => NOW });
    const out = output();
    expect(out).toContain('Factory: not running');
    expect(out).toContain('Open questions (0):');
    expect(out).toContain(`Inbox: ${paths.inboxPath}`);
  });

  it('shows workers, last plan, counts, ship decisions, and open questions while running', async () => {
    writeState();
    acquireLease(paths.stateDir, 'factory', { owner: 'factory-supervisor', ttlSeconds: 300, now: NOW });
    const q = askQuestion(paths.questionsPath, { role: 'shipper', key: 'ship:12:review-required', pr: 12, question: 'PR #12 needs a review', context: '' }, { now: new Date('2026-11-05T09:00:00Z') }).question;
    factoryIdeaCommand(['An idea'], { config });
    logSpy.mockClear();

    await factoryStatusCommand({}, { config, now: () => NOW });

    const out = output();
    expect(out).toContain(`Factory: running (pid ${process.pid}, tick 12, running)`);
    expect(out).toContain('Base: feat/x · developers: 2 · epics: #454');
    expect(out).toMatch(/dev-7-abc\s+developer\s+#7\s+5555\s+12m\s+-/);
    expect(out).toContain('Log dev-7-abc: /logs/dev-7/worker.log');
    expect(out).toContain('Last plan: dispatched #7; skipped 1');
    expect(out).toContain('#8 overlap (src/lib/x.ts with #7)');
    expect(out).toContain('Counts: dispatched 3 · succeeded 1 · failed 1 · waiting 0 · merged 1');
    expect(out).toContain('PR #12: wait — checks pending');
    expect(out).toContain(`${q.id}  3h  shipper  PR #12 needs a review`);
    expect(out).toContain('Pending ideas: 1');
  });

  it('prints the unchanged JSON snapshot with --json without reading worker logs', async () => {
    const state = writeState({ status: 'stopped' });
    const tails = jest.spyOn(factoryStatus, 'readWorkerLogTails');
    await factoryStatusCommand({ json: true }, { config, now: () => NOW });
    expect(tails).not.toHaveBeenCalled();
    tails.mockRestore();
    const snap = JSON.parse(output());
    expect(Object.keys(snap).sort()).toEqual(['openQuestions', 'paths', 'pendingIdeas', 'running', 'state', 'supervisor']);
    expect(snap.running).toBe(false);
    expect(snap.supervisor).toBeNull();
    expect(snap.state).toEqual(state);
    expect(snap.paths.questionsPath).toBe(paths.questionsPath);
    expect(snap.pendingIdeas).toBe(0);
  });

  it('includes the latest worker log in one-shot text', async () => {
    const logPath = join(root, 'worker.log');
    writeFileSync(logPath, 'old line\nlatest line\n');
    const state = writeState();
    writeState({ workers: [{ ...state.workers[0], logPath }] });
    await factoryStatusCommand({}, { config, now: () => NOW });
    expect(output()).toContain('latest line');
    expect(output()).not.toContain('old line');
    expect(output()).not.toContain('\x1b');
  });

  describe('watch', () => {
    let signals: EventEmitter;
    let write: jest.Mock;

    beforeEach(() => {
      jest.useFakeTimers({ now: NOW });
      signals = new EventEmitter();
      write = jest.fn();
    });
    afterEach(() => {
      signals.emit('SIGINT');
      jest.useRealTimers();
    });

    it('renders immediately and reloads state, tails, questions, inbox, and time every five seconds', async () => {
      const logPath = join(root, 'worker.log');
      writeFileSync(logPath, 'first update\n');
      const state = writeState();
      const workers = [{ ...state.workers[0], startedAt: NOW.toISOString(), logPath }];
      writeState({ workers });
      acquireLease(paths.stateDir, 'factory', { owner: 'factory-supervisor', ttlSeconds: 300, now: NOW });
      const q = askQuestion(paths.questionsPath, { role: 'developer', key: 'dev:7', question: 'Retry?', context: '' }, { now: NOW }).question;
      const watching = factoryStatusCommand({ watch: true }, { config, signals, write, isTTY: false });
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][0]).toContain('first update');
      expect(write.mock.calls[0][0]).toContain(`${q.id}  0s`);
      expect(write.mock.calls[0][0]).toContain('Pending ideas: 0');

      writeFileSync(logPath, 'second update\n');
      writeState({ workers, tick: 13, recent: [{ at: NOW.toISOString(), type: 'worker.started', issue: 7 }] });
      factoryIdeaCommand(['Fresh idea'], { config });
      answerQuestion(paths.questionsPath, q.id, 'yes');
      jest.advanceTimersByTime(4999);
      expect(write).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      const frame = write.mock.calls[1][0];
      expect(frame).toContain('tick 13');
      expect(frame).toMatch(/dev-7-abc\s+developer\s+#7\s+5555\s+5s\s+second update/);
      expect(frame).toContain(`${q.id}  5s  developer  Retry?  [answered]`);
      expect(frame).toContain('Pending ideas: 1');
      expect(frame).toContain('worker.started  issue=7');
      expect(frame).not.toContain('\x1b');

      markQuestion(paths.questionsPath, q.id, 'applied');
      jest.advanceTimersByTime(5000);
      expect(write.mock.calls[2][0]).toContain('Open questions (0):');
      signals.emit('SIGINT');
      await watching;
      expect(jest.getTimerCount()).toBe(0);
      expect(process.exitCode).toBeUndefined();
    });

    it('keeps watching absent or stopped supervisors with a custom cadence and TTY redraws', async () => {
      const watching = factoryStatusCommand({ watch: '0.25' }, { config, signals, write, isTTY: true });
      expect(write.mock.calls[0][0]).toMatch(/^\x1b\[2J\x1b\[HFactory: not running/);
      writeState({ status: 'stopped', workers: [] });
      jest.advanceTimersByTime(249);
      expect(write).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(write.mock.calls[1][0]).toContain('last state stopped');
      expect(write.mock.calls[1][0]).toMatch(/^\x1b\[2J\x1b\[H/);
      rmSync(paths.statePath);
      jest.advanceTimersByTime(250);
      expect(write.mock.calls[2][0]).toContain('Workers (0):');
      signals.emit('SIGINT');
      await watching;
    });

    it.each(['SIGINT', 'SIGTERM'])('cleans up on %s without removing other listeners or stopping workers', async (signal) => {
      const otherListener = jest.fn();
      signals.on(signal, otherListener);
      const kill = jest.spyOn(process, 'kill');
      const watching = factoryStatusCommand({ watch: 2 }, { config, signals, write });
      expect(jest.getTimerCount()).toBe(1);
      signals.emit(signal);
      await watching;
      expect(jest.getTimerCount()).toBe(0);
      expect(signals.listeners(signal)).toEqual([otherListener]);
      expect(signals.listenerCount(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT')).toBe(0);
      expect(otherListener).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(10_000);
      expect(write).toHaveBeenCalledTimes(1);
      expect(kill).not.toHaveBeenCalled();
      kill.mockRestore();
      expect(process.exitCode).toBeUndefined();
    });

    it('installs signal handling before the first frame and does not start a timer after shutdown', async () => {
      write.mockImplementation(() => signals.emit('SIGINT'));
      await factoryStatusCommand({ watch: true }, { config, signals, write });
      expect(jest.getTimerCount()).toBe(0);
      expect(signals.eventNames()).toEqual([]);
      expect(write).toHaveBeenCalledTimes(1);
    });

    it.each([1, 2])('cleans up after an output failure on frame %i', async (failureFrame) => {
      write.mockImplementation(() => {
        if (write.mock.calls.length === failureFrame) throw new Error('output failed');
      });
      const watching = factoryStatusCommand({ watch: true }, { config, signals, write });
      if (failureFrame === 2) jest.advanceTimersByTime(5000);
      await watching;
      expect(jest.getTimerCount()).toBe(0);
      expect(signals.eventNames()).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(mockError).toHaveBeenCalledWith('output failed');
    });

    it('cleans up when collecting the next frame fails', async () => {
      const now = jest.fn().mockReturnValueOnce(NOW).mockImplementation(() => { throw new Error('clock failed'); });
      const watching = factoryStatusCommand({ watch: true }, { config, signals, write, now });
      jest.advanceTimersByTime(5000);
      await watching;
      expect(jest.getTimerCount()).toBe(0);
      expect(signals.eventNames()).toEqual([]);
      expect(mockError).toHaveBeenCalledWith('clock failed');
    });

    it('rejects JSON watch before installing listeners or rendering', async () => {
      await factoryStatusCommand({ watch: true, json: true }, { config, signals, write });
      expect(write).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(signals.eventNames()).toEqual([]);
      expect(mockError).toHaveBeenCalledWith('--watch cannot be combined with --json');
    });
  });
});

describe('factory pm-worker', () => {
  function writeContext(workerId = 'pm-I-abc-1', over: Record<string, unknown> = {}): { contextPath: string; resultPath: string } {
    const dir = join(paths.workersDir, workerId);
    mkdirSync(dir, { recursive: true });
    const contextPath = join(dir, 'context.json');
    const resultPath = join(dir, 'result.json');
    writeFileSync(contextPath, JSON.stringify({
      version: 1,
      workerId,
      idea: { id: 'I-abc', text: 'Auto-rebase stale PRs' },
      priorAnswers: ['Use rebase'],
      resultPath,
      autoReady: true,
      agent: '',
      model: 'opus',
      timeoutSeconds: 120,
      dryRun: false,
      ...over,
    }));
    return { contextPath, resultPath };
  }

  it('runs the PM with the built context and writes a success result', async () => {
    const { contextPath, resultPath } = writeContext();
    const listOpenIssues = jest.fn().mockReturnValue([{ number: 3, title: 'Existing', body: '', labels: ['bug'] }]);
    const decision = { decision: 'issue', reason: 'small', issues: [] };
    const runPm = jest.fn().mockResolvedValue({ decision, createdIssues: [101], note: '#101' });

    await factoryPmWorkerCommand({ context: contextPath }, { config, runPm, listOpenIssues });

    expect(listOpenIssues).toHaveBeenCalledWith('o/r', 300);
    expect(runPm).toHaveBeenCalledWith(config, { id: 'I-abc', text: 'Auto-rebase stale PRs' }, expect.objectContaining({
      model: 'opus',
      timeoutMs: 120_000,
      autoReady: true,
      dryRun: false,
      ctx: expect.objectContaining({
        openIssues: [{ number: 3, title: 'Existing', labels: ['bug'] }],
        priorAnswers: ['Use rebase'],
      }),
    }));
    expect(runPm.mock.calls[0][2]).not.toHaveProperty('agent');
    expect(JSON.parse(readFileSync(resultPath, 'utf-8'))).toEqual({ status: 'success', decision, createdIssues: [101], note: '#101' });
    expect(process.exitCode).toBeUndefined();
  });

  it('reports issues created before a failure so the supervisor does not re-create them', async () => {
    const { contextPath, resultPath } = writeContext();
    const err = Object.assign(new Error('failed to create epic'), { createdIssues: [55, 56] });
    const runPm = jest.fn().mockRejectedValue(err);

    await factoryPmWorkerCommand({ context: contextPath }, { config, runPm, listOpenIssues: jest.fn().mockReturnValue([]) });

    expect(JSON.parse(readFileSync(resultPath, 'utf-8'))).toEqual({
      status: 'failure', createdIssues: [55, 56], note: '', error: 'failed to create epic',
    });
    expect(process.exitCode).toBe(1);
  });

  it('ignores SIGINT, and on SIGTERM before applying writes an interrupted failure result and exits', async () => {
    const { contextPath, resultPath } = writeContext();
    const handlers = new Map<string, () => void>();
    const signals = {
      on: jest.fn((sig: string, fn: () => void) => { handlers.set(sig, fn); }),
      removeListener: jest.fn((sig: string) => { handlers.delete(sig); }),
    };
    const exit = jest.fn();
    const runPm = jest.fn(async () => {
      handlers.get('SIGINT')!();
      expect(exit).not.toHaveBeenCalled();
      handlers.get('SIGTERM')!();
      throw new Error('agent killed');
    });

    await factoryPmWorkerCommand({ context: contextPath }, {
      config, runPm, listOpenIssues: jest.fn().mockReturnValue([]),
      signals: signals as unknown as NodeJS.Process, exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(JSON.parse(readFileSync(resultPath, 'utf-8'))).toEqual(expect.objectContaining({
      status: 'failure', createdIssues: [], interrupted: true,
    }));
    expect(handlers.size).toBe(0);
  });

  it('on SIGTERM while applying, stops before the next write and records every issue created so far', async () => {
    const { contextPath, resultPath } = writeContext();
    const handlers = new Map<string, () => void>();
    const signals = {
      on: jest.fn((sig: string, fn: () => void) => { handlers.set(sig, fn); }),
      removeListener: jest.fn((sig: string) => { handlers.delete(sig); }),
    };
    const exit = jest.fn();
    const runPm = jest.fn(async (_c: unknown, _i: unknown, opts: { onApplyStart: () => void; onIssueCreated: (n: number[]) => void; shouldStop: () => boolean }) => {
      opts.onApplyStart();
      opts.onIssueCreated([71]);
      handlers.get('SIGTERM')!();
      expect(opts.shouldStop()).toBe(true);
      throw Object.assign(new Error('interrupted'), { createdIssues: [71] });
    });

    await factoryPmWorkerCommand({ context: contextPath }, {
      config, runPm: runPm as never, listOpenIssues: jest.fn().mockReturnValue([]),
      signals: signals as unknown as NodeJS.Process, exit,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(resultPath, 'utf-8'))).toEqual(expect.objectContaining({
      status: 'failure', createdIssues: [71], interrupted: true,
    }));
    expect(JSON.parse(readFileSync(join(dirname(resultPath), 'progress.json'), 'utf-8'))).toEqual({ phase: 'applying', createdIssues: [71] });
  });

  it('writes no result for an invalid context', async () => {
    const outside = join(root, 'context.json');
    writeFileSync(outside, '{}');
    const runPm = jest.fn();
    await factoryPmWorkerCommand({ context: outside }, { config, runPm });
    expect(runPm).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mockError).toHaveBeenCalledWith(expect.stringMatching(/Invalid factory PM worker context/));
  });
});
