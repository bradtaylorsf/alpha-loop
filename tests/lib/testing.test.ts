import { runTests, runE2eTests } from '../../src/lib/testing';

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

// Mock fs functions used for log file appending
jest.mock('node:fs', () => ({
  appendFileSync: jest.fn(),
}));

import { exec } from '../../src/lib/shell';
import type { Config } from '../../src/lib/config';

const mockExec = exec as jest.MockedFunction<typeof exec>;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 1,
    model: 'opus',
    reviewModel: 'opus',
    maxTurns: 30,
    pollInterval: 60,
    dryRun: false,
    baseBranch: 'master',
    logDir: 'logs',
    labelReady: 'ready',
    maxTestRetries: 3,
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
    autoMerge: false,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runTests', () => {
  test('returns passed=true immediately when skipTests is true', () => {
    const result = runTests('/work', makeConfig({ skipTests: true }), '/log');
    expect(result).toEqual({ passed: true, output: 'Tests skipped' });
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('returns passed=true immediately when dryRun is true', () => {
    const result = runTests('/work', makeConfig({ dryRun: true }), '/log');
    expect(result).toEqual({ passed: true, output: 'Tests skipped (dry run)' });
    expect(mockExec).not.toHaveBeenCalled();
  });

  test('runs configured test command in worktree', () => {
    mockExec.mockReturnValue({ stdout: 'All tests passed', stderr: '', exitCode: 0 });

    const result = runTests('/work', makeConfig({ testCommand: 'npm test' }), '/log');

    expect(result.passed).toBe(true);
    expect(mockExec).toHaveBeenCalledWith('npm test', expect.objectContaining({ cwd: '/work' }));
  });

  test('returns passed=false when test command exits non-zero', () => {
    mockExec.mockReturnValue({ stdout: 'FAIL', stderr: 'Error', exitCode: 1 });

    const result = runTests('/work', makeConfig(), '/log');

    expect(result.passed).toBe(false);
    expect(result.output).toContain('FAIL');
  });

  test('sets RECORD_FIXTURES env when runFull is true', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });

    runTests('/work', makeConfig({ runFull: true }), '/log');

    expect(mockExec).toHaveBeenCalledWith('pnpm test', expect.objectContaining({
      env: { RECORD_FIXTURES: 'true' },
    }));
  });
});

describe('runE2eTests', () => {
  test('returns passed=true on successful exit', () => {
    mockExec.mockReturnValue({ stdout: 'E2E passed', stderr: '', exitCode: 0 });

    const result = runE2eTests('/work', '/log');

    expect(result.passed).toBe(true);
    expect(mockExec).toHaveBeenCalledWith('pnpm test:e2e', expect.objectContaining({ cwd: '/work' }));
  });

  test('returns passed=false on failure', () => {
    mockExec.mockReturnValue({ stdout: 'E2E failed', stderr: '', exitCode: 1 });

    const result = runE2eTests('/work', '/log');

    expect(result.passed).toBe(false);
  });
});
