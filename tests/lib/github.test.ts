import {
  pollIssues, labelIssue, commentIssue, assignIssue, createPR, mergePR,
  createIssue, updateIssue, closeIssue, createMilestone,
  setIssueMilestone, listOpenIssues, addIssueToProject,
  getIssueBody, updateEpicIssueBody, commentChildEpicBacklink,
  listRoadmapEpics, listEpics, getEpicSubIssues, updateEpicChecklist, updateProjectStatus,
  getMergedPRForIssue,
} from '../../src/lib/github';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  shellQuote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
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
  const projectCache = new Map<string, unknown>();
  const projectKey = (owner: string, projectNum: number) => `${owner}/${projectNum}`;

  return {
    ghExec: jest.fn((cmd: string) => shell.exec(cmd)),
    getProjectCache: jest.fn(
      (owner: string, projectNum: number) => projectCache.get(projectKey(owner, projectNum)) ?? null,
    ),
    setProjectCache: jest.fn((owner: string, projectNum: number, cache: unknown) => {
      projectCache.set(projectKey(owner, projectNum), cache);
    }),
    clearProjectCache: jest.fn(() => {
      projectCache.clear();
    }),
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
  const { clearProjectCache } = require('../../src/lib/rate-limit');
  clearProjectCache();
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

  test('filters malformed label payloads from issue polling', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([
        {
          number: 1,
          title: 'Fix labels',
          body: 'Description here',
          labels: [{ name: 'ready' }, {}, { name: null }, null],
        },
      ]),
      stderr: '',
      exitCode: 0,
    });

    const issues = pollIssues('owner/repo', 'ready');

    expect(issues[0].labels).toEqual(['ready']);
  });

  test('calls gh with correct arguments', () => {
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });

    pollIssues('owner/repo', 'ready', 5);

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue list --repo "owner/repo" --label "ready" --state open --json number,title,body,labels --limit 5'),
    );
  });

  test('keeps the ready label filter when polling a milestone', () => {
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });

    pollIssues('owner/repo', 'ready', 5, { milestone: 'Sprint 1' });

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue list --repo "owner/repo" --label "ready" --state open --milestone "Sprint 1"'),
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
    const updated = labelIssue('owner/repo', 42, 'in-progress');

    expect(updated).toBe(true);
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

  test('returns false when the label command fails', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'not found', exitCode: 1 });

    expect(labelIssue('owner/repo', 42, 'in-progress')).toBe(false);
  });
});

describe('assignIssue', () => {
  test('returns true when assignment succeeds', () => {
    expect(assignIssue('owner/repo', 42, '@me')).toBe(true);
  });

  test('returns false when assignment fails', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'not found', exitCode: 1 });

    expect(assignIssue('owner/repo', 42, '@me')).toBe(false);
  });
});

