import { createSession, saveResult, getPreviousResult, finalizeSession, writeCrashMarker, loadCrashMarkers, clearCrashMarker } from '../../src/lib/session';
import type { PipelineResult } from '../../src/lib/pipeline';
import type { BranchAncestryMode, QueueSessionContext } from '../../src/lib/epic-queue';

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  formatTimestamp: jest.fn().mockReturnValue('20260101-000000'),
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

jest.mock('../../src/lib/github', () => ({
  createPR: jest.fn(),
  updateProjectStatus: jest.fn(),
}));

jest.mock('../../src/lib/learning', () => ({
  repairSessionLearningArtifacts: jest.fn(),
  repairSessionSummaryArtifact: jest.fn(),
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  renameSync: jest.fn(),
}));

import { exec } from '../../src/lib/shell';
import { createPR } from '../../src/lib/github';
import { repairSessionLearningArtifacts, repairSessionSummaryArtifact } from '../../src/lib/learning';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import type { Config } from '../../src/lib/config';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockCreatePR = createPR as jest.MockedFunction<typeof createPR>;
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockUnlinkSync = unlinkSync as jest.MockedFunction<typeof unlinkSync>;
const mockRenameSync = renameSync as jest.MockedFunction<typeof renameSync>;
const mockRepairSessionLearningArtifacts = repairSessionLearningArtifacts as jest.MockedFunction<typeof repairSessionLearningArtifacts>;
const mockRepairSessionSummaryArtifact = repairSessionSummaryArtifact as jest.MockedFunction<typeof repairSessionSummaryArtifact>;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 1,
    agent: 'claude',
    model: 'opus',
    reviewModel: 'opus',
    pollInterval: 60,
    dryRun: false,
    baseBranch: 'master',
    logDir: 'logs',
    labelReady: 'ready',
    maxTestRetries: 3,
    testCommand: 'pnpm test',
    devCommand: 'pnpm dev',
    skipTests: false,
    skipReview: false,
    skipInstall: false,
    skipPreflight: false,
    skipVerify: false,
    skipLearn: false,
    skipE2e: false,
    autoMerge: false,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    verbose: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    harnesses: [],
    setupCommand: '',
    evalDir: '.alpha-loop/evals',
    evalModel: '',
    skipEval: false,
    evalTimeout: 300,
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    sessionRetention: { pausedWorktreeDays: 0, completedWorktreeDays: 30 },
    preferEpics: false,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    ...overrides,
  };
}

function makeQueueContext(overrides: Partial<QueueSessionContext> = {}): QueueSessionContext {
  const mode: BranchAncestryMode = overrides.branchAncestryMode ?? 'stacked';
  const previousSessionBranch = overrides.previousSessionBranch ?? 'session/epic-205-first';
  const dependsOnSessionBranch = overrides.dependsOnSessionBranch
    ?? (mode === 'stacked' ? previousSessionBranch : null);

  return {
    queueId: 'queue-20260521T101112Z',
    queueIndex: 2,
    queueTotal: 3,
    currentEpic: { number: 166, title: 'Second Epic' },
    previousEpic: {
      number: 205,
      title: 'First Epic',
      sessionBranch: 'session/epic-205-first',
      sessionPrUrl: 'https://github.com/owner/repo/pull/205',
    },
    nextEpic: { number: 214, title: 'Third Epic' },
    previousSessionBranch,
    previousSessionPrUrl: 'https://github.com/owner/repo/pull/205',
    branchAncestryMode: mode,
    branchedFromBranch: mode === 'stacked' ? 'session/epic-205-first' : 'master',
    dependsOnSessionBranch,
    dependsOnSessionPrUrl: mode === 'stacked' ? 'https://github.com/owner/repo/pull/205' : null,
    rebaseOntoBranch: mode === 'stacked' ? 'master' : null,
    dependencyWarnings: ['Epic #166 declares a dependency on queued epic #205.'],
    overlapWarnings: ['Epics #166 and #214 both mention src/lib/session.ts.'],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
  mockReadFileSync.mockReturnValue('');
});

