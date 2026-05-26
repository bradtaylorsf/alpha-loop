import { triageCommand } from '../../src/commands/triage';
import { roadmapCommand } from '../../src/commands/roadmap';
import { runCommand } from '../../src/commands/run';

jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
    readFileSync: jest.fn(() => ''),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    renameSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

jest.mock('@inquirer/prompts', () => ({
  checkbox: jest.fn(),
  confirm: jest.fn(),
}));

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn((overrides = {}) => ({
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 0,
    agent: 'claude' as const,
    model: 'sonnet',
    reviewModel: 'sonnet',
    labelReady: 'ready',
    dryRun: false,
    baseBranch: 'master',
    pollInterval: 60,
    logDir: 'logs',
    maxTestRetries: 3,
    testCommand: 'pnpm test',
    devCommand: 'pnpm dev',
    skipTests: false,
    skipReview: false,
    skipInstall: false,
    skipPreflight: true,
    skipVerify: false,
    skipLearn: true,
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
    skipPostSessionReview: true,
    skipPostSessionSecurity: true,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    preferEpics: false,
    ...overrides,
  })),
  assertSafeShellArg: jest.fn((val: string) => val),
}));

jest.mock('../../src/lib/agent', () => ({
  buildOneShotCommand: jest.fn(() => 'claude -p --output-format text'),
  spawnAgent: jest.fn(),
}));

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(() => ({ stdout: '/usr/bin/tool', stderr: '', exitCode: 0 })),
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

jest.mock('../../src/lib/rate-limit', () => ({
  ghExec: jest.fn(() => ({ stdout: '', stderr: '', exitCode: 0 })),
  getRateLimitStatus: jest.fn(() => ({ remaining: 5000, limit: 5000, used: 0, resetAt: 0, ratio: 1 })),
  getProjectCache: jest.fn(() => null),
  setProjectCache: jest.fn(),
  clearProjectCache: jest.fn(),
  resetRateLimitState: jest.fn(),
  parseRateLimitHeaders: jest.fn(() => null),
  stripDebugOutput: jest.fn((s: string) => s),
}));

jest.mock('../../src/lib/planning', () => ({
  ...jest.requireActual('../../src/lib/planning'),
  parseTriageAnalysisResponse: jest.fn(),
  extractJsonFromResponse: jest.fn(),
  formatTriageFindings: jest.fn(() => 'FORMATTED FINDINGS'),
  formatEpicGroupProposals: jest.fn(() => 'FORMATTED EPIC PROPOSALS'),
  formatRoadmapTable: jest.fn(() => 'FORMATTED ROADMAP'),
  buildPlanningContext: jest.fn(() => ({
    visionContext: null,
    projectContext: null,
    existingIssues: [],
  })),
}));

jest.mock('../../src/lib/github', () => ({
  listOpenIssues: jest.fn(() => []),
  listOpenIssuesWithComments: jest.fn(() => []),
  listRoadmapEpics: jest.fn(() => []),
  listMilestones: jest.fn(() => []),
  createMilestone: jest.fn(() => 0),
  setIssueMilestone: jest.fn(),
  addIssueToProject: jest.fn(),
  createIssue: jest.fn(() => 0),
  closeIssue: jest.fn(),
  updateIssue: jest.fn(),
  commentIssue: jest.fn(),
  getIssueBody: jest.fn(() => ''),
  updateEpicIssueBody: jest.fn(() => true),
  commentChildEpicBacklink: jest.fn(() => true),
  getIssueComments: jest.fn(() => []),
  pollIssues: jest.fn(() => []),
  listEpics: jest.fn(() => []),
  getEpicSubIssues: jest.fn(() => []),
  getIssueWithComments: jest.fn(),
  getMergedPRForIssue: jest.fn(() => null),
  updateEpicChecklist: jest.fn(),
  labelIssue: jest.fn(),
}));

jest.mock('../../src/lib/pipeline', () => ({
  processIssue: jest.fn(),
  processBatch: jest.fn(() => []),
  readGateResult: jest.fn(() => ({ passed: true, findings: [] })),
  formatGateFindings: jest.fn(() => ''),
}));

