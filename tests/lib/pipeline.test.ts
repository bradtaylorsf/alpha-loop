import { processIssue, processBatch, buildPRBody } from '../../src/lib/pipeline';
import type { SessionContext } from '../../src/lib/session';

// Mock all dependencies
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
  },
}));

jest.mock('../../src/lib/agent', () => ({
  spawnAgent: jest.fn(),
  buildEndpointEnv: jest.fn().mockReturnValue({}),
}));

jest.mock('../../src/lib/worktree', () => ({
  setupWorktree: jest.fn(),
  cleanupWorktree: jest.fn(),
  worktreeHasCommits: jest.fn(),
}));

jest.mock('../../src/lib/github', () => ({
  assignIssue: jest.fn(),
  labelIssue: jest.fn(),
  commentIssue: jest.fn(),
  createPR: jest.fn(),
  mergePR: jest.fn(),
  updateProjectStatus: jest.fn(),
  getIssueComments: jest.fn(() => []),
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
  writeCrashMarker: jest.fn(),
}));

jest.mock('../../src/lib/traces', () => ({
  writeTrace: jest.fn(),
  writeTraceMetadata: jest.fn(),
  writeTraceToSubdir: jest.fn(),
  writeRunManifest: jest.fn(),
  writeConfigSnapshot: jest.fn(),
  writeScores: jest.fn(),
  writeCosts: jest.fn(),
  computeScores: jest.fn().mockReturnValue({}),
  computeCosts: jest.fn().mockReturnValue({}),
  runDir: jest.fn().mockReturnValue('/tmp/traces/run'),
}));

jest.mock('../../src/lib/telemetry', () => ({
  buildStageTelemetry: jest.fn().mockReturnValue({}),
  writeStageTelemetry: jest.fn(),
}));

jest.mock('../../src/lib/config', () => ({
  estimateCost: jest.fn().mockReturnValue(0),
  getFallbackPolicy: jest.fn().mockReturnValue(null),
  resolveRoutingStage: jest.fn().mockReturnValue(undefined),
  resolveStepConfig: jest.fn((config: Config, step: string) => {
    const stepOverride = config.pipeline?.[step as keyof typeof config.pipeline];
    return {
      agent: stepOverride?.agent ?? config.agent,
      model: stepOverride?.model ?? (step === 'review' ? (config.reviewModel || config.model) : config.model),
    };
  }),
  selectRoutingProfile: jest.fn().mockReturnValue(undefined),
}));

