import { runVerify, type VerifyResult } from '../../src/lib/verify.js';
import type { Config } from '../../src/lib/config.js';

// Mock agent and shell to avoid real process spawning
jest.mock('../../src/lib/agent.js', () => ({
  spawnAgent: jest.fn(),
}));

jest.mock('../../src/lib/shell.js', () => ({
  exec: jest.fn().mockReturnValue({ exitCode: 1, stdout: '', stderr: '' }),
  formatTimestamp: jest.fn().mockReturnValue('20260101-000000'),
}));

const { exec } = jest.requireMock('../../src/lib/shell.js') as { exec: jest.Mock };
const { spawnAgent } = jest.requireMock('../../src/lib/agent.js') as { spawnAgent: jest.Mock };

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'test/repo',
    repoOwner: 'test',
    project: 1,
    model: 'opus',
    reviewModel: 'opus',
    pollInterval: 60,
    dryRun: false,
    baseBranch: 'main',
    logDir: 'logs',
    labelReady: 'ready',
    maxTestRetries: 1,
    testCommand: 'pnpm test',
    devCommand: 'pnpm dev',
    port: 3000,
    skipTests: false,
    skipReview: false,
    skipInstall: false,
    skipPreflight: false,
    skipVerify: false,
    skipLearn: false,
    skipE2e: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    harnesses: [],
    autoMerge: false,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    verbose: false,
    ...overrides,
  };
}

describe('runVerify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns passed when skipVerify is true', async () => {
    const result = await runVerify({
      worktree: '/tmp/test',
      logFile: '/tmp/test.log',
      issueNum: 1,
      title: 'test',
      body: 'test body',
      config: makeConfig({ skipVerify: true }),
      sessionDir: '/tmp/session',
    });

    expect(result.passed).toBe(true);
    expect(result.output).toContain('skipped');
  });

  it('returns passed when dryRun is true', async () => {
    const result = await runVerify({
      worktree: '/tmp/test',
      logFile: '/tmp/test.log',
      issueNum: 1,
      title: 'test',
      body: 'test body',
      config: makeConfig({ dryRun: true }),
      sessionDir: '/tmp/session',
    });

    expect(result.passed).toBe(true);
    expect(result.output).toContain('dry run');
  });

  it('skips verification when playwright-cli is not installed', async () => {
    exec.mockReturnValue({ exitCode: 1, stdout: '', stderr: '' });

    const result = await runVerify({
      worktree: '/tmp/test',
      logFile: '/tmp/test.log',
      issueNum: 1,
      title: 'test',
      body: 'test body',
      config: makeConfig(),
      sessionDir: '/tmp/session',
    });

    expect(result.passed).toBe(true);
    expect(result.output).toContain('playwright-cli not installed');
  });

  it('skips verification when no dev command found', async () => {
    // playwright-cli exists
    exec.mockImplementation((cmd: string) => {
      if (cmd === 'which playwright-cli') {
        return { exitCode: 0, stdout: '/usr/bin/playwright-cli', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    });

    const result = await runVerify({
      worktree: '/tmp/nonexistent',
      logFile: '/tmp/test.log',
      issueNum: 1,
      title: 'test',
      body: 'test body',
      config: makeConfig({ devCommand: '' }),
      sessionDir: '/tmp/session',
    });

    expect(result.passed).toBe(true);
    expect(result.output).toContain('no start command');
  });
});
