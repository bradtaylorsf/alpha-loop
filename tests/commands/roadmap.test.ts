import { roadmapCommand } from '../../src/commands/roadmap';

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

jest.mock('../../src/lib/prompts', () => ({
  buildRoadmapPrompt: jest.fn(() => 'ROADMAP PROMPT'),
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
  extractJsonFromResponse: jest.fn(),
  formatEpicQueuePlan: jest.fn(() => 'FORMATTED QUEUE PLAN'),
  formatRoadmapTable: jest.fn(() => 'FORMATTED ROADMAP'),
  normalizeRoadmapPlan: jest.requireActual('../../src/lib/planning').normalizeRoadmapPlan,
  planEpicQueue: jest.fn(() => ({
    milestoneFilter: null,
    totalEpicCount: 0,
    consideredEpicCount: 0,
    orderedEpics: [],
    blockedEpics: [],
    command: null,
  })),
  buildPlanningContext: jest.fn(() => ({
    visionContext: null,
    projectContext: null,
    existingIssues: [],
  })),
}));

jest.mock('../../src/lib/github', () => ({
  listOpenIssues: jest.fn(() => []),
  listRoadmapEpics: jest.fn(() => []),
  listMilestones: jest.fn(() => []),
  createMilestone: jest.fn(() => 0),
  setIssueMilestone: jest.fn(),
  addIssueToProject: jest.fn(),
}));

import { checkbox, confirm } from '@inquirer/prompts';
import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { buildRoadmapPrompt } from '../../src/lib/prompts';
import { extractJsonFromResponse, formatEpicQueuePlan, planEpicQueue } from '../../src/lib/planning';
import {
  listOpenIssues,
  listRoadmapEpics,
  listMilestones,
  createMilestone,
  setIssueMilestone,
  addIssueToProject,
} from '../../src/lib/github';

const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockBuildRoadmapPrompt = buildRoadmapPrompt as jest.MockedFunction<typeof buildRoadmapPrompt>;
const mockExtractJson = extractJsonFromResponse as jest.MockedFunction<typeof extractJsonFromResponse>;
const mockFormatEpicQueuePlan = formatEpicQueuePlan as jest.MockedFunction<typeof formatEpicQueuePlan>;
const mockPlanEpicQueue = planEpicQueue as jest.MockedFunction<typeof planEpicQueue>;
const mockListOpenIssues = listOpenIssues as jest.MockedFunction<typeof listOpenIssues>;
const mockListRoadmapEpics = listRoadmapEpics as jest.MockedFunction<typeof listRoadmapEpics>;
const mockListMilestones = listMilestones as jest.MockedFunction<typeof listMilestones>;
const mockCreateMilestone = createMilestone as jest.MockedFunction<typeof createMilestone>;
const mockSetIssueMilestone = setIssueMilestone as jest.MockedFunction<typeof setIssueMilestone>;
const mockAddIssueToProject = addIssueToProject as jest.MockedFunction<typeof addIssueToProject>;

const SAMPLE_ISSUES = [
  { number: 3, title: 'Set up database schema', body: 'Create tables', labels: [] },
  { number: 7, title: 'Create API endpoints', body: 'REST API', labels: [] },
  { number: 15, title: 'User dashboard', body: 'Build dashboard UI', labels: [] },
];

const SAMPLE_AGENT_RESPONSE = {
  milestones: [
    { title: '001 - v1.0 Core', description: 'Core infrastructure', dueOn: '2026-05-01', order: 1 },
    { title: '002 - v1.1 Features', description: 'User-facing features', dueOn: '2026-06-15', order: 2 },
  ],
  assignments: [
    { issueNum: 3, title: 'Set up database schema', milestone: '001 - v1.0 Core', currentMilestone: '', selected: true },
    { issueNum: 7, title: 'Create API endpoints', milestone: '001 - v1.0 Core', currentMilestone: '', selected: true },
    { issueNum: 15, title: 'User dashboard', milestone: '002 - v1.1 Features', currentMilestone: '', selected: true },
  ],
};

