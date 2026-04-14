import { extractLearnings, getLearningContext, countLearnings, parseLearningOutput } from '../../src/lib/learning';

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
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
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

  test('calls spawnAgent with learn prompt and saves parsed output', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: '---\nissue: 42\nstatus: success\n---\n## What Worked\n- Everything\n\n## What Failed\n- Nothing',
      duration: 5000,
    });

    await extractLearnings({ ...baseOptions, config: makeConfig() });

    expect(mockSpawnAgent).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'claude',
      model: 'opus',
    }));
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('issue-42-'),
      expect.stringContaining('## What Worked'),
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

  test('saves raw output to session traces directory when sessionLogsDir provided', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: '---\nissue: 42\nstatus: success\n---\n## What Worked\n- Everything',
      duration: 5000,
    });

    await extractLearnings({
      ...baseOptions,
      config: makeConfig(),
      sessionLogsDir: '/fake/session/logs',
    });

    // Should write both raw and parsed files
    expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('issue-42-raw.md'),
      expect.any(String),
    );
  });

  test('adds trace pointers when sessionName provided', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: '---\nissue: 42\nstatus: success\n---\n## What Worked\n- Everything',
      duration: 5000,
    });

    await extractLearnings({
      ...baseOptions,
      config: makeConfig(),
      sessionName: 'test-session',
    });

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('traces:');
    expect(writtenContent).toContain('.alpha-loop/sessions/test-session');
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

describe('parseLearningOutput', () => {
  test('extracts expected sections from clean output', () => {
    const raw = `---
issue: 42
status: success
---
## What Worked
- Tests passed first try

## What Failed
- Nothing

## Patterns
- Good test coverage

## Anti-Patterns
- Skipping validation

## Suggested Skill Updates
- None`;

    const { frontmatter, sections } = parseLearningOutput(raw);
    expect(frontmatter).toContain('issue: 42');
    expect(sections).toContain('## What Worked');
    expect(sections).toContain('Tests passed first try');
    expect(sections).toContain('## Anti-Patterns');
  });

  test('discards noise around expected sections', () => {
    const raw = `Some random agent preamble and tool calls...

---
issue: 42
status: success
---

A bunch of prompt echo text that should be discarded.

## What Worked
- Clean implementation

## What Failed
- Nothing

Some trailing garbage text`;

    const { sections } = parseLearningOutput(raw);
    expect(sections).toContain('## What Worked');
    expect(sections).toContain('Clean implementation');
    expect(sections).not.toContain('random agent preamble');
    expect(sections).not.toContain('prompt echo text');
  });

  test('returns null frontmatter when none present', () => {
    const raw = '## What Worked\n- Good stuff';
    const { frontmatter } = parseLearningOutput(raw);
    expect(frontmatter).toBeNull();
  });

  test('handles output with no expected sections', () => {
    const raw = 'Just some random text with no sections';
    const { sections } = parseLearningOutput(raw);
    expect(sections).toBe('');
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
