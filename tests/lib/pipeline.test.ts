import { processIssue } from '../../src/lib/pipeline';
import type { SessionContext } from '../../src/lib/session';

// Mock all dependencies
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

jest.mock('../../src/lib/agent', () => ({
  spawnAgent: jest.fn(),
}));

jest.mock('../../src/lib/worktree', () => ({
  setupWorktree: jest.fn(),
  cleanupWorktree: jest.fn(),
}));

jest.mock('../../src/lib/github', () => ({
  assignIssue: jest.fn(),
  labelIssue: jest.fn(),
  commentIssue: jest.fn(),
  createPR: jest.fn(),
  mergePR: jest.fn(),
  updateProjectStatus: jest.fn(),
}));

jest.mock('../../src/lib/testing', () => ({
  runTests: jest.fn(),
}));

jest.mock('../../src/lib/verify', () => ({
  runVerify: jest.fn().mockResolvedValue({ passed: true, output: 'Verification skipped' }),
}));

jest.mock('../../src/lib/learning', () => ({
  extractLearnings: jest.fn(),
  getLearningContext: jest.fn(),
}));

jest.mock('../../src/lib/session', () => ({
  saveResult: jest.fn(),
  getPreviousResult: jest.fn(),
}));

jest.mock('../../src/lib/prompts', () => ({
  buildImplementPrompt: jest.fn().mockReturnValue('implement prompt'),
  buildReviewPrompt: jest.fn().mockReturnValue('review prompt'),
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import { exec } from '../../src/lib/shell';
import { spawnAgent } from '../../src/lib/agent';
import { setupWorktree, cleanupWorktree } from '../../src/lib/worktree';
import { labelIssue, commentIssue, createPR, updateProjectStatus } from '../../src/lib/github';
import { runTests } from '../../src/lib/testing';
import { extractLearnings, getLearningContext } from '../../src/lib/learning';
import { saveResult, getPreviousResult } from '../../src/lib/session';
import type { Config } from '../../src/lib/config';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockSetupWorktree = setupWorktree as jest.MockedFunction<typeof setupWorktree>;
const mockCleanupWorktree = cleanupWorktree as jest.MockedFunction<typeof cleanupWorktree>;
const mockCreatePR = createPR as jest.MockedFunction<typeof createPR>;
const mockRunTests = runTests as jest.MockedFunction<typeof runTests>;
const mockExtractLearnings = extractLearnings as jest.MockedFunction<typeof extractLearnings>;
const mockGetLearningContext = getLearningContext as jest.MockedFunction<typeof getLearningContext>;
const mockSaveResult = saveResult as jest.MockedFunction<typeof saveResult>;
const mockGetPreviousResult = getPreviousResult as jest.MockedFunction<typeof getPreviousResult>;

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
    skipVerify: true,  // Skip verify by default in tests
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
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    pricing: {
      'claude-opus-4-6': { input: 15.0, output: 75.0 },
      'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
      'claude-haiku-4-5': { input: 0.80, output: 4.0 },
    },
    pipeline: {},
    ...overrides,
  };
}

function makeSession(): SessionContext {
  return {
    name: 'session/20260330-143000',
    branch: 'session/20260330-143000',
    resultsDir: '/tmp/sessions/session/20260330-143000',
    logsDir: '/tmp/sessions/session/20260330-143000/logs',
    results: [],
  };
}

beforeEach(() => {
  jest.clearAllMocks();

  // Default: everything succeeds
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
  mockSetupWorktree.mockResolvedValue({ path: '/tmp/worktree', branch: 'agent/issue-42' });
  mockCleanupWorktree.mockResolvedValue();
  mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: 'Agent output', duration: 5000 });
  mockRunTests.mockReturnValue({ passed: true, output: 'All tests passed' });
  mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/1');
  mockExtractLearnings.mockResolvedValue();
  mockGetLearningContext.mockReturnValue('');
  mockGetPreviousResult.mockReturnValue(null);
});

