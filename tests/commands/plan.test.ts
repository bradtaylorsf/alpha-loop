import { planCommand } from '../../src/commands/plan';

// Mock all external dependencies
jest.mock('@inquirer/prompts', () => ({
  input: jest.fn(),
  checkbox: jest.fn(),
  confirm: jest.fn(),
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
  },
}));

jest.mock('../../src/lib/planning', () => ({
  extractJsonFromResponse: jest.fn(),
  formatIssueTable: jest.fn(() => 'FORMATTED TABLE'),
  readSeedFiles: jest.fn(() => []),
  savePlanDraft: jest.fn(),
  buildPlanningContext: jest.fn(() => ({
    visionContext: null,
    projectContext: null,
    existingIssues: [],
  })),
}));

jest.mock('../../src/lib/github', () => ({
  createMilestone: jest.fn(() => 1),
  createIssue: jest.fn(() => 42),
  addIssueToProject: jest.fn(),
  listOpenIssues: jest.fn(() => []),
}));

import { input, checkbox, confirm } from '@inquirer/prompts';
import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { extractJsonFromResponse, savePlanDraft } from '../../src/lib/planning';
import { createMilestone, createIssue, addIssueToProject } from '../../src/lib/github';
import { loadConfig } from '../../src/lib/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockInput = input as jest.MockedFunction<typeof input>;
const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockExtractJson = extractJsonFromResponse as jest.MockedFunction<typeof extractJsonFromResponse>;
const mockCreateMilestone = createMilestone as jest.MockedFunction<typeof createMilestone>;
const mockCreateIssue = createIssue as jest.MockedFunction<typeof createIssue>;
const mockAddIssueToProject = addIssueToProject as jest.MockedFunction<typeof addIssueToProject>;
const mockSavePlanDraft = savePlanDraft as jest.MockedFunction<typeof savePlanDraft>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;

const VALID_PLAN_DRAFT = {
  vision: null,
  milestones: [
    { title: 'MVP', description: 'Core features', dueOn: '2026-06-01', order: 1 },
  ],
  issues: [
    {
      id: 1,
      title: 'Add login page',
      body: '## Acceptance Criteria\n- [ ] User can log in',
      labels: ['enhancement'],
      milestone: 'MVP',
      priority: 'p1' as const,
      complexity: 'medium' as const,
      dependsOn: [],
      selected: true,
    },
    {
      id: 2,
      title: 'Add dashboard',
      body: '## Acceptance Criteria\n- [ ] Dashboard renders',
      labels: ['enhancement'],
      milestone: 'MVP',
      priority: 'p2' as const,
      complexity: 'small' as const,
      dependsOn: [1],
      selected: true,
    },
  ],
  projectBoard: null,
};

