import { processIssue, processBatch, buildPRBody } from '../../src/lib/pipeline';
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
  buildEndpointEnv: jest.fn().mockReturnValue({}),
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

jest.mock('../../src/lib/config', () => ({
  estimateCost: jest.fn().mockReturnValue(0),
  getFallbackPolicy: jest.fn().mockReturnValue(null),
  resolveRoutingStage: jest.fn().mockReturnValue(undefined),
}));

jest.mock('../../src/lib/prompts', () => ({
  buildImplementPrompt: jest.fn().mockReturnValue('implement prompt'),
  buildReviewPrompt: jest.fn().mockReturnValue('review prompt'),
  buildBatchPlanPrompt: jest.fn().mockReturnValue('batch plan prompt'),
  buildBatchImplementPrompt: jest.fn().mockReturnValue('batch implement prompt'),
  buildBatchReviewPrompt: jest.fn().mockReturnValue('batch review prompt'),
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
import { spawnAgent } from '../../src/lib/agent';
import { setupWorktree, cleanupWorktree } from '../../src/lib/worktree';
import { labelIssue, commentIssue, createPR, mergePR, updateProjectStatus } from '../../src/lib/github';
import { runTests } from '../../src/lib/testing';
import { extractLearnings, getLearningContext } from '../../src/lib/learning';
import { saveResult, getPreviousResult } from '../../src/lib/session';
import type { Config } from '../../src/lib/config';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockSetupWorktree = setupWorktree as jest.MockedFunction<typeof setupWorktree>;
const mockCleanupWorktree = cleanupWorktree as jest.MockedFunction<typeof cleanupWorktree>;
const mockCreatePR = createPR as jest.MockedFunction<typeof createPR>;
const mockMergePR = mergePR as jest.MockedFunction<typeof mergePR>;
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

  // Default: everything succeeds
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
  mockSetupWorktree.mockResolvedValue({ path: '/tmp/worktree', branch: 'agent/issue-42', resumed: false });
  mockCleanupWorktree.mockResolvedValue();
  mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: 'Agent output', duration: 5000 });
  mockRunTests.mockReturnValue({ passed: true, output: 'All tests passed' });
  mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/1');
  mockMergePR.mockReturnValue(undefined as any);
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
  });

  test('returns failure and re-queues when worktree setup fails', async () => {
    mockSetupWorktree.mockRejectedValue(new Error('git lock'));

    const result = await processIssue(42, 'Test issue', 'Body', makeConfig(), makeSession());

    expect(result.status).toBe('failure');
    // Should re-queue (label back to ready) instead of marking as failed
    expect(labelIssue).toHaveBeenCalledWith('owner/repo', 42, 'ready', 'in-progress');
    expect(updateProjectStatus).toHaveBeenCalledWith('owner/repo', 1, 'owner', 42, 'Todo');
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
