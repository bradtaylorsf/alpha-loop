import { formatEpicPickerMeta, formatMilestonePickerMeta, runCommand, runSingleEpicExecution } from '../../src/commands/run';

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

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn(),
  assertSafeShellArg: jest.fn((value: string) => value),
  resolveStepConfig: jest.fn((config: any) => ({ agent: config.agent, model: config.model })),
}));

jest.mock('../../src/lib/github', () => ({
  pollIssues: jest.fn(),
  listMilestones: jest.fn().mockReturnValue([]),
  listEpics: jest.fn().mockReturnValue([]),
  getEpicSubIssues: jest.fn().mockReturnValue([]),
  getIssueWithComments: jest.fn(),
  getMergedPRForIssue: jest.fn(),
  updateEpicChecklist: jest.fn(),
  commentIssue: jest.fn(),
  closeIssue: jest.fn(),
  labelIssue: jest.fn(),
}));

jest.mock('../../src/lib/pipeline', () => ({
  processIssue: jest.fn(),
  processBatch: jest.fn(),
  readGateResult: jest.fn(() => ({ passed: true, summary: '', findings: [] })),
  formatGateFindings: jest.fn(() => ''),
}));

jest.mock('../../src/lib/session', () => ({
  createSession: jest.fn(),
  finalizeSession: jest.fn(),
  recordSessionIssue: jest.fn(),
  recordSessionPolicyDecision: jest.fn(),
  saveResult: jest.fn(),
  transitionHumanFeedbackSessionStatus: jest.fn(),
  recordSessionCleanup: jest.fn(),
  transitionSessionStatus: jest.fn(),
  updateSessionManifest: jest.fn(),
}));

jest.mock('../../src/lib/verify-epic', () => ({
  verifyEpic: jest.fn().mockResolvedValue({
    verdict: 'pass',
    comment: 'Epic verified',
    parsed: { verdict: 'pass', summary: 'Epic verified', findings: [] },
  }),
}));

jest.mock('../../src/lib/worktree', () => ({
  cleanupWorktree: jest.fn(),
}));

jest.mock('../../src/lib/learning', () => ({
  generateSessionSummary: jest.fn().mockResolvedValue(null),
  repairSessionLearningArtifacts: jest.fn(),
  repairSessionSummaryArtifact: jest.fn(),
}));

jest.mock('../../src/lib/vision', () => ({
  hasVision: jest.fn().mockReturnValue(true),
}));

jest.mock('../../src/lib/context', () => ({
  contextNeedsRefresh: jest.fn().mockReturnValue(false),
}));

jest.mock('../../src/lib/preflight', () => ({
  runPreflight: jest.fn().mockResolvedValue({ passed: true, preExistingFailures: [] }),
  runPortCheck: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/lib/events', () => ({
  emitLifecycleEvent: jest.fn().mockResolvedValue({ event: {}, deliveries: [] }),
}));

jest.mock('../../src/lib/eval', () => ({
  saveCapturedCase: jest.fn(),
  detectFailureStep: jest.fn(() => 'implement'),
}));

jest.mock('../../src/commands/sync', () => ({
  syncAgentAssets: jest.fn().mockReturnValue({ synced: false, docSynced: false, skillsDirs: [] }),
  resolveHarnesses: jest.fn((harnesses: string[], _agent: string) => harnesses),
}));

jest.mock('node:fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  renameSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { loadConfig } from '../../src/lib/config';
import { pollIssues, listEpics, getEpicSubIssues, getIssueWithComments, updateEpicChecklist, labelIssue, commentIssue } from '../../src/lib/github';
import { processIssue, processBatch } from '../../src/lib/pipeline';
import { createSession, finalizeSession, transitionSessionStatus, recordSessionPolicyDecision, saveResult } from '../../src/lib/session';
import { generateSessionSummary, repairSessionLearningArtifacts, repairSessionSummaryArtifact } from '../../src/lib/learning';
import { contextNeedsRefresh } from '../../src/lib/context';
import { syncAgentAssets } from '../../src/commands/sync';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { emitLifecycleEvent } from '../../src/lib/events';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockLog = log as jest.Mocked<typeof log>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockPollIssues = pollIssues as jest.MockedFunction<typeof pollIssues>;
const mockListEpics = listEpics as jest.MockedFunction<typeof listEpics>;
const mockGetEpicSubIssues = getEpicSubIssues as jest.MockedFunction<typeof getEpicSubIssues>;
const mockGetIssueWithComments = getIssueWithComments as jest.MockedFunction<typeof getIssueWithComments>;
const mockUpdateEpicChecklist = updateEpicChecklist as jest.MockedFunction<typeof updateEpicChecklist>;
const mockLabelIssue = labelIssue as jest.MockedFunction<typeof labelIssue>;
const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;
const mockProcessIssue = processIssue as jest.MockedFunction<typeof processIssue>;
const mockProcessBatch = processBatch as jest.MockedFunction<typeof processBatch>;
const mockCreateSession = createSession as jest.MockedFunction<typeof createSession>;
const mockFinalizeSession = finalizeSession as jest.MockedFunction<typeof finalizeSession>;
const mockTransitionSessionStatus = transitionSessionStatus as jest.MockedFunction<typeof transitionSessionStatus>;
const mockRecordSessionPolicyDecision = recordSessionPolicyDecision as jest.MockedFunction<typeof recordSessionPolicyDecision>;
const mockSaveResult = saveResult as jest.MockedFunction<typeof saveResult>;
const mockGenerateSessionSummary = generateSessionSummary as jest.MockedFunction<typeof generateSessionSummary>;
const mockRepairSessionLearningArtifacts = repairSessionLearningArtifacts as jest.MockedFunction<typeof repairSessionLearningArtifacts>;
const mockRepairSessionSummaryArtifact = repairSessionSummaryArtifact as jest.MockedFunction<typeof repairSessionSummaryArtifact>;
const mockContextNeedsRefresh = contextNeedsRefresh as jest.MockedFunction<typeof contextNeedsRefresh>;
const mockSyncAgentAssets = syncAgentAssets as jest.MockedFunction<typeof syncAgentAssets>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockEmitLifecycleEvent = emitLifecycleEvent as jest.MockedFunction<typeof emitLifecycleEvent>;

function makeConfig(overrides: Record<string, unknown> = {}) {
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
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    preferEpics: false,
    ...overrides,
  };
}