describe('plan command', () => {
  let consoleSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let origIsTTY: boolean | undefined;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
    origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    jest.clearAllMocks();

    // Default config
    mockLoadConfig.mockReturnValue({
      repo: 'owner/repo',
      repoOwner: 'owner',
      project: 0,
      agent: 'claude',
      model: 'sonnet',
      labelReady: 'ready',
      dryRun: false,
    } as ReturnType<typeof loadConfig>);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });

  it('skips when not running in an interactive terminal', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await planCommand({});

    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('interactive terminal'),
    );
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('generates plan and creates GitHub resources on confirmation', async () => {
    // Interactive flow
    mockInput.mockResolvedValueOnce('Build an e-commerce app');
    mockCheckbox
      .mockResolvedValueOnce([]) // no seed sources
      .mockResolvedValueOnce([1, 2]); // select all issues
    mockConfirm
      .mockResolvedValueOnce(false) // don't edit bodies
      .mockResolvedValueOnce(true); // confirm creation

    // Agent returns valid plan JSON
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(VALID_PLAN_DRAFT);
    mockCreateMilestone.mockReturnValue(1);
    mockCreateIssue.mockReturnValueOnce(42).mockReturnValueOnce(43);

    await planCommand({});

    // Verify plan was saved
    expect(mockSavePlanDraft).toHaveBeenCalledWith(
      expect.objectContaining({ milestones: VALID_PLAN_DRAFT.milestones }),
      expect.any(String),
    );

    // Verify milestone created
    expect(mockCreateMilestone).toHaveBeenCalledWith(
      'owner/repo', 'MVP', 'Core features', '2026-06-01',
    );

    // Verify issues created with ready label
    expect(mockCreateIssue).toHaveBeenCalledTimes(2);
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Add login page',
      expect.any(String),
      expect.arrayContaining(['enhancement', 'ready']),
      1,
    );

    expect(log.success).toHaveBeenCalledWith(
      expect.stringContaining('Created'),
    );
  });

  it('exits gracefully on agent failure', async () => {
    mockInput.mockResolvedValueOnce('Build something');
    mockCheckbox.mockResolvedValueOnce([]);

    // Agent fails
    mockExec.mockReturnValue({ stdout: '', stderr: 'agent crashed', exitCode: 1 });

    await planCommand({});

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Agent failed'),
    );
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('does not create GitHub resources in dry-run mode', async () => {
    mockInput.mockResolvedValueOnce('Build an app');
    mockCheckbox.mockResolvedValueOnce([]);

    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(VALID_PLAN_DRAFT);

    await planCommand({ dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(
      expect.stringContaining('Dry run'),
    );
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockSavePlanDraft).not.toHaveBeenCalled();
  });

  it('reads seed file with --seed option', async () => {
    // Write a temp seed file
    const tmpSeed = path.join(os.tmpdir(), `plan-test-seed-${Date.now()}.md`);
    fs.writeFileSync(tmpSeed, 'Build a task management app with kanban boards');

    mockCheckbox.mockResolvedValueOnce([]);

    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(VALID_PLAN_DRAFT);

    try {
      await planCommand({ seed: tmpSeed, dryRun: true });
    } finally {
      try { fs.unlinkSync(tmpSeed); } catch { /* cleanup */ }
    }

    // Should not prompt for description
    expect(mockInput).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Read seed from'));
  });

  it('handles JSON parse failure gracefully', async () => {
    mockInput.mockResolvedValueOnce('Build something');
    mockCheckbox.mockResolvedValueOnce([]);

    mockExec.mockReturnValue({ stdout: 'not valid json at all', stderr: '', exitCode: 0 });
    mockExtractJson.mockImplementation(() => {
      throw new Error('Could not extract valid JSON');
    });

    await planCommand({});

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse plan JSON'),
    );
    expect(mockCreateMilestone).not.toHaveBeenCalled();
  });

  it('allows non-TTY execution with --yes and --seed', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const tmpSeed = path.join(os.tmpdir(), `plan-yes-test-${Date.now()}.md`);
    fs.writeFileSync(tmpSeed, 'Build a task app');

    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(VALID_PLAN_DRAFT);
    mockCreateMilestone.mockReturnValue(1);
    mockCreateIssue.mockReturnValueOnce(42).mockReturnValueOnce(43);

    try {
      await planCommand({ seed: tmpSeed, yes: true });
    } finally {
      try { fs.unlinkSync(tmpSeed); } catch { /* cleanup */ }
    }

    // Should not prompt for anything
    expect(mockInput).not.toHaveBeenCalled();
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();

    // Should auto-select all issues and create resources
    expect(mockCreateMilestone).toHaveBeenCalledTimes(1);
    expect(mockCreateIssue).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('--yes: selecting all'));
  });

  it('errors when --yes is used without --seed', async () => {
    await planCommand({ yes: true });

    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('--yes requires --seed'),
    );
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('combines --yes with --dry-run safely', async () => {
    const tmpSeed = path.join(os.tmpdir(), `plan-yesdry-test-${Date.now()}.md`);
    fs.writeFileSync(tmpSeed, 'Build something');

    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(VALID_PLAN_DRAFT);

    try {
      await planCommand({ seed: tmpSeed, yes: true, dryRun: true });
    } finally {
      try { fs.unlinkSync(tmpSeed); } catch { /* cleanup */ }
    }

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('adds issues to project board when project is configured', async () => {
    mockLoadConfig.mockReturnValue({
      repo: 'owner/repo',
      repoOwner: 'owner',
      project: 5,
      agent: 'claude',
      model: 'sonnet',
      labelReady: 'ready',
      dryRun: false,
    } as ReturnType<typeof loadConfig>);

    mockInput.mockResolvedValueOnce('Build an app');
    mockCheckbox
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([1, 2]);
    mockConfirm
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(VALID_PLAN_DRAFT);
    mockCreateMilestone.mockReturnValue(1);
    mockCreateIssue.mockReturnValueOnce(42).mockReturnValueOnce(43);

    await planCommand({});

    expect(mockAddIssueToProject).toHaveBeenCalledTimes(2);
    expect(mockAddIssueToProject).toHaveBeenCalledWith('owner', 5, 'owner/repo', 42);
    expect(mockAddIssueToProject).toHaveBeenCalledWith('owner', 5, 'owner/repo', 43);
  });
});
