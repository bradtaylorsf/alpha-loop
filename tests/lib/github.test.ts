import { pollIssues, labelIssue, commentIssue, createPR, mergePR } from '../../src/lib/github';

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
}));

jest.mock('../../src/lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  dry: jest.fn(),
}));

import { exec } from '../../src/lib/shell';

const mockExec = exec as jest.MockedFunction<typeof exec>;

beforeEach(() => {
  jest.clearAllMocks();
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
});

describe('pollIssues', () => {
  test('returns parsed issues with number, title, body, labels', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([
        {
          number: 1,
          title: 'Fix bug',
          body: 'Description here',
          labels: [{ name: 'ready' }, { name: 'bug' }],
        },
        {
          number: 2,
          title: 'Add feature',
          body: 'Feature spec',
          labels: [{ name: 'ready' }],
        },
      ]),
      stderr: '',
      exitCode: 0,
    });

    const issues = pollIssues('owner/repo', 'ready');

    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({
      number: 1,
      title: 'Fix bug',
      body: 'Description here',
      labels: ['ready', 'bug'],
    });
    expect(issues[1].labels).toEqual(['ready']);
  });

  test('calls gh with correct arguments', () => {
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });

    pollIssues('owner/repo', 'ready', 5);

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue list --repo "owner/repo" --label "ready" --state open --json number,title,body,labels --limit 5'),
    );
  });

  test('returns empty array on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'not found', exitCode: 1 });

    const issues = pollIssues('owner/repo', 'ready');
    expect(issues).toEqual([]);
  });

  test('returns empty array on invalid JSON', () => {
    mockExec.mockReturnValue({ stdout: 'not json', stderr: '', exitCode: 0 });

    const issues = pollIssues('owner/repo', 'ready');
    expect(issues).toEqual([]);
  });
});

describe('labelIssue', () => {
  test('adds label via gh issue edit', () => {
    labelIssue('owner/repo', 42, 'in-progress');

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue edit 42 --repo "owner/repo" --add-label "in-progress"'),
    );
  });

  test('removes label when specified', () => {
    labelIssue('owner/repo', 42, 'in-progress', 'ready');

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--remove-label "ready"'),
    );
  });
});

describe('commentIssue', () => {
  test('posts comment via gh issue comment', () => {
    commentIssue('owner/repo', 42, 'Build started');

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue comment 42 --repo "owner/repo"'),
    );
  });
});

describe('createPR', () => {
  const baseOptions = {
    repo: 'owner/repo',
    base: 'master',
    head: 'agent/issue-42',
    title: 'feat: Add feature (closes #42)',
    body: '## Summary\n\nAutomated implementation',
    cwd: '/project',
  };

  test('creates a new PR and returns URL', () => {
    // Push succeeds
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('git push')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr list')) {
        return { stdout: '[]', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr create')) {
        return { stdout: 'https://github.com/owner/repo/pull/1', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const url = createPR(baseOptions);
    expect(url).toBe('https://github.com/owner/repo/pull/1');
  });

  test('updates existing PR instead of creating new one', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('git push')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr list')) {
        return {
          stdout: JSON.stringify([{ number: 5, url: 'https://github.com/owner/repo/pull/5' }]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('gh pr edit')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const url = createPR(baseOptions);
    expect(url).toBe('https://github.com/owner/repo/pull/5');

    // Should have called gh pr edit, not gh pr create
    const editCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('gh pr edit'),
    );
    const createCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('gh pr create'),
    );
    expect(editCalls).toHaveLength(1);
    expect(createCalls).toHaveLength(0);
  });

  test('truncates body at 30k chars', () => {
    const longBody = 'x'.repeat(35000);

    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('git push')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr list')) {
        return { stdout: '[]', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr create')) {
        return { stdout: 'https://github.com/owner/repo/pull/1', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    createPR({ ...baseOptions, body: longBody });

    // The gh pr create call should use --body-file (not inline body)
    const createCall = mockExec.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('gh pr create'),
    );
    expect(createCall).toBeDefined();
    expect(createCall?.[0]).toContain('--body-file');
  });

  test('tries force push on initial push failure', () => {
    let pushAttempt = 0;
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('git push') && !cmd.includes('--force')) {
        return { stdout: '', stderr: 'rejected', exitCode: 1 };
      }
      if (cmd.includes('git push') && cmd.includes('--force')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr list')) {
        return { stdout: '[]', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr create')) {
        return { stdout: 'https://github.com/owner/repo/pull/1', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const url = createPR(baseOptions);
    expect(url).toBe('https://github.com/owner/repo/pull/1');

    // Should have tried force push
    const forcePushCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('--force'),
    );
    expect(forcePushCalls.length).toBeGreaterThan(0);
  });

  test('throws when push fails completely', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'auth error', exitCode: 1 });

    expect(() => createPR(baseOptions)).toThrow('Failed to push branch');
  });
});

describe('mergePR', () => {
  test('merges with squash by default', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return {
          stdout: JSON.stringify([{ number: 5 }]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('gh pr merge')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    mergePR('owner/repo', 'agent/issue-42');

    const mergeCall = mockExec.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('gh pr merge'),
    );
    expect(mergeCall?.[0]).toContain('--squash');
    expect(mergeCall?.[0]).toContain('--delete-branch');
  });

  test('warns when no PR found', () => {
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });

    const logger = require('../../src/lib/logger');
    mergePR('owner/repo', 'agent/issue-42');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No PR found'),
    );
  });
});