describe('createSession', () => {
  test('generates session name with timestamp format', () => {
    const session = createSession(makeConfig());

    expect(session.name).toMatch(/^session\/\d{8}-\d{6}$/);
    expect(session.branch).toBe(session.name);
    expect(session.results).toEqual([]);
  });

  test('creates results and logs directories', () => {
    createSession(makeConfig());

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.alpha-loop/sessions/session/'),
      { recursive: true },
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('/logs'),
      { recursive: true },
    );
  });

  test('writes durable session manifest for non-dry-run targeted sessions', () => {
    createSession(makeConfig(), {
      issueNum: 284,
      issueTitle: 'Persist resumable session state',
      parentEpicNum: 293,
      parentEpicTitle: 'Hosted Alpha Loop',
    });

    const manifestWrite = mockWriteFileSync.mock.calls.find((call) => String(call[0]).endsWith('session.json.tmp'));
    expect(manifestWrite).toBeDefined();
    const manifest = JSON.parse(String(manifestWrite?.[1]));
    expect(manifest).toEqual(expect.objectContaining({
      version: 1,
      issueNumber: 284,
      issueNumbers: [284],
      parentEpicNumber: 293,
      status: 'active',
      stage: 'created',
      branch: 'session/20260101-000000',
    }));
    expect(manifest.harness).toEqual(expect.objectContaining({
      agent: 'claude',
      model: 'opus',
      command: 'claude',
      testCommand: 'pnpm test',
    }));
    expect(mockRenameSync).toHaveBeenCalledWith(
      expect.stringContaining('session.json.tmp'),
      expect.stringContaining('session.json'),
    );
  });

  test('uses mergeTo as branch name when provided', () => {
    const session = createSession(makeConfig({ mergeTo: 'my-branch' }));
    expect(session.branch).toBe('my-branch');
  });

  test('creates session branch when autoMerge is enabled', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 1 }); // branch doesn't exist

    createSession(makeConfig({ autoMerge: true }));

    // Should attempt to create branch
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git checkout -b'),
      expect.any(Object),
    );
  });

  test('does not create session branch in dryRun mode', () => {
    createSession(makeConfig({ autoMerge: true, dryRun: true }));

    // Should NOT attempt to create branch
    const checkoutCalls = (mockExec as jest.Mock).mock.calls.filter(
      (call: string[]) => call[0]?.includes('git checkout -b'),
    );
    expect(checkoutCalls).toHaveLength(0);
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  test('generates epic-scoped session name when epicNum and epicTitle are provided', () => {
    const session = createSession(makeConfig(), { epicNum: 165, epicTitle: 'Hybrid Routing' });

    expect(session.name).toBe('session/epic-165-hybrid-routing');
    expect(session.branch).toBe('session/epic-165-hybrid-routing');
  });

  test('sets session.epic to the epicNum', () => {
    const session = createSession(makeConfig(), { epicNum: 165, epicTitle: 'Hybrid Routing' });
    expect(session.epic).toBe(165);
  });

  test('generates epic-scoped session name with only epicNum when epicTitle is absent', () => {
    const session = createSession(makeConfig(), { epicNum: 42 });
    expect(session.name).toBe('session/epic-42');
  });

  test('slugifies epicTitle correctly (lowercase, hyphens)', () => {
    const session = createSession(makeConfig(), { epicNum: 7, epicTitle: 'Multi-Word Title With Spaces!' });
    expect(session.name).toBe('session/epic-7-multi-word-title-with-spaces');
  });

  test('draft PR title uses Epic #<N>: <title> format when autoMerge is enabled', () => {
    // autoMerge triggers draft PR creation
    mockExec.mockImplementation((cmd: string) => {
      // branch doesn't exist so it gets created
      if (cmd.includes('rev-parse --verify')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/99');

    createSession(makeConfig({ autoMerge: true }), { epicNum: 165, epicTitle: 'Hybrid Routing' });

    expect(mockCreatePR).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Epic #165: Hybrid Routing',
      }),
    );
  });

  test('creates stacked queue session branch from the previous session branch and annotates draft PR body', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --verify')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/166');

    createSession(makeConfig({ autoMerge: true }), {
      epicNum: 166,
      epicTitle: 'Second Epic',
      queue: makeQueueContext(),
    });

    expect(mockExec).toHaveBeenCalledWith(
      'git checkout -b "session/epic-166-second-epic" "origin/session/epic-205-first"',
      expect.any(Object),
    );
    const body = mockCreatePR.mock.calls[0][0].body;
    expect(body).toContain('## Execution Queue');
    expect(body).toContain('**Position:** 2 of 3');
    expect(body).toContain('**Previous queued epic:** #205 - First Epic ([session PR](https://github.com/owner/repo/pull/205))');
    expect(body).toContain('Merge [the previous session PR](https://github.com/owner/repo/pull/205) first; after it lands on master, rebase `session/epic-166-second-epic` onto `master` before final review/merge.');
  });

  test('creates independent queue session branch from base branch and explains no ancestry dependency in draft PR body', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('rev-parse --verify')) return { stdout: '', stderr: '', exitCode: 1 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/166');

    createSession(makeConfig({ autoMerge: true }), {
      epicNum: 166,
      epicTitle: 'Second Epic',
      queue: makeQueueContext({
        branchAncestryMode: 'independent',
        branchedFromBranch: 'master',
        dependsOnSessionBranch: null,
        dependsOnSessionPrUrl: null,
        rebaseOntoBranch: null,
      }),
    });

    expect(mockExec).toHaveBeenCalledWith(
      'git checkout -b "session/epic-166-second-epic" "origin/master"',
      expect.any(Object),
    );
    const body = mockCreatePR.mock.calls[0][0].body;
    expect(body).toContain('**Branch ancestry:** independent');
    expect(body).toContain('**Depends on:** None - no branch ancestry dependency was created.');
    expect(body).toContain('No branch ancestry dependency was created; this branch starts from `master`.');
  });
});