jest.mock('../../src/lib/prompts', () => ({
  buildIssuePlanPrompt: jest.fn().mockReturnValue('structured implementation plan prompt'),
  buildImplementPrompt: jest.fn().mockReturnValue('implement prompt'),
  buildReviewPrompt: jest.fn().mockReturnValue('review prompt'),
  buildBatchPlanPrompt: jest.fn().mockReturnValue('batch plan prompt'),
  buildBatchImplementPrompt: jest.fn().mockReturnValue('batch implement prompt'),
  buildBatchReviewPrompt: jest.fn().mockReturnValue('batch review prompt'),
  formatEpicPromptContext: jest.fn().mockReturnValue('## Parent Epic Context\nEpic #195: Parent epic'),
  buildAssumptionsPrompt: jest.fn().mockReturnValue('assumptions prompt'),
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { spawnAgent } from '../../src/lib/agent';
import { setupWorktree, cleanupWorktree, worktreeHasCommits } from '../../src/lib/worktree';
import { labelIssue, commentIssue, createPR, mergePR, updateProjectStatus } from '../../src/lib/github';
import { runTests } from '../../src/lib/testing';
import { runVerify } from '../../src/lib/verify';
import { extractLearnings, getLearningContext } from '../../src/lib/learning';
import { saveResult, getPreviousResult, writeCrashMarker } from '../../src/lib/session';
import { buildIssuePlanPrompt, buildImplementPrompt, buildReviewPrompt, buildBatchPlanPrompt, buildBatchImplementPrompt, buildBatchReviewPrompt } from '../../src/lib/prompts';
import { writeTraceToSubdir } from '../../src/lib/traces';
import type { Config } from '../../src/lib/config';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockLog = log as jest.Mocked<typeof log>;
const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockSetupWorktree = setupWorktree as jest.MockedFunction<typeof setupWorktree>;
const mockCleanupWorktree = cleanupWorktree as jest.MockedFunction<typeof cleanupWorktree>;
const mockWorktreeHasCommits = worktreeHasCommits as jest.MockedFunction<typeof worktreeHasCommits>;
const mockCreatePR = createPR as jest.MockedFunction<typeof createPR>;
const mockMergePR = mergePR as jest.MockedFunction<typeof mergePR>;
const mockRunTests = runTests as jest.MockedFunction<typeof runTests>;
const mockRunVerify = runVerify as jest.MockedFunction<typeof runVerify>;
const mockExtractLearnings = extractLearnings as jest.MockedFunction<typeof extractLearnings>;
const mockGetLearningContext = getLearningContext as jest.MockedFunction<typeof getLearningContext>;
const mockSaveResult = saveResult as jest.MockedFunction<typeof saveResult>;
const mockGetPreviousResult = getPreviousResult as jest.MockedFunction<typeof getPreviousResult>;
const mockWriteCrashMarker = writeCrashMarker as jest.MockedFunction<typeof writeCrashMarker>;
const mockBuildIssuePlanPrompt = buildIssuePlanPrompt as jest.MockedFunction<typeof buildIssuePlanPrompt>;
const mockBuildImplementPrompt = buildImplementPrompt as jest.MockedFunction<typeof buildImplementPrompt>;
const mockBuildReviewPrompt = buildReviewPrompt as jest.MockedFunction<typeof buildReviewPrompt>;
const mockBuildBatchPlanPrompt = buildBatchPlanPrompt as jest.MockedFunction<typeof buildBatchPlanPrompt>;
const mockBuildBatchImplementPrompt = buildBatchImplementPrompt as jest.MockedFunction<typeof buildBatchImplementPrompt>;
const mockBuildBatchReviewPrompt = buildBatchReviewPrompt as jest.MockedFunction<typeof buildBatchReviewPrompt>;
const mockWriteTraceToSubdir = writeTraceToSubdir as jest.MockedFunction<typeof writeTraceToSubdir>;

const epicContext = {
  number: 195,
  title: 'Parent epic',
  bodySummary: 'Parent body summary',
  acceptanceCriteria: ['- [ ] Parent AC'],
  subIssues: [
    { issueNum: 42, title: 'Test issue', checked: false },
  ],
};

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
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    preferEpics: false,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
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
  const { existsSync, readFileSync } = require('node:fs');
  (existsSync as jest.Mock).mockReset();
  (existsSync as jest.Mock).mockReturnValue(false);
  (readFileSync as jest.Mock).mockReset();
  (readFileSync as jest.Mock).mockReturnValue('');

  // Default: everything succeeds
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
  mockSetupWorktree.mockResolvedValue({ path: '/tmp/worktree', branch: 'agent/issue-42', resumed: false });
  mockCleanupWorktree.mockResolvedValue();
  mockWorktreeHasCommits.mockReturnValue(0);
  mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: 'Agent output', duration: 5000 });
  mockRunTests.mockReturnValue({ passed: true, output: 'All tests passed' });
  mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/1');
  mockMergePR.mockReturnValue(undefined as any);
  mockExtractLearnings.mockResolvedValue(null);
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

  test('sets auto-commit metadata when the agent leaves uncommitted work', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') {
        return { stdout: ' M src/lib/pipeline.ts\n?? tests/lib/pipeline.test.ts\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await processIssue(42, 'Test issue', 'Issue body', makeConfig(), makeSession());

    expect(result.autoCommittedByPipeline).toBe(true);
    expect(result.autoCommittedPaths).toEqual(['src/lib/pipeline.ts', 'tests/lib/pipeline.test.ts']);
    expect(mockLog.warn).toHaveBeenCalledWith(
      'Agent did not commit; auto-committing 2 files: src/lib/pipeline.ts, tests/lib/pipeline.test.ts',
    );
    expect(mockExec).toHaveBeenCalledWith('git add -A', { cwd: '/tmp/worktree' });
    expect(mockExec).toHaveBeenCalledWith(
      "git commit -m 'feat: implement issue #42 - Test issue'",
      { cwd: '/tmp/worktree' },
    );
    expect(mockSaveResult).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      autoCommittedByPipeline: true,
      autoCommittedPaths: ['src/lib/pipeline.ts', 'tests/lib/pipeline.test.ts'],
    }));
  });

  test('shell-quotes issue titles in fallback auto-commit messages', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain') {
        return { stdout: ' M src/lib/pipeline.ts\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await processIssue(42, "Danger $(touch /tmp/pwned) 'quote'", 'Issue body', makeConfig(), makeSession());

    expect(mockExec).toHaveBeenCalledWith(
      "git commit -m 'feat: implement issue #42 - Danger $(touch /tmp/pwned) '\\''quote'\\'''",
      { cwd: '/tmp/worktree' },
    );
  });

  test('extracts and commits the learning artifact in the worktree before creating the PR', async () => {
    const learningPath = '/tmp/worktree/.alpha-loop/learnings/issue-42-20260101-000000.md';
    mockExtractLearnings.mockResolvedValueOnce(learningPath);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git diff "origin/master...HEAD"') {
        return { stdout: 'diff --git a/src/foo.ts b/src/foo.ts', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith('git diff --cached --name-only --')) {
        return { stdout: '.alpha-loop/learnings/issue-42-20260101-000000.md', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await processIssue(42, 'Test issue', 'Issue body', makeConfig(), makeSession());

    expect(mockExtractLearnings).toHaveBeenCalledWith(expect.objectContaining({
      outputRoot: '/tmp/worktree',
      agentCwd: '/tmp/worktree',
      sessionLogsDir: '/tmp/sessions/session/20260330-143000/logs',
      sessionName: 'session/20260330-143000',
    }));

    const commitCallIndex = mockExec.mock.calls.findIndex(([cmd]) =>
      String(cmd).startsWith("git commit -m 'chore: add learning artifact for issue #42'"),
    );
    expect(commitCallIndex).toBeGreaterThanOrEqual(0);
    expect(mockExec.mock.calls[commitCallIndex][0]).toContain('.alpha-loop/learnings/issue-42-20260101-000000.md');
    expect(mockExtractLearnings.mock.invocationCallOrder[0]).toBeLessThan(
      mockExec.mock.invocationCallOrder[commitCallIndex],
    );
    expect(mockExec.mock.invocationCallOrder[commitCallIndex]).toBeLessThan(
      mockCreatePR.mock.invocationCallOrder[0],
    );
  });

  test('uses per-step pipeline agents for plan, implementation, and review', async () => {
    await processIssue(42, 'Test issue', 'Issue body', makeConfig({
      agent: 'codex',
      model: 'gpt-5.4',
      reviewModel: 'gpt-5.4',
      pipeline: {
        plan: { agent: 'claude', model: 'claude-opus-4-6' },
        implement: { agent: 'codex', model: 'gpt-5.4' },
        review: { agent: 'claude', model: 'claude-sonnet-4-6' },
      },
    }), makeSession());

    const planCall = mockSpawnAgent.mock.calls.find(
      (call: any[]) => call[0].prompt === 'structured implementation plan prompt',
    );
    const implementCall = mockSpawnAgent.mock.calls.find(
      (call: any[]) => call[0].prompt === 'implement prompt',
    );
    const reviewCall = mockSpawnAgent.mock.calls.find(
      (call: any[]) => call[0].prompt === 'review prompt',
    );

    expect(planCall?.[0]).toEqual(expect.objectContaining({
      agent: 'claude',
      model: 'claude-opus-4-6',
    }));
    expect(implementCall?.[0]).toEqual(expect.objectContaining({
      agent: 'codex',
      model: 'gpt-5.4',
    }));
    expect(reviewCall?.[0]).toEqual(expect.objectContaining({
      agent: 'claude',
      model: 'claude-sonnet-4-6',
    }));
  });

  test('uses test_fix pipeline override for failing test repair', async () => {
    let testAttempt = 0;
    mockRunTests.mockImplementation(() => {
      testAttempt++;
      return testAttempt === 1
        ? { passed: false, output: 'First attempt failed' }
        : { passed: true, output: 'Tests passed on retry' };
    });

    await processIssue(42, 'Test issue', 'Issue body', makeConfig({
      agent: 'claude',
      model: 'opus',
      pipeline: {
        test_fix: { agent: 'codex', model: 'gpt-5.4-mini' },
      },
    }), makeSession());

    const fixCall = mockSpawnAgent.mock.calls.find(
      (call: any[]) => call[0].prompt?.includes('Tests are failing for issue #42'),
    );
    expect(fixCall?.[0]).toEqual(expect.objectContaining({
      agent: 'codex',
      model: 'gpt-5.4-mini',
      resume: true,
    }));
  });

  test('passes epic context into plan, implementation, review, and learning stages', async () => {
    await processIssue(42, 'Test issue', 'Issue body', makeConfig(), makeSession(), { epicContext });

    expect(mockBuildIssuePlanPrompt).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
    expect(mockBuildImplementPrompt).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
    expect(mockBuildReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
    expect(mockExtractLearnings).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
  });

  test('does not pass epic context when pipeline options are omitted', async () => {
    await processIssue(42, 'Test issue', 'Issue body', makeConfig(), makeSession());

    expect(mockBuildIssuePlanPrompt.mock.calls[0][0]).not.toHaveProperty('epicContext');
    expect(mockBuildImplementPrompt.mock.calls[0][0]).not.toHaveProperty('epicContext');
    expect(mockBuildReviewPrompt.mock.calls[0][0]).not.toHaveProperty('epicContext');
    expect(mockExtractLearnings.mock.calls[0][0]).not.toHaveProperty('epicContext');
  });

  test('prompt traces contain epic context only when provided', async () => {
    mockBuildIssuePlanPrompt.mockImplementationOnce((options: any) =>
      options.epicContext ? 'plan prompt\n## Parent Epic Context' : 'plan prompt',
    );
    mockBuildImplementPrompt.mockImplementationOnce((options: any) =>
      options.epicContext ? 'implement prompt\n## Parent Epic Context' : 'implement prompt',
    );
    mockBuildReviewPrompt.mockImplementationOnce((options: any) =>
      options.epicContext ? 'review prompt\n## Parent Epic Context' : 'review prompt',
    );

    await processIssue(42, 'Test issue', 'Issue body', makeConfig(), makeSession(), { epicContext });

    const promptTraceBodies = mockWriteTraceToSubdir.mock.calls
      .filter((call) => call[1] === 'prompts')
      .map((call) => String(call[3]));

    expect(promptTraceBodies.some((body) => body.includes('## Parent Epic Context'))).toBe(true);

    jest.clearAllMocks();
    mockBuildIssuePlanPrompt.mockReturnValue('structured implementation plan prompt');
    mockBuildImplementPrompt.mockReturnValue('implement prompt');
    mockBuildReviewPrompt.mockReturnValue('review prompt');

    await processIssue(42, 'Test issue', 'Issue body', makeConfig(), makeSession());

    const nonEpicPromptTraceBodies = mockWriteTraceToSubdir.mock.calls
      .filter((call) => call[1] === 'prompts')
      .map((call) => String(call[3]));
    expect(nonEpicPromptTraceBodies.every((body) => !body.includes('## Parent Epic Context'))).toBe(true);
  });

  test('passes epic context into runVerify when plan requires verification', async () => {
    const { existsSync, readFileSync } = require('node:fs');
    const mockExistsSync = existsSync as jest.MockedFunction<typeof import('node:fs').existsSync>;
    const mockReadFileSync = readFileSync as jest.MockedFunction<typeof import('node:fs').readFileSync>;

    mockExistsSync.mockImplementation((path: any) => String(path).includes('plan-issue-42.json'));
    mockReadFileSync.mockImplementation((path: any) => {
      if (String(path).includes('plan-issue-42.json')) {
        return JSON.stringify({
          summary: 'Plan',
          files: ['src/index.ts'],
          implementation: 'Implement it',
          testing: { needed: false, reason: 'Covered by verification' },
          verification: { needed: true, method: 'playwright', instructions: 'Open app', reason: 'Runtime behavior' },
        });
      }
      return '';
    });
    mockRunVerify.mockResolvedValue({ passed: true, skipped: false, output: 'Status: PASS' });

    await processIssue(42, 'Test issue', 'Issue body', makeConfig({ skipVerify: false }), makeSession(), { epicContext });

    expect(mockRunVerify).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
  });

  test('continues from verify-fix into PR creation when verification passes on retry', async () => {
    const { existsSync, readFileSync } = require('node:fs');
    const mockExistsSync = existsSync as jest.MockedFunction<typeof import('node:fs').existsSync>;
    const mockReadFileSync = readFileSync as jest.MockedFunction<typeof import('node:fs').readFileSync>;

    mockExistsSync.mockImplementation((path: any) => String(path).includes('plan-issue-42.json'));
    mockReadFileSync.mockImplementation((path: any) => {
      if (String(path).includes('plan-issue-42.json')) {
        return JSON.stringify({
          summary: 'Plan with live verification',
          files: ['src/index.ts'],
          implementation: 'Implement it',
          testing: { needed: false, reason: 'Verified live' },
          verification: { needed: true, method: 'playwright', instructions: 'Open app', reason: 'Runtime behavior' },
        });
      }
      return '';
    });

    let verifyAttempt = 0;
    mockRunVerify.mockImplementation(async () => {
      verifyAttempt++;
      if (verifyAttempt === 1) {
        return { passed: false, skipped: false, output: 'Verification failed' };
      }
      return { passed: true, skipped: false, output: 'Verification passed' };
    });

    const result = await processIssue(42, 'Test issue', 'Issue body', makeConfig({ skipVerify: false }), makeSession());

    expect(result.status).toBe('success');
    expect(mockRunVerify).toHaveBeenCalledTimes(2);
    expect(mockCreatePR).toHaveBeenCalled();

    const verifyFixCallIndex = (mockSpawnAgent as jest.Mock).mock.calls.findIndex(
      (call: any[]) => (call[0] as any).prompt?.includes('Live verification failed for issue #42'),
    );
    expect(verifyFixCallIndex).toBeGreaterThanOrEqual(0);
    const verifyFixOptions = (mockSpawnAgent as jest.Mock).mock.calls[verifyFixCallIndex][0] as any;
    expect(verifyFixOptions.resume).toBe(true);
    expect(verifyFixOptions.resultGraceMs).toBe(60_000);

    expect(mockCreatePR.mock.invocationCallOrder[0]).toBeGreaterThan(
      (mockSpawnAgent as jest.Mock).mock.invocationCallOrder[verifyFixCallIndex],
    );
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

  test('does NOT re-queue on timeout (timeout is not transient)', async () => {
    mockSpawnAgent.mockImplementation(async (options) => {
      if (options.prompt === 'implement prompt') {
        return { exitCode: 1, output: 'some output\n[TIMEOUT] Agent killed after exceeding time limit.', duration: 1800000 };
      }
      return { exitCode: 0, output: 'OK', duration: 1000 };
    });

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('failure');
    expect(result.failureReason).toBe('permanent');
    // Should label as failed, NOT re-queue
    expect(labelIssue).toHaveBeenCalledWith('owner/repo', 42, 'failed', 'in-progress');
  });

  test('does NOT re-queue when transient keywords appear only in code the agent wrote', async () => {
    // Agent wrote an exceptions.py containing "rate limit" and "capacity" in docstrings,
    // but the actual error was a timeout — not a transient API error.
    const codeOutput = 'class TransientError(AgentError):\n    """Retryable error — network timeouts, rate limits, temporary DB failures."""\n';
    const paddedOutput = codeOutput + 'x'.repeat(3000) + '\nError: implementation failed';
    mockSpawnAgent.mockImplementation(async (options) => {
      if (options.prompt === 'implement prompt') {
        return { exitCode: 1, output: paddedOutput, duration: 1000 };
      }
      return { exitCode: 0, output: 'OK', duration: 1000 };
    });

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('failure');
    // The "rate limit" text is in the code, not the tail — should be permanent failure
    expect(result.failureReason).toBe('permanent');
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
    expect(mockSaveResult).not.toHaveBeenCalled();
    expect(mockWriteTraceToSubdir).not.toHaveBeenCalled();
  });

  test('returns failure and re-queues when worktree setup fails', async () => {
    mockSetupWorktree.mockRejectedValue(new Error('git lock'));

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('failure');
    // Should re-queue (label back to ready) instead of marking as failed
    expect(labelIssue).toHaveBeenCalledWith('owner/repo', 42, 'ready', 'in-progress');
    expect(updateProjectStatus).toHaveBeenCalledWith('owner/repo', 1, 'owner', 42, 'Todo');
  });

  test('writes a recoverable crash marker when a post-commit pipeline step throws', async () => {
    const { existsSync, readFileSync } = require('node:fs');
    const mockExistsSync = existsSync as jest.MockedFunction<typeof import('node:fs').existsSync>;
    const mockReadFileSync = readFileSync as jest.MockedFunction<typeof import('node:fs').readFileSync>;
    const session = makeSession();

    mockExistsSync.mockImplementation((path: any) => String(path).includes('plan-issue-42.json'));
    mockReadFileSync.mockImplementation((path: any) => {
      if (String(path).includes('plan-issue-42.json')) {
        return JSON.stringify({
          summary: 'Plan with live verification',
          files: ['src/index.ts'],
          implementation: 'Implement it',
          testing: { needed: false, reason: 'Covered by verification' },
          verification: { needed: true, method: 'playwright', instructions: 'Open app', reason: 'Runtime behavior' },
        });
      }
      return '';
    });
    mockWorktreeHasCommits.mockReturnValue(1);
    mockRunVerify.mockRejectedValueOnce(new Error('review browser crashed'));

    await expect(
      processIssue(42, 'Test issue', 'Body', makeConfig({ skipVerify: false }), session),
    ).rejects.toThrow('review browser crashed');

    expect(mockWriteCrashMarker).toHaveBeenCalledWith(session, expect.objectContaining({
      issueNum: 42,
      step: 'verify',
      branch: 'agent/issue-42',
      hasCommits: true,
      error: 'review browser crashed',
      recoverable: true,
    }));
    expect(mockSaveResult).not.toHaveBeenCalled();
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

  test('skips auto-merge when tests are failing', async () => {
    mockRunTests.mockReturnValue({ passed: false, output: 'Tests failed' });

    await processIssue(42, 'Test issue', 'Body', makeConfig({ autoMerge: true }), makeSession());

    // PR should still be created
    expect(mockCreatePR).toHaveBeenCalled();
    // But mergePR should NOT be called
    expect(mockMergePR).not.toHaveBeenCalled();
  });

  test('preserves worktree when auto-merge fails', async () => {
    mockMergePR.mockImplementation(() => { throw new Error('merge conflict'); });

    await processIssue(42, 'Test issue', 'Body', makeConfig({ autoMerge: true }), makeSession());

    // Cleanup should be called with preserveIfCommits: true
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ preserveIfCommits: true }),
    );
  });

  test('preserves worktree when tests fail and auto-merge is enabled', async () => {
    mockRunTests.mockReturnValue({ passed: false, output: 'Tests failed' });

    await processIssue(42, 'Test issue', 'Body', makeConfig({ autoMerge: true }), makeSession());

    // Cleanup should preserve commits since merge didn't happen
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ preserveIfCommits: true }),
    );
  });
});

