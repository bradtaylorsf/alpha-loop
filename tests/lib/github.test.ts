import {
  pollIssues, labelIssue, commentIssue, createPR, mergePR,
  createIssue, updateIssue, closeIssue, createMilestone,
  setIssueMilestone, listOpenIssues, addIssueToProject,
} from '../../src/lib/github';

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
    rate: jest.fn(),
  },
}));

// Mock ghExec to delegate to the already-mocked exec from shell.ts
jest.mock('../../src/lib/rate-limit', () => {
  const shell = require('../../src/lib/shell');
  return {
    ghExec: jest.fn((cmd: string) => shell.exec(cmd)),
    getProjectCache: jest.fn(() => null),
    setProjectCache: jest.fn(),
    clearProjectCache: jest.fn(),
    resetRateLimitState: jest.fn(),
    getRateLimitStatus: jest.fn(() => ({ remaining: 5000, limit: 5000, used: 0, resetAt: 0, ratio: 1 })),
    parseRateLimitHeaders: jest.fn(() => null),
    stripDebugOutput: jest.fn((s: string) => s),
  };
});

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

    const { log: mockLog } = require('../../src/lib/logger');
    mergePR('owner/repo', 'agent/issue-42');

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('No PR found'),
    );
  });
});

describe('createIssue', () => {
  test('creates issue and returns issue number from URL', () => {
    mockExec.mockReturnValue({
      stdout: 'https://github.com/owner/repo/issues/42\n',
      stderr: '',
      exitCode: 0,
    });

    const num = createIssue('owner/repo', 'New issue', 'Body text', ['bug', 'ready']);
    expect(num).toBe(42);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue create --repo "owner/repo"'),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--body-file'),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--label "bug"'),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--label "ready"'),
    );
  });

  test('passes milestone flag when provided', () => {
    mockExec.mockReturnValue({
      stdout: 'https://github.com/owner/repo/issues/10\n',
      stderr: '',
      exitCode: 0,
    });

    createIssue('owner/repo', 'Title', 'Body', [], 'MVP');
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--milestone "MVP"'),
    );
  });

  test('returns 0 on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    const num = createIssue('owner/repo', 'Title', 'Body', []);
    expect(num).toBe(0);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to create issue'));
  });
});

describe('updateIssue', () => {
  test('updates title only', () => {
    updateIssue('owner/repo', 42, { title: 'New title' });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue edit 42 --repo "owner/repo" --title'),
    );
  });

  test('updates body with body-file', () => {
    updateIssue('owner/repo', 42, { body: 'New body content' });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--body-file'),
    );
  });

  test('updates both title and body', () => {
    updateIssue('owner/repo', 42, { title: 'New title', body: 'New body' });

    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain('--title');
    expect(cmd).toContain('--body-file');
  });

  test('warns on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    updateIssue('owner/repo', 42, { title: 'New title' });
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to update issue'));
  });
});

describe('closeIssue', () => {
  test('closes issue without reason', () => {
    closeIssue('owner/repo', 42);

    expect(mockExec).toHaveBeenCalledWith(
      'gh issue close 42 --repo "owner/repo"',
    );
  });

  test('closes issue with reason', () => {
    closeIssue('owner/repo', 42, 'not_planned');

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--reason "not_planned"'),
    );
  });

  test('warns on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    closeIssue('owner/repo', 42);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to close issue'));
  });
});

describe('createMilestone', () => {
  test('creates milestone and returns number', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({ number: 3 }),
      stderr: '',
      exitCode: 0,
    });

    const num = createMilestone('owner/repo', 'v1.0', 'First release');
    expect(num).toBe(3);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh api "repos/owner/repo/milestones" -X POST'),
    );
  });

  test('passes due_on when provided', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({ number: 1 }),
      stderr: '',
      exitCode: 0,
    });

    createMilestone('owner/repo', 'v1.0', 'Desc', '2026-05-01T00:00:00Z');
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('due_on='),
    );
  });

  test('returns 0 on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    const num = createMilestone('owner/repo', 'v1.0', 'Desc');
    expect(num).toBe(0);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to create milestone'));
  });

  test('returns 0 on invalid JSON', () => {
    mockExec.mockReturnValue({ stdout: 'not json', stderr: '', exitCode: 0 });

    const num = createMilestone('owner/repo', 'v1.0', 'Desc');
    expect(num).toBe(0);
  });
});

describe('setIssueMilestone', () => {
  test('sets milestone via CLI', () => {
    setIssueMilestone('owner/repo', 42, 'v1.0 Core');

    expect(mockExec).toHaveBeenCalledWith(
      'gh issue edit 42 --repo "owner/repo" --milestone "v1.0 Core"',
    );
  });

  test('warns on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    setIssueMilestone('owner/repo', 42, 'v1.0 Core');
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to set milestone'));
  });
});

describe('listOpenIssues', () => {
  test('returns parsed issues', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([
        { number: 1, title: 'Bug', body: 'Fix it', labels: [{ name: 'bug' }] },
        { number: 2, title: 'Feature', body: 'Add it', labels: [] },
      ]),
      stderr: '',
      exitCode: 0,
    });

    const issues = listOpenIssues('owner/repo');
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({ number: 1, title: 'Bug', body: 'Fix it', labels: ['bug'] });
    expect(issues[1].labels).toEqual([]);
  });

  test('uses default limit of 100', () => {
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });

    listOpenIssues('owner/repo');
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--limit 100'),
    );
  });

  test('uses custom limit', () => {
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });

    listOpenIssues('owner/repo', 50);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--limit 50'),
    );
  });

  test('returns empty array on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const issues = listOpenIssues('owner/repo');
    expect(issues).toEqual([]);
  });

  test('returns empty array on invalid JSON', () => {
    mockExec.mockReturnValue({ stdout: 'not json', stderr: '', exitCode: 0 });

    const issues = listOpenIssues('owner/repo');
    expect(issues).toEqual([]);
  });
});

describe('addIssueToProject', () => {
  test('adds issue to project with correct URL', () => {
    addIssueToProject('owner', 7, 'owner/repo', 42);

    expect(mockExec).toHaveBeenCalledWith(
      'gh project item-add 7 --owner "owner" --url "https://github.com/owner/repo/issues/42"',
    );
  });

  test('warns on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    addIssueToProject('owner', 7, 'owner/repo', 42);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to add issue'));
  });
});
