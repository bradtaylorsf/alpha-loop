import { setupWorktree, cleanupWorktree, composeProjectName, gitLockPath, allowDestructiveWorktreeSetup } from '../../src/lib/worktree';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FACTORY_CONFIG } from '../../src/lib/config';
import type { LeasePayload } from '../../src/lib/lease';

// Mock dependencies
jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  shellQuote: (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`,
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

// node:fs is mocked below, so the real cross-process lock can't run here;
// record the lock path and run the critical section inline.
jest.mock('../../src/lib/lease', () => ({
  ...jest.requireActual('../../src/lib/lease'),
  withFileLockSync: jest.fn((_path: string, fn: () => unknown) => fn()),
}));

jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  symlinkSync: jest.fn(),
  readlinkSync: jest.fn(),
  unlinkSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue(''),
  writeFileSync: jest.fn(),
  appendFileSync: jest.fn(),
}));

import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { withFileLockSync } from '../../src/lib/lease';
import { existsSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockWithFileLock = withFileLockSync as jest.MockedFunction<typeof withFileLockSync>;
const mockExists = existsSync as jest.MockedFunction<typeof existsSync>;
const mockMkdir = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockSymlink = symlinkSync as jest.MockedFunction<typeof symlinkSync>;
const mockWriteFile = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
const mockReadFile = readFileSync as jest.MockedFunction<typeof readFileSync>;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: commands succeed, paths don't exist
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
  mockExists.mockReturnValue(false);
  mockReadFile.mockReturnValue('');
});

describe('allowDestructiveWorktreeSetup', () => {
  let previousWorker: string | undefined;
  const liveLease = (): LeasePayload => ({
    version: 1, key: 'issue-42', owner: 'factory', pid: process.pid,
    hostname: hostname(), token: 'lease-token', workerPid: process.pid,
    acquiredAt: new Date().toISOString(), refreshedAt: new Date().toISOString(),
    ttlSeconds: 60, meta: { issue: 42, workerId: 'dev-42' },
  });

  beforeEach(() => {
    previousWorker = process.env.ALPHA_LOOP_FACTORY_WORKER;
    process.env.ALPHA_LOOP_FACTORY_WORKER = 'dev-42';
    mockReadFile.mockReturnValue(JSON.stringify(liveLease()));
  });
  afterEach(() => {
    if (previousWorker === undefined) delete process.env.ALPHA_LOOP_FACTORY_WORKER;
    else process.env.ALPHA_LOOP_FACTORY_WORKER = previousWorker;
  });

  test('ordinary callers retain permission without reading a lease', () => {
    delete process.env.ALPHA_LOOP_FACTORY_WORKER;
    expect(allowDestructiveWorktreeSetup({}, 42)).toBe(true);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  test('permits the live owner and rechecks ownership on the next attempt', () => {
    expect(allowDestructiveWorktreeSetup({}, 42)).toBe(true);
    mockReadFile.mockReturnValue(JSON.stringify({ ...liveLease(), workerPid: process.pid + 1 }));
    expect(allowDestructiveWorktreeSetup({}, 42)).toBe(false);
  });

  test.each([
    ['foreign worker', { meta: { issue: 42, workerId: 'dev-other' } }],
    ['wrong issue', { meta: { issue: 43, workerId: 'dev-42' } }],
    ['wrong key', { key: 'issue-43' }],
    ['foreign host', { hostname: `${hostname()}-other` }],
    ['missing host', { hostname: undefined }],
    ['wrong PID', { workerPid: process.pid + 1 }],
    ['missing worker PID', { workerPid: undefined }],
    ['missing metadata', { meta: undefined }],
    ['expired', { refreshedAt: new Date(0).toISOString() }],
    ['expired singleton override', { refreshedAt: new Date(0).toISOString(), aliveOverridesTtl: true }],
    ['invalid timestamp without TTL', { refreshedAt: 'invalid', ttlSeconds: 0 }],
    ['invalid owner PID', { pid: 0 }],
    ['invalid acquisition time', { acquiredAt: undefined }],
    ['missing token', { token: undefined }],
  ] satisfies Array<[string, Partial<LeasePayload>]>)('refuses %s leases', (_name, overrides) => {
    mockReadFile.mockReturnValue(JSON.stringify({ ...liveLease(), ...overrides }));
    expect(allowDestructiveWorktreeSetup({}, 42)).toBe(false);
  });

  test.each(['', '{corrupt', '{}', 'null'])('refuses missing or corrupt lease content %j', content => {
    mockReadFile.mockReturnValue(content);
    expect(allowDestructiveWorktreeSetup({}, 42)).toBe(false);
  });

  test('refuses an unreadable lease and an empty worker context', () => {
    mockReadFile.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(allowDestructiveWorktreeSetup({}, 42)).toBe(false);
    process.env.ALPHA_LOOP_FACTORY_WORKER = '';
    expect(allowDestructiveWorktreeSetup({}, 42)).toBe(false);
  });

  test.each(['custom/factory', '/tmp/custom-factory'])('uses configured state directory %s', stateDir => {
    expect(allowDestructiveWorktreeSetup({ factory: { ...DEFAULT_FACTORY_CONFIG, stateDir } }, 42)).toBe(true);
    expect(mockReadFile).toHaveBeenCalledWith(
      join(stateDir.startsWith('/') ? stateDir : join(process.cwd(), stateDir), 'leases/issue-42.lock'),
      'utf-8',
    );
  });
});

describe('setupWorktree', () => {
  const baseOptions = {
    issueNum: 42,
    projectDir: '/home/user/project',
    baseBranch: 'master',
  };

  describe('destructive cleanup permission', () => {
    const worktreePath = '/home/user/project/.worktrees/issue-42';
    const ok = { stdout: '', stderr: '', exitCode: 0 };
    const missing = { stdout: '', stderr: 'missing', exitCode: 1 };
    const commands = (): string[] => mockExec.mock.calls.map(([cmd]) => cmd);
    const expectNoDestruction = (): void => {
      expect(commands().filter(cmd => /worktree remove|branch -D|push origin --delete/.test(cmd))).toEqual([]);
    };

    test('rechecks ownership after waiting for the Git lock', async () => {
      let ownsLease = true;
      const permission = ownsLease;
      mockWithFileLock.mockImplementationOnce((_path, fn) => {
        ownsLease = false;
        return fn();
      });
      mockExists.mockImplementation(path => path === worktreePath);
      mockExec.mockImplementation(cmd => ({ ...ok, stdout: cmd.includes('--abbrev-ref') ? 'other-worker' : '' }));

      await expect(setupWorktree({
        ...baseOptions,
        allowDestructive: permission,
        checkDestructivePermission: () => ownsLease,
      })).rejects.toThrow(/lease/);
      expectNoDestruction();
    });

    test.each(['worktree', 'local branch', 'remote branch'])('rechecks ownership before deleting the %s', async target => {
      let ownsLease = true;
      mockExists.mockImplementation(path => target === 'worktree' && path === worktreePath);
      mockExec.mockImplementation(cmd => {
        if (cmd.includes('--abbrev-ref')) {
          ownsLease = false;
          return { ...ok, stdout: 'other-worker' };
        }
        if (cmd === "git rev-parse --verify 'agent/issue-42'" && target === 'remote branch') {
          ownsLease = false;
          return missing;
        }
        if (cmd.includes('worktree add')) {
          ownsLease = false;
          return missing;
        }
        return ok;
      });

      await expect(setupWorktree({
        ...baseOptions,
        allowDestructive: true,
        checkDestructivePermission: () => ownsLease,
      })).rejects.toThrow(/lease/);
      expectNoDestruction();
    });

    test.each([true, undefined, false])('wrong-branch cleanup with allowDestructive=%s', async (allowDestructive) => {
      let exists = true;
      mockExists.mockImplementation(path => path === worktreePath && exists);
      mockExec.mockImplementation(cmd => {
        if (cmd.includes('--abbrev-ref')) return { ...ok, stdout: 'other-worker' };
        if (cmd.includes('worktree remove')) exists = false;
        return ok;
      });
      const attempt = setupWorktree({ ...baseOptions, allowDestructive });
      if (allowDestructive === false) {
        await expect(attempt).rejects.toThrow(/issue #42.*agent\/issue-42.*issue-42.*lease.*allowDestructive/);
        expect(commands()).toHaveLength(1);
        expectNoDestruction();
      } else {
        await expect(attempt).resolves.toMatchObject({ resumed: true });
        expect(commands()).toContain(`git worktree remove '${worktreePath}' --force`);
      }
    });

    test.each([true, undefined, false])('failed local attachment with allowDestructive=%s', async (allowDestructive) => {
      mockExec.mockImplementation(cmd => cmd === `git worktree add '${worktreePath}' 'agent/issue-42'` ? missing : ok);
      const attempt = setupWorktree({ ...baseOptions, allowDestructive });
      if (allowDestructive === false) {
        await expect(attempt).rejects.toThrow(/lease.*allowDestructive/);
        expectNoDestruction();
        expect(commands().filter(cmd => cmd.includes('worktree add'))).toHaveLength(1);
      } else {
        await expect(attempt).resolves.toMatchObject({ resumed: false });
        expect(commands()).toContain("git branch -D 'agent/issue-42'");
      }
    });

    test.each([true, undefined, false])('remote-only issue branch with allowDestructive=%s', async (allowDestructive) => {
      mockExec.mockImplementation(cmd => {
        if (cmd === "git rev-parse --verify 'agent/issue-42'") return missing;
        if (cmd.includes('ls-remote')) return { ...ok, stdout: 'abc123\trefs/heads/agent/issue-42\n' };
        return ok;
      });
      const result = await setupWorktree({ ...baseOptions, allowDestructive });
      expect(result.resumed).toBe(allowDestructive === false);
      if (allowDestructive === false) {
        expectNoDestruction();
        expect(commands()).toContain(`git worktree add '${worktreePath}' -b 'agent/issue-42' 'origin/agent/issue-42'`);
      } else {
        expect(commands()).toContain("git push origin --delete 'agent/issue-42'");
      }
    });

    test('creates fresh without deleting when origin confirms the branch is absent', async () => {
      mockExec.mockImplementation(cmd => {
        if (cmd === "git rev-parse --verify 'agent/issue-42'") return missing;
        if (cmd.includes('ls-remote')) return { ...ok, exitCode: 2 };
        return ok;
      });
      await expect(setupWorktree({ ...baseOptions, allowDestructive: false })).resolves.toMatchObject({ resumed: false });
      expectNoDestruction();
      expect(commands()).toContain(`git worktree add '${worktreePath}' -b 'agent/issue-42' 'origin/master'`);
    });

    test.each(['fetch', 'discovery', 'empty discovery', 'branch fetch', 'recovery'])('fails closed on remote %s failure', async failure => {
      mockExec.mockImplementation(cmd => {
        if (cmd === "git rev-parse --verify 'agent/issue-42'") return missing;
        if (cmd === 'git fetch origin' && failure === 'fetch') return missing;
        if (cmd.startsWith('git fetch origin ') && failure === 'branch fetch') return missing;
        if (cmd.includes('ls-remote')) {
          if (failure === 'discovery') return missing;
          return { ...ok, stdout: failure === 'empty discovery' ? '' : 'abc123\trefs/heads/agent/issue-42' };
        }
        if (cmd.includes('worktree add') && failure === 'recovery') return missing;
        return ok;
      });
      await expect(setupWorktree({ ...baseOptions, allowDestructive: false })).rejects.toThrow(/issue #42.*lease/);
      expectNoDestruction();
      expect(commands().some(cmd => cmd.includes('origin/master'))).toBe(false);
      expect(commands().some(cmd => cmd.includes('pnpm install'))).toBe(false);
      if (failure === 'branch fetch') {
        expect(commands().some(cmd => cmd.includes('worktree add'))).toBe(false);
      }
    });

    test('refuses an unreadable existing worktree without fallback', async () => {
      mockExists.mockImplementation(path => path === worktreePath);
      mockExec.mockReturnValue(missing);
      await expect(setupWorktree({ ...baseOptions, allowDestructive: false })).rejects.toThrow(/cannot be inspected/);
      expect(commands()).toEqual(['git rev-parse --abbrev-ref HEAD']);
      expectNoDestruction();
    });

    test('does not create from a stale local base when the fresh-creation fetch fails', async () => {
      let fetches = 0;
      mockExec.mockImplementation(cmd => {
        if (cmd.includes('rev-parse')) return missing;
        if (cmd.includes('ls-remote')) return { ...ok, exitCode: 2 };
        if (cmd === 'git fetch origin' && ++fetches === 2) return missing;
        return ok;
      });
      await expect(setupWorktree({ ...baseOptions, allowDestructive: false })).rejects.toThrow(/cannot fetch source branch/);
      expectNoDestruction();
      expect(commands().some(cmd => cmd.includes('worktree add'))).toBe(false);
    });

    test.each([true, false, undefined])('recovers remote saved and explicit branches with permission %s', async allowDestructive => {
      mockExec.mockImplementation(cmd => {
        if (cmd === "git rev-parse --verify 'agent/saved'") return missing;
        return { ...ok, stdout: 'abc123' };
      });
      for (const branchOption of [{ branch: 'agent/saved' }, { savedBranch: 'agent/saved' }]) {
        await expect(setupWorktree({ ...baseOptions, ...branchOption, allowDestructive })).resolves.toMatchObject({ resumed: true });
      }
      expectNoDestruction();
      expect(commands().filter(cmd => cmd.includes('worktree add'))).toEqual([
        `git worktree add '${worktreePath}' -b 'agent/saved' 'origin/agent/saved'`,
        `git worktree add '${worktreePath}' -b 'agent/saved' 'origin/agent/saved'`,
      ]);
    });

    test.each([true, false, undefined])('preserves saved and explicit branches with permission %s', async allowDestructive => {
      mockExec.mockImplementation(cmd => cmd.includes('worktree add') ? missing : ok);
      for (const branchOption of [{ branch: 'agent/saved' }, { savedBranch: 'agent/saved' }]) {
        await expect(setupWorktree({ ...baseOptions, ...branchOption, allowDestructive })).rejects.toThrow(/Failed to recreate/);
      }
      expectNoDestruction();
      expect(commands().filter(cmd => cmd.includes('worktree add'))).toHaveLength(2);
    });

    test('does not replace a missing saved branch when cleanup is forbidden', async () => {
      mockExec.mockImplementation(cmd => {
        if (cmd.includes('rev-parse')) return missing;
        if (cmd.includes('ls-remote')) return { ...ok, exitCode: 2 };
        return ok;
      });
      await expect(setupWorktree({ ...baseOptions, savedBranch: 'agent/saved', allowDestructive: false })).rejects.toThrow(/Saved resume branch/);
      expectNoDestruction();
      expect(commands().some(cmd => cmd.includes('worktree add'))).toBe(false);
    });
  });

  test('creates worktree at correct path with correct branch', async () => {
    const result = await setupWorktree(baseOptions);

    expect(result.path).toContain('issue-42');
    expect(result.branch).toBe('agent/issue-42');

    // Should have called git worktree add
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree add'),
      expect.objectContaining({ cwd: '/home/user/project' }),
    );
  });

  test('creates an explicitly named session worktree without deleting its remote branch', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --verify 'session/epic-371'")) {
        return { stdout: '', stderr: 'missing', exitCode: 1 };
      }
      if (cmd.includes("rev-parse --verify 'origin/session/epic-371'")) {
        return { stdout: '', stderr: 'missing', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await setupWorktree({
      ...baseOptions,
      branch: 'session/epic-371',
      worktreePath: '/home/user/project/.worktrees/session-epic-371',
      skipInstall: true,
    });

    expect(result).toEqual({
      path: '/home/user/project/.worktrees/session-epic-371',
      branch: 'session/epic-371',
      resumed: false,
    });
    expect(mockExec).toHaveBeenCalledWith(
      "git worktree add '/home/user/project/.worktrees/session-epic-371' -b 'session/epic-371' 'origin/master'",
      { cwd: '/home/user/project' },
    );
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('git push origin --delete'))).toBe(false);
  });

  test('rejects explicit worktree paths outside the repo worktrees directory', async () => {
    await expect(setupWorktree({
      ...baseOptions,
      branch: 'session/epic-371',
      worktreePath: '/tmp/session-epic-371',
    })).rejects.toThrow(/unsafe worktree path/);
  });

  test('rejects the worktrees container itself as an explicit worktree path', async () => {
    await expect(setupWorktree({
      ...baseOptions,
      branch: 'session/epic-371',
      worktreePath: '/home/user/project/.worktrees',
    })).rejects.toThrow(/unsafe worktree path/);
  });

  test('branches from base branch when autoMerge is false', async () => {
    // No existing branch → fresh creation
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --verify 'agent/issue-42'")) {
        return { stdout: '', stderr: 'error', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await setupWorktree(baseOptions);

    // Should use origin/master
    const worktreeAddCall = mockExec.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('git worktree add') && call[0].includes('-b'),
    );
    expect(worktreeAddCall?.[0]).toContain('origin/master');
  });

  test('branches from session branch when autoMerge is true and session branch exists', async () => {
    mockExec.mockImplementation((cmd: string) => {
      // No existing agent branch
      if (cmd.includes("rev-parse --verify 'agent/issue-42'")) {
        return { stdout: '', stderr: 'error', exitCode: 1 };
      }
      // Session branch exists on remote
      if (cmd.includes("rev-parse --verify 'origin/session/main'")) {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await setupWorktree({
      ...baseOptions,
      autoMerge: true,
      sessionBranch: 'session/main',
    });

    // Should use session branch for worktree add
    const worktreeAddCall = mockExec.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('git worktree add') && call[0].includes('-b'),
    );
    expect(worktreeAddCall?.[0]).toContain('session/main');
  });

  test('falls back to base branch when session branch does not exist', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse')) {
        return { stdout: '', stderr: 'error', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await setupWorktree({
      ...baseOptions,
      autoMerge: true,
      sessionBranch: 'session/main',
    });

    const worktreeAddCall = mockExec.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('git worktree add') && call[0].includes('-b'),
    );
    expect(worktreeAddCall?.[0]).toContain('origin/master');
  });

  test.each([true, false, undefined])('reuses existing worktree with permission %s', async allowDestructive => {
    // Worktree path exists
    mockExists.mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('issue-42')) return true;
      return false;
    });
    // HEAD is on the right branch; merge-base returns empty (no commits)
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'agent/issue-42', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('merge-base')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await setupWorktree({ ...baseOptions, allowDestructive });

    expect(result.resumed).toBe(true);
    // Should NOT have called git worktree add (reused existing)
    const addCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('git worktree add'),
    );
    expect(addCalls).toHaveLength(0);
  });

  test('removes stale worktree when branch does not match', async () => {
    mockExists.mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('issue-42')) return true;
      return false;
    });
    mockExec.mockImplementation((cmd: string) => {
      // HEAD is on wrong branch
      if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
        return { stdout: 'some-other-branch', stderr: '', exitCode: 0 };
      }
      // No existing agent branch after cleanup
      if (cmd.includes("rev-parse --verify 'agent/issue-42'")) {
        return { stdout: '', stderr: 'error', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await setupWorktree(baseOptions);

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
  });

  test.each([true, false, undefined])('reuses existing branch with permission %s', async allowDestructive => {
    // No worktree dir, but branch exists
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --verify 'agent/issue-42'")) {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('merge-base')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await setupWorktree({ ...baseOptions, allowDestructive });

    expect(result.resumed).toBe(true);
    // Should create worktree from existing branch (no -b flag)
    const addCall = mockExec.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('git worktree add') && !call[0].includes('-b'),
    );
    expect(addCall).toBeDefined();
  });

  test('recreates a missing saved worktree from the saved branch', async () => {
    mockExists.mockReturnValue(false);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --verify 'agent/custom-286'")) {
        return { stdout: 'abc123', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('merge-base')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await setupWorktree({
      ...baseOptions,
      savedBranch: 'agent/custom-286',
      savedPath: '/home/user/project/.worktrees/custom-286',
    });

    expect(result).toEqual({
      path: '/home/user/project/.worktrees/custom-286',
      branch: 'agent/custom-286',
      resumed: true,
    });
    expect(mockExec).toHaveBeenCalledWith(
      "git worktree add '/home/user/project/.worktrees/custom-286' 'agent/custom-286'",
      { cwd: '/home/user/project' },
    );
  });

  test('rejects saved worktree paths outside the repo worktrees directory', async () => {
    await expect(setupWorktree({
      ...baseOptions,
      savedBranch: 'agent/custom-286',
      savedPath: '/tmp/outside-worktree',
    })).rejects.toThrow(/unsafe worktree path/);
  });

  test('deletes remote branch on fresh creation', async () => {
    // No existing branch
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --verify 'agent/issue-42'")) {
        return { stdout: '', stderr: 'error', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await setupWorktree(baseOptions);

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git push origin --delete'),
      expect.anything(),
    );
  });

  test('symlinks .env files to worktree', async () => {
    mockExists.mockImplementation((p: any) => {
      if (typeof p === 'string' && (p.endsWith('.env') || p.endsWith('.env.local'))) return true;
      return false;
    });

    await setupWorktree(baseOptions);

    expect(mockSymlink).toHaveBeenCalled();
  });

  test('sets COMPOSE_PROJECT_NAME in worktree', async () => {
    await setupWorktree(baseOptions);

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.env'),
      expect.stringContaining('COMPOSE_PROJECT_NAME='),
    );
  });

  test('derives a per-worktree COMPOSE_PROJECT_NAME', async () => {
    await setupWorktree(baseOptions);

    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('issue-42/.env'),
      'COMPOSE_PROJECT_NAME=project-issue-42\n',
    );
  });

  test('serializes the shared-.git commands under the repo git lock, but not install/setup', async () => {
    let insideLock = false;
    const commandsInsideLock: string[] = [];
    const commandsOutsideLock: string[] = [];
    mockWithFileLock.mockImplementation((_path, fn) => {
      insideLock = true;
      try {
        return fn();
      } finally {
        insideLock = false;
      }
    });
    mockExec.mockImplementation((cmd: string) => {
      (insideLock ? commandsInsideLock : commandsOutsideLock).push(cmd);
      // No existing issue branch: take the fresh-creation path.
      if (cmd.includes('rev-parse --verify')) return { stdout: '', stderr: 'missing', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await setupWorktree({ ...baseOptions, setupCommand: 'make deps' });

    expect(mockWithFileLock).toHaveBeenCalledWith(
      '/home/user/project/.alpha-loop/locks/git.lock',
      expect.any(Function),
    );
    expect(commandsInsideLock).toEqual(expect.arrayContaining([
      expect.stringContaining('git push origin --delete'),
      'git fetch origin',
      expect.stringContaining('git worktree add'),
    ]));
    expect(commandsInsideLock.some((cmd) => cmd.includes('pnpm install'))).toBe(false);
    expect(commandsOutsideLock).toEqual(expect.arrayContaining(['pnpm install --frozen-lockfile', 'make deps']));
  });

  test('does not install dependencies when the locked git section throws', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('git worktree add')) return { stdout: '', stderr: 'boom', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(setupWorktree(baseOptions)).rejects.toThrow(/Failed to create worktree/);
    expect(mockExec).not.toHaveBeenCalledWith('pnpm install --frozen-lockfile', expect.anything());
  });

  test('runs pnpm install unless skipInstall is true', async () => {
    await setupWorktree(baseOptions);

    expect(mockExec).toHaveBeenCalledWith(
      'pnpm install --frozen-lockfile',
      expect.anything(),
    );
  });

  test('fails when both dependency installation attempts fail', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('pnpm install')) {
        return { stdout: '', stderr: 'dependency error', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(setupWorktree(baseOptions))
      .rejects.toThrow('Dependency installation failed (exit 1)');
  });

  test('runs setup command after dependency install', async () => {
    await setupWorktree({ ...baseOptions, setupCommand: 'python -m venv .venv' });

    expect(mockExec).toHaveBeenCalledWith(
      'python -m venv .venv',
      expect.objectContaining({ cwd: expect.stringContaining('issue-42') }),
    );
  });

  test('skips setup command when not configured', async () => {
    await setupWorktree(baseOptions);

    const setupCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('python'),
    );
    expect(setupCalls).toHaveLength(0);
  });

  test('fails closed when setup command fails', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('python')) {
        return { stdout: '', stderr: 'error', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(setupWorktree({ ...baseOptions, setupCommand: 'python -m venv .venv' }))
      .rejects.toThrow('Setup command failed (exit 1): python -m venv .venv');
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('Setup command failed'));
  });

  test('skips pnpm install when skipInstall is true', async () => {
    await setupWorktree({ ...baseOptions, skipInstall: true });

    const installCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('pnpm install'),
    );
    expect(installCalls).toHaveLength(0);
  });

  test.each([true, false, undefined])('dry run logs without acting with permission %s', async allowDestructive => {
    await setupWorktree({ ...baseOptions, dryRun: true, allowDestructive });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Would create worktree'));
    expect(mockMkdir).not.toHaveBeenCalled();

    // Should not have run any destructive git commands
    const destructiveCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (
        call[0].includes('git worktree add') ||
        call[0].includes('git worktree remove') ||
        call[0].includes('git branch -D') ||
        call[0].includes('git push origin --delete') ||
        call[0].includes('pnpm install')
      ),
    );
    expect(destructiveCalls).toHaveLength(0);
  });

  test('falls back to local branch when origin/ fails', async () => {
    let callCount = 0;
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('git worktree add') && cmd.includes('origin/')) {
        return { stdout: '', stderr: 'fatal: not a valid ref', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await setupWorktree(baseOptions);

    const localCall = mockExec.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('git worktree add') &&
        !call[0].includes('origin/'),
    );
    expect(localCall).toBeDefined();
  });
});

describe('cleanupWorktree', () => {
  const baseOptions = {
    issueNum: 42,
    projectDir: '/home/user/project',
  };

  test('removes worktree but keeps branch', async () => {
    mockExists.mockReturnValue(true);

    await cleanupWorktree(baseOptions);

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );

    // Should NOT delete the branch
    const branchDeleteCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('git branch -D'),
    );
    expect(branchDeleteCalls).toHaveLength(0);
  });

  test('removes the worktree under the repo git lock', async () => {
    mockExists.mockReturnValue(true);

    await cleanupWorktree(baseOptions);

    expect(mockWithFileLock).toHaveBeenCalledWith(
      '/home/user/project/.alpha-loop/locks/git.lock',
      expect.any(Function),
    );
  });

  test('force removes and prunes on failure', async () => {
    mockExists.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('git worktree remove')) {
        return { stdout: '', stderr: 'error', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await cleanupWorktree(baseOptions);

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('rm -rf'),
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      'git worktree prune',
      expect.anything(),
    );
  });

  test('skips cleanup when autoCleanup is false', async () => {
    await cleanupWorktree({ ...baseOptions, autoCleanup: false });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Skipping'));
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('dry run logs without acting', async () => {
    await cleanupWorktree({ ...baseOptions, dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Would clean up'));
  });

  test('preserves paused worktree unless retention has expired', async () => {
    mockExists.mockReturnValue(true);

    const result = await cleanupWorktree({ ...baseOptions, sessionStatus: 'paused' });

    expect(result.status).toBe('preserved');
    expect(mockExec).not.toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
  });

  test('removes paused worktree when retention explicitly expires it', async () => {
    mockExists.mockReturnValue(true);

    const result = await cleanupWorktree({ ...baseOptions, sessionStatus: 'paused', retentionExpired: true });

    expect(result.status).toBe('removed');
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
  });

  test('skips cleanup for worktree paths outside the repo worktrees directory', async () => {
    mockExists.mockReturnValue(true);

    const result = await cleanupWorktree({
      ...baseOptions,
      worktreePath: '/tmp/outside-worktree',
    });

    expect(result).toEqual({
      status: 'skipped',
      path: '/tmp/outside-worktree',
      reason: 'unsafe-worktree-path',
    });
    expect(mockExec).not.toHaveBeenCalledWith(
      expect.stringContaining('rm -rf'),
      expect.anything(),
    );
  });

  test('skips cleanup when the target is the worktrees container itself', async () => {
    mockExists.mockReturnValue(true);

    const result = await cleanupWorktree({
      ...baseOptions,
      worktreePath: '/home/user/project/.worktrees',
    });

    expect(result).toEqual({
      status: 'skipped',
      path: '/home/user/project/.worktrees',
      reason: 'unsafe-worktree-path',
    });
    expect(mockExec).not.toHaveBeenCalled();
  });
});

describe('composeProjectName', () => {
  test('keeps the bare repo name for the main checkout', () => {
    expect(composeProjectName('/home/user/my-repo', '/home/user/my-repo')).toBe('my-repo');
    expect(composeProjectName('/home/user/my-repo/', '/home/user/my-repo')).toBe('my-repo');
  });

  test('appends the worktree directory name for worktrees', () => {
    expect(composeProjectName('/home/user/my-repo/.worktrees/issue-42', '/home/user/my-repo')).toBe('my-repo-issue-42');
    expect(composeProjectName('/home/user/my-repo/.worktrees/session-epic-7-x', '/home/user/my-repo'))
      .toBe('my-repo-session-epic-7-x');
  });

  test('normalizes to a valid compose project name', () => {
    expect(composeProjectName('/w/My Repo/.worktrees/Issue.42', '/w/My Repo')).toBe('my-repo-issue-42');
  });
});

describe('gitLockPath', () => {
  test('lives under the project .alpha-loop/locks dir', () => {
    expect(gitLockPath('/home/user/project')).toBe('/home/user/project/.alpha-loop/locks/git.lock');
  });
});
