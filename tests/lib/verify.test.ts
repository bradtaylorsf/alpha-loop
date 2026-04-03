import { runVerify, isNonUiChange, type VerifyResult } from '../../src/lib/verify.js';
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
    agent: 'claude',
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
    setupCommand: '',
    autoMerge: false,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    verbose: false,
    evalDir: '.alpha-loop/evals',
    evalModel: '',
    skipEval: false,
    evalTimeout: 300,
    ...overrides,
  };
}

describe('isNonUiChange', () => {
  it('returns true for config-only changes', () => {
    const diff = ` agents/fork/config.yaml       | 20 ++++++++++++++++++++
 agents/fork/behaviors.yaml    | 15 +++++++++++++++
 agents/fork/system_prompt.md  | 30 ++++++++++++++++++++++++++++++
 3 files changed, 65 insertions(+)`;
    expect(isNonUiChange(diff)).toBe(true);
  });

  it('returns true for test-only changes', () => {
    const diff = ` src/utils.test.ts  | 10 ++++++++++
 src/api.test.tsx   | 5 +++++
 2 files changed, 15 insertions(+)`;
    expect(isNonUiChange(diff)).toBe(true);
  });

  it('returns false for source code changes', () => {
    const diff = ` src/components/App.tsx | 10 ++++++++++
 1 file changed, 10 insertions(+)`;
    expect(isNonUiChange(diff)).toBe(false);
  });

  it('returns false when mix of UI and non-UI files', () => {
    const diff = ` config.yaml         | 5 +++++
 src/pages/Home.tsx   | 20 ++++++++++++++++++++
 2 files changed, 25 insertions(+)`;
    expect(isNonUiChange(diff)).toBe(false);
  });

  it('returns true for empty diff', () => {
    expect(isNonUiChange('')).toBe(true);
  });

  it('returns true for json/lock files', () => {
    const diff = ` package.json     | 2 +-
 pnpm-lock.yaml   | 100 +++++++++++++++++++++++++++++++
 2 files changed, 101 insertions(+), 1 deletion(-)`;
    expect(isNonUiChange(diff)).toBe(true);
  });
});

describe('runVerify', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns passed and skipped when skipVerify is true', async () => {
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
    expect(result.skipped).toBe(true);
    expect(result.output).toContain('skipped');
  });

  it('returns passed and skipped when dryRun is true', async () => {
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
    expect(result.skipped).toBe(true);
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
    expect(result.skipped).toBe(true);
    expect(result.output).toContain('playwright-cli not installed');
  });

  it('skips verification for non-UI changes', async () => {
    exec.mockImplementation((cmd: string) => {
      if (cmd === 'which playwright-cli') {
        return { exitCode: 0, stdout: '/usr/bin/playwright-cli', stderr: '' };
      }
      if (cmd.includes('git diff --stat')) {
        return { exitCode: 0, stdout: ' config.yaml | 5 +++++\n 1 file changed, 5 insertions(+)', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    });

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
    expect(result.skipped).toBe(true);
    expect(result.output).toContain('non-UI');
  });

  it('skips verification when no dev command found', async () => {
    exec.mockImplementation((cmd: string) => {
      if (cmd === 'which playwright-cli') {
        return { exitCode: 0, stdout: '/usr/bin/playwright-cli', stderr: '' };
      }
      if (cmd.includes('git diff --stat')) {
        return { exitCode: 0, stdout: ' src/app.tsx | 5 +++++\n 1 file changed, 5 insertions(+)', stderr: '' };
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
    expect(result.skipped).toBe(true);
    expect(result.output).toContain('no start command');
  });
});
