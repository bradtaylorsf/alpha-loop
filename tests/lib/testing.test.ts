import { runTests } from '../../src/lib/testing';

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  shellQuote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
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
import { log } from '../../src/lib/logger';
import type { Config } from '../../src/lib/config';

const mockExec = exec as jest.MockedFunction<typeof exec>;

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    testScope: 'full',
    changedTestCommand: '',
    devCommand: 'pnpm dev',
    skipTests: false,
    skipReview: false,
    skipInstall: false,
    skipPreflight: false,
    skipVerify: false,
    skipQa: false,
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
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    preferEpics: false,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    quick: false,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
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

  test('uses a safely quoted changed-file template in changed scope', () => {
    mockExec.mockReturnValue({ stdout: 'Related tests passed', stderr: '', exitCode: 0 });

    runTests('/work', makeConfig({
      testScope: 'changed',
      changedTestCommand: 'pnpm jest --findRelatedTests {files}',
    }), '/log', {
      changedFiles: ['src/one.ts', "src/it's complicated.ts"],
    });

    expect(mockExec).toHaveBeenCalledWith(
      "pnpm jest --findRelatedTests 'src/one.ts' 'src/it'\\''s complicated.ts'",
      expect.objectContaining({ cwd: '/work' }),
    );
  });

  test('preserves the full command in full scope even when changed files are provided', () => {
    mockExec.mockReturnValue({ stdout: 'All tests passed', stderr: '', exitCode: 0 });

    runTests('/work', makeConfig(), '/log', { changedFiles: ['src/one.ts'] });

    expect(mockExec).toHaveBeenCalledWith('pnpm test', expect.objectContaining({ cwd: '/work' }));
  });

  test('treats an omitted test scope as full for backwards compatibility', () => {
    mockExec.mockReturnValue({ stdout: 'All tests passed', stderr: '', exitCode: 0 });

    runTests('/work', makeConfig({ testScope: undefined }), '/log');

    expect(mockExec).toHaveBeenCalledWith('pnpm test', expect.objectContaining({ cwd: '/work' }));
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('forces the full command for the session gate', () => {
    mockExec.mockReturnValue({ stdout: 'All tests passed', stderr: '', exitCode: 0 });

    runTests('/work', makeConfig({
      testScope: 'changed',
      changedTestCommand: 'pnpm jest --findRelatedTests {files}',
    }), '/log', { changedFiles: ['src/one.ts'], forceFull: true });

    expect(mockExec).toHaveBeenCalledWith('pnpm test', expect.objectContaining({ cwd: '/work' }));
  });

  test('warns and falls back to the full command when changed_test_command is unset', () => {
    mockExec.mockReturnValue({ stdout: 'All tests passed', stderr: '', exitCode: 0 });

    runTests('/work', makeConfig({ testScope: 'changed' }), '/log', {
      changedFiles: ['src/one.ts'],
    });

    expect(mockExec).toHaveBeenCalledWith('pnpm test', expect.objectContaining({ cwd: '/work' }));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('changed_test_command is not configured'));
  });

  test('warns and falls back when the changed command has no files placeholder', () => {
    mockExec.mockReturnValue({ stdout: 'All tests passed', stderr: '', exitCode: 0 });

    runTests('/work', makeConfig({
      testScope: 'changed',
      changedTestCommand: 'pnpm jest --findRelatedTests',
    }), '/log', { changedFiles: ['src/one.ts'] });

    expect(mockExec).toHaveBeenCalledWith('pnpm test', expect.objectContaining({ cwd: '/work' }));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('{files}'));
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

// Note: Live verification tests are in tests/lib/verify.test.ts
// runE2eTests was removed — verification now uses playwright-cli via src/lib/verify.ts
