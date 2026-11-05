import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readWorkerLogTail,
  readWorkerLogTails,
  renderFactoryStatus,
  type FactoryStatusSnapshot,
} from '../../src/lib/factory-status.js';

const now = new Date('2026-11-05T12:00:00Z');

function snapshot(): FactoryStatusSnapshot {
  return {
    running: true,
    supervisor: { pid: 123, hostname: 'host', acquiredAt: '2026-11-05T11:00:00Z', refreshedAt: now.toISOString() },
    state: {
      version: 1, pid: 123, startedAt: '2026-11-05T11:00:00Z', updatedAt: now.toISOString(),
      tick: 12, status: 'running', baseBranch: 'feat/factory-mode', developers: 2, epics: [454],
      workers: [
        { id: 'dev-447', role: 'developer', issue: 447, pid: 456, startedAt: '2026-11-05T11:48:00Z', logPath: '/factory/dev/worker.log' },
        { id: 'pm-idea', role: 'pm', ideaId: 'I-1', pid: null, startedAt: 'invalid', logPath: '/factory/pm/worker.log' },
      ],
      lastPlan: { dispatched: [447], skipped: [{ issue: 448, reason: 'overlap', detail: 'src/cli.ts with #447' }] },
      ship: { lastRunAt: '2026-11-05T11:55:00Z', error: 'GitHub unavailable', decisions: [{ pr: 9, action: 'wait', reason: 'checks pending' }] },
      counts: { dispatched: 3, succeeded: 1, failed: 1, waiting: 0, merged: 1, ideasIngested: 2, questionsAsked: 2, answersApplied: 0 },
      openQuestions: 2, pendingIdeas: 3,
      recent: [
        { at: 'old', type: 'excluded' },
        { at: '2026-11-05T11:50:00Z', type: 'worker.started', issue: 447, workerId: 'dev-447' },
        { at: '2026-11-05T11:51:00Z', type: 'idea.ingested', createdIssues: [1, 2] },
        { at: '2026-11-05T11:52:00Z', type: 'ship.error', error: 'offline\nretry later' },
        { at: '2026-11-05T11:53:00Z', type: 'ship.pass', prs: 1, merged: 0 },
        { at: '2026-11-05T11:54:00Z', type: 'factory.draining' },
      ],
    },
    openQuestions: [
      { id: 'Q-1', status: 'open', role: 'shipper', askedAt: '2026-11-05T09:00:00Z', key: 'ship:9', question: 'Merge PR #9?\nMore context' },
      { id: 'Q-2', status: 'answered', role: 'developer', askedAt: 'invalid', key: 'dev:1', question: 'Retry?' },
    ],
    pendingIdeas: 3,
    paths: { stateDir: '/factory', inboxPath: '/factory/inbox.md', questionsPath: '/factory/questions.md', leasesDir: '/factory/leases', workersDir: '/factory/workers', statePath: '/factory/state.json', eventsPath: '/factory/events.jsonl', lockDir: '/factory/locks' },
  };
}