describe('processIssue', () => {
  test('executes all pipeline steps in order and returns success', async () => {
    const result = await processIssue(42, 'Test issue', 'Issue body', makeConfig(), makeSession());

    expect(result.issueNum).toBe(42);
    expect(result.title).toBe('Test issue');
    expect(result.status).toBe('success');
    expect(result.testsPassing).toBe(true);
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/1');
    expect(result.duration).toBeGreaterThanOrEqual(0);

    // Verify step order: status update -> worktree -> plan -> implement -> tests -> review -> PR -> learnings -> cleanup
    expect(updateProjectStatus).toHaveBeenCalled();
    expect(labelIssue).toHaveBeenCalledWith('owner/repo', 42, 'in-progress', 'ready');
    expect(mockSetupWorktree).toHaveBeenCalled();
    expect(mockSpawnAgent).toHaveBeenCalled();
    expect(mockRunTests).toHaveBeenCalled();
    expect(mockCreatePR).toHaveBeenCalled();
    expect(mockExtractLearnings).toHaveBeenCalled();
    expect(mockSaveResult).toHaveBeenCalled();
    expect(mockCleanupWorktree).toHaveBeenCalled();
  });

  test('returns failure and labels failed when implementation fails', async () => {
    mockSpawnAgent.mockImplementation(async (options) => {
      // Plan succeeds, implement fails
      if (options.prompt === 'implement prompt') {
        return { exitCode: 1, output: 'Error', duration: 1000 };
      }
      return { exitCode: 0, output: 'OK', duration: 1000 };
    });

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('failure');
    expect(result.failureReason).toBe('permanent');
    expect(labelIssue).toHaveBeenCalledWith('owner/repo', 42, 'failed', 'in-progress');
    expect(commentIssue).toHaveBeenCalledWith('owner/repo', 42, expect.stringContaining('failed during implementation'));
    expect(mockCleanupWorktree).toHaveBeenCalled();
  });

  test('re-queues issue on transient error (usage limit) during implementation', async () => {
    mockSpawnAgent.mockImplementation(async (options) => {
      if (options.prompt === 'implement prompt') {
        return { exitCode: 1, output: "ERROR: You've hit your usage limit. Try again at 5:39 PM.", duration: 1000 };
      }
      return { exitCode: 0, output: 'OK', duration: 1000 };
    });

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('failure');
    expect(result.failureReason).toBe('transient');
    // Should re-queue with ready label, not failed
    expect(labelIssue).toHaveBeenCalledWith('owner/repo', 42, 'ready', 'in-progress');
    expect(updateProjectStatus).toHaveBeenCalledWith('owner/repo', 1, 'owner', 42, 'Todo');
    // Should NOT comment about failure
    expect(commentIssue).not.toHaveBeenCalledWith('owner/repo', 42, expect.stringContaining('failed during implementation'));
  });

  test('re-queues issue on transient error during planning', async () => {
    mockSpawnAgent.mockImplementation(async (options) => {
      if (options.prompt?.includes('structured implementation plan')) {
        return { exitCode: 1, output: "ERROR: You've hit your usage limit.", duration: 500 };
      }
      return { exitCode: 0, output: 'OK', duration: 1000 };
    });

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('failure');
    expect(result.failureReason).toBe('transient');
    expect(labelIssue).toHaveBeenCalledWith('owner/repo', 42, 'ready', 'in-progress');
  });

  test('retries tests up to maxTestRetries with fix agent', async () => {
    let testAttempt = 0;
    mockRunTests.mockImplementation(() => {
      testAttempt++;
      if (testAttempt < 3) {
        return { passed: false, output: `Fail attempt ${testAttempt}` };
      }
      return { passed: true, output: 'Tests passed on retry' };
    });

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig({ maxTestRetries: 3 }), makeSession());

    expect(result.status).toBe('success');
    expect(result.testsPassing).toBe(true);
    // Tests called 3 times (initial + 2 retries)
    expect(mockRunTests).toHaveBeenCalledTimes(3);
    // Fix agent called 2 times (after failures 1 and 2)
    // spawnAgent is called for: plan, implement, fix1, fix2, review = 5 times
    const fixCalls = (mockSpawnAgent as jest.Mock).mock.calls.filter(
      (call: any[]) => (call[0] as any).prompt?.includes('Tests are failing'),
    );
    expect(fixCalls).toHaveLength(2);
    // Fix calls should use session resume
    for (const call of fixCalls) {
      expect((call[0] as any).resume).toBe(true);
    }
  });

  test('dry run mode logs without executing side effects', async () => {
    const result = await processIssue(42, 'Test issue', 'Body', makeConfig({ dryRun: true }), makeSession());

    expect(result.issueNum).toBe(42);
    // Should not call GitHub APIs
    expect(updateProjectStatus).not.toHaveBeenCalled();
    expect(labelIssue).not.toHaveBeenCalled();
    // Should not create PR
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  test('returns failure when worktree setup fails', async () => {
    mockSetupWorktree.mockRejectedValue(new Error('git lock'));

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('failure');
    expect(labelIssue).toHaveBeenCalledWith('owner/repo', 42, 'failed', 'in-progress');
  });

  test('creates PR with review report and test output', async () => {
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: 'Review: all good', duration: 1000 });

    await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'owner/repo',
      head: 'agent/issue-42',
      title: expect.stringContaining('closes #42'),
      body: expect.stringContaining('Test Results'),
    }));
  });

  test('review gate loops back to implementer when review fails', async () => {
    const { existsSync, readFileSync } = require('node:fs');
    const mockExistsSync = existsSync as jest.MockedFunction<typeof import('node:fs').existsSync>;
    const mockReadFileSync = readFileSync as jest.MockedFunction<typeof import('node:fs').readFileSync>;

    // First review call: review gate says failed. Second: passed.
    let reviewCallCount = 0;
    mockExistsSync.mockImplementation((path: any) => {
      if (String(path).includes('review-issue-42.json')) return true;
      return false;
    });
    mockReadFileSync.mockImplementation((path: any) => {
      if (String(path).includes('review-issue-42.json')) {
        reviewCallCount++;
        if (reviewCallCount === 1) {
          return JSON.stringify({
            passed: false,
            summary: 'Scope drift detected',
            findings: [{ severity: 'critical', description: 'Unrelated files changed', fixed: false, file: 'globals.css' }],
          });
        }
        return JSON.stringify({ passed: true, summary: 'All issues fixed', findings: [] });
      }
      return '';
    });

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('success');
    // Should have called spawnAgent for: plan, implement, review1, fix, review2 = 5+ calls
    // The fix call should use resume
    const fixCalls = (mockSpawnAgent as jest.Mock).mock.calls.filter(
      (call: any[]) => (call[0] as any).prompt?.includes('code review for issue #42 found problems'),
    );
    expect(fixCalls.length).toBeGreaterThanOrEqual(1);
    expect(fixCalls[0][0].resume).toBe(true);
  });
});
