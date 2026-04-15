import { addCommand } from '../../src/commands/add';

// Mock all external dependencies
jest.mock('@inquirer/prompts', () => ({
  input: jest.fn(),
  select: jest.fn(),
  editor: jest.fn(),
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
  extractJsonFromResponse: jest.fn(),
  buildPlanningContext: jest.fn(() => ({
    visionContext: null,
    projectContext: null,
    existingIssues: [],
  })),
}));

jest.mock('../../src/lib/prompts', () => ({
  buildAddPrompt: jest.fn(() => 'MOCK PROMPT'),
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
  listMilestones: jest.fn(() => []),
  listLabels: jest.fn(() => ['bug', 'enhancement', 'documentation']),
  createIssue: jest.fn(() => 0),
  createMilestone: jest.fn(() => 0),
  addIssueToProject: jest.fn(),
}));

jest.mock('node:fs', () => ({
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
}));

import { readFileSync } from 'node:fs';
import { input, select, editor } from '@inquirer/prompts';
import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { extractJsonFromResponse } from '../../src/lib/planning';
import { loadConfig } from '../../src/lib/config';
import {
  listMilestones,
  listLabels,
  createIssue,
  createMilestone,
  addIssueToProject,
} from '../../src/lib/github';

const mockInput = input as jest.MockedFunction<typeof input>;
const mockSelect = select as jest.MockedFunction<typeof select>;
const mockEditor = editor as jest.MockedFunction<typeof editor>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockExtractJson = extractJsonFromResponse as jest.MockedFunction<typeof extractJsonFromResponse>;
const mockListMilestones = listMilestones as jest.MockedFunction<typeof listMilestones>;
const mockCreateIssue = createIssue as jest.MockedFunction<typeof createIssue>;
const mockCreateMilestone = createMilestone as jest.MockedFunction<typeof createMilestone>;
const mockAddIssueToProject = addIssueToProject as jest.MockedFunction<typeof addIssueToProject>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;

function makeSampleProposal() {
  return {
    title: 'Add user authentication',
    body: '## Summary\nImplement OAuth2 login flow.\n\n## Acceptance Criteria\n- [ ] Login page\n- [ ] Token refresh',
    labels: ['enhancement', 'security'],
    milestone: {
      title: 'v2.0',
      description: 'Major release',
      isNew: false,
    },
  };
}

const SAMPLE_MILESTONES = [
  {
    number: 1,
    title: 'v1.0',
    description: 'Initial release',
    openIssues: 3,
    closedIssues: 5,
    dueOn: null,
    state: 'open',
  },
  {
    number: 2,
    title: 'v2.0',
    description: 'Major release',
    openIssues: 10,
    closedIssues: 0,
    dueOn: null,
    state: 'open',
  },
];