describe('commentIssue', () => {
  test('posts comment via gh issue comment', () => {
    const ok = commentIssue('owner/repo', 42, 'Build started');

    expect(ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue comment 42 --repo "owner/repo"'),
    );
  });

  test('returns false when comment command fails', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const ok = commentIssue('owner/repo', 42, 'Build started');

    expect(ok).toBe(false);
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

  test('throws when updating an existing PR fails', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('git push')) return { stdout: '', stderr: '', exitCode: 0 };
      if (cmd.includes('gh pr list')) {
        return {
          stdout: JSON.stringify([{ number: 5, url: 'https://github.com/owner/repo/pull/5' }]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('gh pr edit')) return { stdout: '', stderr: 'permission denied', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    expect(() => createPR(baseOptions)).toThrow('Failed to update PR #5: permission denied');
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

  test('shell-quotes PR title and branch values', () => {
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

    createPR({
      ...baseOptions,
      head: "agent/issue-42-$(touch /tmp/pwned)'branch",
      title: "feat: Add $(touch /tmp/pwned) 'quoted'",
    });

    const createCall = mockExec.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('gh pr create'),
    );
    expect(createCall?.[0]).toContain("--head 'agent/issue-42-$(touch /tmp/pwned)'\\''branch'");
    expect(createCall?.[0]).toContain("--title 'feat: Add $(touch /tmp/pwned) '\\''quoted'\\'''");
  });

  test('skips push when the remote branch already contains local commits', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git push')) {
        return { stdout: '', stderr: 'rejected (fetch first)', exitCode: 1 };
      }
      // local is an ancestor of origin/<head> — remote is ahead (e.g. auto-merged PRs)
      if (cmd.startsWith("git merge-base --is-ancestor 'agent/")) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith("git merge-base --is-ancestor 'origin/")) {
        return { stdout: '', stderr: '', exitCode: 1 };
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

    // Exactly one (failed) push attempt — no retry, no force push
    const pushCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('git push'),
    );
    expect(pushCalls).toHaveLength(1);
  });

  test('retries a plain push after fetch when local fast-forwards the remote', () => {
    let pushAttempts = 0;
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('--force-with-lease')) {
        return { stdout: '', stderr: 'should not force push', exitCode: 1 };
      }
      if (cmd.startsWith('git push')) {
        pushAttempts += 1;
        return pushAttempts === 1
          ? { stdout: '', stderr: 'rejected (stale packed-refs)', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith("git merge-base --is-ancestor 'agent/")) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      // origin/<head> is an ancestor of local — push fast-forwards
      if (cmd.startsWith("git merge-base --is-ancestor 'origin/")) {
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
    expect(pushAttempts).toBe(2);

    const forcePushCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('--force'),
    );
    expect(forcePushCalls).toHaveLength(0);
  });

  test('force pushes with lease only when diverged trees are identical', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('--force-with-lease')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith('git push')) {
        return { stdout: '', stderr: 'rejected', exitCode: 1 };
      }
      if (cmd.startsWith('git merge-base')) {
        return { stdout: '', stderr: '', exitCode: 1 }; // diverged both ways
      }
      if (cmd.startsWith('git diff --quiet')) {
        return { stdout: '', stderr: '', exitCode: 0 }; // identical trees
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

    const forcePushCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('--force-with-lease'),
    );
    expect(forcePushCalls).toHaveLength(1);
    const mergeCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith("git merge 'origin/"),
    );
    expect(mergeCalls).toHaveLength(0);
  });

  test('merges remote commits instead of force-pushing when content diverged', () => {
    let pushAttempts = 0;
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('--force-with-lease')) {
        return { stdout: '', stderr: 'should not force push', exitCode: 1 };
      }
      if (cmd.startsWith('git push')) {
        pushAttempts += 1;
        return pushAttempts === 1
          ? { stdout: '', stderr: 'rejected', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith('git merge-base')) {
        return { stdout: '', stderr: '', exitCode: 1 }; // diverged both ways
      }
      if (cmd.startsWith('git diff --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 }; // different content
      }
      if (cmd === 'git rev-parse --abbrev-ref HEAD') {
        return { stdout: 'agent/issue-42', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith("git merge 'origin/")) {
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
    expect(pushAttempts).toBe(2);

    const mergeCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith("git merge 'origin/agent/issue-42'"),
    );
    expect(mergeCalls).toHaveLength(1);
    const forcePushCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('--force'),
    );
    expect(forcePushCalls).toHaveLength(0);
  });

  test('aborts the merge and throws instead of force-pushing when divergent content conflicts', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git push')) {
        return { stdout: '', stderr: 'rejected', exitCode: 1 };
      }
      if (cmd.startsWith('git merge-base')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (cmd.startsWith('git diff --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (cmd === 'git rev-parse --abbrev-ref HEAD') {
        return { stdout: 'agent/issue-42', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith("git merge 'origin/")) {
        return { stdout: '', stderr: 'CONFLICT (content)', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    expect(() => createPR(baseOptions)).toThrow(/refusing to force-push/);

    const abortCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0] === 'git merge --abort',
    );
    expect(abortCalls).toHaveLength(1);
    const forcePushCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('--force'),
    );
    expect(forcePushCalls).toHaveLength(0);
  });

  test('refuses to merge when the diverged branch is not checked out', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git push')) {
        return { stdout: '', stderr: 'rejected', exitCode: 1 };
      }
      if (cmd.startsWith('git merge-base')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (cmd.startsWith('git diff --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (cmd === 'git rev-parse --abbrev-ref HEAD') {
        return { stdout: 'some-other-branch', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    expect(() => createPR(baseOptions)).toThrow(/not checked out/);

    const mergeCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith("git merge 'origin/"),
    );
    expect(mergeCalls).toHaveLength(0);
  });

  test('skipPush creates the PR without any git push', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: '[]', stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr create')) {
        return { stdout: 'https://github.com/owner/repo/pull/1', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const url = createPR({ ...baseOptions, skipPush: true });
    expect(url).toBe('https://github.com/owner/repo/pull/1');

    const pushCalls = mockExec.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].startsWith('git push'),
    );
    expect(pushCalls).toHaveLength(0);
  });

  test('throws when push fails completely', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'auth error', exitCode: 1 });

    expect(() => createPR(baseOptions)).toThrow('Failed to push branch');
  });
});

