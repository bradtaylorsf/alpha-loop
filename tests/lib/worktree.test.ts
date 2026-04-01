import { setupWorktree, cleanupWorktree } from '../../src/lib/worktree';

// Mock dependencies
jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
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
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockExists = existsSync as jest.MockedFunction<typeof existsSync>;
const mockSymlink = symlinkSync as jest.MockedFunction<typeof symlinkSync>;
const mockWriteFile = writeFileSync as jest.MockedFunction<typeof writeFileSync>;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: commands succeed, paths don't exist
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
  mockExists.mockReturnValue(false);
});

describe('setupWorktree', () => {
  const baseOptions = {
    issueNum: 42,
    projectDir: '/home/user/project',
    baseBranch: 'master',
  };

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

  test('branches from base branch when autoMerge is false', async () => {
    await setupWorktree(baseOptions);

    // Should use origin/master
    const worktreeAddCall = mockExec.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('git worktree add'),
    );
    expect(worktreeAddCall?.[0]).toContain('origin/master');
  });

  test('branches from session branch when autoMerge is true and session branch exists', async () => {
    // Session branch exists on remote
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --verify "origin/session/main"')) {
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
      (call) => typeof call[0] === 'string' && call[0].includes('git worktree add'),
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
      (call) => typeof call[0] === 'string' && call[0].includes('git worktree add'),
    );
    expect(worktreeAddCall?.[0]).toContain('origin/master');
  });

  test('cleans up existing worktree before creating new one', async () => {
    mockExists.mockImplementation((p: any) => {
      if (typeof p === 'string' && p.includes('issue-42')) return true;
      return false;
    });

    await setupWorktree(baseOptions);

    // Should remove existing worktree and delete branch
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git worktree remove'),
      expect.anything(),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D'),
      expect.anything(),
    );
  });

  test('deletes remote branch from previous failed runs', async () => {
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

  test('runs pnpm install unless skipInstall is true', async () => {
    await setupWorktree(baseOptions);

    expect(mockExec).toHaveBeenCalledWith(
      'pnpm install --frozen-lockfile',
      expect.anything(),
    );
  });

  test('skips pnpm install when skipInstall is true', async () => {
    await setupWorktree({ ...baseOptions, skipInstall: true });

    const installCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('pnpm install'),
    );
    expect(installCalls).toHaveLength(0);
  });

  test('dry run logs without acting', async () => {
    await setupWorktree({ ...baseOptions, dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Would create worktree'));

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
});
