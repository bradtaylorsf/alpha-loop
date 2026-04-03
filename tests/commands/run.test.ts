import { runCommand } from '../../src/commands/run';

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
}));

jest.mock('../../src/lib/pipeline', () => ({
  processIssue: jest.fn(),
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
import { pollIssues } from '../../src/lib/github';
import { processIssue } from '../../src/lib/pipeline';
import { createSession, finalizeSession } from '../../src/lib/session';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockPollIssues = pollIssues as jest.MockedFunction<typeof pollIssues>;
const mockProcessIssue = processIssue as jest.MockedFunction<typeof processIssue>;
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
    ...overrides,
  };
}

// Prevent process.exit from actually exiting
const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

beforeEach(() => {
  jest.clearAllMocks();

  mockExec.mockReturnValue({ stdout: '/usr/bin/tool', stderr: '', exitCode: 0 });
  mockLoadConfig.mockReturnValue(makeConfig() as any);
  mockCreateSession.mockReturnValue({
    name: 'session/20260330-143000',
    branch: 'session/20260330-143000',
    resultsDir: '/tmp/sessions',
    logsDir: '/tmp/sessions/logs',
    results: [],
  });
  mockFinalizeSession.mockResolvedValue(null);
  mockPollIssues.mockReturnValue([]);
});

afterEach(() => {
  // Remove signal handlers to prevent test pollution
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});

describe('runCommand', () => {
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
});