describe('mergePR', () => {
  const blockGate = {
    requireChecks: true,
    timeoutSeconds: 60,
    onTimeout: 'block' as const,
  };
  const now = new Date('2026-08-15T19:00:00.000Z');

  function metadata(
    statusCheckRollup: Array<Record<string, unknown>>,
    createdAt = now.toISOString(),
  ): string {
    return JSON.stringify({ createdAt, statusCheckRollup });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('waits for delayed checks to appear and pass before merging', async () => {
    let viewCount = 0;
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        const checks = viewCount === 0
          ? []
          : viewCount < 7
            ? [{ name: 'CI', status: 'IN_PROGRESS', conclusion: null }]
            : [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }];
        viewCount += 1;
        return { stdout: metadata(checks), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mergePromise = mergePR('owner/repo', 'agent/issue-42', 'squash', blockGate);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('gh pr merge'))).toBe(false);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('gh pr merge'))).toBe(false);

    await jest.advanceTimersByTimeAsync(30_000);
    await expect(mergePromise).resolves.toBe(true);
    const mergeCall = mockExec.mock.calls.find(([cmd]) => String(cmd).includes('gh pr merge'));
    expect(mergeCall?.[0]).toContain('--squash');
    expect(mergeCall?.[0]).toContain('--delete-branch');
  });

  test('never merges a loop-authored PR in single-digit seconds', async () => {
    let mergeAgeMs = -1;
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        return {
          stdout: metadata([{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }]),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('gh pr merge')) {
        mergeAgeMs = Date.now() - now.getTime();
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mergePromise = mergePR('owner/repo', 'agent/issue-42', 'squash', blockGate);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(mergeAgeMs).toBe(-1);
    await jest.advanceTimersByTimeAsync(1);

    await expect(mergePromise).resolves.toBe(true);
    expect(mergeAgeMs).toBeGreaterThanOrEqual(10_000);
  });

  test('blocks immediately when an observed check fails', async () => {
    let viewCount = 0;
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        const checks = viewCount++ === 0
          ? [{ name: 'CI', status: 'IN_PROGRESS', conclusion: null }]
          : [
            { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { name: 'Tests', status: 'COMPLETED', conclusion: 'FAILURE' },
          ];
        return { stdout: metadata(checks), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mergePromise = mergePR('owner/repo', 'agent/issue-42', 'squash', blockGate);
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(mergePromise).resolves.toBe(false);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('gh pr merge'))).toBe(false);
  });

  test.each(['CANCELLED', 'TIMED_OUT'])('blocks on a %s check conclusion', async (conclusion) => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        return {
          stdout: metadata([{ name: 'CI', status: 'COMPLETED', conclusion }]),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(mergePR('owner/repo', 'agent/issue-42', 'squash', blockGate)).resolves.toBe(false);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('gh pr merge'))).toBe(false);
  });

  test('blocks after the registration window when no checks appear and checks are required', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        return { stdout: metadata([]), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mergePromise = mergePR('owner/repo', 'agent/issue-42', 'squash', blockGate);
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(mergePromise).resolves.toBe(false);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('gh pr merge'))).toBe(false);
  });

  test('permits an empty rollup only when requireChecks is explicitly false', async () => {
    const oldCreatedAt = new Date(now.getTime() - 20_000).toISOString();
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        return { stdout: metadata([], oldCreatedAt), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(mergePR('owner/repo', 'agent/issue-42', 'squash', {
      ...blockGate,
      requireChecks: false,
    })).resolves.toBe(true);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('gh pr merge'))).toBe(true);
  });

  test.each([
    { onTimeout: 'block' as const, expected: false },
    { onTimeout: 'warn' as const, expected: true },
  ])('$onTimeout policy returns $expected when checks remain pending at timeout', async ({ onTimeout, expected }) => {
    const oldCreatedAt = new Date(now.getTime() - 20_000).toISOString();
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        return {
          stdout: metadata([{ name: 'CI', status: 'IN_PROGRESS', conclusion: null }], oldCreatedAt),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mergePromise = mergePR('owner/repo', 'agent/issue-42', 'squash', {
      requireChecks: true,
      timeoutSeconds: 12,
      onTimeout,
    });
    await jest.advanceTimersByTimeAsync(12_000);

    await expect(mergePromise).resolves.toBe(expected);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('gh pr merge'))).toBe(expected);
  });

  test('blocks query and parse uncertainty on timeout by default', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        return { stdout: 'not-json', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const mergePromise = mergePR('owner/repo', 'agent/issue-42', 'squash', {
      ...blockGate,
      timeoutSeconds: 10,
    });
    await jest.advanceTimersByTimeAsync(10_000);

    await expect(mergePromise).resolves.toBe(false);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).includes('gh pr merge'))).toBe(false);
  });

  test('returns false when no PR is found', async () => {
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });

    const { log: mockLog } = require('../../src/lib/logger');
    const merged = await mergePR('owner/repo', 'agent/issue-42', 'squash', blockGate);

    expect(merged).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('No PR found'),
    );
  });

  test.each([
    { stdout: '', stderr: 'lookup failed', exitCode: 1 },
    { stdout: 'not-json', stderr: '', exitCode: 0 },
    { stdout: '[{}]', stderr: '', exitCode: 0 },
  ])('returns false when PR lookup cannot identify a PR', async (lookupResult) => {
    mockExec.mockReturnValue(lookupResult);

    await expect(mergePR('owner/repo', 'agent/issue-42', 'squash', blockGate)).resolves.toBe(false);
  });

  test('returns false when the merge command fails after checks pass', async () => {
    const oldCreatedAt = new Date(now.getTime() - 20_000).toISOString();
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh pr list')) {
        return { stdout: JSON.stringify([{ number: 5 }]), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh pr view')) {
        return {
          stdout: metadata([{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }], oldCreatedAt),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('gh pr merge')) {
        return { stdout: '', stderr: 'merge rejected', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(mergePR('owner/repo', 'agent/issue-42', 'squash', blockGate)).resolves.toBe(false);
  });
});

describe('updateProjectStatus', () => {
  test('returns without gh calls when project number is not configured', () => {
    expect(updateProjectStatus('owner/repo', 0, 'owner', 42, 'In progress')).toBe(true);
    expect(updateProjectStatus('owner/repo', -1, 'owner', 42, 'In Review')).toBe(true);

    expect(mockExec).not.toHaveBeenCalled();
  });

  test('disables project board once when field list fails across epic transitions', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh project field-list')) {
        return { stdout: '', stderr: 'missing project scope', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    for (let issueNum = 1; issueNum <= 5; issueNum += 1) {
      updateProjectStatus('owner/repo', 2, 'owner', issueNum, 'In progress');
      updateProjectStatus('owner/repo', 2, 'owner', issueNum, 'In Review');
    }

    const projectCalls = mockExec.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('gh project'),
    );
    const fieldListCalls = mockExec.mock.calls.filter(
      ([cmd]) => typeof cmd === 'string' && cmd.includes('gh project field-list'),
    );
    const { log: mockLog } = require('../../src/lib/logger');

    expect(fieldListCalls).toHaveLength(1);
    expect(projectCalls).toHaveLength(1);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Project board #2 disabled for this session: Could not list project fields: missing project scope',
    );
  });

  test('updates project item status when project metadata resolves', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh project field-list')) {
        return {
          stdout: JSON.stringify({
            fields: [
              {
                id: 'field-id',
                name: 'Status',
                options: [
                  { id: 'todo-id', name: 'Todo' },
                  { id: 'progress-id', name: 'In progress' },
                  { id: 'review-id', name: 'In Review' },
                ],
              },
            ],
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      if (cmd.includes('gh project view')) {
        return { stdout: JSON.stringify({ id: 'project-id' }), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh project item-add')) {
        return { stdout: JSON.stringify({ id: 'item-id' }), stderr: '', exitCode: 0 };
      }
      if (cmd.includes('gh project item-edit')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 1 };
    });

    const updated = updateProjectStatus('owner/repo', 2, 'owner', 42, 'In progress');

    const commands = mockExec.mock.calls.map(([cmd]) => cmd as string);
    const { log: mockLog } = require('../../src/lib/logger');

    expect(commands.some((cmd) => cmd.includes('gh project field-list 2'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes('gh project view 2'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes('gh project item-add 2'))).toBe(true);
    expect(commands.some((cmd) => cmd.includes('gh project item-edit'))).toBe(true);
    expect(commands.find((cmd) => cmd.includes('gh project item-edit'))).toContain('--project-id "project-id"');
    expect(commands.find((cmd) => cmd.includes('gh project item-edit'))).toContain('--field-id "field-id"');
    expect(commands.find((cmd) => cmd.includes('gh project item-edit'))).toContain(
      '--single-select-option-id "progress-id"',
    );
    expect(mockLog.warn).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith('Project board: #42 -> In progress');
    expect(updated).toBe(true);
  });

  test('returns false when project metadata cannot be resolved', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'missing project scope', exitCode: 1 });

    expect(updateProjectStatus('owner/repo', 2, 'owner', 42, 'In progress')).toBe(false);
    expect(updateProjectStatus('owner/repo', 2, 'owner', 43, 'In Review')).toBe(false);
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
    const ok = updateIssue('owner/repo', 42, { title: 'New title' });

    expect(ok).toBe(true);
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
    const ok = updateIssue('owner/repo', 42, { title: 'New title' });
    expect(ok).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to update issue'));
  });
});

