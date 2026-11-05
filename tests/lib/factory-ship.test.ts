import {
  summarizeChecks, decideShip, listShippablePrs, mergeShippablePr, updateShippablePrBranch,
  type ShipPr, type ShipPolicy,
} from '../../src/lib/factory-ship';

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  shellQuote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
}));

jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(), success: jest.fn(), warn: jest.fn(), error: jest.fn(),
    step: jest.fn(), dry: jest.fn(), debug: jest.fn(), rate: jest.fn(),
  },
}));

// Mock ghExec to delegate to the already-mocked exec from shell.ts
jest.mock('../../src/lib/rate-limit', () => {
  const shell = require('../../src/lib/shell');
  return {
    ghExec: jest.fn((cmd: string) => shell.exec(cmd)),
  };
});

import { exec } from '../../src/lib/shell';
import { ghExec } from '../../src/lib/rate-limit';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockGhExec = ghExec as jest.MockedFunction<typeof ghExec>;

const NOW = new Date('2026-11-04T12:00:00Z');

function pr(overrides: Partial<ShipPr> = {}): ShipPr {
  return {
    number: 512,
    title: 'feat: session issue-498',
    url: 'https://github.com/o/r/pull/512',
    headRefName: 'session/issue-498-thing',
    baseRefName: 'master',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: null,
    checks: 'success',
    failingChecks: [],
    createdAt: '2026-11-04T11:30:00Z',
    closingIssues: [498],
    ...overrides,
  };
}

function policy(overrides: Partial<ShipPolicy> = {}): ShipPolicy {
  return {
    merge: true,
    adminMerge: false,
    requireChecks: true,
    checksTimeoutMinutes: 60,
    mergeMethod: 'squash',
    headPrefixes: ['session/'],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
});

describe('summarizeChecks', () => {
  test('empty rollup → none', () => {
    expect(summarizeChecks([])).toEqual({ state: 'none', failing: [] });
  });

  test.each(['SUCCESS', 'NEUTRAL', 'SKIPPED'])('CheckRun conclusion %s → success', (conclusion) => {
    expect(summarizeChecks([{ name: 'ci', status: 'COMPLETED', conclusion }]).state).toBe('success');
  });

  test.each(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])(
    'conclusion %s → failure, names the check',
    (conclusion) => {
      expect(summarizeChecks([
        { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'test', status: 'COMPLETED', conclusion },
      ])).toEqual({ state: 'failure', failing: ['test'] });
    },
  );

  test.each(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING'])('CheckRun status %s with no conclusion → pending', (status) => {
    expect(summarizeChecks([{ name: 'ci', status, conclusion: '' }]).state).toBe('pending');
  });

  test.each([
    ['SUCCESS', 'success'], ['FAILURE', 'failure'], ['ERROR', 'failure'], ['PENDING', 'pending'], ['EXPECTED', 'pending'],
  ])('StatusContext state %s → %s', (state, expected) => {
    expect(summarizeChecks([{ context: 'ci/legacy', state }]).state).toBe(expected);
  });

  test('failure beats pending; failing lists use context name for StatusContext', () => {
    expect(summarizeChecks([
      { name: 'build', status: 'IN_PROGRESS', conclusion: null },
      { context: 'ci/legacy', state: 'FAILURE' },
    ])).toEqual({ state: 'failure', failing: ['ci/legacy'] });
  });

  test('unrecognized or malformed entries fail closed as pending', () => {
    expect(summarizeChecks([{ name: 'x', status: 'COMPLETED', conclusion: 'STALE' }]).state).toBe('pending');
    expect(summarizeChecks([{ name: 'x', status: 'COMPLETED' }]).state).toBe('pending');
    expect(summarizeChecks([null]).state).toBe('pending');
    expect(summarizeChecks([{ name: 'ok', conclusion: 'SUCCESS' }, 'garbage']).state).toBe('pending');
  });

  test('non-array input → none', () => {
    expect(summarizeChecks(undefined as unknown as unknown[])).toEqual({ state: 'none', failing: [] });
  });
});