describe('processIssue — retry-with-escalation', () => {
  const mockedConfigModule = require('../../src/lib/config');
  const routedConfig = () => makeConfig({
    routing: {
      profile: 'hybrid-v1',
      endpoints: {
        anthropic: { type: 'anthropic' as const, base_url: 'https://api.anthropic.com' },
        lmstudio_local: { type: 'anthropic_compat' as const, base_url: 'http://localhost:1234' },
      },
      stages: {
        plan: { model: 'claude-opus-4-7', endpoint: 'anthropic' },
        build: { model: 'qwen3-coder-30b-a3b', endpoint: 'lmstudio_local' },
      },
      fallback: {
        on_tool_error: 'escalate',
        escalate_to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic' },
      },
    },
  });

  const { EscalationTracker } = require('../../src/lib/escalation');

  beforeEach(() => {
    mockedConfigModule.getFallbackPolicy.mockReset();
    mockedConfigModule.resolveRoutingStage.mockReset();
    mockedConfigModule.getFallbackPolicy.mockReturnValue(null);
    mockedConfigModule.resolveRoutingStage.mockReturnValue(undefined);
  });

  test('re-invokes the build stage with escalate_to after 2 tool errors in one turn', async () => {
    mockedConfigModule.getFallbackPolicy.mockReturnValue({
      on_tool_error: 'escalate',
      escalate_to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic' },
      escalation_window_issues: 10,
      escalation_error_threshold: 0.08,
      escalation_revert_ms: 86_400_000,
    });
    mockedConfigModule.resolveRoutingStage.mockImplementation((_c: any, stage: string) => {
      if (stage === 'build') return { model: 'qwen3-coder-30b-a3b', endpoint: { type: 'anthropic_compat', base_url: 'http://localhost:1234' } };
      return undefined;
    });

    const errorOutput = 'SyntaxError: Unexpected token } in JSON\nunknown tool: frobnicate\n';
    mockSpawnAgent.mockImplementation(async (options: any) => {
      if (options.prompt === 'implement prompt' && options.model === 'qwen3-coder-30b-a3b') {
        return { exitCode: 0, output: errorOutput, duration: 100 };
      }
      return { exitCode: 0, output: 'ok', duration: 100 };
    });

    const tracker = new EscalationTracker({ statePath: null, now: () => 1_000_000 });
    const result = await (processIssue as any)(42, 'Test', 'Body', routedConfig(), makeSession(), tracker);

    const buildCalls = (mockSpawnAgent as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0].prompt === 'implement prompt',
    );
    // First call with primary, second call with escalated model
    expect(buildCalls.length).toBe(2);
    expect(buildCalls[0][0].model).toBe('qwen3-coder-30b-a3b');
    expect(buildCalls[1][0].model).toBe('claude-sonnet-4-6');

    // Escalation event captured on the result
    expect(result.escalationEvents).toBeDefined();
    const esc = result.escalationEvents!.find((e: any) => e.type === 'escalation');
    expect(esc).toBeDefined();
    expect(esc!.stage).toBe('build');
    expect(esc!.from_model).toBe('qwen3-coder-30b-a3b');
    expect(esc!.to_model).toBe('claude-sonnet-4-6');
  });

  test('does not escalate when on_tool_error === "fail"', async () => {
    mockedConfigModule.getFallbackPolicy.mockReturnValue({
      on_tool_error: 'fail',
      escalate_to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic' },
      escalation_window_issues: 10,
      escalation_error_threshold: 0.08,
      escalation_revert_ms: 86_400_000,
    });
    mockedConfigModule.resolveRoutingStage.mockImplementation((_c: any, stage: string) => {
      if (stage === 'build') return { model: 'qwen3-coder-30b-a3b', endpoint: { type: 'anthropic_compat', base_url: 'http://localhost:1234' } };
      return undefined;
    });

    const errorOutput = 'SyntaxError: Unexpected token\nunknown tool: foo\n';
    mockSpawnAgent.mockImplementation(async (options: any) => {
      if (options.prompt === 'implement prompt') {
        return { exitCode: 0, output: errorOutput, duration: 100 };
      }
      return { exitCode: 0, output: 'ok', duration: 100 };
    });

    const tracker = new EscalationTracker({ statePath: null, now: () => 1_000_000 });
    const result = await (processIssue as any)(42, 'Test', 'Body', routedConfig(), makeSession(), tracker);

    const buildCalls = (mockSpawnAgent as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0].prompt === 'implement prompt',
    );
    // on_tool_error === 'fail' — no retry, single invocation
    expect(buildCalls.length).toBe(1);
    // No escalation event
    const esc = (result.escalationEvents ?? []).find((e: any) => e.type === 'escalation');
    expect(esc).toBeUndefined();
  });

  test('subsequent turn reverts to primary — escalation is single-turn scoped', async () => {
    mockedConfigModule.getFallbackPolicy.mockReturnValue({
      on_tool_error: 'escalate',
      escalate_to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic' },
      escalation_window_issues: 10,
      escalation_error_threshold: 0.08,
      escalation_revert_ms: 86_400_000,
    });
    mockedConfigModule.resolveRoutingStage.mockImplementation((_c: any, stage: string) => {
      if (stage === 'build') return { model: 'qwen3-coder-30b-a3b', endpoint: { type: 'anthropic_compat', base_url: 'http://localhost:1234' } };
      return undefined;
    });

    // First build call emits errors (triggers escalation). Test retries cause additional turns.
    let buildCallIdx = 0;
    mockSpawnAgent.mockImplementation(async (options: any) => {
      if (options.prompt === 'implement prompt') {
        buildCallIdx++;
        if (buildCallIdx === 1) {
          // First turn: primary emits errors, will escalate
          return { exitCode: 0, output: 'SyntaxError: x\nZodError: y', duration: 100 };
        }
        // Escalated retry — clean
        return { exitCode: 0, output: 'ok', duration: 100 };
      }
      return { exitCode: 0, output: 'ok', duration: 100 };
    });
    // Tests pass immediately — no test_write stage needed
    mockRunTests.mockReturnValue({ passed: true, output: 'ok' });

    const tracker = new EscalationTracker({ statePath: null, now: () => 1_000_000 });
    await (processIssue as any)(42, 'Test', 'Body', routedConfig(), makeSession(), tracker);

    // After escalation, the tracker should have recorded one turn for 'build' stage
    expect(tracker.errorRate('build')).toBeGreaterThan(0);
  });

  test('stage pinned to fallback emits stage_revert_active when >threshold', async () => {
    mockedConfigModule.getFallbackPolicy.mockReturnValue({
      on_tool_error: 'escalate',
      escalate_to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic' },
      escalation_window_issues: 10,
      escalation_error_threshold: 0.08,
      escalation_revert_ms: 86_400_000,
    });
    mockedConfigModule.resolveRoutingStage.mockImplementation((_c: any, stage: string) => {
      if (stage === 'build') return { model: 'qwen3-coder-30b-a3b', endpoint: { type: 'anthropic_compat', base_url: 'http://localhost:1234' } };
      return undefined;
    });

    const tracker = new EscalationTracker({ statePath: null, now: () => 1_000_000 });
    // Pre-fill the tracker so the build stage is already pinned
    tracker.markRevert('build', 1_000_000 + 60 * 60 * 1000);

    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: 'ok', duration: 100 });

    const result = await (processIssue as any)(42, 'Test', 'Body', routedConfig(), makeSession(), tracker);

    // The build stage call should go directly to the fallback model
    const buildCalls = (mockSpawnAgent as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0].prompt === 'implement prompt',
    );
    expect(buildCalls[0][0].model).toBe('claude-sonnet-4-6');

    // stage_revert_active event recorded
    const revertEvent = (result.escalationEvents ?? []).find((e: any) => e.type === 'stage_revert_active');
    expect(revertEvent).toBeDefined();
    expect(revertEvent!.stage).toBe('build');
  });

  test('crossing the rolling error threshold emits stage_revert + needs_human_input', async () => {
    mockedConfigModule.getFallbackPolicy.mockReturnValue({
      on_tool_error: 'escalate',
      escalate_to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic' },
      escalation_window_issues: 4,
      escalation_error_threshold: 0.08,
      escalation_revert_ms: 86_400_000,
    });
    mockedConfigModule.resolveRoutingStage.mockImplementation((_c: any, stage: string) => {
      if (stage === 'build') return { model: 'qwen3-coder-30b-a3b', endpoint: { type: 'anthropic_compat', base_url: 'http://localhost:1234' } };
      return undefined;
    });

    const tracker = new EscalationTracker({ statePath: null, now: () => 1_000_000 });
    // Pre-populate 3 errored turns for 'build' — next errored turn will push rate over 0.08
    for (let i = 0; i < 3; i++) {
      tracker.recordTurn({ stage: 'build', errored: true, escalated: false, windowSize: 4 });
    }

    mockSpawnAgent.mockImplementation(async (options: any) => {
      if (options.prompt === 'implement prompt' && options.model === 'qwen3-coder-30b-a3b') {
        return { exitCode: 0, output: 'SyntaxError: x\nunknown tool: y', duration: 100 };
      }
      return { exitCode: 0, output: 'ok', duration: 100 };
    });

    const result = await (processIssue as any)(42, 'Test', 'Body', routedConfig(), makeSession(), tracker);

    const events = result.escalationEvents ?? [];
    const hasRevert = events.some((e: any) => e.type === 'stage_revert');
    const hasNeedsHuman = events.some((e: any) => e.type === 'needs_human_input');
    expect(hasRevert).toBe(true);
    expect(hasNeedsHuman).toBe(true);
    // Guardrail pin established
    expect(tracker.isStageReverted('build')).toBe(true);
  });
});