describe('epic issue helpers', () => {
  test('listEpics can filter open epics by milestone and normalizes milestone titles', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([
        {
          number: 195,
          title: 'Scheduled epic',
          body: '- [ ] #201',
          labels: [{ name: 'epic' }],
          milestone: { title: 'Sprint 1' },
        },
      ]),
      stderr: '',
      exitCode: 0,
    });

    const epics = listEpics('owner/repo', { milestone: 'Sprint 1' });

    expect(epics).toEqual([{
      number: 195,
      title: 'Scheduled epic',
      body: '- [ ] #201',
      labels: ['epic'],
      milestone: 'Sprint 1',
    }]);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--milestone "Sprint 1"'),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--json number,title,body,labels,milestone'),
    );
  });

  test('listRoadmapEpics returns open epic child counts and summaries from known issues', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([
        {
          number: 195,
          title: 'Epic: Roadmap scheduling',
          body: [
            '## Goal',
            'Schedule parent epics.',
            '',
            '## Ordered Work',
            '- [x] #3',
            '- [ ] #7',
          ].join('\n'),
          labels: [{ name: 'epic' }],
          milestone: { title: '001 - Core' },
        },
      ]),
      stderr: '',
      exitCode: 0,
    });

    const epics = listRoadmapEpics('owner/repo', [
      { number: 3, title: 'Set up database schema', body: 'Create tables for roadmap data.', labels: [] },
      { number: 7, title: 'Create API endpoints', body: 'REST API for scheduling.', labels: [] },
    ]);

    expect(epics).toEqual([{
      issueNum: 195,
      title: 'Epic: Roadmap scheduling',
      bodySummary: expect.stringContaining('Schedule parent epics.'),
      currentMilestone: '001 - Core',
      completedChildCount: 1,
      totalChildCount: 2,
      openChildCount: 1,
      children: [
        {
          issueNum: 3,
          title: 'Set up database schema',
          bodySummary: 'Create tables for roadmap data.',
          checked: true,
          labels: [],
          state: 'OPEN',
          milestone: null,
        },
        {
          issueNum: 7,
          title: 'Create API endpoints',
          bodySummary: 'REST API for scheduling.',
          checked: false,
          labels: [],
          state: 'OPEN',
          milestone: null,
        },
      ],
    }]);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--label "epic"'),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--json number,title,body,labels,milestone'),
    );
  });

  test('listRoadmapEpics fetches missing child issue details', () => {
    mockExec
      .mockReturnValueOnce({
        stdout: JSON.stringify([
          {
            number: 195,
            title: 'Epic: Roadmap scheduling',
            body: '- [ ] #7',
            labels: [{ name: 'epic' }],
            milestone: null,
          },
        ]),
        stderr: '',
        exitCode: 0,
      })
      .mockReturnValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'Create API endpoints',
          body: 'REST API for scheduling.',
          labels: [],
          comments: [],
        }),
        stderr: '',
        exitCode: 0,
      });

    const epics = listRoadmapEpics('owner/repo');

    expect(epics[0].children[0]).toEqual({
      issueNum: 7,
      title: 'Create API endpoints',
      bodySummary: 'REST API for scheduling.',
      checked: false,
      labels: [],
      state: 'OPEN',
      milestone: null,
    });
    expect(mockExec).toHaveBeenCalledWith(
      'gh issue view 7 --repo "owner/repo" --json number,title,body,labels,comments,state,stateReason,milestone',
    );
  });

  test('getEpicSubIssues warns when an issue-like checklist line is not parsed', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({
        number: 214,
        title: 'Epic: Parser regression',
        body: [
          '- [ ] **#10** - parsed bold ref',
          '- [ ] [#11](https://github.com/owner/repo/issues/11) - parsed link ref',
          '- [ ] (#12) - unsupported wrapper',
          '- [ ] owner/repo#13 - cross-repo refs are out of scope',
          '- [ ] 14 - numeric-only refs are out of scope',
        ].join('\n'),
        labels: [{ name: 'epic' }],
        comments: [],
      }),
      stderr: '',
      exitCode: 0,
    });

    const { log: mockLog } = require('../../src/lib/logger');
    const refs = getEpicSubIssues('owner/repo', 214);

    expect(refs).toEqual([
      { number: 10, checked: false, lineIndex: 0 },
      { number: 11, checked: false, lineIndex: 1 },
    ]);
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('Checklist line did not parse in epic #214 at line 3: - [ ] (#12) - unsupported wrapper'),
    );
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("Hint: expected '- [ ] #N - title' format"),
    );
  });

  test('getIssueBody fetches a single issue body', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({
        number: 99,
        title: 'Existing epic',
        body: '## Ordered Work\n\n- [ ] #1',
        labels: [{ name: 'epic' }],
        comments: [],
      }),
      stderr: '',
      exitCode: 0,
    });

    const body = getIssueBody('owner/repo', 99);

    expect(body).toBe('## Ordered Work\n\n- [ ] #1');
    expect(mockExec).toHaveBeenCalledWith(
      'gh issue view 99 --repo "owner/repo" --json number,title,body,labels,comments,state,stateReason,milestone',
    );
  });

  test('updateEpicIssueBody delegates to issue body update', () => {
    const ok = updateEpicIssueBody('owner/repo', 99, 'new body');

    expect(ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue edit 99 --repo "owner/repo"'),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--body-file'),
    );
  });

  test('commentChildEpicBacklink posts a lightweight parent backlink', () => {
    const ok = commentChildEpicBacklink('owner/repo', 12, 99);

    expect(ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('gh issue comment 12 --repo "owner/repo"'),
    );
  });

  test('updateEpicChecklist returns false when the delegated body update fails', () => {
    mockExec
      .mockReturnValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'Existing epic',
          body: '- [ ] #12 Child issue',
          labels: [{ name: 'epic' }],
          comments: [],
        }),
        stderr: '',
        exitCode: 0,
      })
      .mockReturnValueOnce({ stdout: '', stderr: 'permission denied', exitCode: 1 });

    expect(updateEpicChecklist('owner/repo', 99, 12, true)).toBe(false);
  });

  test('updateEpicChecklist returns true when the item is already in the requested state', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify({
        number: 99,
        title: 'Existing epic',
        body: '- [x] #12 Child issue',
        labels: [{ name: 'epic' }],
        comments: [],
      }),
      stderr: '',
      exitCode: 0,
    });

    expect(updateEpicChecklist('owner/repo', 99, 12, true)).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