describe('decideShip', () => {
  test.each([undefined, [], ['unrelated'], ['factory-changes-requested'], ['factory-reviewed', 'factory-changes-requested']])(
    'required factory review waits without an unopposed pass: %j', (labels) => {
      expect(decideShip(pr({ labels }), policy({ requireFactoryReview: true }), NOW)).toMatchObject({ action: 'wait' });
    },
  );

  test.each(['CLEAN', 'HAS_HOOKS', 'UNSTABLE', 'BEHIND', 'BLOCKED'])(
    'factory review gate covers every shipping path (%s), including admin merge', (mergeStateStatus) => {
      const snapshot = pr({
        mergeStateStatus, requiredChecksMissing: [],
        reviewDecision: mergeStateStatus === 'BLOCKED' ? 'REVIEW_REQUIRED' : null,
      });
      const required = policy({ adminMerge: true, requireFactoryReview: true });
      expect(decideShip(snapshot, required, NOW)).toMatchObject({ action: 'wait' });
      expect(decideShip({ ...snapshot, labels: ['factory-reviewed'] }, required, NOW)).toMatchObject({
        action: mergeStateStatus === 'BEHIND' ? 'update-branch' : 'merge',
      });
    },
  );

  test('factory review is opt-in and does not weaken CI, conflicts or human reviews', () => {
    expect(decideShip(pr(), policy(), NOW)).toMatchObject({ action: 'merge' });
    expect(decideShip(pr({ labels: ['factory-changes-requested'] }), policy({ requireFactoryReview: false }), NOW))
      .toMatchObject({ action: 'merge' });
    for (const overrides of [
      { checks: 'failure' as const }, { checks: 'pending' as const }, { checks: 'none' as const },
      { mergeable: 'CONFLICTING' }, { reviewDecision: 'CHANGES_REQUESTED' },
    ]) {
      const decision = decideShip(pr({ ...overrides, labels: ['factory-reviewed'] }), policy({ requireFactoryReview: true, adminMerge: true }), NOW);
      expect(['ask', 'wait']).toContain(decision.action);
    }
  });

  test('draft → skip', () => {
    expect(decideShip(pr({ isDraft: true }), policy(), NOW)).toMatchObject({ action: 'skip' });
  });

  test('non-factory head branch → skip', () => {
    expect(decideShip(pr({ headRefName: 'feat/manual' }), policy(), NOW)).toMatchObject({ action: 'skip' });
  });

  test('custom head prefixes are honoured', () => {
    expect(decideShip(pr({ headRefName: 'agent/issue-1' }), policy({ headPrefixes: ['agent/', 'session/'] }), NOW))
      .toMatchObject({ action: 'merge', admin: false });
  });

  test('failing checks → ask with checks-failing key listing failures', () => {
    const decision = decideShip(pr({ checks: 'failure', failingChecks: ['test', 'lint'] }), policy(), NOW);
    expect(decision).toMatchObject({ action: 'ask', key: 'ship:512:checks-failing' });
    if (decision.action !== 'ask') throw new Error('expected ask');
    expect(decision.question).toContain('test, lint');
    expect(decision.context).toContain('- lint');
    expect(decision.context).toContain('#498');
  });

  test('no checks + requireChecks within timeout → wait', () => {
    expect(decideShip(pr({ checks: 'none' }), policy(), NOW)).toMatchObject({ action: 'wait' });
  });

  test('no checks + requireChecks past timeout → ask no-checks', () => {
    expect(decideShip(pr({ checks: 'none', createdAt: '2026-11-04T10:00:00Z' }), policy(), NOW))
      .toMatchObject({ action: 'ask', key: 'ship:512:no-checks' });
  });

  test('no checks + requireChecks with unparseable createdAt → wait', () => {
    expect(decideShip(pr({ checks: 'none', createdAt: 'nonsense' }), policy(), NOW)).toMatchObject({ action: 'wait' });
  });

  test('no checks + requireChecks=false continues to merge when CLEAN', () => {
    expect(decideShip(pr({ checks: 'none' }), policy({ requireChecks: false }), NOW))
      .toMatchObject({ action: 'merge', admin: false });
  });

  test('pending checks → wait', () => {
    expect(decideShip(pr({ checks: 'pending' }), policy(), NOW)).toMatchObject({ action: 'wait' });
  });

  test('CONFLICTING → ask conflict', () => {
    expect(decideShip(pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), policy(), NOW))
      .toMatchObject({ action: 'ask', key: 'ship:512:conflict' });
  });

  test('mergeStateStatus DIRTY alone → ask conflict', () => {
    expect(decideShip(pr({ mergeStateStatus: 'DIRTY' }), policy(), NOW))
      .toMatchObject({ action: 'ask', key: 'ship:512:conflict' });
  });

  test('UNKNOWN mergeable → wait', () => {
    expect(decideShip(pr({ mergeable: 'UNKNOWN' }), policy(), NOW)).toMatchObject({ action: 'wait' });
  });

  test.each([
    [{ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }],
    [{ reviewDecision: 'CHANGES_REQUESTED' }],
  ])('review %j → ask review-required', (overrides) => {
    expect(decideShip(pr(overrides), policy(), NOW)).toMatchObject({ action: 'ask', key: 'ship:512:review-required' });
  });

  test('review required + adminMerge + every required check passed → admin merge', () => {
    expect(decideShip(pr({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', requiredChecksMissing: [] }), policy({ adminMerge: true }), NOW))
      .toMatchObject({ action: 'merge', admin: true });
  });

  // Regression: admin merge used to fire on any BLOCKED state and over CHANGES_REQUESTED.
  test('CHANGES_REQUESTED is never admin-merged', () => {
    expect(decideShip(pr({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED', requiredChecksMissing: [] }), policy({ adminMerge: true }), NOW))
      .toMatchObject({ action: 'ask', key: 'ship:512:review-required' });
  });

  test('BLOCKED without a review requirement waits (no admin merge), then asks after the checks timeout', () => {
    const blocked = { mergeStateStatus: 'BLOCKED', requiredChecksMissing: [] };
    expect(decideShip(pr(blocked), policy({ adminMerge: true }), NOW)).toMatchObject({ action: 'wait' });
    const old = { ...blocked, createdAt: new Date(NOW.getTime() - 120 * 60_000).toISOString() };
    expect(decideShip(pr(old), policy({ adminMerge: true, checksTimeoutMinutes: 60 }), NOW))
      .toMatchObject({ action: 'ask', key: 'ship:512:blocked' });
  });

  test('review required + adminMerge with a required check not yet reported → wait, then ask', () => {
    const missing = { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', requiredChecksMissing: ['e2e'] };
    expect(decideShip(pr(missing), policy({ adminMerge: true }), NOW)).toMatchObject({ action: 'wait' });
    const old = { ...missing, createdAt: new Date(NOW.getTime() - 120 * 60_000).toISOString() };
    expect(decideShip(pr(old), policy({ adminMerge: true, checksTimeoutMinutes: 60 }), NOW))
      .toMatchObject({ action: 'ask', key: 'ship:512:required-checks' });
  });

  test('review required + adminMerge when the required checks are unknown → ask, never admin merge', () => {
    expect(decideShip(pr({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }), policy({ adminMerge: true }), NOW))
      .toMatchObject({ action: 'ask', key: 'ship:512:review-required' });
  });

  test('BEHIND with successful checks and mergeability → update-branch', () => {
    const decision = decideShip(pr({ mergeStateStatus: 'BEHIND' }), policy(), NOW);
    expect(decision).toMatchObject({ action: 'update-branch' });
    if (decision.action !== 'update-branch') throw new Error('expected update-branch');
    expect(decision.reason).toContain('behind');
  });

  test.each<[Partial<ShipPr>, Partial<ShipPolicy>, string]>([
    [{ isDraft: true }, {}, 'skip'],
    [{ headRefName: 'feat/manual' }, {}, 'skip'],
    [{ checks: 'failure' }, {}, 'ask'],
    [{ checks: 'pending' }, {}, 'wait'],
    [{ checks: 'none' }, {}, 'wait'],
    [{ checks: 'none' }, { requireChecks: false }, 'wait'],
    [{ mergeable: 'UNKNOWN' }, {}, 'wait'],
    [{ mergeable: 'CONFLICTING' }, {}, 'ask'],
    [{ reviewDecision: 'CHANGES_REQUESTED' }, { adminMerge: true }, 'ask'],
    [{ reviewDecision: 'REVIEW_REQUIRED' }, {}, 'ask'],
    [{ reviewDecision: 'REVIEW_REQUIRED' }, { adminMerge: true }, 'ask'],
    [{ reviewDecision: 'REVIEW_REQUIRED', requiredChecksMissing: ['ci'] }, { adminMerge: true }, 'wait'],
    [{ reviewDecision: 'REVIEW_REQUIRED', requiredChecksMissing: [] }, { adminMerge: true }, 'update-branch'],
    [{ reviewDecision: 'REVIEW_REQUIRED', requiredChecksMissing: [], checks: 'none' }, { adminMerge: true, requireChecks: false }, 'wait'],
    [{}, { requireChecks: false, mergeMethod: 'rebase' }, 'update-branch'],
    [{}, { merge: false }, 'skip'],
    [{ reviewDecision: 'REVIEW_REQUIRED', requiredChecksMissing: [] }, { adminMerge: true, merge: false }, 'skip'],
  ])('BEHIND preserves safeguards for PR %j and policy %j → %s', (overrides, settings, action) => {
    expect(decideShip(pr({ mergeStateStatus: 'BEHIND', ...overrides }), policy(settings), NOW)).toMatchObject({ action });
  });

  test.each(['CLEAN', 'HAS_HOOKS'])('%s → merge', (mergeStateStatus) => {
    expect(decideShip(pr({ mergeStateStatus }), policy(), NOW)).toMatchObject({ action: 'merge', admin: false });
  });

  test('UNSTABLE with success checks → merge', () => {
    expect(decideShip(pr({ mergeStateStatus: 'UNSTABLE' }), policy(), NOW)).toMatchObject({ action: 'merge', admin: false });
  });

  test('UNSTABLE without success checks → wait', () => {
    expect(decideShip(pr({ mergeStateStatus: 'UNSTABLE', checks: 'none' }), policy({ requireChecks: false }), NOW))
      .toMatchObject({ action: 'wait' });
  });

  test('unrecognized merge state → wait', () => {
    expect(decideShip(pr({ mergeStateStatus: 'UNKNOWN' }), policy(), NOW)).toMatchObject({ action: 'wait' });
  });

  test('policy.merge=false converts merge into skip', () => {
    expect(decideShip(pr(), policy({ merge: false }), NOW))
      .toEqual({ action: 'skip', reason: 'would merge (ship.merge disabled)' });
    expect(decideShip(pr({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', requiredChecksMissing: [] }), policy({ merge: false, adminMerge: true }), NOW))
      .toEqual({ action: 'skip', reason: 'would merge (ship.merge disabled)' });
  });

  test('policy.merge=false leaves asks and waits alone', () => {
    expect(decideShip(pr({ checks: 'pending' }), policy({ merge: false }), NOW)).toMatchObject({ action: 'wait' });
    expect(decideShip(pr({ mergeable: 'CONFLICTING' }), policy({ merge: false }), NOW)).toMatchObject({ action: 'ask' });
  });
});

describe('listShippablePrs', () => {
  const rawPr = (overrides: Record<string, unknown> = {}) => ({
    number: 512,
    title: 'Session PR',
    url: 'https://github.com/o/r/pull/512',
    headRefName: 'session/issue-498-thing',
    headRefOid: 'abc123',
    baseRefName: 'master',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    createdAt: '2026-11-04T11:00:00Z',
    closingIssuesReferences: [
      { number: 498, repository: { name: 'r', owner: { login: 'o' } } },
      { number: 7, repository: { name: 'other', owner: { login: 'o' } } },
    ],
    ...overrides,
  });

  test('builds the gh command, filters by prefix, maps and sorts oldest first', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([
        rawPr({ number: 600, createdAt: '2026-11-04T11:30:00Z', statusCheckRollup: [] }),
        rawPr(),
        rawPr({ number: 700, headRefName: 'feat/manual' }),
      ]),
      stderr: '',
      exitCode: 0,
    });

    const prs = listShippablePrs('o/r', 'master', ['session/']);

    const cmd = mockGhExec.mock.calls[0][0];
    expect(cmd).toContain("gh pr list --repo 'o/r' --base 'master' --state open");
    expect(cmd).toContain('--json number,title,url,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt,closingIssuesReferences');
    expect(cmd).toContain('--limit 100');
    expect(prs.map((p) => p.number)).toEqual([512, 600]);
    expect(prs[0]).toEqual({
      number: 512,
      title: 'Session PR',
      url: 'https://github.com/o/r/pull/512',
      headRefName: 'session/issue-498-thing',
      baseRefName: 'master',
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: null,
      checks: 'success',
      failingChecks: [],
      createdAt: '2026-11-04T11:00:00Z',
      closingIssues: [498],
      headRefOid: 'abc123',
      labels: [],
    });
    expect(prs[1].checks).toBe('none');
  });

  test('fetches and normalizes labels for the optional factory review gate', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([rawPr({ labels: [{ name: 'factory-reviewed' }, { name: 'unrelated' }, {}, null] })]),
      stderr: '', exitCode: 0,
    });
    const [snapshot] = listShippablePrs('o/r', 'master', ['session/']);
    expect(snapshot.labels).toEqual(['factory-reviewed', 'unrelated']);
    expect(mockGhExec.mock.calls[0][0]).toContain('closingIssuesReferences,labels');
    expect(decideShip(snapshot, policy({ requireFactoryReview: true }), NOW)).toMatchObject({ action: 'merge' });
  });

  test('throws when gh fails', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'HTTP 502', exitCode: 1 });
    expect(() => listShippablePrs('o/r', 'master', ['session/'])).toThrow(/HTTP 502/);
  });

  test('throws on unparseable output', () => {
    mockExec.mockReturnValue({ stdout: '{not json', stderr: '', exitCode: 0 });
    expect(() => listShippablePrs('o/r', 'master', ['session/'])).toThrow(/parse/);
  });

  test('empty stdout → []', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    expect(listShippablePrs('o/r', 'master', ['session/'])).toEqual([]);
  });

  test('requiredChecks: reports required checks that have not passed on the head', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.startsWith('gh api')) {
        return { stdout: JSON.stringify({ contexts: ['test', 'e2e'], checks: [{ context: 'test' }] }), stderr: '', exitCode: 0 };
      }
      return { stdout: JSON.stringify([rawPr()]), stderr: '', exitCode: 0 };
    });
    const [prItem] = listShippablePrs('o/r', 'master', ['session/'], { requiredChecks: true });
    expect(mockGhExec.mock.calls.some(([cmd]) => String(cmd).includes("gh api 'repos/o/r/branches/master/protection/required_status_checks'"))).toBe(true);
    expect(prItem.requiredChecksMissing).toEqual(['e2e']);
  });

  test('requiredChecks: unprotected branch → nothing missing; unreadable protection → unknown', () => {
    mockExec.mockImplementation((cmd: string) => (cmd.startsWith('gh api')
      ? { stdout: '', stderr: 'gh: Branch not protected (HTTP 404)', exitCode: 1 }
      : { stdout: JSON.stringify([rawPr()]), stderr: '', exitCode: 0 }));
    expect(listShippablePrs('o/r', 'master', ['session/'], { requiredChecks: true })[0].requiredChecksMissing).toEqual([]);

    mockExec.mockImplementation((cmd: string) => (cmd.startsWith('gh api')
      ? { stdout: '', stderr: 'HTTP 403: Resource not accessible', exitCode: 1 }
      : { stdout: JSON.stringify([rawPr()]), stderr: '', exitCode: 0 }));
    expect(listShippablePrs('o/r', 'master', ['session/'], { requiredChecks: true })[0].requiredChecksMissing).toBeUndefined();
  });

  test('default head prefix is the factory developer branch session/issue-', () => {
    mockExec.mockReturnValue({
      stdout: JSON.stringify([rawPr(), rawPr({ number: 513, headRefName: 'session/epic-454' })]),
      stderr: '',
      exitCode: 0,
    });
    expect(listShippablePrs('o/r', 'master', []).map((p) => p.number)).toEqual([512]);
  });
});