describe('saveResult', () => {
  test('writes result JSON to correct path', () => {
    const session = createSession(makeConfig());
    const result: PipelineResult = {
      issueNum: 42,
      title: 'Test issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 120,
      filesChanged: 5,
    };

    saveResult(session, result);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('result-42.json'),
      expect.stringContaining('"issueNum": 42'),
    );
  });

  test('clears a stale crash marker after writing a result', () => {
    const session = createSession(makeConfig());
    const result: PipelineResult = {
      issueNum: 42,
      title: 'Recovered issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 120,
      filesChanged: 5,
    };
    mockExistsSync.mockImplementation((filePath: any) => String(filePath).endsWith('crash-42.json'));

    saveResult(session, result);

    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('crash-42.json'));
  });
});

describe('crash markers', () => {
  test('writes crash marker JSON to the session directory', () => {
    const session = createSession(makeConfig());

    writeCrashMarker(session, {
      issueNum: 216,
      step: 'review',
      branch: 'agent/issue-216',
      hasCommits: true,
      error: 'review crashed',
      timestamp: '2026-05-25T23:59:00.000Z',
      recoverable: true,
    });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('crash-216.json'),
      expect.stringContaining('"step": "review"'),
    );
  });

  test('loads valid markers and ignores invalid marker files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['crash-216.json', 'crash-bad.json', 'result-216.json'] as any);
    mockReadFileSync.mockImplementation((filePath: any) => {
      if (String(filePath).endsWith('crash-216.json')) {
        return JSON.stringify({
          issueNum: 216,
          step: 'review',
          branch: 'agent/issue-216',
          hasCommits: true,
          error: 'review crashed',
          timestamp: '2026-05-25T23:59:00.000Z',
          recoverable: true,
        });
      }
      return '{';
    });

    expect(loadCrashMarkers('/tmp/session')).toEqual([{
      issueNum: 216,
      step: 'review',
      branch: 'agent/issue-216',
      hasCommits: true,
      error: 'review crashed',
      timestamp: '2026-05-25T23:59:00.000Z',
      recoverable: true,
    }]);
  });

  test('clears a crash marker by issue number', () => {
    mockExistsSync.mockReturnValue(true);

    clearCrashMarker('/tmp/session', 216);

    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/session/crash-216.json');
  });
});

describe('getPreviousResult', () => {
  test('returns null when no results exist', () => {
    const session = createSession(makeConfig());
    expect(getPreviousResult(session)).toBeNull();
  });

  test('returns formatted string for last result', () => {
    const session = createSession(makeConfig());
    session.results.push({
      issueNum: 42,
      title: 'Test issue',
      status: 'success',
      prUrl: 'https://github.com/owner/repo/pull/1',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 120,
      filesChanged: 5,
    });

    const prev = getPreviousResult(session);
    expect(prev).toContain('#42');
    expect(prev).toContain('Test issue');
    expect(prev).toContain('PASSING');
    expect(prev).toContain('Build on what was already done');
  });
});