describe('processBatch', () => {
  const batchIssues = [
    { number: 10, title: 'Issue 10', body: 'Body 10' },
    { number: 11, title: 'Issue 11', body: 'Body 11' },
  ];

  test('passes epic context into batch prompts, learnings, and PR body', async () => {
    await processBatch(batchIssues, makeConfig({ batch: true }), { ...makeSession(), epic: 195 }, { epicContext });

    expect(mockBuildBatchPlanPrompt).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
    expect(mockBuildBatchImplementPrompt).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
    expect(mockBuildBatchReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
    expect(mockExtractLearnings).toHaveBeenCalledWith(expect.objectContaining({ epicContext }));
    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('Part of #195'),
    }));
  });

  test('dry run mode does not save batch results or traces', async () => {
    await processBatch(batchIssues, makeConfig({ batch: true, dryRun: true }), makeSession());

    expect(mockSaveResult).not.toHaveBeenCalled();
    expect(mockWriteTraceToSubdir).not.toHaveBeenCalled();
  });

  test('commits all batch learning artifacts before creating the batch PR', async () => {
    mockExtractLearnings
      .mockResolvedValueOnce('/tmp/worktree/.alpha-loop/learnings/issue-10-20260101-000000.md')
      .mockResolvedValueOnce('/tmp/worktree/.alpha-loop/learnings/issue-11-20260101-000000.md');
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git diff "origin/master...HEAD"') {
        return { stdout: 'diff --git a/src/foo.ts b/src/foo.ts', stderr: '', exitCode: 0 };
      }
      if (cmd.startsWith('git diff --cached --name-only --')) {
        return {
          stdout: [
            '.alpha-loop/learnings/issue-10-20260101-000000.md',
            '.alpha-loop/learnings/issue-11-20260101-000000.md',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await processBatch(batchIssues, makeConfig({ batch: true }), makeSession());

    expect(mockExtractLearnings).toHaveBeenCalledTimes(2);
    expect(mockExtractLearnings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      issueNum: 10,
      outputRoot: '/tmp/worktree',
      agentCwd: '/tmp/worktree',
    }));
    expect(mockExtractLearnings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      issueNum: 11,
      outputRoot: '/tmp/worktree',
      agentCwd: '/tmp/worktree',
    }));

    const commitCallIndex = mockExec.mock.calls.findIndex(([cmd]) =>
      String(cmd).startsWith("git commit -m 'chore: add learning artifacts for issues #10, #11'"),
    );
    expect(commitCallIndex).toBeGreaterThanOrEqual(0);
    expect(mockExec.mock.calls[commitCallIndex][0]).toContain('issue-10-20260101-000000.md');
    expect(mockExec.mock.calls[commitCallIndex][0]).toContain('issue-11-20260101-000000.md');
    expect(mockExtractLearnings.mock.invocationCallOrder[1]).toBeLessThan(
      mockExec.mock.invocationCallOrder[commitCallIndex],
    );
    expect(mockExec.mock.invocationCallOrder[commitCallIndex]).toBeLessThan(
      mockCreatePR.mock.invocationCallOrder[0],
    );
  });

  test('skips auto-merge when tests are failing', async () => {
    mockRunTests.mockReturnValue({ passed: false, output: 'Tests failed' });

    const results = await processBatch(batchIssues, makeConfig({ autoMerge: true, batch: true }), makeSession());

    // All results should be failures
    expect(results.every((r) => r.status === 'failure')).toBe(true);
    // PR should still be created
    expect(mockCreatePR).toHaveBeenCalled();
    // But mergePR should NOT be called
    expect(mockMergePR).not.toHaveBeenCalled();
  });

  test('preserves worktree when auto-merge fails', async () => {
    mockMergePR.mockImplementation(() => { throw new Error('DIRTY merge state'); });

    await processBatch(batchIssues, makeConfig({ autoMerge: true, batch: true }), makeSession());

    // Cleanup should preserve commits
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ preserveIfCommits: true }),
    );
  });

  test('cleans up worktree normally after successful merge', async () => {
    await processBatch(batchIssues, makeConfig({ autoMerge: true, batch: true }), makeSession());

    // Merge should have been called
    expect(mockMergePR).toHaveBeenCalled();
    // Cleanup should NOT have preserveIfCommits
    expect(mockCleanupWorktree).toHaveBeenCalledWith(
      expect.not.objectContaining({ preserveIfCommits: true }),
    );
  });
});

