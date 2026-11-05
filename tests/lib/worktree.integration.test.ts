import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupWorktree } from '../../src/lib/worktree';

describe('setupWorktree with real repositories', () => {
  let fixture: string;
  let projectDir: string;
  let origin: string;
  const branch = 'agent/issue-42';
  const initialCwd = process.cwd();

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'alpha-loop-worktree-'));
    projectDir = join(fixture, 'project');
    origin = join(fixture, 'origin.git');
    mkdirSync(projectDir);
    git(fixture, 'init', '--bare', '--initial-branch=master', origin);
    git(projectDir, 'init', '--initial-branch=master');
    git(projectDir, 'config', 'user.name', 'Worktree test');
    git(projectDir, 'config', 'user.email', 'worktree@example.test');
    git(projectDir, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(projectDir, 'tracked.txt'), 'base\n');
    git(projectDir, 'add', 'tracked.txt');
    git(projectDir, 'commit', '-m', 'base');
    git(projectDir, 'remote', 'add', 'origin', origin);
    git(projectDir, 'push', '-u', 'origin', 'master');
  });

  afterEach(() => {
    // All repositories and worktrees in this suite belong to this fixture.
    rmSync(fixture, { recursive: true, force: true });
    expect(process.cwd()).toBe(initialCwd);
  });

  function options(allowDestructive: boolean | undefined) {
    return { issueNum: 42, projectDir, baseBranch: 'master', skipInstall: true, allowDestructive };
  }

  function commitIssueBranch(): string {
    git(projectDir, 'checkout', '-b', branch);
    writeFileSync(join(projectDir, 'tracked.txt'), 'previous worker commit\n');
    git(projectDir, 'commit', '-am', 'previous work');
    const tip = git(projectDir, 'rev-parse', 'HEAD');
    git(projectDir, 'checkout', 'master');
    return tip;
  }

  test.each([false, true, undefined])('remote-only branch is preserved unless cleanup is allowed (%s)', async allowDestructive => {
    const tip = commitIssueBranch();
    git(projectDir, 'push', 'origin', branch);
    git(projectDir, 'branch', '-D', branch);

    const result = await setupWorktree(options(allowDestructive));

    expect(result.resumed).toBe(allowDestructive === false);
    if (allowDestructive === false) {
      // Protect every remote branch, including a PR head, without a GitHub query.
      expect(git(origin, 'rev-parse', `refs/heads/${branch}`)).toBe(tip);
      expect(git(result.path, 'rev-parse', 'HEAD')).toBe(tip);
      expect(readFileSync(join(result.path, 'tracked.txt'), 'utf-8')).toBe('previous worker commit\n');
    } else {
      expect(git(projectDir, 'ls-remote', '--heads', 'origin', branch)).toBe('');
      expect(git(result.path, 'rev-parse', 'HEAD')).toBe(git(projectDir, 'rev-parse', 'master'));
    }
  });

  test.each([false, true, undefined])('dirty wrong-branch worktree requires cleanup permission (%s)', async allowDestructive => {
    const path = join(projectDir, '.worktrees', 'issue-42');
    git(projectDir, 'worktree', 'add', '-b', 'other-worker', path, 'master');
    writeFileSync(join(path, 'tracked.txt'), 'uncommitted work\n');
    writeFileSync(join(path, 'untracked.txt'), 'untracked work\n');

    const attempt = setupWorktree(options(allowDestructive));
    if (allowDestructive === false) {
      await expect(attempt).rejects.toThrow(/lease.*allowDestructive/);
      expect(git(path, 'branch', '--show-current')).toBe('other-worker');
      expect(readFileSync(join(path, 'tracked.txt'), 'utf-8')).toBe('uncommitted work\n');
      expect(readFileSync(join(path, 'untracked.txt'), 'utf-8')).toBe('untracked work\n');
    } else {
      await expect(attempt).resolves.toMatchObject({ resumed: false });
      expect(git(path, 'branch', '--show-current')).toBe(branch);
      expect(readFileSync(join(path, 'tracked.txt'), 'utf-8')).toBe('base\n');
      expect(existsSync(join(path, 'untracked.txt'))).toBe(false);
    }
  });

  test.each(['missing', 'stale'])('recovers the remote tip with a restricted fetch and %s tracking ref', async trackingRef => {
    const tip = commitIssueBranch();
    git(projectDir, 'push', 'origin', branch);
    git(projectDir, 'branch', '-D', branch);
    // Single-branch clones do not update issue tracking refs on a plain fetch.
    git(projectDir, 'config', 'remote.origin.fetch', '+refs/heads/master:refs/remotes/origin/master');
    if (trackingRef === 'missing') {
      git(projectDir, 'update-ref', '-d', `refs/remotes/origin/${branch}`);
    } else {
      git(projectDir, 'update-ref', `refs/remotes/origin/${branch}`, git(projectDir, 'rev-parse', 'master'));
    }

    const result = await setupWorktree(options(false));

    expect(result.resumed).toBe(true);
    expect(git(result.path, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(origin, 'rev-parse', `refs/heads/${branch}`)).toBe(tip);
    expect(readFileSync(join(result.path, 'tracked.txt'), 'utf-8')).toBe('previous worker commit\n');
  });

  test.each([false, true, undefined])('failed attachment preserves the local tip without permission (%s)', async allowDestructive => {
    const tip = commitIssueBranch();
    mkdirSync(join(projectDir, '.worktrees'));
    // A file in the parent path makes real git worktree attachment fail.
    writeFileSync(join(projectDir, '.worktrees', 'blocked'), 'obstruction');
    const attempt = setupWorktree({
      ...options(allowDestructive),
      worktreePath: join(projectDir, '.worktrees', 'blocked', 'issue-42'),
    });

    await expect(attempt).rejects.toThrow(allowDestructive === false ? /lease.*allowDestructive/ : /Failed to create/);
    if (allowDestructive === false) {
      expect(git(projectDir, 'rev-parse', branch)).toBe(tip);
    } else {
      // Legacy cleanup discards the old tip before its fresh attachment fails.
      expect(git(projectDir, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branch}`)).not.toBe(tip);
    }
    expect(readFileSync(join(projectDir, '.worktrees', 'blocked'), 'utf-8')).toBe('obstruction');
  });

  test('creates a fresh branch when origin confirms absence without permission', async () => {
    const result = await setupWorktree(options(false));
    expect(result.resumed).toBe(false);
    expect(git(result.path, 'rev-parse', 'HEAD')).toBe(git(projectDir, 'rev-parse', 'master'));
  });
});
