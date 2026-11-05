jest.mock('../../src/lib/rate-limit', () => ({ ghExec: jest.fn() }));

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFactoryRelease, inspectFactoryRelease, type DueRelease, type FactoryReleaseOptions } from '../../src/lib/factory-release.js';
import { gitLockPath } from '../../src/lib/lease.js';
import { ghExec } from '../../src/lib/rate-limit.js';
import * as shell from '../../src/lib/shell.js';

const mockGh = jest.mocked(ghExec);
const actualExec = shell.exec;
let root: string;
let project: string;
let origin: string;
let options: FactoryReleaseOptions;
let commands: Array<{ command: string; cwd?: string; locked: boolean }>;
let prBody: string;
let prWorktree: string;
let branch: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function commit(message: string): void {
  git(project, 'commit', '--allow-empty', '-m', message);
}

function due(): DueRelease {
  const inspection = inspectFactoryRelease(options);
  expect(inspection.status).toBe('due');
  if (inspection.status !== 'due') throw new Error(inspection.reason);
  return inspection;
}

function checkoutSnapshot(): unknown {
  return {
    branch: git(project, 'symbolic-ref', 'HEAD'),
    head: git(project, 'rev-parse', 'HEAD'),
    status: git(project, 'status', '--porcelain'),
    index: readFileSync(join(project, '.git', 'index')),
    pkg: readFileSync(join(project, 'package.json'), 'utf8'),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release 'quoted'-"));
  project = join(root, 'project');
  origin = join(root, 'origin.git');
  mkdirSync(project);
  git(root, 'init', '--bare', origin);
  git(project, 'init', '-b', 'feat/factory-mode');
  git(project, 'config', 'user.name', 'Release Test');
  git(project, 'config', 'user.email', 'release@example.invalid');
  git(project, 'config', 'commit.gpgsign', 'false');
  git(project, 'config', 'core.hooksPath', join(root, 'no-hooks'));
  writeFileSync(join(project, '.gitignore'), '.alpha-loop/\n');
  writeFileSync(join(project, 'package.json'), '{"name":"release-test","version":"1.2.3"}\n');
  git(project, 'add', '.gitignore', 'package.json');
  commit('chore: initial');
  git(project, 'tag', 'v1.2.3');
  commit('feat(factory): cadence\n\nOne full message\nwith several body lines');
  git(project, 'remote', 'add', 'origin', origin);
  git(project, 'push', '--tags', 'origin', 'feat/factory-mode');
  options = { projectDir: project, repo: 'o/r', baseBranch: 'feat/factory-mode', releaseEvery: 1 };
  branch = 'chore/release-v1.3.0';
  commands = [];
  prBody = '';
  prWorktree = '';
  jest.spyOn(shell, 'exec').mockImplementation((command, opts) => {
    commands.push({ command, cwd: opts?.cwd, locked: existsSync(gitLockPath(project)) });
    return actualExec(command, opts);
  });
  mockGh.mockReset();
  mockGh.mockImplementation((command, opts, mutation) => {
    if (command.startsWith('gh api ')) {
      expect(command).toContain('--paginate --slurp');
      expect(command).not.toContain('base=');
      expect(opts?.cwd).toBe(project);
      expect(mutation).toBeUndefined();
      return { exitCode: 0, stdout: '[[]]', stderr: '' };
    }
    expect(command).toContain('gh pr create');
    expect(command).toContain("--base 'feat/factory-mode'");
    expect(mutation).toBe(true);
    prWorktree = opts!.cwd!;
    expect(prWorktree).not.toBe(project);
    const match = /--body-file '([^']+)'$/.exec(command);
    expect(match).not.toBeNull();
    prBody = readFileSync(match![1], 'utf8');
    expect(JSON.parse(readFileSync(join(prWorktree, 'package.json'), 'utf8')).version).toBe('1.3.0');
    return { exitCode: 0, stdout: 'https://github.com/o/r/pull/99', stderr: '' };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('factory release worktree', () => {
  it('uses origin/base, preserving the checkout branch, tracked files, and staged index byte for byte', () => {
    git(project, 'checkout', '-b', 'local-work', 'v1.2.3');
    commit('feat!: unrelated local work');
    writeFileSync(join(project, 'staged.txt'), 'unrelated staged change');
    git(project, 'add', 'staged.txt');
    writeFileSync(join(project, 'package.json'), '{"version":"99.0.0","dirty":true}\n');
    const before = checkoutSnapshot();
    const inspection = due();
    expect(inspection.plan).toEqual({ version: '1.3.0', bump: 'minor', branch });
    const result = createFactoryRelease(options, inspection);
    expect(result).toMatchObject({ status: 'created', url: 'https://github.com/o/r/pull/99' });
    expect(checkoutSnapshot()).toEqual(before);
    expect(git(origin, 'show', `${branch}^:package.json`)).toBe('{"name":"release-test","version":"1.2.3"}');
    expect(git(origin, 'diff-tree', '--no-commit-id', '--name-only', '-r', branch)).toBe('package.json');
    expect(git(origin, 'rev-parse', `${branch}^`)).toBe(inspection.baseSha);
    expect(prBody).toContain('- feat(factory): cadence');
    expect(prBody).not.toContain('unrelated local work');
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(existsSync(prWorktree)).toBe(false);
    expect(commands.every(c => c.cwd !== undefined)).toBe(true);
    expect(commands.filter(c => /^git '(fetch|worktree|push)'/.test(c.command)).every(c => c.locked)).toBe(true);
    expect(commands.filter(c => /^git '(add|commit|push)'/.test(c.command)).every(c => c.cwd !== project)).toBe(true);
    expect(commands.some(c => /publish|checkout|chdir/.test(c.command))).toBe(false);
  });

  it('checks all pages for an open release on any base before any Git operation', () => {
    mockGh.mockReturnValue({ exitCode: 0, stdout: JSON.stringify([
      Array.from({ length: 100 }, (_, n) => ({ head: { ref: `session/issue-${n}` } })),
      [{ head: { ref: 'chore/release-v9.0.0' }, base: { ref: 'other-base' }, draft: true }],
    ]), stderr: '' });
    expect(inspectFactoryRelease(options)).toEqual({ status: 'skipped', reason: 'an open release PR already exists' });
    expect(commands).toEqual([]);
    expect(existsSync(gitLockPath(project))).toBe(false);
  });

  it('does nothing on subsequent passes once the release PR is open', () => {
    const inspection = due();
    createFactoryRelease(options, inspection);
    commands = [];
    mockGh.mockReturnValue({ exitCode: 0, stdout: `[[{"head":{"ref":"${branch}"}}]]`, stderr: '' });
    expect(inspectFactoryRelease(options).status).toBe('skipped');
    expect(createFactoryRelease(options, inspection).status).toBe('skipped');
    expect(commands).toEqual([]);
    expect(mockGh.mock.calls.filter(([command]) => command.startsWith('gh pr create'))).toHaveLength(1);
  });

  it('keeps shell metacharacters in release notes literal', () => {
    const subject = 'docs: keep "quotes", \'apostrophes\', $(touch injected) and `touch injected`';
    commit(subject);
    git(project, 'push', 'origin', 'feat/factory-mode');
    createFactoryRelease(options, due());
    expect(prBody).toContain(subject);
    expect(git(origin, 'show', '-s', '--format=%B', branch)).toContain(subject);
    expect(existsSync(join(project, 'injected'))).toBe(false);
    expect(git(origin, 'ls-tree', '--name-only', branch)).not.toContain('injected');
  });

  it.each([
    { exitCode: 1, stdout: '', stderr: 'API unavailable' },
    { exitCode: 0, stdout: 'not JSON', stderr: '' },
    { exitCode: 0, stdout: '[[{}]]', stderr: '' },
  ])('fails closed when the duplicate query cannot be trusted: %j', response => {
    mockGh.mockReturnValue(response);
    expect(() => inspectFactoryRelease(options)).toThrow();
    expect(commands).toEqual([]);
  });

  it('is a no-op when disabled', () => {
    expect(inspectFactoryRelease({ ...options, releaseEvery: 0 }).status).toBe('skipped');
    expect(mockGh).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
  });

  it('dry-run uses local remote refs without fetching, locking or writing', () => {
    // Advance the remote behind our local origin snapshot.
    commit('fix!: only visible after fetch');
    git(project, 'push', 'origin', 'feat/factory-mode');
    git(project, 'update-ref', 'refs/remotes/origin/feat/factory-mode', 'HEAD^');
    const before = checkoutSnapshot();
    const dry = inspectFactoryRelease(options, true);
    expect(dry).toMatchObject({ status: 'due', plan: { version: '1.3.0' } });
    expect(commands.some(c => /'(fetch|worktree|commit|push)'/.test(c.command))).toBe(false);
    expect(existsSync(join(project, '.alpha-loop'))).toBe(false);
    expect(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).version).toBe('1.2.3');
    expect(checkoutSnapshot()).toEqual(before);
  });

  it('reports a missing local base in dry-run without fetching or falling back to HEAD', () => {
    git(project, 'update-ref', '-d', 'refs/remotes/origin/feat/factory-mode');
    expect(() => inspectFactoryRelease(options, true)).toThrow('git rev-parse');
    expect(commands.some(c => /'(fetch|worktree|commit|push)'/.test(c.command))).toBe(false);
    expect(existsSync(join(project, '.alpha-loop'))).toBe(false);
  });

  it('selects reachable stable tags and ignores prereleases and tags on other branches', () => {
    git(project, 'tag', 'v1.4.0-rc.1');
    git(project, 'tag', 'notes');
    git(project, 'checkout', '-b', 'unrelated', 'v1.2.3');
    commit('feat!: unrelated');
    git(project, 'tag', 'v9.0.0');
    git(project, 'push', '--tags', 'origin', 'unrelated');
    expect(due()).toMatchObject({ lastTag: 'v1.2.3', plan: { version: '1.3.0' } });
  });

  it('counts full messages and skips merge commits even with nonstandard subjects', () => {
    git(project, 'checkout', '-b', 'side');
    commit('docs: explain');
    git(project, 'checkout', 'feat/factory-mode');
    git(project, 'merge', '--no-ff', 'side', '-m', 'feat!: wrapper only');
    git(project, 'push', 'origin', 'feat/factory-mode');
    expect(inspectFactoryRelease({ ...options, releaseEvery: 3 })).toMatchObject({ status: 'skipped' });
    expect(inspectFactoryRelease({ ...options, releaseEvery: 2 })).toMatchObject({ status: 'due', plan: { version: '1.3.0' } });
  });

  it('supports an initial release without tags', () => {
    git(project, 'tag', '-d', 'v1.2.3');
    git(project, 'push', 'origin', ':refs/tags/v1.2.3');
    expect(due()).toMatchObject({ lastTag: null, plan: { version: '0.1.0' } });
  });

  it('defers after merge until CI tags the release, then starts the next cadence', () => {
    createFactoryRelease(options, due());
    git(project, 'fetch', 'origin', `refs/heads/${branch}`);
    git(project, 'merge', '--ff-only', 'FETCH_HEAD');
    git(project, 'push', 'origin', 'feat/factory-mode');
    expect(inspectFactoryRelease(options)).toEqual({ status: 'skipped', reason: 'waiting for CI to tag the merged release' });
    git(project, 'tag', 'v1.3.0');
    commit('fix: next change');
    git(project, 'push', '--tags', 'origin', 'feat/factory-mode');
    expect(due().plan.version).toBe('1.3.1');
  });

  it('does not wait for a tag after release maintenance that leaves the version unchanged', () => {
    commit('chore(release): repair the publish workflow');
    git(project, 'push', 'origin', 'feat/factory-mode');
    expect(due().plan.version).toBe('1.3.0');
  });

  it('recovers a pushed branch after PR creation fails, even when base advances', () => {
    const handler = mockGh.getMockImplementation()!;
    mockGh.mockImplementation((cmd, opts, mutation) => {
      const result = handler(cmd, opts, mutation);
      return mutation ? { exitCode: 1, stdout: '', stderr: 'PR API unavailable' } : result;
    });
    expect(() => createFactoryRelease(options, due())).toThrow('PR API unavailable');
    expect(existsSync(prWorktree)).toBe(false);
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    const pushed = git(origin, 'rev-parse', branch);
    commit('fix: arrived after failed PR request');
    git(project, 'push', 'origin', 'feat/factory-mode');
    commands = [];
    mockGh.mockImplementation(handler);
    expect(createFactoryRelease(options, due()).status).toBe('created');
    expect(git(origin, 'rev-parse', branch)).toBe(pushed);
    expect(commands.some(c => /^git '(commit|push)'/.test(c.command))).toBe(false);
    expect(prBody).not.toContain('arrived after failed PR request');
  });

  it('refuses an unrelated remote release branch without overwriting it', () => {
    git(project, 'push', 'origin', `HEAD:refs/heads/${branch}`);
    const before = git(origin, 'rev-parse', branch);
    expect(() => createFactoryRelease(options, due())).toThrow('unrelated release branch');
    expect(git(origin, 'rev-parse', branch)).toBe(before);
    expect(commands.some(c => /^git '(push|commit|worktree)'/.test(c.command))).toBe(false);
  });

  it('rechecks for an open release immediately before creating the PR', () => {
    const inspection = due();
    mockGh.mockReturnValueOnce({ exitCode: 0, stdout: '[[]]', stderr: '' })
      .mockReturnValueOnce({ exitCode: 0, stdout: '[[{"head":{"ref":"chore/release-v2.0.0"}}]]', stderr: '' });
    expect(createFactoryRelease(options, inspection)).toEqual({ status: 'skipped', reason: 'an open release PR already exists' });
    expect(mockGh.mock.calls.some(([command]) => command.startsWith('gh pr create'))).toBe(false);
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('cleans up the worktree if pushing fails and leaves the checkout untouched', () => {
    const inspection = due();
    const before = checkoutSnapshot();
    jest.spyOn(shell, 'exec').mockImplementation((command, opts) => {
      if (command.startsWith("git 'push'")) return { exitCode: 1, stdout: '', stderr: 'push denied' };
      return actualExec(command, opts);
    });
    expect(() => createFactoryRelease(options, inspection)).toThrow('push denied');
    expect(checkoutSnapshot()).toEqual(before);
    expect(git(project, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    expect(git(origin, 'for-each-ref', `refs/heads/${branch}`)).toBe('');
  });
});
