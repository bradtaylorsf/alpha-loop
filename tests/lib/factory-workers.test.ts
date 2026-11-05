import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FACTORY_CONFIG, resolveFactoryPaths, type Config, type FactoryPaths } from '../../src/lib/config.js';
import {
  readPmProgress,
  readPmWorkerContext,
  readWorkerResult,
  sessionSlugFor,
  spawnDeveloperWorker,
  spawnPmWorker,
  type SpawnImpl,
} from '../../src/lib/factory-workers.js';
import type { InboxIdea } from '../../src/lib/factory-inbox.js';
import { readFactoryWorkerContext } from '../../src/commands/run.js';

type FakeChild = EventEmitter & { pid?: number; kill: jest.Mock };

function fakeSpawn(pid: number | undefined = 4242): { impl: SpawnImpl; calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>; child: FakeChild } {
  const child = Object.assign(new EventEmitter(), { pid, kill: jest.fn() }) as FakeChild;
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const impl = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return child;
  }) as unknown as SpawnImpl;
  return { impl, calls, child };
}

const NOW = new Date('2026-11-05T10:00:00Z');

describe('factory workers', () => {
  let root: string;
  let config: Config;
  let paths: FactoryPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-workers-'));
    config = { factory: { ...DEFAULT_FACTORY_CONFIG, stateDir: join(root, 'factory') } } as unknown as Config;
    paths = resolveFactoryPaths(config);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('sessionSlugFor', () => {
    it('slugifies and caps the title at 40 characters', () => {
      expect(sessionSlugFor(12, 'Let the Shipper auto-rebase stale PRs!')).toBe('issue-12-let-the-shipper-auto-rebase-stale-prs');
      const long = sessionSlugFor(7, 'a'.repeat(39) + ' bbbbbb');
      expect(long).toBe(`issue-7-${'a'.repeat(39)}`);
      expect(sessionSlugFor(3, '!!!')).toBe('issue-3');
    });
  });

  describe('spawnDeveloperWorker', () => {
    it('writes a context run.ts accepts and spawns run --issue --factory-worker from the project root', () => {
      const { impl, calls } = fakeSpawn();
      const handle = spawnDeveloperWorker({
        paths, issue: 12, title: 'Add the thing', baseBranch: 'feat/x', model: 'm1', verbose: true, spawnImpl: impl, now: NOW,
      });

      expect(handle.id).toBe(`dev-12-${NOW.getTime().toString(36)}`);
      expect(handle.role).toBe('developer');
      expect(handle.issue).toBe(12);
      expect(handle.pid).toBe(4242);
      expect(handle.contextPath).toBe(join(paths.workersDir, handle.id, 'context.json'));
      expect(handle.resultPath).toBe(join(paths.workersDir, handle.id, 'result.json'));
      expect(handle.logPath).toBe(join(paths.workersDir, handle.id, 'worker.log'));

      const ctx = JSON.parse(readFileSync(handle.contextPath, 'utf-8'));
      expect(ctx).toEqual({
        version: 1,
        workerId: handle.id,
        issueNumber: 12,
        baseBranch: 'feat/x',
        sessionSlug: 'issue-12-add-the-thing',
        resultPath: handle.resultPath,
        model: 'm1',
      });
      // The real validator in run.ts accepts exactly this shape and location.
      const validated = readFactoryWorkerContext(config, handle.contextPath, 12);
      expect(validated.sessionSlug).toBe('issue-12-add-the-thing');
      expect(validated.resultPath).toBe(handle.resultPath);

      expect(calls).toHaveLength(1);
      const { command, args, options } = calls[0];
      expect(command).toBe(process.execPath);
      expect(args.slice(-6)).toEqual(['run', '--issue', '12', '--factory-worker', handle.contextPath, '--verbose']);
      expect(options.cwd).toBe(process.cwd());
      expect((options.env as Record<string, string>).ALPHA_LOOP_FACTORY_WORKER).toBe(handle.id);
      const stdio = options.stdio as unknown[];
      expect(stdio[0]).toBe('ignore');
      expect(typeof stdio[1]).toBe('number');
    });

    it('resolves done with the parsed result when the child closes', async () => {
      const { impl, child } = fakeSpawn();
      const handle = spawnDeveloperWorker({ paths, issue: 5, title: 'x', baseBranch: 'master', spawnImpl: impl, now: NOW });
      writeFileSync(handle.resultPath, JSON.stringify({ issueNumber: 5, status: 'success', failures: [] }));
      child.emit('close', 0, null);
      await expect(handle.done).resolves.toEqual({ exitCode: 0, result: { issueNumber: 5, status: 'success', failures: [] } });
    });

    it('reports a missing result file as an error with a null result', async () => {
      const { impl, child } = fakeSpawn();
      const handle = spawnDeveloperWorker({ paths, issue: 5, title: 'x', baseBranch: 'master', spawnImpl: impl, now: NOW });
      child.emit('close', 1, null);
      const exit = await handle.done;
      expect(exit.exitCode).toBe(1);
      expect(exit.result).toBeNull();
      expect(exit.error).toMatch(/no result file/);
    });

    it('reports an unparseable result file and a terminating signal', async () => {
      const { impl, child } = fakeSpawn();
      const handle = spawnDeveloperWorker({ paths, issue: 5, title: 'x', baseBranch: 'master', spawnImpl: impl, now: NOW });
      writeFileSync(handle.resultPath, '{not json');
      child.emit('close', null, 'SIGTERM');
      const exit = await handle.done;
      expect(exit.exitCode).toBe(1);
      expect(exit.result).toBeNull();
      expect(exit.error).toMatch(/terminated by SIGTERM/);
      expect(exit.error).toMatch(/not valid JSON/);
    });

    it('treats a process error event as a failure and settles only once', async () => {
      const { impl, child } = fakeSpawn();
      const handle = spawnDeveloperWorker({ paths, issue: 5, title: 'x', baseBranch: 'master', spawnImpl: impl, now: NOW });
      child.emit('error', new Error('ENOENT'));
      child.emit('close', 0, null);
      const exit = await handle.done;
      expect(exit.exitCode).toBe(1);
      expect(exit.error).toMatch(/worker process error: ENOENT/);
    });

    it('forwards kill signals to the child (SIGTERM by default)', () => {
      const { impl, child } = fakeSpawn();
      const handle = spawnDeveloperWorker({ paths, issue: 5, title: 'x', baseBranch: 'master', spawnImpl: impl, now: NOW });
      handle.kill();
      handle.kill('SIGKILL');
      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    });

    it('returns a settled failure handle when spawn throws', async () => {
      const impl = (() => { throw new Error('spawn EAGAIN'); }) as unknown as SpawnImpl;
      const handle = spawnDeveloperWorker({ paths, issue: 5, title: 'x', baseBranch: 'master', spawnImpl: impl, now: NOW });
      expect(handle.pid).toBeNull();
      const exit = await handle.done;
      expect(exit).toEqual({ exitCode: 1, result: null, error: 'failed to start worker: spawn EAGAIN' });
      expect(() => handle.kill()).not.toThrow();
    });
  });

  describe('spawnPmWorker and readPmWorkerContext', () => {
    const idea: InboxIdea = { id: 'I-abc123', status: 'pending', text: 'Rebase stale PRs', note: '', line: 4, meta: {} };

    it('writes a PM context and spawns factory pm-worker --context', () => {
      const { impl, calls } = fakeSpawn(99);
      const handle = spawnPmWorker({
        paths,
        idea,
        priorAnswers: ['use rebase, not merge'],
        pm: { autoReady: true, agent: 'claude', model: '', timeoutSeconds: 120 },
        spawnImpl: impl,
        now: NOW,
      });
      expect(handle.role).toBe('pm');
      expect(handle.ideaId).toBe('I-abc123');
      expect(calls[0].args.slice(-4)).toEqual(['factory', 'pm-worker', '--context', handle.contextPath]);

      const ctx = readPmWorkerContext(paths, handle.contextPath);
      expect(ctx).toEqual({
        version: 1,
        workerId: handle.id,
        idea: { id: 'I-abc123', text: 'Rebase stale PRs' },
        priorAnswers: ['use rebase, not merge'],
        resultPath: handle.resultPath,
        autoReady: true,
        agent: 'claude',
        model: '',
        timeoutSeconds: 120,
        dryRun: false,
      });
    });

    it('rejects a context outside the workers directory', () => {
      const outside = join(root, 'elsewhere', 'w1', 'context.json');
      mkdirSync(join(root, 'elsewhere', 'w1'), { recursive: true });
      writeFileSync(outside, JSON.stringify({ version: 1, workerId: 'w1', idea: { id: 'I-1', text: 't' }, resultPath: join(root, 'elsewhere', 'w1', 'result.json') }));
      expect(() => readPmWorkerContext(paths, outside)).toThrow(/workers\/<workerId>\/context.json/);
    });

    it('rejects a result path that is not the sibling result.json', () => {
      const dir = join(paths.workersDir, 'pm-1');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'context.json'), JSON.stringify({ version: 1, workerId: 'pm-1', idea: { id: 'I-1', text: 't' }, resultPath: join(root, 'x.json') }));
      expect(() => readPmWorkerContext(paths, join(dir, 'context.json'))).toThrow(/sibling result.json/);
    });

    it('rejects a mismatched worker id and an empty idea', () => {
      const dir = join(paths.workersDir, 'pm-2');
      mkdirSync(dir, { recursive: true });
      const ctxPath = join(dir, 'context.json');
      writeFileSync(ctxPath, JSON.stringify({ version: 1, workerId: 'other', idea: { id: 'I-1', text: 't' }, resultPath: join(dir, 'result.json') }));
      expect(() => readPmWorkerContext(paths, ctxPath)).toThrow(/does not match/);
      writeFileSync(ctxPath, JSON.stringify({ version: 1, workerId: 'pm-2', idea: { id: 'I-1', text: '  ' }, resultPath: join(dir, 'result.json') }));
      expect(() => readPmWorkerContext(paths, ctxPath)).toThrow(/idea must be/);
    });
  });

  it('readWorkerResult distinguishes missing, invalid, and valid files', () => {
    const p = join(root, 'r.json');
    expect(readWorkerResult(p)).toEqual({ result: null, error: expect.stringMatching(/no result file/) });
    writeFileSync(p, 'nope');
    expect(readWorkerResult(p).error).toMatch(/not valid JSON/);
    writeFileSync(p, '{"a":1}');
    expect(readWorkerResult(p)).toEqual({ result: { a: 1 } });
  });
  describe('process groups (regression)', () => {
    it('spawns detached and kills the whole process group, falling back to the child', () => {
      const { impl, calls, child } = fakeSpawn(4242);
      const killGroup = jest.fn();
      const handle = spawnDeveloperWorker({ paths, issue: 5, title: 'x', baseBranch: 'master', spawnImpl: impl, killGroup, now: NOW });
      expect(calls[0].options.detached).toBe(true);
      handle.kill('SIGTERM');
      expect(killGroup).toHaveBeenCalledWith(4242, 'SIGTERM');
      expect(child.kill).not.toHaveBeenCalled();

      killGroup.mockImplementation(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });
      handle.kill('SIGKILL');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('never signals a process group for an injected (fake) spawn unless asked', () => {
      const { impl, child } = fakeSpawn(4242);
      const handle = spawnDeveloperWorker({ paths, issue: 5, title: 'x', baseBranch: 'master', spawnImpl: impl, now: NOW });
      handle.kill('SIGTERM');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('readPmProgress', () => {
    it('reads the PM progress sidecar next to result.json', () => {
      const dir = join(root, 'w');
      mkdirSync(dir, { recursive: true });
      const resultPath = join(dir, 'result.json');
      expect(readPmProgress(resultPath)).toBeNull();
      writeFileSync(join(dir, 'progress.json'), JSON.stringify({ phase: 'applying', createdIssues: [3, 'x', -1, 4] }));
      expect(readPmProgress(resultPath)).toEqual({ phase: 'applying', createdIssues: [3, 4] });
    });
  });
});