describe('updateShippablePrBranch', () => {
  test('an already-current branch is a successful no-op, not an update', () => {
    mockExec.mockReturnValueOnce({ exitCode: 0, stdout: '✓ PR branch already up-to-date\n', stderr: '' });
    expect(updateShippablePrBranch('o/r', pr())).toEqual({ updated: false, conflict: false });
  });

  test('uses the default merge strategy, quotes the repo, and marks the gh call as a mutation', () => {
    expect(updateShippablePrBranch("o/r's", pr())).toEqual({ updated: true, conflict: false });
    expect(mockGhExec).toHaveBeenCalledTimes(1);
    expect(mockGhExec).toHaveBeenCalledWith("gh pr update-branch 512 --repo 'o/r'\\''s'", undefined, true);
  });

  test.each([
    ['Cannot update PR branch due to conflicts', ''],
    ['', 'GraphQL: merge conflict between base and head (updatePullRequestBranch)'],
    ['GraphQL request failed', 'Merge conflict'],
  ])('recognizes explicit conflicts in either stream (%s, %s)', (stderr, stdout) => {
    mockExec.mockReturnValueOnce({ exitCode: 1, stderr, stdout });
    const result = updateShippablePrBranch('o/r', pr());
    expect(result).toMatchObject({ updated: false, conflict: true });
    for (const message of [stderr, stdout].filter(Boolean)) expect(result.error).toContain(message);
  });

  test.each(['HTTP 403: Resource not accessible', 'HTTP 502', 'HTTP 409: head SHA changed'])('other failures are not merge conflicts: %s', (stderr) => {
    mockExec.mockReturnValueOnce({ exitCode: 1, stderr, stdout: '' });
    expect(updateShippablePrBranch('o/r', pr())).toEqual({ updated: false, conflict: false, error: expect.stringContaining(stderr) });
  });

  test('retains stdout errors and falls back to the exit code for empty errors', () => {
    mockExec.mockReturnValueOnce({ exitCode: 1, stderr: '', stdout: 'Network unavailable' });
    expect(updateShippablePrBranch('o/r', pr()).error).toContain('Network unavailable');
    mockExec.mockReturnValueOnce({ exitCode: 2, stderr: '', stdout: '' });
    expect(updateShippablePrBranch('o/r', pr())).toEqual({ updated: false, conflict: false, error: expect.stringContaining('exit 2') });
  });
});