jest.mock('../../src/lib/session', () => ({
  createSession: jest.fn(() => ({
    name: 'session/epic-first',
    branch: 'session/epic-first',
    resultsDir: '/tmp/session',
    logsDir: '/tmp/session/logs',
    results: [],
  })),
  finalizeSession: jest.fn(),
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
  hasVision: jest.fn(() => true),
}));

jest.mock('../../src/lib/context', () => ({
  contextNeedsRefresh: jest.fn(() => false),
}));

jest.mock('../../src/lib/preflight', () => ({
  runPreflight: jest.fn().mockResolvedValue({ passed: true, preExistingFailures: [] }),
  runPortCheck: jest.fn(() => []),
}));

jest.mock('../../src/commands/sync', () => ({
  syncAgentAssets: jest.fn(() => ({ synced: false, docSynced: false, skillsDirs: [] })),
  resolveHarnesses: jest.fn((harnesses: string[]) => harnesses),
}));

jest.mock('../../src/lib/eval', () => ({
  saveCapturedCase: jest.fn(),
  detectFailureStep: jest.fn(() => 'implement'),
}));

jest.mock('../../src/lib/traces', () => ({
  writeTraceToSubdir: jest.fn(),
}));

jest.mock('../../src/lib/validation', () => ({
  validateIssueQueue: jest.fn(() => ({ dependencyWarnings: [], completenessWarnings: [], skippedIssues: [], reorderedQueue: [] })),
  printValidationReport: jest.fn(),
  commentOnIncompleteIssues: jest.fn(),
}));

jest.mock('../../src/lib/verify-epic', () => ({
  verifyEpic: jest.fn().mockResolvedValue({
    verdict: 'pass',
    comment: 'Epic verified',
    parsed: { verdict: 'pass', summary: 'Epic verified', findings: [] },
  }),
}));

import { exec } from '../../src/lib/shell';
import { parseTriageAnalysisResponse, extractJsonFromResponse } from '../../src/lib/planning';
import {
  listOpenIssuesWithComments,
  createIssue,
  commentChildEpicBacklink,
  closeIssue,
  updateIssue,
  listOpenIssues,
  listRoadmapEpics,
  listMilestones,
  createMilestone,
  setIssueMilestone,
  pollIssues,
  listEpics,
  getIssueWithComments,
  getEpicSubIssues,
  getMergedPRForIssue,
  updateEpicChecklist,
  commentIssue,
} from '../../src/lib/github';
import { processIssue } from '../../src/lib/pipeline';
import { createSession } from '../../src/lib/session';
import { verifyEpic } from '../../src/lib/verify-epic';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockParseTriage = parseTriageAnalysisResponse as jest.MockedFunction<typeof parseTriageAnalysisResponse>;
const mockExtractJson = extractJsonFromResponse as jest.MockedFunction<typeof extractJsonFromResponse>;
const mockListOpenIssuesWithComments = listOpenIssuesWithComments as jest.MockedFunction<typeof listOpenIssuesWithComments>;
const mockCreateIssue = createIssue as jest.MockedFunction<typeof createIssue>;
const mockCommentChildEpicBacklink = commentChildEpicBacklink as jest.MockedFunction<typeof commentChildEpicBacklink>;
const mockCloseIssue = closeIssue as jest.MockedFunction<typeof closeIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockListOpenIssues = listOpenIssues as jest.MockedFunction<typeof listOpenIssues>;
const mockListRoadmapEpics = listRoadmapEpics as jest.MockedFunction<typeof listRoadmapEpics>;
const mockListMilestones = listMilestones as jest.MockedFunction<typeof listMilestones>;
const mockCreateMilestone = createMilestone as jest.MockedFunction<typeof createMilestone>;
const mockSetIssueMilestone = setIssueMilestone as jest.MockedFunction<typeof setIssueMilestone>;
const mockPollIssues = pollIssues as jest.MockedFunction<typeof pollIssues>;
const mockListEpics = listEpics as jest.MockedFunction<typeof listEpics>;
const mockGetIssueWithComments = getIssueWithComments as jest.MockedFunction<typeof getIssueWithComments>;
const mockGetEpicSubIssues = getEpicSubIssues as jest.MockedFunction<typeof getEpicSubIssues>;
const mockGetMergedPRForIssue = getMergedPRForIssue as jest.MockedFunction<typeof getMergedPRForIssue>;
const mockUpdateEpicChecklist = updateEpicChecklist as jest.MockedFunction<typeof updateEpicChecklist>;
const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;
const mockProcessIssue = processIssue as jest.MockedFunction<typeof processIssue>;
const mockCreateSession = createSession as jest.MockedFunction<typeof createSession>;
const mockVerifyEpic = verifyEpic as jest.MockedFunction<typeof verifyEpic>;

