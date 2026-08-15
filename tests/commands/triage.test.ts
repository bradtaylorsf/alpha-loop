import { triageCommand } from '../../src/commands/triage';

// Mock all external dependencies
jest.mock('@inquirer/prompts', () => ({
  checkbox: jest.fn(),
  confirm: jest.fn(),
}));

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn(() => ({
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 0,
    agent: 'claude' as const,
    model: 'sonnet',
    labelReady: 'ready',
    dryRun: false,
  })),
  assertSafeShellArg: jest.fn((val: string) => val),
}));

jest.mock('../../src/lib/agent', () => ({
  buildOneShotCommand: jest.fn(() => 'claude -p --dangerously-skip-permissions --output-format text'),
}));

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(() => ({ stdout: '', stderr: '', exitCode: 0 })),
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

jest.mock('../../src/lib/planning', () => ({
  parseTriageAnalysisResponse: jest.fn(),
  saveTriagePlan: jest.fn(() => '.alpha-loop/triage-2026-08-15T19-30-45-123Z.json'),
  loadTriagePlan: jest.fn(),
  formatTriageFindings: jest.fn(() => 'FORMATTED FINDINGS'),
  formatEpicGroupProposals: jest.fn(() => 'FORMATTED EPIC PROPOSALS'),
  buildPlanningContext: jest.fn(() => ({
    visionContext: null,
    projectContext: null,
    existingIssues: [],
  })),
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

jest.mock('../../src/lib/github', () => ({
  listOpenIssues: jest.fn(() => []),
  listOpenIssuesWithComments: jest.fn(() => []),
  closeIssue: jest.fn(),
  updateIssue: jest.fn(),
  createIssue: jest.fn(() => 0),
  commentIssue: jest.fn(),
  getIssueBody: jest.fn(() => ''),
  updateEpicIssueBody: jest.fn(() => true),
  commentChildEpicBacklink: jest.fn(() => true),
  getIssueComments: jest.fn(() => []),
}));

import { checkbox, confirm } from '@inquirer/prompts';
import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import {
  parseTriageAnalysisResponse,
  saveTriagePlan,
  loadTriagePlan,
  formatEpicGroupProposals,
} from '../../src/lib/planning';
import {
  listOpenIssuesWithComments,
  closeIssue,
  updateIssue,
  createIssue,
  commentIssue,
  getIssueBody,
  updateEpicIssueBody,
  commentChildEpicBacklink,
} from '../../src/lib/github';

const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockParseTriageAnalysis = parseTriageAnalysisResponse as jest.MockedFunction<typeof parseTriageAnalysisResponse>;
const mockSaveTriagePlan = saveTriagePlan as jest.MockedFunction<typeof saveTriagePlan>;
const mockLoadTriagePlan = loadTriagePlan as jest.MockedFunction<typeof loadTriagePlan>;
const mockFormatEpicGroupProposals = formatEpicGroupProposals as jest.MockedFunction<typeof formatEpicGroupProposals>;
const mockListOpenIssuesWithComments = listOpenIssuesWithComments as jest.MockedFunction<typeof listOpenIssuesWithComments>;
const mockCloseIssue = closeIssue as jest.MockedFunction<typeof closeIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockCreateIssue = createIssue as jest.MockedFunction<typeof createIssue>;
const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;
const mockGetIssueBody = getIssueBody as jest.MockedFunction<typeof getIssueBody>;
const mockUpdateEpicIssueBody = updateEpicIssueBody as jest.MockedFunction<typeof updateEpicIssueBody>;
const mockCommentChildEpicBacklink = commentChildEpicBacklink as jest.MockedFunction<typeof commentChildEpicBacklink>;

const SAMPLE_ISSUES = [
  { number: 1, title: 'Old feature', body: 'Implement X', labels: [] },
  { number: 2, title: 'Vague task', body: 'Do the thing', labels: [] },
  { number: 3, title: 'Huge issue', body: 'Build everything', labels: [] },
  { number: 4, title: 'Same as #1', body: 'Also implement X', labels: [] },
];

const SAMPLE_FINDINGS = [
  {
    issueNum: 1,
    title: 'Old feature',
    category: 'stale' as const,
    reason: 'Already implemented in PR #10',
    action: 'close' as const,
    selected: true,
  },
  {
    issueNum: 2,
    title: 'Vague task',
    category: 'unclear' as const,
    reason: 'No acceptance criteria',
    action: 'rewrite' as const,
    rewrittenBody: '## Summary\nDo the thing properly\n\n## Acceptance Criteria\n- [ ] Step 1\n- [ ] Step 2',
    selected: true,
  },
  {
    issueNum: 3,
    title: 'Huge issue',
    category: 'too_large' as const,
    reason: 'Covers 3 independent features',
    action: 'split' as const,
    splitInto: ['Sub-task A', 'Sub-task B', 'Sub-task C'],
    selected: true,
  },
  {
    issueNum: 4,
    title: 'Same as #1',
    category: 'duplicate' as const,
    reason: 'Same scope as #1',
    action: 'merge' as const,
    duplicateOf: 1,
    selected: true,
  },
];

const SAMPLE_EPIC_GROUPS = [
  {
    title: 'Epic: Settings reliability',
    goal: 'Make settings saves reliable.',
    rationale: 'Issues #2 and #3 form one settings workflow deliverable.',
    orderedChildIssueNumbers: [2, 3],
    acceptanceCriteria: ['- [ ] Settings save successfully'],
    selected: true,
  },
];

const SAMPLE_ANALYSIS = {
  findings: SAMPLE_FINDINGS,
  epicGroups: [],
};

describe('triage command', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.clearAllMocks();
    mockSaveTriagePlan.mockReset();
    mockSaveTriagePlan.mockReturnValue('.alpha-loop/triage-2026-08-15T19-30-45-123Z.json');
    mockLoadTriagePlan.mockReset();
    mockCreateIssue.mockReturnValue(0);
    mockGetIssueBody.mockReturnValue('');
    mockUpdateIssue.mockReturnValue(true);
    mockUpdateEpicIssueBody.mockReturnValue(true);
    mockCommentChildEpicBacklink.mockReturnValue(true);
    mockCloseIssue.mockReturnValue(true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('exits early when no open issues exist', async () => {
    mockListOpenIssuesWithComments.mockReturnValue([]);

    await triageCommand({});

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('No open issues'));
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('applies correct GitHub calls for each finding category', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue(SAMPLE_ANALYSIS);
    mockCreateIssue.mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12);

    // Select all findings, confirm
    mockCheckbox.mockResolvedValueOnce([1, 2, 3, 4]);
    mockConfirm.mockResolvedValueOnce(true);

    await triageCommand({});

    // Stale: comment + close with not_planned
    expect(mockCommentIssue).toHaveBeenCalledWith(
      'owner/repo', 1, expect.stringContaining('stale'),
    );
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 1, 'not_planned');

    // Unclear: update body
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      'owner/repo', 2, { body: expect.stringContaining('Acceptance Criteria') },
    );

    // Too large: create sub-issues + comment + close original
    expect(mockCreateIssue).toHaveBeenCalledTimes(3);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo', 'Sub-task A', expect.stringContaining('#3'), ['enhancement'],
    );
    expect(mockCommentIssue).toHaveBeenCalledWith(
      'owner/repo', 3, expect.stringContaining('Split into'),
    );
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 3, 'completed');

    // Duplicate: comment + close
    expect(mockCommentIssue).toHaveBeenCalledWith(
      'owner/repo', 4, expect.stringContaining('duplicate of #1'),
    );
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 4, 'duplicate', 1);

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Applied'));
  });

  it.each([
    {
      label: 'stale',
      finding: SAMPLE_FINDINGS[0],
      successMessage: 'Closed stale issue #1',
      failureMessage: '#1: failed to close stale issue',
    },
    {
      label: 'split parent',
      finding: SAMPLE_FINDINGS[2],
      successMessage: 'Closed #3 after splitting',
      failureMessage: '#3: failed to close issue after splitting',
    },
    {
      label: 'duplicate',
      finding: SAMPLE_FINDINGS[3],
      successMessage: 'Closed duplicate #4',
      failureMessage: '#4: failed to close as duplicate of #1',
    },
  ])('does not report a failed $label close as successful', async ({ finding, successMessage, failureMessage }) => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({ findings: [finding], epicGroups: [] });
    mockCloseIssue.mockReturnValue(false);
    if (finding.category === 'too_large') {
      mockCreateIssue.mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12);
    }

    await triageCommand({ yes: true });

    expect(log.success).not.toHaveBeenCalledWith(expect.stringContaining(successMessage));
    expect(log.warn).toHaveBeenCalledWith('Applied 0 of 1 triage action(s)');
    expect(log.warn).toHaveBeenCalledWith('1 operation(s) failed:');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(failureMessage));
  });

  it.each([
    {
      label: 'rewrite',
      finding: SAMPLE_FINDINGS[1],
      successMessage: 'Rewrote body for #2',
      failureMessage: '#2: failed to rewrite issue body',
    },
    {
      label: 'enrichment',
      finding: {
        issueNum: 5,
        title: 'Sparse issue',
        category: 'enrich' as const,
        reason: 'Missing implementation details',
        action: 'enrich' as const,
        enrichedBody: '## Summary\nAdd implementation details',
        selected: true,
      },
      successMessage: 'Enriched #5',
      failureMessage: '#5: failed to enrich issue body',
    },
  ])('does not report a failed $label mutation as successful', async ({ finding, successMessage, failureMessage }) => {
    mockListOpenIssuesWithComments.mockReturnValue([
      ...SAMPLE_ISSUES,
      { number: 5, title: 'Sparse issue', body: 'Needs details', labels: [] },
    ]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({ findings: [finding], epicGroups: [] });
    mockUpdateIssue.mockReturnValue(false);

    await triageCommand({ yes: true });

    expect(log.success).not.toHaveBeenCalledWith(expect.stringContaining(successMessage));
    expect(mockCommentIssue).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Applied 0 of 1 triage action(s)');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining(failureMessage));
  });

  it('exits gracefully on agent failure', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '', stderr: 'agent crashed', exitCode: 1 });

    await triageCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Agent failed'));
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it('exits gracefully on JSON parse failure', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: 'not json', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockImplementation(() => {
      throw new Error('Could not extract valid JSON');
    });

    await triageCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse triage JSON'));
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('does not make GitHub calls in dry-run mode', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue(SAMPLE_ANALYSIS);

    await triageCommand({ dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCommentIssue).not.toHaveBeenCalled();
    expect(mockSaveTriagePlan).toHaveBeenCalledWith(
      'owner/repo',
      SAMPLE_ANALYSIS,
      process.cwd(),
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('triage --apply'));
    // Should not show interactive prompts in dry-run
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('saves the exact filtered analysis displayed by dry-run', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({
      findings: [SAMPLE_FINDINGS[0]],
      epicGroups: [
        SAMPLE_EPIC_GROUPS[0],
        {
          ...SAMPLE_EPIC_GROUPS[0],
          title: 'Epic: Invalid unknown issue group',
          orderedChildIssueNumbers: [2, 999],
        },
      ],
    });

    await triageCommand({ dryRun: true });

    expect(mockSaveTriagePlan).toHaveBeenCalledWith(
      'owner/repo',
      {
        findings: [SAMPLE_FINDINGS[0]],
        epicGroups: [SAMPLE_EPIC_GROUPS[0]],
      },
      process.cwd(),
    );
  });

  it('saves an empty analysis so a no-op preview is replayable', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({ findings: [], epicGroups: [] });

    await triageCommand({ dryRun: true });

    expect(mockSaveTriagePlan).toHaveBeenCalledWith(
      'owner/repo',
      { findings: [], epicGroups: [] },
      process.cwd(),
    );
    expect(log.dry).toHaveBeenCalled();
  });

  it('replays the dry-run plan unchanged without invoking or parsing a second agent response', async () => {
    const persistedAnalysis = {
      findings: [
        SAMPLE_FINDINGS[0],
        { ...SAMPLE_FINDINGS[3], selected: false },
      ],
      epicGroups: [
        { ...SAMPLE_EPIC_GROUPS[0], selected: false },
        { ...SAMPLE_EPIC_GROUPS[0], title: 'Epic: Persisted selection', selected: true },
      ],
    };
    let savedAnalysis: typeof persistedAnalysis | undefined;
    mockSaveTriagePlan.mockImplementation((_repo, analysis) => {
      savedAnalysis = analysis as typeof persistedAnalysis;
      return '.alpha-loop/reviewed.json';
    });
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"first":"analysis"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue(persistedAnalysis);

    await triageCommand({ dryRun: true });

    expect(savedAnalysis).toEqual(persistedAnalysis);
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();

    mockExec.mockClear();
    mockParseTriageAnalysis.mockClear();
    mockLoadTriagePlan.mockImplementation(() => ({
      version: 1,
      repo: 'owner/repo',
      createdAt: '2026-08-15T19:30:45.123Z',
      analysis: savedAnalysis!,
    }));
    mockCreateIssue.mockReturnValueOnce(250);

    await triageCommand({ apply: '.alpha-loop/reviewed.json', yes: true });

    expect(mockLoadTriagePlan).toHaveBeenCalledWith('.alpha-loop/reviewed.json', 'owner/repo');
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockParseTriageAnalysis).not.toHaveBeenCalled();
    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 1, 'not_planned');
    expect(mockCloseIssue).not.toHaveBeenCalledWith('owner/repo', 4, expect.anything(), expect.anything());
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Epic: Persisted selection',
      expect.any(String),
      ['epic'],
    );
  });

  it.each([
    ['invalid', 'Unsupported triage plan version: 2'],
    ['for another repository', 'Triage plan is for other/repo, but the configured repository is owner/repo'],
  ])('fails closed before fetching issues or mutating when a replay artifact is %s', async (_label, message) => {
    mockLoadTriagePlan.mockImplementation(() => {
      throw new Error(message);
    });

    await triageCommand({ apply: '.alpha-loop/invalid.json', yes: true });

    expect(log.error).toHaveBeenCalledWith(`Cannot apply triage plan: ${message}`);
    expect(mockListOpenIssuesWithComments).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCommentIssue).not.toHaveBeenCalled();
  });

  it('rejects --dry-run with --apply before loading or generating a plan', async () => {
    await triageCommand({ dryRun: true, apply: '.alpha-loop/reviewed.json' });

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('cannot be combined'));
    expect(mockLoadTriagePlan).not.toHaveBeenCalled();
    expect(mockListOpenIssuesWithComments).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('displays epic proposals separately from cleanup findings in dry-run mode', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({
      findings: SAMPLE_FINDINGS,
      epicGroups: SAMPLE_EPIC_GROUPS,
    });

    await triageCommand({ dryRun: true });

    expect(consoleSpy).toHaveBeenCalledWith('FORMATTED FINDINGS');
    expect(consoleSpy).toHaveBeenCalledWith('FORMATTED EPIC PROPOSALS');
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('proposed epic group'));
    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('shows epic-only proposals without reporting all issues ok', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({
      findings: [],
      epicGroups: SAMPLE_EPIC_GROUPS,
    });

    await triageCommand({ dryRun: true });

    expect(consoleSpy).toHaveBeenCalledWith('FORMATTED EPIC PROPOSALS');
    expect(log.success).not.toHaveBeenCalledWith(expect.stringContaining('All issues look good'));
    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('prompts for cleanup actions and epic proposals independently', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({
      findings: [SAMPLE_FINDINGS[0]],
      epicGroups: SAMPLE_EPIC_GROUPS,
    });
    mockCreateIssue.mockReturnValueOnce(200);
    mockCheckbox
      .mockResolvedValueOnce([1])
      .mockResolvedValueOnce([0]);
    mockConfirm.mockResolvedValueOnce(true);

    await triageCommand({});

    expect(mockCheckbox).toHaveBeenCalledTimes(2);
    expect(mockCheckbox.mock.calls[0][0]).toMatchObject({
      message: 'Select cleanup actions to apply:',
    });
    expect(mockCheckbox.mock.calls[1][0]).toMatchObject({
      message: 'Select epic proposals to apply:',
    });
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 1, 'not_planned');
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Epic: Settings reliability',
      expect.stringContaining('## Ordered Work'),
      ['epic'],
    );
    expect(mockCommentChildEpicBacklink).toHaveBeenCalledWith('owner/repo', 2, 200);
    expect(mockCommentChildEpicBacklink).toHaveBeenCalledWith('owner/repo', 3, 200);
  });

  it('--yes applies only epic proposals marked selected by the agent', async () => {
    mockListOpenIssuesWithComments.mockReturnValue([
      { number: 2, title: 'Settings API', body: 'Build API', labels: ['ready'] },
      { number: 3, title: 'Settings UI', body: 'Build UI', labels: ['ready'] },
      { number: 4, title: 'Settings tests', body: 'Add tests', labels: ['ready'] },
    ]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({
      findings: [],
      epicGroups: [
        {
          ...SAMPLE_EPIC_GROUPS[0],
          title: 'Epic: Speculative grouping',
          orderedChildIssueNumbers: [2, 3],
          selected: false,
        },
        {
          ...SAMPLE_EPIC_GROUPS[0],
          title: 'Epic: Selected grouping',
          orderedChildIssueNumbers: [3, 4],
          selected: true,
        },
      ],
    });
    mockCreateIssue.mockReturnValueOnce(201);

    await triageCommand({ yes: true });

    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Epic: Selected grouping',
      expect.any(String),
      ['epic'],
    );
    expect(mockCommentChildEpicBacklink).toHaveBeenCalledWith('owner/repo', 3, 201);
    expect(mockCommentChildEpicBacklink).toHaveBeenCalledWith('owner/repo', 4, 201);
    expect(mockCommentChildEpicBacklink).not.toHaveBeenCalledWith('owner/repo', 2, expect.any(Number));
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('updates an existing candidate epic without duplicating child refs', async () => {
    mockListOpenIssuesWithComments.mockReturnValue([
      { number: 2, title: 'Settings API', body: 'Build API', labels: ['ready'] },
      { number: 3, title: 'Settings UI', body: 'Build UI', labels: ['ready'] },
      { number: 99, title: 'Epic: Settings reliability', body: '- [ ] #2', labels: ['epic'] },
    ]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({
      findings: [],
      epicGroups: [{
        ...SAMPLE_EPIC_GROUPS[0],
        orderedChildIssueNumbers: [2, 3],
        existingEpicIssueNum: 99,
        selected: true,
      }],
    });
    mockGetIssueBody.mockReturnValue('## Ordered Work\n\n- [ ] #2');

    await triageCommand({ yes: true });

    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockUpdateEpicIssueBody).toHaveBeenCalledTimes(1);
    const updatedBody = mockUpdateEpicIssueBody.mock.calls[0][2];
    expect(updatedBody.match(/#2/g)).toHaveLength(1);
    expect(updatedBody).toContain('- [ ] #3');
    expect(mockCommentChildEpicBacklink).toHaveBeenCalledWith('owner/repo', 2, 99);
    expect(mockCommentChildEpicBacklink).toHaveBeenCalledWith('owner/repo', 3, 99);
  });

  it('summarizes backlink failures while still reporting created epic resources', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({
      findings: [],
      epicGroups: SAMPLE_EPIC_GROUPS,
    });
    mockCreateIssue.mockReturnValueOnce(202);
    mockCommentChildEpicBacklink
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await triageCommand({ yes: true });

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Created epic #202'));
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Applied 1 epic proposal'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('operation(s) failed'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Child #3: backlink to epic #202 failed'));
  });

  it('filters proposed epic groups that include nested epic children', async () => {
    mockListOpenIssuesWithComments.mockReturnValue([
      { number: 1, title: 'Existing epic', body: 'Umbrella issue', labels: ['epic'] },
      { number: 2, title: 'Child issue', body: 'Concrete task', labels: ['ready'] },
    ]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({
      findings: [],
      epicGroups: [{
        title: 'Epic: Nested proposal',
        goal: 'Invalid nested group.',
        rationale: 'Includes an existing epic.',
        orderedChildIssueNumbers: [1, 2],
        acceptanceCriteria: ['- [ ] Done'],
        selected: true,
      }],
    });

    await triageCommand({ dryRun: true });

    expect(mockFormatEpicGroupProposals).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('nested epic child'));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('No valid epic proposals'));
  });

  it('truncates large issue bodies before building prompt', async () => {
    const longBody = 'x'.repeat(1000);
    mockListOpenIssuesWithComments.mockReturnValue([
      { number: 1, title: 'Long body issue', body: longBody, labels: [] },
    ]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({ findings: [], epicGroups: [] });

    await triageCommand({});

    // The agent should have been called (exec), and the prompt should not contain the full 1000-char body
    expect(mockExec).toHaveBeenCalled();
    const callArgs = mockExec.mock.calls[0][0] as string;
    // The prompt is JSON.stringify'd in the echo command — the body should be truncated
    expect(callArgs).not.toContain('x'.repeat(1000));
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('All issues look good'));
  });

  it('skips prompts and applies all selected findings with --yes', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue(SAMPLE_ANALYSIS);
    mockCreateIssue.mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12);

    await triageCommand({ yes: true });

    // Should not prompt
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();

    // Should apply all selected findings
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 1, 'not_planned');
    expect(mockUpdateIssue).toHaveBeenCalledWith('owner/repo', 2, { body: expect.any(String) });
    expect(mockCreateIssue).toHaveBeenCalledTimes(3);
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 4, 'duplicate', 1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('--yes: applying all'));
  });

  it('combines --yes with --dry-run safely', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue(SAMPLE_ANALYSIS);

    await triageCommand({ yes: true, dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('exits with success message when all issues are ok', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });
    mockParseTriageAnalysis.mockReturnValue({ findings: [], epicGroups: [] });

    await triageCommand({});

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('All issues look good'));
    expect(mockCheckbox).not.toHaveBeenCalled();
  });
});
