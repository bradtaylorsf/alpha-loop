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
  formatRoadmapTable: jest.fn(() => 'FORMATTED ROADMAP'),
  normalizeRoadmapMilestones: jest.requireActual('../../src/lib/planning').normalizeRoadmapMilestones,
  buildPlanningContext: jest.fn(() => ({
    visionContext: null,
    projectContext: null,
    existingIssues: [],
  })),
}));

jest.mock('../../src/lib/github', () => ({
  listOpenIssues: jest.fn(() => []),
  listMilestones: jest.fn(() => []),
  createMilestone: jest.fn(() => 0),
  setIssueMilestone: jest.fn(),
  addIssueToProject: jest.fn(),
}));

import { checkbox, confirm } from '@inquirer/prompts';
import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { extractJsonFromResponse } from '../../src/lib/planning';
import {
  listOpenIssues,
  listMilestones,
  createMilestone,
  setIssueMilestone,
  addIssueToProject,
} from '../../src/lib/github';

const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockExtractJson = extractJsonFromResponse as jest.MockedFunction<typeof extractJsonFromResponse>;
const mockListOpenIssues = listOpenIssues as jest.MockedFunction<typeof listOpenIssues>;
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

describe('roadmap command', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.clearAllMocks();
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

  it('creates milestones and assigns issues on happy path', async () => {
    mockListOpenIssues.mockReturnValue(SAMPLE_ISSUES);
    mockListMilestones.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_AGENT_RESPONSE);
    mockCreateMilestone.mockReturnValueOnce(1).mockReturnValueOnce(2);

    // Select all assignments, confirm
    mockCheckbox.mockResolvedValueOnce([3, 7, 15]);
    mockConfirm.mockResolvedValueOnce(true);

    await roadmapCommand({});

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