describe('mergeShippablePr', () => {
  test('merges with the policy method, pins head commit, and confirms MERGED', () => {
    mockExec
      .mockReturnValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockReturnValueOnce({ stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-04T12:00:00Z' }), stderr: '', exitCode: 0 });

    const result = mergeShippablePr('o/r', pr({ headRefOid: 'abc123' }), policy(), false);

    expect(result).toEqual({ merged: true });
    expect(mockGhExec).toHaveBeenNthCalledWith(1, "gh pr merge 512 --repo 'o/r' --squash --match-head-commit 'abc123'", undefined, true);
    expect(mockGhExec.mock.calls[1][0]).toBe("gh pr view 512 --repo 'o/r' --json state,mergedAt");
  });

  test('admin flag, rebase method and opt-in --delete-branch', () => {
    mockExec
      .mockReturnValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockReturnValueOnce({ stdout: JSON.stringify({ state: 'MERGED' }), stderr: '', exitCode: 0 });

    mergeShippablePr('o/r', pr(), policy({ mergeMethod: 'rebase', deleteBranch: true }), true);

    expect(mockGhExec.mock.calls[0][0]).toBe("gh pr merge 512 --repo 'o/r' --rebase --admin --delete-branch");
  });

  test('never passes --delete-branch by default', () => {
    mockExec
      .mockReturnValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockReturnValueOnce({ stdout: JSON.stringify({ state: 'MERGED' }), stderr: '', exitCode: 0 });
    mergeShippablePr('o/r', pr(), policy({ mergeMethod: 'merge' }), false);
    expect(mockGhExec.mock.calls[0][0]).toBe("gh pr merge 512 --repo 'o/r' --merge");
  });

  test('merge command failure → merged false with error, no view call', () => {
    mockExec.mockReturnValueOnce({ stdout: '', stderr: 'Pull request is not mergeable', exitCode: 1 });
    const result = mergeShippablePr('o/r', pr(), policy(), false);
    expect(result.merged).toBe(false);
    expect(result.error).toContain('not mergeable');
    expect(mockGhExec).toHaveBeenCalledTimes(1);
  });

  test('zero exit but PR still OPEN (e.g. auto-merge queued) → fail closed', () => {
    mockExec
      .mockReturnValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockReturnValueOnce({ stdout: JSON.stringify({ state: 'OPEN', mergedAt: null }), stderr: '', exitCode: 0 });
    const result = mergeShippablePr('o/r', pr(), policy(), false);
    expect(result).toEqual({ merged: false, error: expect.stringContaining('OPEN') });
  });

  test('view failure or garbage → fail closed', () => {
    mockExec
      .mockReturnValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockReturnValueOnce({ stdout: '', stderr: 'boom', exitCode: 1 });
    expect(mergeShippablePr('o/r', pr(), policy(), false).merged).toBe(false);

    mockExec
      .mockReturnValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockReturnValueOnce({ stdout: 'not json', stderr: '', exitCode: 0 });
    expect(mergeShippablePr('o/r', pr(), policy(), false).merged).toBe(false);
  });
});