describe('closeIssue', () => {
  beforeEach(() => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh issue view')) {
        return { stdout: 'CLOSED\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  });

  test('closes issue without reason', () => {
    const closed = closeIssue('owner/repo', 42);

    expect(closed).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'gh issue close 42 --repo "owner/repo"',
    );
  });

  test('maps not_planned to the supported CLI reason', () => {
    expect(closeIssue('owner/repo', 42, 'not_planned')).toBe(true);

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--reason "not planned"'),
    );
  });

  test('returns false when the close command fails', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    expect(closeIssue('owner/repo', 42)).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to close issue'));
  });

  test('returns false when the issue remains open after the command succeeds', () => {
    mockExec
      .mockReturnValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockReturnValueOnce({ stdout: 'OPEN\n', stderr: '', exitCode: 0 });

    expect(closeIssue('owner/repo', 42)).toBe(false);
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
    const updated = setIssueMilestone('owner/repo', 42, 'v1.0 Core');

    expect(updated).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'gh issue edit 42 --repo "owner/repo" --milestone "v1.0 Core"',
    );
  });

  test('returns false on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    expect(setIssueMilestone('owner/repo', 42, 'v1.0 Core')).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to set milestone'));
  });
});

describe('listOpenIssues', () => {
  test('returns parsed issues', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([
        { number: 1, title: 'Bug', body: 'Fix it', labels: [{ name: 'bug' }] },
        { number: 2, title: 'Feature', body: 'Add it', labels: [], milestone: { title: 'Sprint 1' } },
      ]),
      stderr: '',
      exitCode: 0,
    });

    const issues = listOpenIssues('owner/repo');
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({ number: 1, title: 'Bug', body: 'Fix it', labels: ['bug'] });
    expect(issues[1]).toEqual({ number: 2, title: 'Feature', body: 'Add it', labels: [], milestone: 'Sprint 1' });
  });

  test('filters malformed label payloads from open issue listing', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([
        { number: 1, title: 'Bug', body: 'Fix it', labels: [{ name: 'bug' }, {}, { name: null }] },
      ]),
      stderr: '',
      exitCode: 0,
    });

    const issues = listOpenIssues('owner/repo');

    expect(issues[0]).toEqual({ number: 1, title: 'Bug', body: 'Fix it', labels: ['bug'] });
  });

  test('requests milestone data for roadmap issue context', () => {
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });

    listOpenIssues('owner/repo');

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--json number,title,body,labels,milestone'),
    );
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
    const added = addIssueToProject('owner', 7, 'owner/repo', 42);

    expect(added).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'gh project item-add 7 --owner "owner" --url "https://github.com/owner/repo/issues/42"',
    );
  });

  test('returns false on failure', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'error', exitCode: 1 });

    const { log: mockLog } = require('../../src/lib/logger');
    expect(addIssueToProject('owner', 7, 'owner/repo', 42)).toBe(false);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to add issue'));
  });
});