describe('renderFactoryStatus', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renders workers, ages, pending ideas, and the last five events without side effects', () => {
    const snap = snapshot();
    const before = JSON.stringify(snap);
    const read = jest.spyOn(fs, 'readFileSync');
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('clock used'); });
    const print = jest.spyOn(console, 'log').mockImplementation(() => {});
    const rendered = renderFactoryStatus(snap, { tails: { 'dev-447': '\x1b[32mTests passed\x1b[0m\r\nNext\tstep\x07' }, now });
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();
    expect(print).not.toHaveBeenCalled();
    expect(rendered).toMatchInlineSnapshot(`
"Factory: running (pid 123, tick 12, running)
Base: feat/factory-mode · developers: 2 · epics: #454
Workers (2):
  ID       Role       Issue / idea  PID  Elapsed  Last log line
  dev-447  developer  #447          456  12m      Tests passed Next step
  pm-idea  pm         I-1           -    ?        -
  Log dev-447: /factory/dev/worker.log
  Log pm-idea: /factory/pm/worker.log
Last plan: dispatched #447; skipped 1
  #448 overlap (src/cli.ts with #447)
Counts: dispatched 3 · succeeded 1 · failed 1 · waiting 0 · merged 1 · ideas 2 · questions 2
Ship: last pass 2026-11-05T11:55:00Z — error: GitHub unavailable
  PR #9: wait — checks pending
Open questions (2):
  Q-1  3h  shipper  Merge PR #9?
  Q-2  ?  developer  Retry?  [answered]
Pending ideas: 3
Recent events (5):
  2026-11-05T11:50:00Z  worker.started  issue=447 workerId=dev-447
  2026-11-05T11:51:00Z  idea.ingested  createdIssues=[1,2]
  2026-11-05T11:52:00Z  ship.error  error=offline retry later
  2026-11-05T11:53:00Z  ship.pass  prs=1 merged=0
  2026-11-05T11:54:00Z  factory.draining
Inbox: /factory/inbox.md
Questions: /factory/questions.md
State: /factory/state.json"
`);
    expect(rendered).not.toContain('excluded');
    expect(rendered).not.toContain('\x1b');
    expect(JSON.stringify(snap)).toBe(before);
  });

  it('renders stopped workers as last recorded data', () => {
    const snap = snapshot();
    snap.running = false;
    snap.state!.status = 'stopped';
    expect(renderFactoryStatus(snap, { tails: {}, now })).toMatchInlineSnapshot(`
"Factory: not running (last state stopped at 2026-11-05T12:00:00.000Z)
Base: feat/factory-mode · developers: 2 · epics: #454
Workers (2, last recorded):
  ID       Role       Issue / idea  PID  Elapsed  Last log line
  dev-447  developer  #447          456  12m      -
  pm-idea  pm         I-1           -    ?        -
  Log dev-447: /factory/dev/worker.log
  Log pm-idea: /factory/pm/worker.log
Last plan: dispatched #447; skipped 1
  #448 overlap (src/cli.ts with #447)
Counts: dispatched 3 · succeeded 1 · failed 1 · waiting 0 · merged 1 · ideas 2 · questions 2
Ship: last pass 2026-11-05T11:55:00Z — error: GitHub unavailable
  PR #9: wait — checks pending
Open questions (2):
  Q-1  3h  shipper  Merge PR #9?
  Q-2  ?  developer  Retry?  [answered]
Pending ideas: 3
Recent events (5):
  2026-11-05T11:50:00Z  worker.started  issue=447 workerId=dev-447
  2026-11-05T11:51:00Z  idea.ingested  createdIssues=[1,2]
  2026-11-05T11:52:00Z  ship.error  error=offline retry later
  2026-11-05T11:53:00Z  ship.pass  prs=1 merged=0
  2026-11-05T11:54:00Z  factory.draining
Inbox: /factory/inbox.md
Questions: /factory/questions.md
State: /factory/state.json"
`);
  });

  it('renders an empty factory before the first state file exists', () => {
    const snap = snapshot();
    snap.running = false;
    snap.supervisor = null;
    snap.state = null;
    snap.openQuestions = [];
    snap.pendingIdeas = 0;
    expect(renderFactoryStatus(snap, { tails: {}, now })).toMatchInlineSnapshot(`
"Factory: not running
Workers (0):
  (none)
Open questions (0):
Pending ideas: 0
Recent events (0):
Inbox: /factory/inbox.md
Questions: /factory/questions.md
State: /factory/state.json"
`);
  });
});

describe('worker log tails', () => {
  let root: string;
  let path: string;

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'factory-tail-'));
    path = join(root, 'worker.log');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['first\nlast\n\n  \n', 'last'],
    ['first\r\nlast\r\n', 'last'],
    ['first\nunfinished', 'unfinished'],
    ['first\n\x1b[32mlast\x1b[0m\tline\x07\n', 'last line'],
    ['', '-'],
    [' \r\n\x1b[0m\n', '-'],
  ])('returns the last nonblank line from %j', (content, expected) => {
    fs.writeFileSync(path, content);
    expect(readWorkerLogTail(path)).toBe(expected);
  });

  it('reads only the final 4096 bytes, even in a multibyte log', () => {
    const contents = `${'🙂'.repeat(5000)}\nlatest update\n`;
    fs.writeFileSync(path, contents);
    const read = jest.spyOn(fs, 'readSync');
    const wholeFile = jest.spyOn(fs, 'readFileSync');
    expect(readWorkerLogTail(path)).toBe('latest update');
    expect(wholeFile).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.any(Number), expect.any(Buffer), 0, 4096, Buffer.byteLength(contents) - 4096);
    expect((read.mock.calls[0][1] as Buffer).length).toBe(4096);
  });

  it('marks a line that extends before the read window', () => {
    fs.writeFileSync(path, 'x'.repeat(6000));
    expect(readWorkerLogTail(path)).toBe(`…${'x'.repeat(4096)}`);
  });

  it('reopens logs after rotation or truncation and tolerates missing logs', () => {
    const workers = [{ id: 'dev', logPath: path }, { id: 'pm', logPath: join(root, 'missing') }];
    fs.writeFileSync(path, 'old line');
    expect(readWorkerLogTails(workers)).toEqual({ dev: 'old line', pm: '-' });
    fs.renameSync(path, `${path}.old`);
    fs.writeFileSync(path, 'new line');
    expect(readWorkerLogTails(workers).dev).toBe('new line');
    fs.truncateSync(path, 0);
    expect(readWorkerLogTails(workers).dev).toBe('-');
  });

  it('uses bytesRead if the file shrinks between stat and read', () => {
    fs.writeFileSync(path, 'stale contents');
    jest.spyOn(fs, 'readSync').mockImplementation((_fd, buffer) => {
      (buffer as Buffer).write('new');
      return 3;
    });
    expect(readWorkerLogTail(path)).toBe('new');
  });

  it('closes descriptors after read failures and tolerates unreadable logs', () => {
    fs.writeFileSync(path, 'contents');
    const close = jest.spyOn(fs, 'closeSync');
    jest.spyOn(fs, 'readSync').mockImplementation(() => { throw new Error('read failed'); });
    expect(readWorkerLogTail(path)).toBe('-');
    expect(close).toHaveBeenCalledTimes(1);
    jest.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('permission denied'); });
    expect(readWorkerLogTail(path)).toBe('-');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
