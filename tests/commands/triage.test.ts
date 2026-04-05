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
  extractJsonFromResponse: jest.fn(),
  formatTriageFindings: jest.fn(() => 'FORMATTED FINDINGS'),
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
  getIssueComments: jest.fn(() => []),
}));

import { checkbox, confirm } from '@inquirer/prompts';
import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { extractJsonFromResponse } from '../../src/lib/planning';
import {
  listOpenIssuesWithComments,
  closeIssue,
  updateIssue,
  createIssue,
  commentIssue,
} from '../../src/lib/github';

const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;
const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockExtractJson = extractJsonFromResponse as jest.MockedFunction<typeof extractJsonFromResponse>;
const mockListOpenIssuesWithComments = listOpenIssuesWithComments as jest.MockedFunction<typeof listOpenIssuesWithComments>;
const mockCloseIssue = closeIssue as jest.MockedFunction<typeof closeIssue>;
const mockUpdateIssue = updateIssue as jest.MockedFunction<typeof updateIssue>;
const mockCreateIssue = createIssue as jest.MockedFunction<typeof createIssue>;
const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;

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

describe('triage command', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.clearAllMocks();
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
    mockExtractJson.mockReturnValue(SAMPLE_FINDINGS);
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
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 4, 'not_planned');

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Applied'));
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
    mockExtractJson.mockImplementation(() => {
      throw new Error('Could not extract valid JSON');
    });

    await triageCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse triage JSON'));
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('does not make GitHub calls in dry-run mode', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_FINDINGS);

    await triageCommand({ dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(mockUpdateIssue).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCommentIssue).not.toHaveBeenCalled();
    // Should not show interactive prompts in dry-run
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it('truncates large issue bodies before building prompt', async () => {
    const longBody = 'x'.repeat(1000);
    mockListOpenIssuesWithComments.mockReturnValue([
      { number: 1, title: 'Long body issue', body: longBody, labels: [] },
    ]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue([]);

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
    mockExtractJson.mockReturnValue(SAMPLE_FINDINGS);
    mockCreateIssue.mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(12);

    await triageCommand({ yes: true });

    // Should not prompt
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();

    // Should apply all selected findings
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 1, 'not_planned');
    expect(mockUpdateIssue).toHaveBeenCalledWith('owner/repo', 2, { body: expect.any(String) });
    expect(mockCreateIssue).toHaveBeenCalledTimes(3);
    expect(mockCloseIssue).toHaveBeenCalledWith('owner/repo', 4, 'not_planned');
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('--yes: applying all'));
  });

  it('combines --yes with --dry-run safely', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_FINDINGS);

    await triageCommand({ yes: true, dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('exits with success message when all issues are ok', async () => {
    mockListOpenIssuesWithComments.mockReturnValue(SAMPLE_ISSUES);
    mockExec.mockReturnValue({ stdout: '[]', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue([]);

    await triageCommand({});

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('All issues look good'));
    expect(mockCheckbox).not.toHaveBeenCalled();
  });
});
