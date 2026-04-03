import { extractLearnings, getLearningContext, countLearnings } from '../../src/lib/learning';

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

jest.mock('../../src/lib/agent', () => ({
  spawnAgent: jest.fn(),
}));

jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
}));

import { spawnAgent } from '../../src/lib/agent';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Config } from '../../src/lib/config';

const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;

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
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    pricing: {},
    ...overrides,
  };
}

const baseOptions = {
  issueNum: 42,
  title: 'Test issue',
  status: 'success',
  retries: 1,
  duration: 120,
  diff: 'diff --git a/foo.ts',
  testOutput: 'All tests passed',
  reviewOutput: 'Looks good',
  verifyOutput: 'Verified',
  body: 'Issue body',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('extractLearnings', () => {
  test('skips when skipLearn is true', async () => {
    await extractLearnings({ ...baseOptions, config: makeConfig({ skipLearn: true }) });
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  test('skips when dryRun is true', async () => {
    await extractLearnings({ ...baseOptions, config: makeConfig({ dryRun: true }) });
    expect(mockSpawnAgent).not.toHaveBeenCalled();
  });

  test('calls spawnAgent with learn prompt and saves output', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: '---\nissue: 42\nstatus: success\n---\n## What Worked\n- Everything',
      duration: 5000,
    });

    await extractLearnings({ ...baseOptions, config: makeConfig() });

    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'claude',
      model: 'opus',
    }));
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('issue-42-'),
      expect.stringContaining('---'),
    );
  });

  test('wraps output with frontmatter if agent omits it', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: '## What Worked\n- Everything',
      duration: 5000,
    });

    await extractLearnings({ ...baseOptions, config: makeConfig() });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('issue-42-'),
      expect.stringContaining('issue: 42'),
    );
  });

  test('handles agent failure gracefully', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 1,
      output: '',
      duration: 1000,
    });

    await extractLearnings({ ...baseOptions, config: makeConfig() });

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });
});

describe('countLearnings', () => {
  test('returns 0 when directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(countLearnings('/fake/learnings')).toBe(0);
  });

  test('counts issue-*.md files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      'issue-1-20260330.md' as any,
      'issue-2-20260330.md' as any,
      'README.md' as any,
      '.gitkeep' as any,
    ]);
    expect(countLearnings('/fake/learnings')).toBe(2);
  });
});

describe('getLearningContext', () => {
  test('returns empty string when directory does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(getLearningContext('/fake/learnings')).toBe('');
  });

  test('returns empty string when no learning files exist', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([]);
    expect(getLearningContext('/fake/learnings')).toBe('');
  });

  test('returns formatted context from learning files', () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['issue-1-20260330.md' as any]);
    mockReadFileSync.mockReturnValue(`---
issue: 1
status: success
---
## What Worked
- Good tests

## What Failed
- Nothing

## Anti-Patterns
- Don't skip tests
`);

    const context = getLearningContext('/fake/learnings');
    expect(context).toContain('## Learnings from Previous Runs');
    expect(context).toContain('### Run #1 (success)');
    expect(context).toContain('Good tests');
  });
});