describe('buildPRBody', () => {
  const defaultReviewGate = {
    passed: true,
    summary: 'Looks good',
    findings: [],
  };

  test('contains Closes #<issueNum> reference', () => {
    const body = buildPRBody(42, 'My feature', defaultReviewGate, '', true, true, false, '');
    expect(body).toContain('Closes #42');
  });

  test('contains Part of #<epicNum> when epicNum is provided', () => {
    const body = buildPRBody(42, 'My feature', defaultReviewGate, '', true, true, false, '', 165);
    expect(body).toContain('Closes #42');
    expect(body).toContain('Part of #165');
  });

  test('does NOT contain Part of when epicNum is not provided', () => {
    const body = buildPRBody(42, 'My feature', defaultReviewGate, '', true, true, false, '');
    expect(body).not.toContain('Part of');
  });

  test('includes test results section with pass/fail status', () => {
    const body = buildPRBody(42, 'My feature', defaultReviewGate, 'Tests: 10 passed', true, true, false, '');
    expect(body).toContain('Test Results');
    expect(body).toContain('PASS');
  });

  test('shows SKIPPED for verification when verifySkipped is true', () => {
    const body = buildPRBody(42, 'My feature', defaultReviewGate, '', true, false, true, '');
    expect(body).toContain('SKIPPED');
  });

  test('shows FAIL for verification when verifyPassing is false and not skipped', () => {
    const body = buildPRBody(42, 'My feature', defaultReviewGate, '', true, false, false, '');
    expect(body).toContain('FAIL');
  });
});