describe('mutation wrapper contracts', () => {
  function voidGhExecWrappers(sourceText: string, fileName = 'github.ts'): string[] {
    const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
    const offenders: string[] = [];

    const containsGhExec = (node: ts.Node): boolean => {
      let found = false;
      const visit = (child: ts.Node): void => {
        if (found) return;
        if (
          ts.isCallExpression(child)
          && ts.isIdentifier(child.expression)
          && child.expression.text === 'ghExec'
        ) {
          found = true;
          return;
        }
        ts.forEachChild(child, visit);
      };
      ts.forEachChild(node, visit);
      return found;
    };

    const containsVoid = (type: ts.TypeNode | undefined): boolean => {
      if (!type) return true;
      let found = false;
      const visit = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.VoidKeyword || node.kind === ts.SyntaxKind.UndefinedKeyword) {
          found = true;
          return;
        }
        if (!found) ts.forEachChild(node, visit);
      };
      visit(type);
      return found;
    };

    const isExported = (node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean => (
      Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
    );

    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body && isExported(statement)) {
        if (containsGhExec(statement.body) && containsVoid(statement.type)) {
          offenders.push(statement.name.text);
        }
        continue;
      }

      if (!ts.isVariableStatement(statement) || !isExported(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        if (!ts.isArrowFunction(declaration.initializer) && !ts.isFunctionExpression(declaration.initializer)) continue;
        if (containsGhExec(declaration.initializer.body) && containsVoid(declaration.initializer.type)) {
          offenders.push(declaration.name.text);
        }
      }
    }

    return offenders;
  }

  test('exported ghExec wrappers declare a non-void result', () => {
    const fileName = resolve(process.cwd(), 'src/lib/github.ts');
    expect(voidGhExecWrappers(readFileSync(fileName, 'utf-8'), fileName)).toEqual([]);
  });

  test.each([
    ['function declaration', 'export function mutate(): void { ghExec("gh issue edit 1"); }'],
    ['async function', 'export async function mutate(): Promise<void> { ghExec("gh issue edit 1", undefined, true); }'],
    ['void union', 'export function mutate(): boolean | void { ghExec("gh issue edit 1", undefined, true); }'],
    ['arrow function', 'export const mutate = (): void => { ghExec("gh issue edit 1", undefined, true); };'],
    ['inferred result', 'export const mutate = () => { ghExec("gh issue edit 1", undefined, true); };'],
  ])('rejects a void ghExec wrapper expressed as a %s', (_shape, sourceText) => {
    expect(voidGhExecWrappers(sourceText)).toEqual(['mutate']);
  });
});

