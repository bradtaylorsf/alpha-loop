jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
}));

import { findStrandedBranches } from '../../src/commands/resume';
import { exec } from '../../src/lib/shell';

const mockExec = exec as jest.MockedFunction<typeof exec>;

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('findStrandedBranches', () => {
  test('normalizes + prefixed branches checked out in another worktree', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --list "agent/issue-*"') {
        return ok('  agent/issue-462\n+ agent/issue-466\n');
      }
      if (cmd === 'git worktree list --porcelain') return ok('');
      if (cmd === 'git log "origin/master..agent/issue-462" --oneline') return ok('');
      if (cmd === 'git log "origin/master..agent/issue-466" --oneline') {
        return ok('a3f214b fix(#466): address verification findings\n');
      }
      if (cmd === 'git diff --name-only "origin/master...agent/issue-466"') {
        return ok('src/lib/agent.ts\n');
      }
      return ok('');
    });

    expect(findStrandedBranches('master')).toEqual([
      {
        branch: 'agent/issue-466',
        issueNum: 466,
        commits: ['a3f214b fix(#466): address verification findings'],
        filesChanged: ['src/lib/agent.ts'],
      },
    ]);
  });

  test('detects agent issue branches from git worktree porcelain output', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --list "agent/issue-*"') return ok('');
      if (cmd === 'git worktree list --porcelain') {
        return ok([
          'worktree /repo',
          'HEAD abc123',
          'branch refs/heads/master',
          '',
          'worktree /repo/.worktrees/issue-187',
          'HEAD def456',
          'branch refs/heads/agent/issue-187',
          '',
        ].join('\n'));
      }
      if (cmd === 'git log "origin/master..agent/issue-187" --oneline') {
        return ok('def456 fix(#187): recover after result\n');
      }
      if (cmd === 'git diff --name-only "origin/master...agent/issue-187"') {
        return ok('src/commands/resume.ts\n');
      }
      return ok('');
    });

    expect(findStrandedBranches('master', 187)).toEqual([
      {
        branch: 'agent/issue-187',
        issueNum: 187,
        commits: ['def456 fix(#187): recover after result'],
        filesChanged: ['src/commands/resume.ts'],
      },
    ]);
  });
});
