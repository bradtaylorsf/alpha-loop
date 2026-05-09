import { formatEpicPickerMeta, formatMilestonePickerMeta, runCommand } from '../../src/commands/run';

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
}));

jest.mock('../../src/lib/session', () => ({
  createSession: jest.fn(),
  finalizeSession: jest.fn(),
}));

jest.mock('../../src/lib/worktree', () => ({
  cleanupWorktree: jest.fn(),
}));

jest.mock('../../src/lib/learning', () => ({
  generateSessionSummary: jest.fn().mockResolvedValue(null),
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

jest.mock('../../src/commands/sync', () => ({
  syncAgentAssets: jest.fn().mockReturnValue({ synced: false, docSynced: false, skillsDirs: [] }),
  resolveHarnesses: jest.fn((harnesses: string[], _agent: string) => harnesses),
}));

jest.mock('node:fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
}));

import { exec } from '../../src/lib/shell';
import { loadConfig } from '../../src/lib/config';
import { pollIssues, listEpics, getIssueWithComments, updateEpicChecklist } from '../../src/lib/github';
import { processIssue, processBatch } from '../../src/lib/pipeline';
import { createSession, finalizeSession } from '../../src/lib/session';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockPollIssues = pollIssues as jest.MockedFunction<typeof pollIssues>;
const mockListEpics = listEpics as jest.MockedFunction<typeof listEpics>;
const mockGetIssueWithComments = getIssueWithComments as jest.MockedFunction<typeof getIssueWithComments>;
const mockUpdateEpicChecklist = updateEpicChecklist as jest.MockedFunction<typeof updateEpicChecklist>;
const mockProcessIssue = processIssue as jest.MockedFunction<typeof processIssue>;
const mockProcessBatch = processBatch as jest.MockedFunction<typeof processBatch>;
const mockCreateSession = createSession as jest.MockedFunction<typeof createSession>;
const mockFinalizeSession = finalizeSession as jest.MockedFunction<typeof finalizeSession>;

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
  mockGetIssueWithComments.mockReturnValue(null);
  mockProcessBatch.mockResolvedValue([]);
});

afterEach(() => {
  // Remove signal handlers to prevent test pollution
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
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

    expect(mockExit).toHaveBeenCalledWith(1);
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

    expect(mockExit).toHaveBeenCalledWith(1);
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

    expect(mockExit).toHaveBeenCalledWith(1);
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

    expect(mockExit).toHaveBeenCalledWith(1);
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