// Prevent process.exit from actually exiting
const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;

  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
  mockExec.mockReturnValue({ stdout: '/usr/bin/tool', stderr: '', exitCode: 0 });
  mockLoadConfig.mockImplementation((overrides: any = {}) => makeConfig(overrides) as any);
  mockCreateSession.mockReturnValue({
    name: 'session/20260330-143000',
    branch: 'session/20260330-143000',
    resultsDir: '/tmp/sessions',
    logsDir: '/tmp/sessions/logs',
    results: [],
  });
  mockFinalizeSession.mockResolvedValue(null);
  mockPollIssues.mockReturnValue([]);
  mockListEpics.mockReturnValue([]);
  mockGetEpicSubIssues.mockReturnValue([]);
  mockGetIssueWithComments.mockReturnValue(null);
  mockProcessBatch.mockResolvedValue([]);
  mockContextNeedsRefresh.mockReturnValue(false);
  mockSyncAgentAssets.mockReturnValue({ synced: false, docSynced: false, skillsDirs: [] });
});

afterEach(() => {
  // Remove signal handlers to prevent test pollution
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.exitCode = undefined;
});

describe('runCommand', () => {
  test('picker metadata shows epic milestone membership and scheduled epic counts', () => {
    const epic = {
      number: 195,
      title: 'Scheduled Epic',
      body: '- [x] #1\n- [ ] #2',
      labels: ['epic'],
      milestone: 'Sprint 1',
    };
    const milestone = {
      number: 1,
      title: 'Sprint 1',
      description: '',
      openIssues: 3,
      closedIssues: 2,
      dueOn: '2026-06-01T00:00:00Z',
      state: 'open',
    };

    expect(formatEpicPickerMeta(epic)).toBe('1/2 done · milestone Sprint 1');
    expect(formatMilestonePickerMeta(milestone, [epic])).toBe('3 open, 2/5 done · due 2026-06-01 · 1 scheduled epic');
  });

  test('runSingleEpicExecution returns structured success with session branch and PR URL', async () => {
    const config = makeConfig({
      autoMerge: true,
      skipPostSessionReview: true,
    }) as any;

    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 195) {
        return { number: 195, title: 'Parent Epic', body: '- [ ] #201 Build child', labels: ['epic'] };
      }
      if (issueNum === 201) {
        return { number: 201, title: 'Build child', body: 'Child body', labels: ['ready'] };
      }
      return null;
    });
    mockGetEpicSubIssues.mockReturnValue([{ number: 201, checked: true, lineIndex: 0 }]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 201,
      title: 'Build child',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });
    mockFinalizeSession.mockResolvedValue('https://github.com/owner/repo/pull/500');

    const result = await runSingleEpicExecution({ config, epicNumber: 195 });

    expect(result).toEqual(expect.objectContaining({
      epicNumber: 195,
      sessionName: 'session/20260330-143000',
      sessionBranch: 'session/20260330-143000',
      sessionPrUrl: 'https://github.com/owner/repo/pull/500',
      status: 'success',
      failures: [],
      verificationClosedEpic: true,
    }));
    expect(mockUpdateEpicChecklist).toHaveBeenCalledWith('owner/repo', 195, 201, true);
    expect(mockEmitLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.started',
      session: expect.objectContaining({ name: 'session/20260330-143000' }),
    }));
    expect(mockEmitLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.completed',
      context: expect.objectContaining({
        prUrl: 'https://github.com/owner/repo/pull/500',
      }),
    }));
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('runSingleEpicExecution returns invalid epic number failure without exiting', async () => {
    const result = await runSingleEpicExecution({
      config: makeConfig() as any,
      epicNumber: 0,
    });

    expect(result.status).toBe('failure');
    expect(result.failures).toEqual([
      expect.objectContaining({ code: 'invalid-epic-number', exitCode: 1 }),
    ]);
    expect(mockGetIssueWithComments).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('runSingleEpicExecution returns missing epic label failure without exiting', async () => {
    const result = await runSingleEpicExecution({
      config: makeConfig() as any,
      epicNumber: 195,
      epicIssue: { number: 195, title: 'Tracker', body: '- [ ] #201', labels: ['ready'] },
    });

    expect(result.status).toBe('failure');
    expect(result.failures).toEqual([
      expect.objectContaining({ code: 'missing-epic-label', issueNum: 195, exitCode: 1 }),
    ]);
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('runSingleEpicExecution reports no eligible child issues without exiting', async () => {
    const config = makeConfig({ skipPostSessionReview: true }) as any;
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 195) {
        return { number: 195, title: 'Parent Epic', body: '- [ ] #201 Blocked child', labels: ['epic'] };
      }
      if (issueNum === 201) {
        return { number: 201, title: 'Blocked child', body: 'Child body', labels: ['blocked'] };
      }
      return null;
    });

    const result = await runSingleEpicExecution({ config, epicNumber: 195 });

    expect(result.status).toBe('failure');
    expect(result.sessionBranch).toBe('session/20260330-143000');
    expect(result.failures).toEqual([
      expect.objectContaining({ code: 'no-eligible-child-issues', issueNum: 195 }),
    ]);
    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('skips generated-file auto-commit when refreshed context fails validation', async () => {
    mockLoadConfig.mockImplementation((overrides: any = {}) => makeConfig({
      skipPostSessionReview: true,
      ...overrides,
    }) as any);
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git status --porcelain .alpha-loop/ AGENTS.md CLAUDE.md') {
        return { stdout: ' M .alpha-loop/context.md\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '/usr/bin/tool', stderr: '', exitCode: 0 };
    });
    mockExistsSync.mockImplementation((filePath: any) => String(filePath).endsWith('.alpha-loop/context.md'));
    mockReadFileSync.mockImplementation((filePath: any) => {
      if (String(filePath).endsWith('.alpha-loop/context.md')) {
        return 'Wrote `PROJECT_CONTEXT.md` summarizing the current codebase.';
      }
      return '';
    });

    await runCommand({});

    expect(mockLog.warn).toHaveBeenCalledWith('Skipping generated context/instructions auto-commit because validation failed:');
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).startsWith('git add '))).toBe(false);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).startsWith('git commit '))).toBe(false);
    expect(mockExec.mock.calls.some(([cmd]) => String(cmd).startsWith('git push '))).toBe(false);
  });

  test('--epics dry-run validates the full queue in order without creating sessions or manifests', async () => {
    const issues = new Map([
      [205, { number: 205, title: 'First Epic', body: '- [ ] #305', labels: ['epic'], state: 'OPEN' }],
      [166, { number: 166, title: 'Second Epic', body: '- [ ] #266', labels: ['epic'], state: 'OPEN' }],
      [214, { number: 214, title: 'Third Epic', body: '- [ ] #314', labels: ['epic'], state: 'OPEN' }],
    ]);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => (issues.get(issueNum) as any) ?? null);

    await runCommand({ epics: '205,166,214', dryRun: true });

    expect(mockGetIssueWithComments.mock.calls.map((call) => call[1])).toEqual([205, 166, 214]);
    expect(mockLog.dry).toHaveBeenCalledWith('Validated epic queue (3 epics):');
    expect(mockLog.dry).toHaveBeenCalledWith('  1. #205 First Epic');
    expect(mockLog.dry).toHaveBeenCalledWith('  2. #166 Second Epic');
    expect(mockLog.dry).toHaveBeenCalledWith('  3. #214 Third Epic');
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockUpdateEpicChecklist).not.toHaveBeenCalled();
    expect(mockFinalizeSession).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('dry-run session preview does not sync assets or refresh generated context', async () => {
    mockContextNeedsRefresh.mockReturnValue(true);
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Flat issue', body: 'Body', labels: ['ready'] },
    ]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Flat issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({ dryRun: true, validate: true });

    expect(mockSyncAgentAssets).not.toHaveBeenCalled();
    expect(mockLog.dry).toHaveBeenCalledWith('Would sync agent assets before run');
    expect(mockLog.dry).toHaveBeenCalledWith('Would refresh project context and instructions');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  test('--skip-epic tolerates malformed label entries when filtering epics', async () => {
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Runnable issue', body: 'Body', labels: [undefined, { name: 'ready' }] as any },
      { number: 195, title: 'Parent Epic', body: '- [ ] #42', labels: [{ name: 'epic' }] as any },
    ]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Runnable issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({ skipEpic: true, dryRun: true });

    expect(mockProcessIssue).toHaveBeenCalledTimes(1);
    expect(mockProcessIssue).toHaveBeenCalledWith(
      42,
      'Runnable issue',
      'Body',
      expect.any(Object),
      expect.any(Object),
    );
  });

  test('automation policy pauses blocked-label issues before agent execution', async () => {
    mockLoadConfig.mockImplementation((overrides: any = {}) => makeConfig({
      automationPolicy: {
        requireLabels: [],
        blockLabels: ['do-not-automate'],
        allowedPaths: [],
        protectedPaths: [],
        allowedCommands: [],
        requireHumanFor: [],
        maxActiveSessions: 0,
        maxPausedSessions: 0,
        maxIssuesPerSession: 0,
        maxSessionMinutes: 0,
        maxSessionCostUsd: 0,
        maxIssueCostUsd: 0,
      },
      ...overrides,
    }) as any);
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Unsafe issue', body: 'Body', labels: ['ready', 'do-not-automate'] },
    ]);

    await runCommand({ skipEpic: true });

    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockLabelIssue).toHaveBeenCalledWith('owner/repo', 42, 'needs-human-input', 'ready');
    expect(mockCommentIssue).toHaveBeenCalledWith('owner/repo', 42, expect.stringContaining('blocked label'));
    expect(mockRecordSessionPolicyDecision).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      stage: 'issue_start',
      issueNum: 42,
    }));
    expect(mockSaveResult).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      issueNum: 42,
      status: 'waiting',
      waitingStatus: 'human_input_requested',
    }));
  });

  test('--epics dry-run previews non-epic labels as warnings without mutating', async () => {
    const issues = new Map([
      [205, { number: 205, title: 'First Epic', body: '- [ ] #305', labels: ['epic'], state: 'OPEN' }],
      [214, { number: 214, title: 'Not Yet Labeled', body: '- [ ] #314', labels: ['ready'], state: 'OPEN' }],
    ]);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => (issues.get(issueNum) as any) ?? null);

    await runCommand({ epics: '205,214', dryRun: true });

    expect(mockLog.dry).toHaveBeenCalledWith('  1. #205 First Epic');
    expect(mockLog.dry).toHaveBeenCalledWith(expect.stringContaining('  2. #214 Not Yet Labeled (warning: Issue #214 is not labeled'));
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockUpdateEpicChecklist).not.toHaveBeenCalled();
    expect(mockFinalizeSession).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('--epics rejects incompatible targeting flags before processing', async () => {
    await runCommand({ epics: '205,166', epic: 205, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockGetIssueWithComments).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  test('--epics rejects invalid queued issues before processing the first epic', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 205,
      title: 'Not an epic',
      body: '- [ ] #305',
      labels: ['ready'],
      state: 'OPEN',
    });

    await runCommand({ epics: '205' });

    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('--epics processes each epic sequentially and writes a successful queue manifest', async () => {
    mockLoadConfig.mockImplementation((overrides: any = {}) => makeConfig({
      skipPostSessionReview: true,
      autoMerge: false,
      ...overrides,
    }) as any);

    const issues = new Map([
      [205, { number: 205, title: 'First Epic', body: 'Touches `src/lib/session.ts`.\n- [ ] #305 First child', labels: ['epic'], state: 'OPEN' }],
      [166, { number: 166, title: 'Second Epic', body: 'Depends on #205. Also touches `src/lib/session.ts`.\n- [ ] #266 Second child', labels: ['epic'], state: 'OPEN' }],
      [214, { number: 214, title: 'Third Epic', body: '- [ ] #314 Third child', labels: ['epic'], state: 'OPEN' }],
      [305, { number: 305, title: 'First child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
      [266, { number: 266, title: 'Second child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
      [314, { number: 314, title: 'Third child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
    ]);
    const childByEpic = new Map([[205, 305], [166, 266], [214, 314]]);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => (issues.get(issueNum) as any) ?? null);
    mockGetEpicSubIssues.mockImplementation((_repo: string, epicNum: number) => [{
      number: childByEpic.get(epicNum) ?? 0,
      checked: true,
      lineIndex: 0,
    }]);
    mockCreateSession.mockImplementation((_config: any, options: any = {}) => ({
      name: `session/epic-${options.epicNum}`,
      branch: `session/epic-${options.epicNum}`,
      resultsDir: `/tmp/sessions/epic-${options.epicNum}`,
      logsDir: `/tmp/sessions/epic-${options.epicNum}/logs`,
      results: [],
      epic: options.epicNum,
      queue: options.queue,
    }));
    mockProcessIssue.mockImplementation(async (issueNum: number, title: string) => ({
      issueNum,
      title,
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    }));
    mockFinalizeSession.mockImplementation(async (session: any) => `https://github.com/owner/repo/pull/${session.epic}`);

    await runCommand({ epics: '205,166,214' });

    expect(mockCreateSession.mock.calls.map((call) => call[1]?.epicNum)).toEqual([205, 166, 214]);
    const queueContexts = mockCreateSession.mock.calls.map((call) => (call[1] as any)?.queue);
    expect(queueContexts).toEqual([
      expect.objectContaining({
        queueIndex: 1,
        queueTotal: 3,
        currentEpic: expect.objectContaining({ number: 205, title: 'First Epic' }),
        nextEpic: expect.objectContaining({ number: 166, title: 'Second Epic' }),
        branchAncestryMode: 'stacked',
        branchedFromBranch: 'master',
        dependsOnSessionBranch: null,
        dependencyWarnings: expect.arrayContaining(['Later queued epic #166 declares a dependency on this epic.']),
        overlapWarnings: expect.arrayContaining(['Epics #205 and #166 both mention src/lib/session.ts.']),
      }),
      expect.objectContaining({
        queueIndex: 2,
        previousEpic: expect.objectContaining({ number: 205, title: 'First Epic', sessionPrUrl: 'https://github.com/owner/repo/pull/205' }),
        nextEpic: expect.objectContaining({ number: 214, title: 'Third Epic' }),
        previousSessionBranch: 'session/epic-205',
        previousSessionPrUrl: 'https://github.com/owner/repo/pull/205',
        branchAncestryMode: 'stacked',
        branchedFromBranch: 'session/epic-205',
        dependsOnSessionBranch: 'session/epic-205',
        rebaseOntoBranch: 'master',
        dependencyWarnings: expect.arrayContaining(['Epic #166 declares a dependency on queued epic #205.']),
        overlapWarnings: expect.arrayContaining(['Epics #205 and #166 both mention src/lib/session.ts.']),
      }),
      expect.objectContaining({
        queueIndex: 3,
        previousSessionBranch: 'session/epic-166',
        previousSessionPrUrl: 'https://github.com/owner/repo/pull/166',
        branchAncestryMode: 'stacked',
        branchedFromBranch: 'session/epic-166',
        dependsOnSessionBranch: 'session/epic-166',
      }),
    ]);
    expect(mockCreateSession.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ autoMerge: true, mergeTo: '' }),
      expect.objectContaining({ autoMerge: true, mergeTo: '' }),
      expect.objectContaining({ autoMerge: true, mergeTo: '' }),
    ]);
    expect(mockProcessIssue.mock.calls.map((call) => call[0])).toEqual([305, 266, 314]);
    expect(mockFinalizeSession).toHaveBeenCalledTimes(3);

    const manifest = JSON.parse(String(mockWriteFileSync.mock.calls.at(-1)?.[1]));
    expect(manifest).toEqual(expect.objectContaining({
      epicIds: [205, 166, 214],
      status: 'success',
      stopReason: null,
    }));
    expect(manifest.epics.map((entry: any) => ({
      epicNumber: entry.epicNumber,
      status: entry.status,
      sessionBranch: entry.sessionBranch,
      sessionPrUrl: entry.sessionPrUrl,
      branchAncestryMode: entry.branchAncestryMode,
      branchedFromBranch: entry.branchedFromBranch,
      dependsOnSessionBranch: entry.dependsOnSessionBranch,
      dependsOnSessionPrUrl: entry.dependsOnSessionPrUrl,
      nextSessionPrUrl: entry.nextSessionPrUrl,
    }))).toEqual([
      {
        epicNumber: 205,
        status: 'success',
        sessionBranch: 'session/epic-205',
        sessionPrUrl: 'https://github.com/owner/repo/pull/205',
        branchAncestryMode: 'stacked',
        branchedFromBranch: 'master',
        dependsOnSessionBranch: null,
        dependsOnSessionPrUrl: null,
        nextSessionPrUrl: 'https://github.com/owner/repo/pull/166',
      },
      {
        epicNumber: 166,
        status: 'success',
        sessionBranch: 'session/epic-166',
        sessionPrUrl: 'https://github.com/owner/repo/pull/166',
        branchAncestryMode: 'stacked',
        branchedFromBranch: 'session/epic-205',
        dependsOnSessionBranch: 'session/epic-205',
        dependsOnSessionPrUrl: 'https://github.com/owner/repo/pull/205',
        nextSessionPrUrl: 'https://github.com/owner/repo/pull/214',
      },
      {
        epicNumber: 214,
        status: 'success',
        sessionBranch: 'session/epic-214',
        sessionPrUrl: 'https://github.com/owner/repo/pull/214',
        branchAncestryMode: 'stacked',
        branchedFromBranch: 'session/epic-166',
        dependsOnSessionBranch: 'session/epic-166',
        dependsOnSessionPrUrl: 'https://github.com/owner/repo/pull/166',
        nextSessionPrUrl: null,
      },
    ]);
    expect(manifest.epics[0].dependencyWarnings).toEqual(expect.arrayContaining([
      'Later queued epic #166 declares a dependency on this epic.',
    ]));
    expect(manifest.epics[1].dependencyWarnings).toEqual(expect.arrayContaining([
      'Epic #166 declares a dependency on queued epic #205.',
    ]));
    expect(manifest.epics[1].overlapWarnings).toEqual(expect.arrayContaining([
      'Epics #205 and #166 both mention src/lib/session.ts.',
    ]));
    expect(mockFinalizeSession.mock.calls.map((call) => (call[0] as any).queue?.queueIndex)).toEqual([1, 2, 3]);
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('--epics can run independent queue branches without ancestry dependencies', async () => {
    mockLoadConfig.mockImplementation((overrides: any = {}) => makeConfig({
      skipPostSessionReview: true,
      autoMerge: false,
      ...overrides,
    }) as any);

    const issues = new Map([
      [205, { number: 205, title: 'First Epic', body: '- [ ] #305 First child', labels: ['epic'], state: 'OPEN' }],
      [166, { number: 166, title: 'Second Epic', body: '- [ ] #266 Second child', labels: ['epic'], state: 'OPEN' }],
      [305, { number: 305, title: 'First child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
      [266, { number: 266, title: 'Second child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
    ]);
    const childByEpic = new Map([[205, 305], [166, 266]]);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => (issues.get(issueNum) as any) ?? null);
    mockGetEpicSubIssues.mockImplementation((_repo: string, epicNum: number) => [{
      number: childByEpic.get(epicNum) ?? 0,
      checked: true,
      lineIndex: 0,
    }]);
    mockCreateSession.mockImplementation((_config: any, options: any = {}) => ({
      name: `session/epic-${options.epicNum}`,
      branch: `session/epic-${options.epicNum}`,
      resultsDir: `/tmp/sessions/epic-${options.epicNum}`,
      logsDir: `/tmp/sessions/epic-${options.epicNum}/logs`,
      results: [],
      epic: options.epicNum,
      queue: options.queue,
    }));
    mockProcessIssue.mockImplementation(async (issueNum: number, title: string) => ({
      issueNum,
      title,
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    }));
    mockFinalizeSession.mockImplementation(async (session: any) => `https://github.com/owner/repo/pull/${session.epic}`);

    await runCommand({ epics: '205,166', queueBranchMode: 'independent' });

    const queueContexts = mockCreateSession.mock.calls.map((call) => (call[1] as any)?.queue);
    expect(queueContexts).toEqual([
      expect.objectContaining({
        queueIndex: 1,
        branchAncestryMode: 'independent',
        branchedFromBranch: 'master',
        dependsOnSessionBranch: null,
        previousSessionBranch: null,
      }),
      expect.objectContaining({
        queueIndex: 2,
        branchAncestryMode: 'independent',
        branchedFromBranch: 'master',
        dependsOnSessionBranch: null,
        dependsOnSessionPrUrl: null,
        previousSessionBranch: 'session/epic-205',
        previousSessionPrUrl: 'https://github.com/owner/repo/pull/205',
      }),
    ]);

    const manifest = JSON.parse(String(mockWriteFileSync.mock.calls.at(-1)?.[1]));
    expect(manifest.branchAncestryMode).toBe('independent');
    expect(manifest.epics.map((entry: any) => ({
      epicNumber: entry.epicNumber,
      branchAncestryMode: entry.branchAncestryMode,
      branchedFromBranch: entry.branchedFromBranch,
      dependsOnSessionBranch: entry.dependsOnSessionBranch,
      dependsOnSessionPrUrl: entry.dependsOnSessionPrUrl,
    }))).toEqual([
      {
        epicNumber: 205,
        branchAncestryMode: 'independent',
        branchedFromBranch: 'master',
        dependsOnSessionBranch: null,
        dependsOnSessionPrUrl: null,
      },
      {
        epicNumber: 166,
        branchAncestryMode: 'independent',
        branchedFromBranch: 'master',
        dependsOnSessionBranch: null,
        dependsOnSessionPrUrl: null,
      },
    ]);
    expect(mockFinalizeSession.mock.calls.map((call) => (call[0] as any).queue?.branchAncestryMode)).toEqual(['independent', 'independent']);
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('--epics stops on the first failed epic and records the stop reason in the manifest', async () => {
    mockLoadConfig.mockImplementation((overrides: any = {}) => makeConfig({
      skipPostSessionReview: true,
      autoCapture: false,
      ...overrides,
    }) as any);

    const issues = new Map([
      [205, { number: 205, title: 'First Epic', body: '- [ ] #305 First child', labels: ['epic'], state: 'OPEN' }],
      [166, { number: 166, title: 'Second Epic', body: '- [ ] #266 Second child', labels: ['epic'], state: 'OPEN' }],
      [214, { number: 214, title: 'Third Epic', body: '- [ ] #314 Third child', labels: ['epic'], state: 'OPEN' }],
      [305, { number: 305, title: 'First child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
      [266, { number: 266, title: 'Second child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
      [314, { number: 314, title: 'Third child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
    ]);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => (issues.get(issueNum) as any) ?? null);
    mockGetEpicSubIssues.mockReturnValue([{ number: 305, checked: true, lineIndex: 0 }]);
    mockCreateSession.mockImplementation((_config: any, options: any = {}) => ({
      name: `session/epic-${options.epicNum}`,
      branch: `session/epic-${options.epicNum}`,
      resultsDir: `/tmp/sessions/epic-${options.epicNum}`,
      logsDir: `/tmp/sessions/epic-${options.epicNum}/logs`,
      results: [],
      epic: options.epicNum,
    }));
    mockProcessIssue.mockImplementation(async (issueNum: number, title: string) => ({
      issueNum,
      title,
      status: issueNum === 266 ? 'failure' : 'success',
      testsPassing: issueNum !== 266,
      verifyPassing: issueNum !== 266,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
      ...(issueNum === 266 ? { failureReason: 'transient' as const } : {}),
    }));
    mockFinalizeSession.mockImplementation(async (session: any) => `https://github.com/owner/repo/pull/${session.epic}`);

    await runCommand({ epics: '205,166,214' });

    expect(mockProcessIssue.mock.calls.map((call) => call[0])).toEqual([305, 266]);
    expect(mockCreateSession.mock.calls.map((call) => call[1]?.epicNum)).toEqual([205, 166]);
    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockGenerateSessionSummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session/epic-166',
      results: [expect.objectContaining({ issueNum: 266, status: 'failure' })],
    }));
    expect(mockRepairSessionLearningArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session/epic-166',
      issues: [expect.objectContaining({ issueNum: 266, status: 'failure' })],
    }));
    expect(mockRepairSessionSummaryArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session/epic-166',
    }));

    const manifest = JSON.parse(String(mockWriteFileSync.mock.calls.at(-1)?.[1]));
    expect(manifest.status).toBe('stopped');
    expect(manifest.stopReason).toBe('Epic #166 stopped: transient-agent-stop');
    expect(manifest.epics.map((entry: any) => [entry.epicNumber, entry.status])).toEqual([
      [205, 'success'],
      [166, 'failure'],
      [214, 'pending'],
    ]);
    expect(manifest.epics[1].failures).toEqual([
      expect.objectContaining({ code: 'transient-stop', issueNum: 266 }),
    ]);
  });

  test('--epics stops when an epic remains incomplete after processing eligible children', async () => {
    mockLoadConfig.mockImplementation((overrides: any = {}) => makeConfig({
      skipPostSessionReview: true,
      ...overrides,
    }) as any);

    const issues = new Map([
      [205, { number: 205, title: 'First Epic', body: '- [ ] #305 Ready child\n- [ ] #306 Blocked child', labels: ['epic'], state: 'OPEN' }],
      [166, { number: 166, title: 'Second Epic', body: '- [ ] #266 Second child', labels: ['epic'], state: 'OPEN' }],
      [305, { number: 305, title: 'Ready child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
      [306, { number: 306, title: 'Blocked child', body: 'Body', labels: ['blocked'], state: 'OPEN' }],
      [266, { number: 266, title: 'Second child', body: 'Body', labels: ['ready'], state: 'OPEN' }],
    ]);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => (issues.get(issueNum) as any) ?? null);
    mockCreateSession.mockImplementation((_config: any, options: any = {}) => ({
      name: `session/epic-${options.epicNum}`,
      branch: `session/epic-${options.epicNum}`,
      resultsDir: `/tmp/sessions/epic-${options.epicNum}`,
      logsDir: `/tmp/sessions/epic-${options.epicNum}/logs`,
      results: [],
      epic: options.epicNum,
    }));
    mockProcessIssue.mockResolvedValue({
      issueNum: 305,
      title: 'Ready child',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });
    mockFinalizeSession.mockImplementation(async (session: any) => `https://github.com/owner/repo/pull/${session.epic}`);

    await runCommand({ epics: '205,166' });

    expect(mockProcessIssue.mock.calls.map((call) => call[0])).toEqual([305]);
    expect(mockCreateSession.mock.calls.map((call) => call[1]?.epicNum)).toEqual([205]);
    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();

    const manifest = JSON.parse(String(mockWriteFileSync.mock.calls.at(-1)?.[1]));
    expect(manifest.status).toBe('stopped');
    expect(manifest.stopReason).toBe('Epic #205 stopped: epic-incomplete');
    expect(manifest.epics.map((entry: any) => [entry.epicNumber, entry.status])).toEqual([
      [205, 'failure'],
      [166, 'pending'],
    ]);
    expect(manifest.epics[0].failures).toEqual([
      expect.objectContaining({ code: 'epic-incomplete', issueNum: 205 }),
    ]);
  });

  test('--verify-only bypasses normal session creation and issue processing', async () => {
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 195) {
        return { number: 195, title: 'Parent Epic', body: '- [x] #201 Build child', labels: ['epic'] };
      }
      if (issueNum === 201) {
        return { number: 201, title: 'Build child', body: 'Child body', labels: ['ready'] };
      }
      return null;
    });
    mockGetEpicSubIssues.mockReturnValue([{ number: 201, checked: true, lineIndex: 0 }]);

    await runCommand({ verifyOnly: 195 });

    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockFinalizeSession).not.toHaveBeenCalled();
    expect(mockGetEpicSubIssues).toHaveBeenCalledWith('owner/repo', 195);
  });

  test('--issue dry-run processes exactly the requested standalone issue', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 42,
      title: 'Target issue',
      body: 'Target body',
      labels: ['ready'],
      state: 'OPEN',
    });
    mockListEpics.mockReturnValue([]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Target issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({ issue: 42, dryRun: true });

    expect(mockGetIssueWithComments).toHaveBeenCalledWith('owner/repo', 42);
    expect(mockPollIssues).not.toHaveBeenCalled();
    expect(mockProcessIssue).toHaveBeenCalledTimes(1);
    expect(mockProcessIssue).toHaveBeenCalledWith(
      42,
      'Target issue',
      'Target body',
      expect.objectContaining({ dryRun: true }),
      expect.any(Object),
    );
    expect(mockCreateSession).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      epicNum: undefined,
      milestone: undefined,
    }));
    expect(mockLog.dry).toHaveBeenCalledWith('Resolved --issue #42: Target issue');
    expect(mockLog.dry).toHaveBeenCalledWith(expect.stringContaining("Issue #42 is eligible: open, labeled 'ready', not blocked"));
    expect(mockUpdateEpicChecklist).not.toHaveBeenCalled();
  });

  test('--issue passes one parent epic context and updates only that checklist item', async () => {
    mockLoadConfig.mockImplementation((overrides: any = {}) => makeConfig({
      skipPostSessionReview: true,
      ...overrides,
    }) as any);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 42) {
        return {
          number: 42,
          title: 'Target child',
          body: 'Child body',
          labels: ['ready'],
          state: 'OPEN',
        };
      }
      return null;
    });
    mockListEpics.mockReturnValue([{
      number: 293,
      title: 'Parent Epic',
      body: `## Goal
Coordinate hosted work.

## Acceptance Criteria
- [ ] Child agents get parent context

## Checklist
- [ ] #42 Target child
- [ ] #43 Other child`,
      labels: ['epic'],
      state: 'OPEN',
    }]);
    let capturedEpicContext: any;
    mockProcessIssue.mockImplementation(async (_issueNum: number, _title: string, _body: string, _config: any, _session: any, options: any) => {
      capturedEpicContext = JSON.parse(JSON.stringify(options.epicContext));
      return {
        issueNum: 42,
        title: 'Target child',
        status: 'success',
        testsPassing: true,
        verifyPassing: true,
        verifySkipped: false,
        duration: 60,
        filesChanged: 5,
      };
    });

    await runCommand({ issue: 42 });

    expect(mockPollIssues).not.toHaveBeenCalled();
    expect(mockGetIssueWithComments.mock.calls.map((call) => call[1])).toEqual([42]);
    expect(mockCreateSession).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      epicNum: 293,
      epicTitle: 'Parent Epic',
    }));
    expect(mockProcessIssue).toHaveBeenCalledTimes(1);
    expect(capturedEpicContext).toEqual(expect.objectContaining({
      number: 293,
      title: 'Parent Epic',
      bodySummary: expect.stringContaining('Coordinate hosted work'),
      acceptanceCriteria: expect.arrayContaining(['- [ ] Child agents get parent context']),
    }));
    expect(capturedEpicContext.subIssues).toEqual([
      { issueNum: 42, title: 'Target child', checked: false },
      { issueNum: 43, title: 'Other child', checked: false },
    ]);
    expect(mockUpdateEpicChecklist).toHaveBeenCalledTimes(1);
    expect(mockUpdateEpicChecklist).toHaveBeenCalledWith('owner/repo', 293, 42, true);
  });

  test('--issue rejects parent epic misuse with --epic guidance', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 293,
      title: 'Parent Epic',
      body: '- [ ] #42',
      labels: ['ready', 'epic'],
      state: 'OPEN',
    });

    await runCommand({ issue: 293, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith('Issue #293 is labeled \'epic\'. Use alpha-loop run --epic 293 instead.');
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('--issue rejects blocked issues before session creation', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 42,
      title: 'Blocked issue',
      body: 'Body',
      labels: ['ready', 'blocked'],
      state: 'OPEN',
    });

    await runCommand({ issue: 42, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith('Issue #42 is blocked. Remove the \'blocked\' label before running --issue.');
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('--issue rejects closed issues before session creation', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 42,
      title: 'Closed issue',
      body: 'Body',
      labels: ['ready'],
      state: 'CLOSED',
    });

    await runCommand({ issue: 42, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith('Issue #42 is closed. Reopen it before running --issue.');
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('--issue rejects missing issues before session creation', async () => {
    mockGetIssueWithComments.mockReturnValue(null);

    await runCommand({ issue: 42, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith('Could not fetch issue #42. Check the issue number and repository before running --issue.');
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('--issue rejects ambiguous multi-parent child issues before mutation', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 42,
      title: 'Target child',
      body: 'Child body',
      labels: ['ready'],
      state: 'OPEN',
    });
    mockListEpics.mockReturnValue([
      { number: 293, title: 'Hosted Epic', body: '- [ ] #42 Target child', labels: ['epic'], state: 'OPEN' },
      { number: 294, title: 'Other Epic', body: '- [ ] #42 Target child', labels: ['epic'], state: 'OPEN' },
    ]);

    await runCommand({ issue: 42, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Issue #42 is referenced by multiple open parent epics'));
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockUpdateEpicChecklist).not.toHaveBeenCalled();
  });

  test('--issue exits nonzero when the targeted issue pipeline fails', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 42,
      title: 'Target issue',
      body: 'Target body',
      labels: ['ready'],
      state: 'OPEN',
    });
    mockListEpics.mockReturnValue([]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Target issue',
      status: 'failure',
      testsPassing: false,
      verifyPassing: false,
      verifySkipped: false,
      duration: 60,
      filesChanged: 0,
    });

    await runCommand({ issue: 42, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith('Issue #42 failed during processing');
  });

  test.each([
    [{ issue: 42, epic: 293, dryRun: true }, '--epic'],
    [{ issue: 42, epics: '293,294', dryRun: true }, '--epics'],
    [{ issue: 42, verifyOnly: 293, dryRun: true }, '--verify-only'],
  ])('--issue rejects incompatible flag %s before fetching issues', async (options, flag) => {
    await runCommand(options as any);

    expect(process.exitCode).toBe(1);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining(`--issue cannot be combined with ${flag}`));
    expect(mockGetIssueWithComments).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('processes all matching issues and exits', async () => {
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Test issue', body: 'Body', labels: ['ready'] },
    ]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Test issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({});

    expect(mockProcessIssue).toHaveBeenCalledWith(
      42, 'Test issue', 'Body',
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockRepairSessionLearningArtifacts).not.toHaveBeenCalled();
    expect(mockRepairSessionSummaryArtifact).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith('Skipping parent learning artifact repair; issue learnings are committed in child PRs');
    expect(mockFinalizeSession).toHaveBeenCalled();
  });

  test('continues other eligible work when one issue is waiting for human feedback', async () => {
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Needs clarification', body: 'Body', labels: ['ready'] },
      { number: 43, title: 'Still eligible', body: 'Body', labels: ['ready'] },
    ]);
    mockProcessIssue
      .mockResolvedValueOnce({
        issueNum: 42,
        title: 'Needs clarification',
        status: 'waiting',
        waitingStatus: 'human_input_requested',
        waitingReason: 'Need a decision',
        humanInputQuestion: 'Which option should be used?',
        testsPassing: false,
        verifyPassing: false,
        verifySkipped: true,
        duration: 10,
        filesChanged: 0,
      })
      .mockResolvedValueOnce({
        issueNum: 43,
        title: 'Still eligible',
        status: 'success',
        testsPassing: true,
        verifyPassing: true,
        verifySkipped: false,
        duration: 60,
        filesChanged: 5,
      });

    await runCommand({ dryRun: true });

    expect(mockProcessIssue.mock.calls.map((call) => call[0])).toEqual([42, 43]);
    expect(mockTransitionSessionStatus).toHaveBeenCalledWith(expect.any(Object), 'human_input_requested', 'human_input_requested', expect.any(Object));
    expect(process.exitCode).toBeUndefined();
  });

  test('repairs session learning artifacts only when auto-merge uses a session branch', async () => {
    mockLoadConfig.mockImplementation((overrides: any = {}) =>
      makeConfig({ ...overrides, autoMerge: true, skipPostSessionReview: true }) as any,
    );
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Test issue', body: 'Body', labels: ['ready'] },
    ]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Test issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({});

    expect(mockRepairSessionLearningArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session/20260330-143000',
      sessionLogsDir: '/tmp/sessions/logs',
      issues: [expect.objectContaining({ issueNum: 42, title: 'Test issue', status: 'success', duration: 60 })],
    }));
    expect(mockRepairSessionSummaryArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session/20260330-143000',
    }));
    expect(mockFinalizeSession).toHaveBeenCalled();
  });

  test('processes a single epic scheduled in the requested milestone', async () => {
    mockListEpics.mockReturnValue([
      {
        number: 195,
        title: 'Scheduled Epic',
        body: '- [ ] #201 Build scheduled child',
        labels: ['epic'],
        milestone: 'Sprint 1',
      },
    ]);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 201) {
        return { number: 201, title: 'Build scheduled child', body: 'Child body', labels: ['ready'] };
      }
      return null;
    });
    mockProcessIssue.mockResolvedValue({
      issueNum: 201,
      title: 'Build scheduled child',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({ milestone: 'Sprint 1', dryRun: true });

    expect(mockListEpics).toHaveBeenCalledWith('owner/repo', { milestone: 'Sprint 1' });
    expect(mockPollIssues).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      epicNum: 195,
      epicTitle: 'Scheduled Epic',
      milestone: undefined,
    }));
    expect(mockProcessIssue).toHaveBeenCalledWith(
      201,
      'Build scheduled child',
      'Child body',
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });

  test('surfaces multiple epics scheduled in a milestone and exits with guidance', async () => {
    mockListEpics.mockReturnValue([
      { number: 195, title: 'First Epic', body: '- [ ] #201', labels: ['epic'], milestone: 'Sprint 1' },
      { number: 196, title: 'Second Epic', body: '- [ ] #202', labels: ['epic'], milestone: 'Sprint 1' },
    ]);

    await runCommand({ milestone: 'Sprint 1', dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('falls back to flat milestone flow when no epics are scheduled and filters epic parents', async () => {
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Flat issue', body: 'Body', labels: ['ready'] },
      { number: 195, title: 'Parent Epic', body: '- [ ] #42', labels: ['ready', 'epic'] },
    ]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Flat issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({ milestone: 'Sprint 1', dryRun: true });

    expect(mockListEpics).toHaveBeenCalledWith('owner/repo', { milestone: 'Sprint 1' });
    expect(mockPollIssues).toHaveBeenCalledWith('owner/repo', 'ready', 100, expect.objectContaining({
      milestone: 'Sprint 1',
    }));
    expect(mockProcessIssue).toHaveBeenCalledTimes(1);
    expect(mockProcessIssue).toHaveBeenCalledWith(
      42,
      'Flat issue',
      'Body',
      expect.any(Object),
      expect.any(Object),
    );
  });

  test('--skip-epic preserves flat milestone flow without epic discovery', async () => {
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Flat issue', body: 'Body', labels: ['ready'] },
      { number: 195, title: 'Parent Epic', body: '- [ ] #42', labels: ['ready', 'epic'] },
    ]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Flat issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({ milestone: 'Sprint 1', skipEpic: true, dryRun: true });

    expect(mockListEpics).not.toHaveBeenCalled();
    expect(mockPollIssues).toHaveBeenCalledWith('owner/repo', 'ready', 100, expect.objectContaining({
      milestone: 'Sprint 1',
    }));
    expect(mockProcessIssue).toHaveBeenCalledTimes(1);
  });

  test('--epic overrides milestone-targeted epic discovery', async () => {
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 195) {
        return { number: 195, title: 'Forced Epic', body: '- [ ] #201 Build forced child', labels: ['epic'] };
      }
      if (issueNum === 201) {
        return { number: 201, title: 'Build forced child', body: 'Child body', labels: ['ready'] };
      }
      return null;
    });
    mockProcessIssue.mockResolvedValue({
      issueNum: 201,
      title: 'Build forced child',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({ milestone: 'Sprint 1', epic: 195, dryRun: true });

    expect(mockListEpics).not.toHaveBeenCalled();
    expect(mockPollIssues).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      epicNum: 195,
      milestone: undefined,
    }));
    expect(mockProcessIssue).toHaveBeenCalledWith(
      201,
      'Build forced child',
      'Child body',
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });

  test('--epic rejects issues that are not labeled epic', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 195,
      title: 'Unlabeled tracker',
      body: '- [ ] #201',
      labels: ['ready'],
    });

    await runCommand({ epic: 195, dryRun: true });

    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockPollIssues).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('--verify-only rejects issues that are not labeled epic', async () => {
    mockGetIssueWithComments.mockReturnValue({
      number: 195,
      title: 'Unlabeled tracker',
      body: '- [x] #201',
      labels: ['ready'],
    });

    await runCommand({ verifyOnly: 195 });

    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('exits cleanly when no issues found', async () => {
    mockPollIssues.mockReturnValue([]);

    await runCommand({});

    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockFinalizeSession).toHaveBeenCalled();
  });

  test('passes CLI options to config as overrides', async () => {
    mockPollIssues.mockReturnValue([]);

    await runCommand({
      dryRun: true,
      model: 'sonnet',
      skipTests: true,
      autoMerge: true,
    });

    expect(mockLoadConfig).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      model: 'sonnet',
      skipTests: true,
      autoMerge: true,
    }));
  });

  test('exits when repo is not configured', async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ repo: '' }) as any);

    await runCommand({});

    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
  });

  test('checks prerequisites before fetching issues', async () => {
    mockPollIssues.mockReturnValue([]);

    await runCommand({});

    // Should check for gh, git, claude
    expect(mockExec).toHaveBeenCalledWith('command -v "gh"');
    expect(mockExec).toHaveBeenCalledWith('command -v "git"');
    expect(mockExec).toHaveBeenCalledWith('command -v "claude"');
  });

  test('passes compact parent epic context to sub-issue processing for --epic runs', async () => {
    const epicBody = `## Goal
Ship the epic as a coordinated set of sub-issues.

## Acceptance Criteria
- [ ] Parent agents understand the epic
- [ ] Sibling ordering is visible

## Checklist
- [x] #188 Add epic issue template during init
- [ ] #189 Inject parent epic context into sub-issue agents`;

    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 195) {
        return { number: 195, title: 'Parent Epic', body: epicBody, labels: ['epic'] };
      }
      if (issueNum === 189) {
        return { number: 189, title: 'Child Issue', body: 'Child body', labels: ['ready'] };
      }
      return null;
    });
    mockProcessIssue.mockResolvedValue({
      issueNum: 189,
      title: 'Child Issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({ epic: 195, dryRun: true });

    expect(mockGetIssueWithComments.mock.calls.filter((call) => call[1] === 195)).toHaveLength(1);
    const options = mockProcessIssue.mock.calls[0][5] as any;
    expect(options.epicContext).toEqual(expect.objectContaining({
      number: 195,
      title: 'Parent Epic',
      bodySummary: expect.stringContaining('Ship the epic'),
      acceptanceCriteria: expect.arrayContaining(['- [ ] Parent agents understand the epic']),
    }));
    expect(options.epicContext.subIssues).toEqual([
      { issueNum: 188, title: 'Add epic issue template during init', checked: true },
      { issueNum: 189, title: 'Inject parent epic context into sub-issue agents', checked: false },
    ]);
  });

  test('passes parent epic context to batch processing for --epic batch runs', async () => {
    const epicBody = `## Goal
Coordinate batch children.

## Acceptance Criteria
- [ ] Batch agents understand the epic

## Checklist
- [ ] #189 First child
- [ ] #190 Second child`;

    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 195) {
        return { number: 195, title: 'Parent Epic', body: epicBody, labels: ['epic'] };
      }
      if (issueNum === 189) {
        return { number: 189, title: 'First child', body: 'First body', labels: ['ready'] };
      }
      if (issueNum === 190) {
        return { number: 190, title: 'Second child', body: 'Second body', labels: ['ready'] };
      }
      return null;
    });
    mockProcessBatch.mockResolvedValue([
      { issueNum: 189, title: 'First child', status: 'success', testsPassing: true, verifyPassing: true, verifySkipped: true, duration: 30, filesChanged: 1 },
      { issueNum: 190, title: 'Second child', status: 'success', testsPassing: true, verifyPassing: true, verifySkipped: true, duration: 30, filesChanged: 1 },
    ]);

    await runCommand({ epic: 195, dryRun: true, batch: true });

    const options = mockProcessBatch.mock.calls[0][3] as any;
    expect(options.epicContext).toEqual(expect.objectContaining({
      number: 195,
      title: 'Parent Epic',
      bodySummary: expect.stringContaining('Coordinate batch children'),
    }));
    expect(mockProcessIssue).not.toHaveBeenCalled();
  });

  test('does not pass epic context for flat runs', async () => {
    mockPollIssues.mockReturnValue([
      { number: 42, title: 'Test issue', body: 'Body', labels: ['ready'] },
    ]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 42,
      title: 'Test issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 60,
      filesChanged: 5,
    });

    await runCommand({});

    expect(mockProcessIssue.mock.calls[0]).toHaveLength(5);
  });
});
