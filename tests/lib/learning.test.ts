import { extractLearnings, generateSessionSummary, getLearningContext, countLearnings, parseLearningOutput } from '../../src/lib/learning';

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
import { log } from '../../src/lib/logger';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Config } from '../../src/lib/config';

const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;
const mockLogWarn = log.warn as jest.MockedFunction<typeof log.warn>;

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
    preferEpics: false,
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

function codexLearningTranscript(): string {
  return `OpenAI Codex v0.50.0
warning: using fallback terminal mode
user
Analyze this completed development run.

Output ONLY this markdown structure, nothing else:

---
issue: 42
status: success
test_fix_retries: 1
duration: 120
date: 2026-01-01
---
## What Worked
- (list what went well)

## What Failed
- (list what went wrong, or "Nothing" if all passed)

## Patterns
- (reusable patterns discovered)

## Anti-Patterns
- (mistakes to avoid in future)

## Suggested Skill Updates
- (specific skill file changes, or "None")

codex
---
issue: 42
status: success
---
## What Worked
- Codex final answer was parsed instead of the echoed prompt

## What Failed
- Nothing

## Patterns
- Parse the last meaningful learning markdown candidate

## Anti-Patterns
- Saving raw CLI transcript output as a learning artifact

## Suggested Skill Updates
- None

tokens used: 12,345`;
}

function placeholderLearningOutput(): string {
  return `---
issue: 42
status: success
---
## What Worked
- (list what went well)

## What Failed
- (list what went wrong, or "Nothing" if all passed)

## Patterns
- (reusable patterns discovered)

## Anti-Patterns
- (mistakes to avoid in future)

## Suggested Skill Updates
- (specific skill file changes, or "None")`;
}

function learningFileContent(): string {
  return `---
issue: 42
status: success
---
## What Worked
- Good tests

## What Failed
- Nothing`;
}

function codexSummaryTranscript(): string {
  return `OpenAI Codex v0.50.0
warning: terminal could not enable raw mode
user
Analyze these learnings from a development session and produce a concise session summary.

Output ONLY this markdown structure:

# Session Summary: session/test

## Overview
- (2-3 sentences summarizing the session)

## Recurring Patterns
- (patterns that appeared across multiple issues -- these should be reinforced)

## Recurring Anti-Patterns
- (problems that kept happening -- these need fixing)

## Recommendations
- (specific, actionable improvements for the agent prompts, project config, or workflow)
- (e.g., "Update the implement prompt to always check for X before Y")

## Metrics
| Metric | Value |
|--------|-------|
| Issues processed | 1 |

codex
# Session Summary: session/test

## Overview
The session completed the bug fix and kept the change scoped to learning parsing.

## Recurring Patterns
- Final markdown extraction should prefer the last valid agent answer.

## Recurring Anti-Patterns
- Raw CLI transcript output should not be written as user-facing learnings.

## Recommendations
- Keep placeholder rejection in the learning parser covered by regression tests.

## Metrics
| Metric | Value |
|--------|-------|
| Issues processed | 1 |
| Success rate | 100% |

tokens used: 9,876`;
}

function placeholderSummaryOutput(): string {
  return `# Session Summary: session/test

## Overview
- (2-3 sentences summarizing the session)

## Recurring Patterns
- (patterns that appeared across multiple issues -- these should be reinforced)

## Recurring Anti-Patterns
- (problems that kept happening -- these need fixing)

## Recommendations
- (specific, actionable improvements for the agent prompts, project config, or workflow)
- (e.g., "Update the implement prompt to always check for X before Y")

## Metrics
| Metric | Value |
|--------|-------|
| Issues processed | 1 |
| Success rate | 100% |`;
}

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

  test('saves only the final Codex learning answer from raw transcript output', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: codexLearningTranscript(),
      duration: 5000,
    });

    await extractLearnings({ ...baseOptions, config: makeConfig({ agent: 'codex' }) });

    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).toContain('Codex final answer was parsed');
    expect(writtenContent).toContain('Parse the last meaningful learning markdown candidate');
    expect(writtenContent).not.toContain('OpenAI Codex');
    expect(writtenContent).not.toContain('warning: using fallback terminal mode');
    expect(writtenContent).not.toContain('(list what went well)');
    expect(writtenContent).not.toContain('tokens used');
  });

  test('skips writing learning file when output only contains placeholders', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: placeholderLearningOutput(),
      duration: 5000,
    });

    await extractLearnings({ ...baseOptions, config: makeConfig() });

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('did not contain meaningful learning sections'));
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

  test('prefers the final meaningful answer from Codex transcript output', () => {
    const { frontmatter, sections, hasMeaningfulSections } = parseLearningOutput(codexLearningTranscript());

    expect(hasMeaningfulSections).toBe(true);
    expect(frontmatter).toContain('issue: 42');
    expect(sections).toContain('Codex final answer was parsed');
    expect(sections).toContain('Saving raw CLI transcript output');
    expect(sections).not.toContain('(list what went well)');
    expect(sections).not.toContain('OpenAI Codex');
    expect(sections).not.toContain('tokens used');
  });

  test('rejects placeholder-only learning structure', () => {
    const { sections, hasMeaningfulSections } = parseLearningOutput(placeholderLearningOutput());

    expect(sections).toBe('');
    expect(hasMeaningfulSections).toBe(false);
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

describe('generateSessionSummary', () => {
  test('saves only the final Codex summary from raw transcript output', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['issue-42-20260101-000000.md' as any]);
    mockReadFileSync.mockReturnValue(learningFileContent());
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: codexSummaryTranscript(),
      duration: 5000,
    });

    const result = await generateSessionSummary({
      sessionName: 'session/test',
      results: [{ issueNum: 42, title: 'Test issue', status: 'success', duration: 120 }],
      learningsDir: '/fake/learnings',
      config: makeConfig({ agent: 'codex' }),
    });

    expect(result).toContain('The session completed the bug fix');
    expect(result).not.toContain('(2-3 sentences summarizing the session)');
    expect(result).not.toContain('OpenAI Codex');
    expect(result).not.toContain('tokens used');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('session-summary-session-test.md'),
      expect.stringContaining('Final markdown extraction should prefer the last valid agent answer'),
    );
    const writtenContent = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenContent).not.toContain('warning: terminal could not enable raw mode');
    expect(writtenContent).not.toContain('(patterns that appeared');
  });

  test('skips writing session summary when output is placeholder-only', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['issue-42-20260101-000000.md' as any]);
    mockReadFileSync.mockReturnValue(learningFileContent());
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: placeholderSummaryOutput(),
      duration: 5000,
    });

    const result = await generateSessionSummary({
      sessionName: 'session/test',
      results: [{ issueNum: 42, title: 'Test issue', status: 'success', duration: 120 }],
      learningsDir: '/fake/learnings',
      config: makeConfig(),
    });

    expect(result).toBeNull();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledWith(expect.stringContaining('did not return a valid markdown summary'));
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