const SAMPLE_EPIC_CONTEXT = [
  {
    issueNum: 195,
    title: 'Epic: Scheduling',
    bodySummary: 'Ship milestone scheduling for epics.',
    currentMilestone: null,
    completedChildCount: 1,
    totalChildCount: 2,
    openChildCount: 1,
    children: [
      { issueNum: 3, title: 'Set up database schema', bodySummary: 'Create tables', checked: true },
      { issueNum: 7, title: 'Create API endpoints', bodySummary: 'REST API', checked: false },
    ],
  },
];

const SAMPLE_EPIC_RESPONSE = {
  milestones: [
    { title: 'Epic Delivery', description: 'Grouped epic work', dueOn: null, order: 1 },
  ],
  epicAssignments: [
    { issueNum: 195, title: 'Epic: Scheduling', milestone: 'Epic Delivery', currentMilestone: '', selected: true },
  ],
  standaloneAssignments: [],
};

describe('roadmap command', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.clearAllMocks();
    mockBuildRoadmapPrompt.mockReturnValue('ROADMAP PROMPT');
    mockListRoadmapEpics.mockReturnValue([]);
    mockFormatEpicQueuePlan.mockReturnValue('FORMATTED QUEUE PLAN');
    mockPlanEpicQueue.mockReturnValue({
      milestoneFilter: null,
      totalEpicCount: 0,
      consideredEpicCount: 0,
      orderedEpics: [],
      blockedEpics: [],
      command: null,
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('exits early when no open issues exist', async () => {
    mockListOpenIssues.mockReturnValue([]);

    await roadmapCommand({});

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('No open issues'));
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockSetIssueMilestone).not.toHaveBeenCalled();
  });

  it('prints an epic queue recommendation without invoking AI or mutating GitHub', async () => {
    const { loadConfig } = require('../../src/lib/config');
    const milestones = [
      { number: 4, title: '001 - Existing Core', description: 'Core', openIssues: 0, closedIssues: 0, dueOn: null, state: 'open' },
    ];
    mockListOpenIssues.mockReturnValue([
      { number: 195, title: 'Epic: Scheduling', body: 'Epic body', labels: ['epic'], milestone: '001 - Existing Core' },
      { number: 7, title: 'Create API endpoints', body: 'REST API', labels: ['ready'] },
    ]);
    mockListRoadmapEpics.mockReturnValue(SAMPLE_EPIC_CONTEXT);
    mockListMilestones.mockReturnValue(milestones);
    mockFormatEpicQueuePlan.mockReturnValue('FORMATTED QUEUE PLAN');

    await roadmapCommand({ queue: true, milestone: '001 - Existing Core' });

    expect(mockListOpenIssues).toHaveBeenCalledWith('owner/repo', 1000);
    expect(loadConfig).toHaveBeenCalledWith({
      dryRun: true,
      milestone: '001 - Existing Core',
    });
    expect(mockPlanEpicQueue).toHaveBeenCalledWith(SAMPLE_EPIC_CONTEXT, {
      labelReady: 'ready',
      milestone: '001 - Existing Core',
      openIssues: expect.arrayContaining([
        expect.objectContaining({ number: 195 }),
        expect.objectContaining({ number: 7 }),
      ]),
      milestones,
    });
    expect(consoleSpy).toHaveBeenCalledWith('FORMATTED QUEUE PLAN');
    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Queue planning only'));
    expect(mockBuildRoadmapPrompt).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockSetIssueMilestone).not.toHaveBeenCalled();
    expect(mockAddIssueToProject).not.toHaveBeenCalled();
  });

  it('prints runnable command text and blocked epic notes for planned queue output', async () => {
    const actualPlanning = jest.requireActual('../../src/lib/planning');
    mockFormatEpicQueuePlan.mockImplementation(actualPlanning.formatEpicQueuePlan);
    mockListOpenIssues.mockReturnValue([
      { number: 205, title: 'Epic: Foundation', body: 'Epic body', labels: ['epic'], milestone: '001 - Existing Core' },
      { number: 214, title: 'Epic: Follow-up', body: 'Depends on #205', labels: ['epic'], milestone: '001 - Existing Core' },
      { number: 300, title: 'Epic: Blocked', body: 'Depends on #999', labels: ['epic'], milestone: '001 - Existing Core' },
      { number: 305, title: 'Ready child', body: 'Child body', labels: ['ready'] },
    ]);
    mockListRoadmapEpics.mockReturnValue(SAMPLE_EPIC_CONTEXT);
    mockListMilestones.mockReturnValue([
      { number: 4, title: '001 - Existing Core', description: 'Core', openIssues: 0, closedIssues: 0, dueOn: null, state: 'open' },
    ]);
    mockPlanEpicQueue.mockReturnValue({
      milestoneFilter: '001 - Existing Core',
      totalEpicCount: 3,
      consideredEpicCount: 3,
      orderedEpics: [
        {
          issueNum: 205,
          title: 'Epic: Foundation',
          status: 'runnable',
          readyChildCount: 1,
          completedChildCount: 0,
          blockedChildCount: 0,
          totalChildCount: 1,
          queueDependencies: [],
          rationale: ['Child readiness: 1 ready'],
          blockers: [],
          risks: ['Likely file overlap with #214: src/lib/session.ts'],
        },
        {
          issueNum: 214,
          title: 'Epic: Follow-up',
          status: 'runnable',
          readyChildCount: 1,
          completedChildCount: 0,
          blockedChildCount: 0,
          totalChildCount: 1,
          queueDependencies: [205],
          rationale: ['Queue dependencies: #205'],
          blockers: [],
          risks: ['Likely file overlap with #205: src/lib/session.ts'],
        },
      ],
      blockedEpics: [
        {
          issueNum: 300,
          title: 'Epic: Blocked',
          status: 'blocked',
          readyChildCount: 0,
          completedChildCount: 0,
          blockedChildCount: 1,
          totalChildCount: 1,
          queueDependencies: [],
          rationale: [],
          blockers: ['Open dependency #999 is outside the planned epic queue'],
          risks: [],
        },
      ],
      command: 'alpha-loop run --epics 205,214',
    } as any);

    await roadmapCommand({ queue: true, milestone: '001 - Existing Core' });

    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Epic Queue Recommendation');
    expect(output).toContain('Scope: milestone "001 - Existing Core"');
    expect(output).toContain('Runnable Queue (2)');
    expect(output).toContain('#205 Epic: Foundation');
    expect(output).toContain('#214 Epic: Follow-up');
    expect(output).toContain('Blocked Epics (1)');
    expect(output).toContain('Open dependency #999 is outside the planned epic queue');
    expect(output).toContain('alpha-loop run --epics 205,214');
    expect(mockBuildRoadmapPrompt).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockSetIssueMilestone).not.toHaveBeenCalled();
  });

  it('creates milestones and assigns issues on happy path', async () => {
    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListRoadmapEpics.mockReturnValue([]);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_AGENT_RESPONSE);
    mockCreateMilestone.mockReturnValueOnce(1).mockReturnValueOnce(2);

    // Select all assignments, confirm
    mockCheckbox.mockResolvedValueOnce([3, 7, 15]);
    mockConfirm.mockResolvedValueOnce(true);

    await roadmapCommand({});

    expect(mockListRoadmapEpics).toHaveBeenCalledWith('owner/repo', SAMPLE_ISSUES);
    expect(mockBuildRoadmapPrompt).toHaveBeenCalledWith(expect.objectContaining({
      epics: [],
      issues: expect.arrayContaining([
        expect.objectContaining({ number: 3 }),
        expect.objectContaining({ number: 7 }),
        expect.objectContaining({ number: 15 }),
      ]),
    }));

    // Should create both milestones
    expect(mockCreateMilestone).toHaveBeenCalledTimes(2);
    expect(mockCreateMilestone).toHaveBeenCalledWith('owner/repo', '001 - v1.0 Core', 'Core infrastructure', '2026-05-01');
    expect(mockCreateMilestone).toHaveBeenCalledWith('owner/repo', '002 - v1.1 Features', 'User-facing features', '2026-06-15');

    // Should assign all 3 issues (now passes milestone title, not number)
    expect(mockSetIssueMilestone).toHaveBeenCalledTimes(3);
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 3, '001 - v1.0 Core');
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 7, '001 - v1.0 Core');
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 15, '002 - v1.1 Features');

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('milestone'));
  });

  it('assigns milestones to parent epic issues for epic-only roadmap output', async () => {
    mockListOpenIssues.mockReturnValue([
      { number: 195, title: 'Epic: Scheduling', body: 'Epic body', labels: ['epic'] },
      { number: 3, title: 'Set up database schema', body: 'Create tables', labels: [] },
      { number: 7, title: 'Create API endpoints', body: 'REST API', labels: [] },
    ]);
    mockListRoadmapEpics.mockReturnValue(SAMPLE_EPIC_CONTEXT);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_EPIC_RESPONSE);
    mockCreateMilestone.mockReturnValueOnce(1);

    await roadmapCommand({ yes: true });

    expect(mockBuildRoadmapPrompt).toHaveBeenCalledWith(expect.objectContaining({
      epics: SAMPLE_EPIC_CONTEXT,
      issues: [],
    }));
    expect(mockCreateMilestone).toHaveBeenCalledWith('owner/repo', '001 - Epic Delivery', 'Grouped epic work', undefined);
    expect(mockSetIssueMilestone).toHaveBeenCalledTimes(1);
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 195, '001 - Epic Delivery');
    expect(mockSetIssueMilestone).not.toHaveBeenCalledWith('owner/repo', 3, expect.any(String));
    expect(mockSetIssueMilestone).not.toHaveBeenCalledWith('owner/repo', 7, expect.any(String));
  });

  it('filters epic children from standalone scheduling and applies mixed assignments', async () => {
    mockListOpenIssues.mockReturnValue([
      { number: 195, title: 'Epic: Scheduling', body: 'Epic body', labels: ['epic'] },
      { number: 3, title: 'Set up database schema', body: 'Create tables', labels: [] },
      { number: 7, title: 'Create API endpoints', body: 'REST API', labels: [] },
      { number: 15, title: 'User dashboard', body: 'Build dashboard UI', labels: [] },
    ]);
    mockListRoadmapEpics.mockReturnValue(SAMPLE_EPIC_CONTEXT);
    mockListMilestones.mockReturnValue([
      { number: 4, title: '001 - Existing Core', description: 'Core', openIssues: 0, closedIssues: 0, dueOn: null, state: 'open' },
    ]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue({
      milestones: [
        { title: '001 - Existing Core', description: 'Core', dueOn: null, order: 1 },
        { title: 'New Follow-up', description: 'Standalone work', dueOn: null, order: 2 },
      ],
      epicAssignments: [
        { issueNum: 195, title: 'Epic: Scheduling', milestone: '001 - Existing Core', currentMilestone: '', selected: true },
      ],
      standaloneAssignments: [
        { issueNum: 15, title: 'User dashboard', milestone: 'New Follow-up', currentMilestone: '', selected: true },
      ],
    });
    mockCreateMilestone.mockReturnValueOnce(9);

    await roadmapCommand({ yes: true });

    expect(mockBuildRoadmapPrompt).toHaveBeenCalledWith(expect.objectContaining({
      issues: [
        expect.objectContaining({ number: 15, title: 'User dashboard' }),
      ],
      epics: SAMPLE_EPIC_CONTEXT,
    }));
    expect(mockCreateMilestone).toHaveBeenCalledTimes(1);
    expect(mockCreateMilestone).toHaveBeenCalledWith('owner/repo', '002 - New Follow-up', 'Standalone work', undefined);
    expect(mockSetIssueMilestone).toHaveBeenCalledTimes(2);
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 195, '001 - Existing Core');
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 15, '002 - New Follow-up');
  });

  it('does not recreate existing milestones', async () => {
    const existingMilestones = [
      { number: 5, title: '001 - v1.0 Core', description: 'Core infra', openIssues: 2, closedIssues: 0, dueOn: '2026-05-01', state: 'open' },
    ];

    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListMilestones.mockReturnValue(existingMilestones);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_AGENT_RESPONSE);
    // Only 002 - v1.1 Features is new
    mockCreateMilestone.mockReturnValueOnce(6);

    mockCheckbox.mockResolvedValueOnce([3, 7, 15]);
    mockConfirm.mockResolvedValueOnce(true);

    await roadmapCommand({});

    // Should only create 002 - v1.1 Features (001 - v1.0 Core already exists)
    expect(mockCreateMilestone).toHaveBeenCalledTimes(1);
    expect(mockCreateMilestone).toHaveBeenCalledWith('owner/repo', '002 - v1.1 Features', 'User-facing features', '2026-06-15');

    // Issues assigned to 001 - v1.0 Core should use milestone title (not number)
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 3, '001 - v1.0 Core');
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 7, '001 - v1.0 Core');
    // Issue assigned to 002 - v1.1 Features should use milestone title
    expect(mockSetIssueMilestone).toHaveBeenCalledWith('owner/repo', 15, '002 - v1.1 Features');
  });

  it('does not make GitHub calls in dry-run mode', async () => {
    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_AGENT_RESPONSE);

    await roadmapCommand({ dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockSetIssueMilestone).not.toHaveBeenCalled();
    expect(mockAddIssueToProject).not.toHaveBeenCalled();
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('exits gracefully on agent failure', async () => {
    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '', stderr: 'agent crashed', exitCode: 1 });

    await roadmapCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Agent failed'));
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockSetIssueMilestone).not.toHaveBeenCalled();
  });

  it('exits gracefully on JSON parse failure', async () => {
    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: 'not json', stderr: '', exitCode: 0 });
    mockExtractJson.mockImplementation(() => {
      throw new Error('Could not extract valid JSON');
    });

    await roadmapCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse roadmap JSON'));
    expect(mockCreateMilestone).not.toHaveBeenCalled();
  });

  it('skips prompts and applies all selected assignments with --yes', async () => {
    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_AGENT_RESPONSE);
    mockCreateMilestone.mockReturnValueOnce(1).mockReturnValueOnce(2);

    await roadmapCommand({ yes: true });

    // Should not prompt
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();

    // Should create milestones and assign all selected issues
    expect(mockCreateMilestone).toHaveBeenCalledTimes(2);
    expect(mockSetIssueMilestone).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('--yes: applying all'));
  });

  it('combines --yes with --dry-run safely', async () => {
    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_AGENT_RESPONSE);

    await roadmapCommand({ yes: true, dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockSetIssueMilestone).not.toHaveBeenCalled();
  });

  it('adds issues to project board when configured', async () => {
    // Reconfigure with project > 0
    const { loadConfig } = require('../../src/lib/config');
    (loadConfig as jest.Mock).mockReturnValueOnce({
      repo: 'owner/repo',
      repoOwner: 'owner',
      project: 42,
      agent: 'claude' as const,
      model: 'sonnet',
      labelReady: 'ready',
      dryRun: false,
    });

    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_AGENT_RESPONSE);
    mockCreateMilestone.mockReturnValueOnce(1).mockReturnValueOnce(2);

    mockCheckbox.mockResolvedValueOnce([3, 7, 15]);
    mockConfirm.mockResolvedValueOnce(true);

    await roadmapCommand({});

    expect(mockAddIssueToProject).toHaveBeenCalledTimes(3);
    expect(mockAddIssueToProject).toHaveBeenCalledWith('owner', 42, 'owner/repo', 3);
    expect(mockAddIssueToProject).toHaveBeenCalledWith('owner', 42, 'owner/repo', 7);
    expect(mockAddIssueToProject).toHaveBeenCalledWith('owner', 42, 'owner/repo', 15);
  });
});
