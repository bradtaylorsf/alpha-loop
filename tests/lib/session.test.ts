import { createSession, saveResult, getPreviousResult, finalizeSession } from '../../src/lib/session';
import type { PipelineResult } from '../../src/lib/pipeline';

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  formatTimestamp: jest.fn().mockReturnValue('20260101-000000'),
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

jest.mock('../../src/lib/github', () => ({
  createPR: jest.fn(),
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  existsSync: jest.fn(),
}));

import { exec } from '../../src/lib/shell';
import { createPR } from '../../src/lib/github';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import type { Config } from '../../src/lib/config';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockCreatePR = createPR as jest.MockedFunction<typeof createPR>;
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 1,
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
    verbose: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
});

describe('createSession', () => {
  test('generates session name with timestamp format', () => {
    const session = createSession(makeConfig());

    expect(session.name).toMatch(/^session\/\d{8}-\d{6}$/);
    expect(session.branch).toBe(session.name);
    expect(session.results).toEqual([]);
  });

  test('creates results and logs directories', () => {
    createSession(makeConfig());

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.alpha-loop/sessions/session/'),
      { recursive: true },
    );
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('/logs'),
      { recursive: true },
    );
  });

  test('uses mergeTo as branch name when provided', () => {
    const session = createSession(makeConfig({ mergeTo: 'my-branch' }));
    expect(session.branch).toBe('my-branch');
  });

  test('creates session branch when autoMerge is enabled', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 1 }); // branch doesn't exist

    createSession(makeConfig({ autoMerge: true }));

    // Should attempt to create branch
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('git checkout -b'),
      expect.any(Object),
    );
  });

  test('does not create session branch in dryRun mode', () => {
    createSession(makeConfig({ autoMerge: true, dryRun: true }));

    // Should NOT attempt to create branch
    const checkoutCalls = (mockExec as jest.Mock).mock.calls.filter(
      (call: string[]) => call[0]?.includes('git checkout -b'),
    );
    expect(checkoutCalls).toHaveLength(0);
  });
});

describe('saveResult', () => {
  test('writes result JSON to correct path', () => {
    const session = createSession(makeConfig());
    const result: PipelineResult = {
      issueNum: 42,
      title: 'Test issue',
      status: 'success',
      testsPassing: true,
      verifyPassing: true,
      duration: 120,
      filesChanged: 5,
    };

    saveResult(session, result);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('result-42.json'),
      expect.stringContaining('"issueNum": 42'),
    );
  });
});

describe('getPreviousResult', () => {
  test('returns null when no results exist', () => {
    const session = createSession(makeConfig());
    expect(getPreviousResult(session)).toBeNull();
  });

  test('returns formatted string for last result', () => {
    const session = createSession(makeConfig());
    session.results.push({
      issueNum: 42,
      title: 'Test issue',
      status: 'success',
      prUrl: 'https://github.com/owner/repo/pull/1',
      testsPassing: true,
      verifyPassing: true,
      duration: 120,
      filesChanged: 5,
    });

    const prev = getPreviousResult(session);
    expect(prev).toContain('#42');
    expect(prev).toContain('Test issue');
    expect(prev).toContain('PASSING');
    expect(prev).toContain('Build on what was already done');
  });
});

describe('finalizeSession', () => {
  test('returns null when autoMerge is false', async () => {
    const session = createSession(makeConfig());
    session.results.push({ issueNum: 1, title: 'T', status: 'success', testsPassing: true, verifyPassing: true, duration: 10, filesChanged: 1 });

    const result = await finalizeSession(session, makeConfig({ autoMerge: false }));
    expect(result).toBeNull();
  });

  test('returns null when no issues were processed', async () => {
    const session = createSession(makeConfig());

    const result = await finalizeSession(session, makeConfig({ autoMerge: true }));
    expect(result).toBeNull();
  });

  test('logs dry run message in dry run mode', async () => {
    const session = createSession(makeConfig());
    session.results.push({ issueNum: 1, title: 'T', status: 'success', testsPassing: true, verifyPassing: true, duration: 10, filesChanged: 1 });

    const result = await finalizeSession(session, makeConfig({ autoMerge: true, dryRun: true }));
    expect(result).toBeNull();
  });

  test('creates session PR with correct body', async () => {
    mockExistsSync.mockReturnValue(true);
    // git diff --cached --quiet returns non-zero (changes exist)
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('diff --cached --quiet')) {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/99');

    const config = makeConfig({ autoMerge: true });
    const session = createSession(config);
    session.results.push({
      issueNum: 1,
      title: 'First issue',
      status: 'success',
      prUrl: 'https://github.com/owner/repo/pull/1',
      testsPassing: true,
      verifyPassing: true,
      duration: 60,
      filesChanged: 3,
    });

    const result = await finalizeSession(session, config);

    expect(result).toBe('https://github.com/owner/repo/pull/99');
    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'owner/repo',
      base: 'master',
      title: expect.stringContaining('Session:'),
      body: expect.stringContaining('#1: First issue'),
    }));
  });
});