describe('getMergedPRForIssue', () => {
  test('uses the earliest exact closing PR from the issue timeline', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([[
        {
          event: 'cross-referenced',
          source: {
            issue: {
              html_url: 'https://github.com/owner/repo/pull/13',
              body: 'Implements the feature.\n\nCloses #7',
              pull_request: {
                html_url: 'https://github.com/owner/repo/pull/13',
                merged_at: '2026-08-12T23:32:13Z',
              },
            },
          },
        },
        {
          event: 'cross-referenced',
          source: {
            issue: {
              html_url: 'https://github.com/owner/repo/pull/23',
              body: 'Closes #19. Unblocks #7 and epic #6.',
              pull_request: {
                html_url: 'https://github.com/owner/repo/pull/23',
                merged_at: '2026-08-13T02:13:51Z',
              },
            },
          },
        },
        {
          event: 'cross-referenced',
          source: {
            issue: {
              html_url: 'https://github.com/owner/repo/pull/35',
              body: 'Session integration.\n\nCloses #7',
              pull_request: {
                html_url: 'https://github.com/owner/repo/pull/35',
                merged_at: '2026-08-13T08:58:30Z',
              },
            },
          },
        },
      ]]),
      stderr: '',
      exitCode: 0,
    });

    expect(getMergedPRForIssue('owner/repo', 7)).toBe('https://github.com/owner/repo/pull/13');
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('/issues/7/timeline'));
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  test('recognizes a session PR that closes multiple child issues', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([[
        {
          event: 'cross-referenced',
          source: {
            issue: {
              html_url: 'https://github.com/owner/repo/pull/14',
              body: 'Closes #10\nCloses #11',
              pull_request: {
                html_url: 'https://github.com/owner/repo/pull/14',
                merged_at: '2026-08-13T04:51:23Z',
              },
            },
          },
        },
      ]]),
      stderr: '',
      exitCode: 0,
    });

    expect(getMergedPRForIssue('owner/repo', 11)).toBe('https://github.com/owner/repo/pull/14');
  });

  test('filters fuzzy search hits when the timeline is unavailable', () => {
    mockExec
      .mockReturnValueOnce({ stdout: '', stderr: 'timeline unavailable', exitCode: 1 })
      .mockReturnValueOnce({
        stdout: JSON.stringify([
          {
            url: 'https://github.com/owner/repo/pull/23',
            body: 'Closes #19. Unblocks #7.',
            mergedAt: '2026-08-13T02:13:51Z',
          },
          {
            url: 'https://github.com/owner/repo/pull/13',
            body: 'closes: #7',
            mergedAt: '2026-08-12T23:32:13Z',
          },
        ]),
        stderr: '',
        exitCode: 0,
      });

    expect(getMergedPRForIssue('owner/repo', 7)).toBe('https://github.com/owner/repo/pull/13');
    expect(mockExec).toHaveBeenLastCalledWith(expect.stringContaining('--limit 100'));
  });
});