describe('finalizeSession', () => {
  test('returns null when autoMerge is false', async () => {
    const session = createSession(makeConfig());
    session.results.push({ issueNum: 1, title: 'T', status: 'success', testsPassing: true, verifyPassing: true, verifySkipped: false, duration: 10, filesChanged: 1 });

    const result = await finalizeSession(session, makeConfig({ autoMerge: false }));
    expect(result).toBeNull();
  });

  test('returns null when no issues were processed', async () => {
    const session = createSession(makeConfig());

    const result = await finalizeSession(session, makeConfig({ autoMerge: true }));
    expect(result).toBeNull();
  });

  test('logs dry run message in dry run mode', async () => {
    const session = createSession(makeConfig());
    session.results.push({ issueNum: 1, title: 'T', status: 'success', testsPassing: true, verifyPassing: true, verifySkipped: false, duration: 10, filesChanged: 1 });

    const result = await finalizeSession(session, makeConfig({ autoMerge: true, dryRun: true }));
    expect(result).toBeNull();
  });

  test('creates session PR with correct body', async () => {
    mockExistsSync.mockReturnValue(true);
    // git diff --cached --quiet returns non-zero (changes exist)
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('diff --cached --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/99');

    const config = makeConfig({ autoMerge: true });
    const session = createSession(config);
    session.results.push({
      issueNum: 1,
      title: 'First issue',
      status: 'success',
      prUrl: 'https://github.com/owner/repo/pull/1',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 3,
    });

    const result = await finalizeSession(session, config);

    expect(result).toBe('https://github.com/owner/repo/pull/99');
    expect(mockRepairSessionLearningArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: session.name,
      sessionLogsDir: session.logsDir,
      issues: [expect.objectContaining({ issueNum: 1, title: 'First issue', status: 'success', duration: 60 })],
    }));
    expect(mockRepairSessionSummaryArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: session.name,
    }));
    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'owner/repo',
      base: 'master',
      title: expect.stringContaining('Session:'),
      body: expect.stringContaining('#1: First issue'),
    }));
    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.not.stringContaining('## Execution Queue'),
    }));
  });

  test('lists auto-committed issues in final session PR body and manifest', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('diff --cached --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/99');

    const config = makeConfig({ autoMerge: true });
    const session = createSession(config);
    session.results.push({
      issueNum: 229,
      title: 'Surface auto commit fallback',
      status: 'success',
      prUrl: 'https://github.com/owner/repo/pull/229',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 2,
      autoCommittedByPipeline: true,
      autoCommittedPaths: ['src/lib/pipeline.ts', 'tests/lib/pipeline.test.ts'],
    });

    await finalizeSession(session, config);

    const body = mockCreatePR.mock.calls.at(-1)![0].body;
    expect(body).toContain('### Auto-Committed By Pipeline');
    expect(body).toContain('#229: Surface auto commit fallback ([PR](https://github.com/owner/repo/pull/229))');
    expect(body).toContain('`src/lib/pipeline.ts`, `tests/lib/pipeline.test.ts`');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('session-session-20260101-000000.json'),
      expect.stringContaining('"autoCommittedByPipeline": true'),
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('session-session-20260101-000000.json'),
      expect.stringContaining('"autoCommittedPaths"'),
    );
  });

  test('adds merge order and queue risk notes to final stacked queue session PR body', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('diff --cached --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/166');

    const config = makeConfig({ autoMerge: true });
    const session = createSession(makeConfig(), {
      epicNum: 166,
      epicTitle: 'Second Epic',
      queue: makeQueueContext(),
    });
    session.results.push({
      issueNum: 266,
      title: 'Second child',
      status: 'success',
      prUrl: 'https://github.com/owner/repo/pull/266',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 120,
      filesChanged: 4,
    });

    await finalizeSession(session, config);

    const body = mockCreatePR.mock.calls[0][0].body;
    expect(body).toContain('## Execution Queue');
    expect(body).toContain('**Queue:** queue-20260521T101112Z');
    expect(body).toContain('**Parent epic:** #166 - Second Epic');
    expect(body).toContain('**Next queued epic:** #214 - Third Epic');
    expect(body).toContain('Merge [the previous session PR](https://github.com/owner/repo/pull/205) first; after it lands on master, rebase `session/epic-166-second-epic` onto `master` before final review/merge.');
    expect(body).toContain('Dependency: Epic #166 declares a dependency on queued epic #205.');
    expect(body).toContain('File overlap: Epics #166 and #214 both mention src/lib/session.ts.');
    expect(body).toContain('Closes #266');
  });

  test('adds independent branch guidance to final queue session PR body', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('diff --cached --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/166');

    const config = makeConfig({ autoMerge: true });
    const session = createSession(makeConfig(), {
      epicNum: 166,
      epicTitle: 'Second Epic',
      queue: makeQueueContext({
        branchAncestryMode: 'independent',
        branchedFromBranch: 'master',
        dependsOnSessionBranch: null,
        dependsOnSessionPrUrl: null,
        rebaseOntoBranch: null,
      }),
    });
    session.results.push({
      issueNum: 266,
      title: 'Second child',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 120,
      filesChanged: 4,
    });

    await finalizeSession(session, config);

    const body = mockCreatePR.mock.calls[0][0].body;
    expect(body).toContain('**Branch ancestry:** independent');
    expect(body).toContain('Review this PR in queue order, but it can merge independently once ready.');
    expect(body).toContain('No branch ancestry dependency was created; this branch starts from `master`.');
  });

  test('puts failed issues in collapsed details section', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('diff --cached --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (cmd.includes('ls-remote')) {
        return { stdout: 'abc123\trefs/heads/session/20260101-000000', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/99');

    const config = makeConfig({ autoMerge: true });
    const session = createSession(config);
    session.results.push(
      { issueNum: 1, title: 'Success issue', status: 'success', prUrl: 'https://github.com/owner/repo/pull/1', testsPassing: true, verifyPassing: true, verifySkipped: false, duration: 60, filesChanged: 3 },
      { issueNum: 2, title: 'Failed issue', status: 'failure', failureReason: 'permanent', testsPassing: false, verifyPassing: false, verifySkipped: false, duration: 30, filesChanged: 0 },
    );

    await finalizeSession(session, config);

    const body = mockCreatePR.mock.calls[0][0].body;
    expect(body).toContain('Closes #1');
    expect(body).not.toContain('Closes #2');
    expect(body).toContain('<details>');
    expect(body).toContain('Failed Issues (1)');
    expect(body).toContain('#2: Failed issue');
  });

  test('omits transient failures from PR body and notes re-queue', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('diff --cached --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (cmd.includes('ls-remote')) {
        return { stdout: 'abc123\trefs/heads/session/20260101-000000', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/99');

    const config = makeConfig({ autoMerge: true });
    const session = createSession(config);
    session.results.push(
      { issueNum: 1, title: 'Success issue', status: 'success', prUrl: 'https://github.com/owner/repo/pull/1', testsPassing: true, verifyPassing: true, verifySkipped: false, duration: 60, filesChanged: 3 },
      { issueNum: 2, title: 'Rate limited issue', status: 'failure', failureReason: 'transient', testsPassing: false, verifyPassing: false, verifySkipped: false, duration: 5, filesChanged: 0 },
    );

    await finalizeSession(session, config);

    const body = mockCreatePR.mock.calls[0][0].body;
    expect(body).toContain('Closes #1');
    expect(body).not.toContain('#2: Rate limited');
    expect(body).toContain('re-queued due to agent rate limits');
    // Title should only count completed issues (not transient)
    const title = mockCreatePR.mock.calls[0][0].title;
    expect(title).toContain('1/1 succeeded');
  });

  test('shows recovered issues separately from natural successes in final session PR body', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('diff --cached --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/99');

    const config = makeConfig({ autoMerge: true });
    const session = createSession(config);
    session.results.push(
      { issueNum: 1, title: 'Success issue', status: 'success', prUrl: 'https://github.com/owner/repo/pull/1', testsPassing: true, verifyPassing: true, verifySkipped: false, duration: 60, filesChanged: 3 },
      { issueNum: 2, title: 'Recovered issue', status: 'failure', recoveryMode: 'resume', failureReason: 'transient', prUrl: 'https://github.com/owner/repo/pull/2', testsPassing: false, verifyPassing: false, verifySkipped: true, duration: 0, filesChanged: 2 },
    );

    await finalizeSession(session, config);

    const finalPrCall = mockCreatePR.mock.calls.at(-1)![0];
    const title = finalPrCall.title;
    const body = finalPrCall.body;
    expect(title).toContain('1/1 succeeded, 1 recovered');
    expect(body).toContain('1 succeeded, 0 failed, 1 recovered');
    expect(body).toContain('### Recovered Issues');
    expect(body).toContain('#2: Recovered issue — RECOVERED BY RESUME');
    expect(body).toContain('Closes #1');
    expect(body).not.toContain('Closes #2');
  });
});