const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

const parentEpicBody = `## Goal
Ship the settings workflow as one coordinated epic.

## Acceptance Criteria
- [ ] Settings API and UI work together
- [ ] Verification covers the integrated flow

## Ordered Work
- [ ] #201 Build settings API`;

function clearPhaseMocks(): void {
  jest.clearAllMocks();
  mockExec.mockReturnValue({ stdout: '/usr/bin/tool', stderr: '', exitCode: 0 });
  mockVerifyEpic.mockResolvedValue({
    verdict: 'pass',
    comment: 'Epic verified',
    parsed: { verdict: 'pass', summary: 'Epic verified', findings: [] },
  });
}

describe('epic-first planning workflow', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    clearPhaseMocks();
    process.exitCode = undefined;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockCreateIssue.mockReturnValue(195);
    mockCreateMilestone.mockReturnValue(1);
    mockGetMergedPRForIssue.mockReturnValue('https://github.com/owner/repo/pull/301');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    process.exitCode = undefined;
  });

  afterAll(() => {
    mockExit.mockRestore();
  });

  it('groups issues into an epic, schedules the parent, runs the child with parent context, then verifies the epic', async () => {
    mockListOpenIssuesWithComments.mockReturnValue([
      { number: 99, title: 'Old cleanup', body: 'No longer relevant', labels: [] },
      { number: 201, title: 'Build settings API', body: 'Add endpoint', labels: ['ready'] },
      { number: 202, title: 'Wire settings UI', body: 'Call endpoint', labels: ['ready'] },
    ]);
    mockParseTriage.mockReturnValue({
      findings: [
        {
          issueNum: 99,
          title: 'Old cleanup',
          category: 'stale',
          reason: 'Not part of this workflow',
          action: 'close',
          selected: false,
        },
      ],
      epicGroups: [
        {
          title: 'Epic: Settings workflow',
          goal: 'Ship settings save end to end.',
          rationale: 'The API and UI issues form one deliverable.',
          orderedChildIssueNumbers: [201, 202],
          acceptanceCriteria: ['- [ ] Settings save succeeds end to end'],
          selected: true,
        },
      ],
    });

    await triageCommand({ yes: true });

    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Epic: Settings workflow',
      expect.stringContaining('## Ordered Work'),
      ['epic'],
    );
    expect(mockCommentChildEpicBacklink).toHaveBeenCalledWith('owner/repo', 201, 195);
    expect(mockCommentChildEpicBacklink).toHaveBeenCalledWith('owner/repo', 202, 195);
    expect(mockCloseIssue).not.toHaveBeenCalledWith('owner/repo', 99, expect.any(String));
    expect(mockUpdateIssue).not.toHaveBeenCalledWith('owner/repo', 99, expect.any(Object));

    clearPhaseMocks();

    mockListOpenIssues.mockReturnValue([
      { number: 195, title: 'Epic: Settings workflow', body: parentEpicBody, labels: ['epic'] },
      { number: 201, title: 'Build settings API', body: 'Add endpoint', labels: ['ready'] },
      { number: 202, title: 'Wire settings UI', body: 'Call endpoint', labels: ['ready'] },
      { number: 300, title: 'Standalone docs cleanup', body: 'Update docs', labels: ['ready'] },
    ]);
    mockListRoadmapEpics.mockReturnValue([
      {
        issueNum: 195,
        title: 'Epic: Settings workflow',
        bodySummary: 'Ship settings workflow.',
        currentMilestone: null,
        completedChildCount: 0,
        totalChildCount: 2,
        openChildCount: 2,
        children: [
          { issueNum: 201, title: 'Build settings API', bodySummary: 'Add endpoint', checked: false },
          { issueNum: 202, title: 'Wire settings UI', bodySummary: 'Call endpoint', checked: false },
        ],
      },
    ]);
    mockListMilestones.mockReturnValue([]);
    mockExtractJson.mockReturnValue({
      milestones: [
        { title: 'Sprint 1', description: 'Ship settings epic', dueOn: null, order: 1 },
        { title: 'Sprint 2', description: 'Standalone follow-up', dueOn: null, order: 2 },
      ],
      epicAssignments: [
        { issueNum: 195, title: 'Epic: Settings workflow', milestone: 'Sprint 1', currentMilestone: '', selected: true },
      ],
      standaloneAssignments: [
        { issueNum: 300, title: 'Standalone docs cleanup', milestone: 'Sprint 2', currentMilestone: '', selected: true },
      ],
    });

    await roadmapCommand({ yes: true });

    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 195, '001 - Sprint 1');
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 300, '002 - Sprint 2');
    expect(mockSetIssueMilestone).not.toHaveBeenCalledWith('owner/repo', 201, expect.any(String));
    expect(mockSetIssueMilestone).not.toHaveBeenCalledWith('owner/repo', 202, expect.any(String));

    clearPhaseMocks();

    mockListEpics.mockReturnValue([
      { number: 195, title: 'Epic: Settings workflow', body: parentEpicBody, labels: ['epic'], milestone: '001 - Sprint 1' },
    ]);
    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 195) {
        return { number: 195, title: 'Epic: Settings workflow', body: parentEpicBody, labels: ['epic'] };
      }
      if (issueNum === 201) {
        return { number: 201, title: 'Build settings API', body: 'Add endpoint', labels: ['ready'] };
      }
      return null;
    });
    mockGetEpicSubIssues.mockReturnValue([{ number: 201, checked: true, lineIndex: 7 }]);
    mockProcessIssue.mockResolvedValue({
      issueNum: 201,
      title: 'Build settings API',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
      duration: 30,
      filesChanged: 2,
    });

    await runCommand({ milestone: '001 - Sprint 1' });

    expect(mockListEpics).toHaveBeenCalledWith('owner/repo', { milestone: '001 - Sprint 1' });
    expect(mockPollIssues).not.toHaveBeenCalled();
    expect(mockCreateSession).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      epicNum: 195,
      epicTitle: 'Epic: Settings workflow',
      milestone: undefined,
    }));
    expect(mockProcessIssue).toHaveBeenCalledWith(
      201,
      'Build settings API',
      'Add endpoint',
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        epicContext: expect.objectContaining({
          number: 195,
          title: 'Epic: Settings workflow',
          bodySummary: expect.stringContaining('Ship the settings workflow'),
          acceptanceCriteria: expect.arrayContaining(['- [ ] Settings API and UI work together']),
        }),
      }),
    );
    expect(mockUpdateEpicChecklist).toHaveBeenCalledWith('owner/repo', 195, 201, true);
    expect(mockVerifyEpic).toHaveBeenCalledWith(
      expect.objectContaining({
        epic: expect.objectContaining({ number: 195 }),
        subIssues: [expect.objectContaining({ number: 201 })],
        mergedPRUrls: ['https://github.com/owner/repo/pull/301'],
      }),
      expect.any(Object),
      '/tmp/session/logs',
    );
    expect(mockCommentIssue).toHaveBeenCalledWith('owner/repo', 195, 'Epic verified');
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 195, 'completed');

    clearPhaseMocks();

    mockGetIssueWithComments.mockImplementation((_repo: string, issueNum: number) => {
      if (issueNum === 195) {
        return { number: 195, title: 'Epic: Settings workflow', body: parentEpicBody, labels: ['epic'] };
      }
      if (issueNum === 201) {
        return { number: 201, title: 'Build settings API', body: 'Add endpoint', labels: ['ready'] };
      }
      return null;
    });
    mockGetEpicSubIssues.mockReturnValue([{ number: 201, checked: true, lineIndex: 7 }]);

    await runCommand({ verifyOnly: 195 });

    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockVerifyEpic).toHaveBeenCalledWith(
      expect.objectContaining({
        epic: expect.objectContaining({ number: 195 }),
        subIssues: [expect.objectContaining({ number: 201 })],
      }),
      expect.any(Object),
      expect.stringContaining('.alpha-loop'),
    );
    expect(mockCommentIssue).toHaveBeenCalledWith('owner/repo', 195, 'Epic verified');
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 195, 'completed');
  });
});