describe('add command', () => {
  let consoleSpy: jest.SpyInstance;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    // Default: pretend we have a TTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    jest.clearAllMocks();
    // Reset select mock implementation fully to avoid leaking once-values between tests
    mockSelect.mockReset();
    mockInput.mockReset();
    mockEditor.mockReset();

    // Restore default mock return values after clearAllMocks
    mockLoadConfig.mockReturnValue({
      repo: 'owner/repo',
      repoOwner: 'owner',
      project: 0,
      agent: 'claude' as const,
      model: 'sonnet',
      labelReady: 'ready',
      dryRun: false,
    } as ReturnType<typeof loadConfig>);
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    (listLabels as jest.Mock).mockReturnValue(['bug', 'enhancement', 'documentation']);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true, configurable: true });
  });

  it('exits with error when description is empty', async () => {
    mockInput.mockResolvedValueOnce('');

    await addCommand({});

    expect(log.error).toHaveBeenCalledWith('Please provide a description.');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('exits when not a TTY and no --seed or --yes', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });

    await addCommand({});

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('interactive terminal'));
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('reads description from --seed file', async () => {
    mockReadFileSync.mockReturnValueOnce('Build a REST API');

    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());
    mockCreateIssue.mockReturnValue(42);
    // --yes to skip interactive prompts
    await addCommand({ seed: '/tmp/seed.txt', yes: true });

    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/seed.txt', 'utf-8');
    expect(mockExec).toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalled();
  });

  it('exits gracefully on agent failure', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '', stderr: 'agent crashed', exitCode: 1 });

    await addCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Agent failed'));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('exits gracefully on JSON parse failure', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: 'not json at all', stderr: '', exitCode: 0 });
    mockExtractJson.mockImplementation(() => {
      throw new Error('Could not extract valid JSON');
    });

    await addCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse AI response'));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('exits when AI response is missing required fields', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue({ title: '', body: '', labels: [], milestone: { title: '', isNew: false } });

    await addCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('missing required fields'));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('shows proposal and exits in dry-run mode', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());

    await addCommand({ dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('creates issue with --yes flag (no interactive prompts)', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());
    mockCreateIssue.mockReturnValue(42);

    await addCommand({ yes: true });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Add user authentication',
      expect.stringContaining('OAuth2'),
      ['enhancement', 'security'],
      'v2.0',
    );
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Created issue #42'));
  });

  it('creates new milestone when proposal says isNew', async () => {
    const proposalWithNewMilestone = {
      ...makeSampleProposal(),
      milestone: { title: 'v3.0', description: 'Future release', isNew: true },
    };

    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(proposalWithNewMilestone);
    mockCreateMilestone.mockReturnValue(5);
    mockCreateIssue.mockReturnValue(42);

    await addCommand({ yes: true });

    expect(mockCreateMilestone).toHaveBeenCalledWith('owner/repo', 'v3.0', 'Future release');
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Created milestone'));
    expect(mockCreateIssue).toHaveBeenCalled();
  });

  it('applies --milestone override', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());
    mockCreateIssue.mockReturnValue(42);

    await addCommand({ yes: true, milestone: 'v1.0' });

    // v1.0 exists in SAMPLE_MILESTONES, so isNew should be false
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Add user authentication',
      expect.any(String),
      ['enhancement', 'security'],
      'v1.0',
    );
  });

  it('handles user cancellation during body review', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());

    // Accept milestone, then cancel on body
    mockSelect.mockResolvedValueOnce('accept').mockResolvedValueOnce('cancel');

    await addCommand({});

    expect(log.info).toHaveBeenCalledWith('Cancelled.');
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('allows editing body in editor', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());
    mockCreateIssue.mockReturnValue(42);

    // Accept milestone, choose edit, then return edited body
    mockSelect.mockResolvedValueOnce('accept').mockResolvedValueOnce('edit');
    mockEditor.mockResolvedValueOnce('Edited body content');

    await addCommand({});

    expect(mockEditor).toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Add user authentication',
      'Edited body content',
      ['enhancement', 'security'],
      'v2.0',
    );
  });

  it('adds issue to project board when configured', async () => {
    mockLoadConfig.mockReturnValue({
      repo: 'owner/repo',
      repoOwner: 'owner',
      project: 5,
      agent: 'claude' as const,
      model: 'sonnet',
      labelReady: 'ready',
      dryRun: false,
    } as ReturnType<typeof loadConfig>);

    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());
    mockCreateIssue.mockReturnValue(42);

    await addCommand({ yes: true });

    expect(mockAddIssueToProject).toHaveBeenCalledWith('owner', 5, 'owner/repo', 42);
    expect(log.info).toHaveBeenCalledWith('Added to project board');
  });

  it('handles failed issue creation', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());
    mockCreateIssue.mockReturnValue(0);

    await addCommand({ yes: true });

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to create issue'));
  });

  it('combines --yes with --dry-run safely', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());

    await addCommand({ yes: true, dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('allows picking a different milestone interactively', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());
    mockCreateIssue.mockReturnValue(42);

    // Pick different milestone, then create
    mockSelect.mockResolvedValueOnce('pick').mockResolvedValueOnce('v1.0').mockResolvedValueOnce('create');

    await addCommand({});

    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Add user authentication',
      expect.any(String),
      ['enhancement', 'security'],
      'v1.0',
    );
  });

  it('allows creating a new milestone interactively', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode');
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(makeSampleProposal());
    mockCreateMilestone.mockReturnValue(10);
    mockCreateIssue.mockReturnValue(42);

    // Choose new milestone, provide title/desc, then create
    mockSelect.mockResolvedValueOnce('new');
    mockInput.mockResolvedValueOnce('v4.0').mockResolvedValueOnce('Far future');
    mockSelect.mockResolvedValueOnce('create');

    await addCommand({});

    expect(mockCreateMilestone).toHaveBeenCalledWith('owner/repo', 'v4.0', 'Far future');
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Add user authentication',
      expect.any(String),
      ['enhancement', 'security'],
      'v4.0',
    );
  });
});
