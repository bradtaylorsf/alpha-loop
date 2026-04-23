import { verifyEpic } from '../../src/lib/verify-epic.js';
import type { VerifyEpicInput } from '../../src/lib/verify-epic.js';
import type { Issue } from '../../src/lib/github.js';
import type { Config } from '../../src/lib/config.js';

// Mock spawnAgent (the agent runner) and ghExec (used to fetch diffs)
jest.mock('../../src/lib/agent.js', () => ({
  spawnAgent: jest.fn(),
}));

jest.mock('../../src/lib/rate-limit.js', () => ({
  ghExec: jest.fn(),
}));

jest.mock('../../src/lib/logger.js', () => ({
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

import { spawnAgent } from '../../src/lib/agent.js';
import { ghExec } from '../../src/lib/rate-limit.js';

const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockGhExec = ghExec as jest.MockedFunction<typeof ghExec>;

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

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: 'Test issue',
    body: '## AC\n- [ ] Something works',
    labels: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<VerifyEpicInput> = {}): VerifyEpicInput {
  return {
    epic: makeIssue({ number: 165, title: 'Hybrid Routing', body: '## Epic AC\n- [ ] Routing works' }),
    subIssues: [
      makeIssue({ number: 10, title: 'Sub A' }),
      makeIssue({ number: 11, title: 'Sub B' }),
    ],
    mergedPRUrls: [
      'https://github.com/owner/repo/pull/201',
      'https://github.com/owner/repo/pull/202',
    ],
    ...overrides,
  };
}

const STUB_LOGS_DIR = '/tmp/epic-verify-logs';

beforeEach(() => {
  jest.clearAllMocks();

  // Default: gh pr diff returns an empty diff (non-zero = no diff available)
  mockGhExec.mockReturnValue({ exitCode: 0, stdout: '', stderr: '' });
});

describe('verifyEpic', () => {
  test('returns verdict=pass when agent output contains valid json fence with verdict pass', async () => {
    const agentOutput = `
Here is my assessment:

\`\`\`json
{
  "verdict": "pass",
  "summary": "All criteria met.",
  "findings": [
    { "issueNum": 10, "criterion": "Routing works", "verdict": "met", "notes": "Covered by tests" }
  ]
}
\`\`\`
`;
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: agentOutput, duration: 3000 });

    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    expect(result.verdict).toBe('pass');
    expect(result.parsed.verdict).toBe('pass');
    expect(result.parsed.summary).toBe('All criteria met.');
    expect(result.parsed.findings).toHaveLength(1);
    expect(result.parsed.findings[0]).toMatchObject({ issueNum: 10, verdict: 'met' });
  });

  test('returns verdict=partial when agent output contains verdict partial', async () => {
    const agentOutput = `
\`\`\`json
{
  "verdict": "partial",
  "summary": "Some criteria met.",
  "findings": [
    { "issueNum": 10, "criterion": "Routing works", "verdict": "partial", "notes": "Partially covered" },
    { "issueNum": 11, "criterion": "Auth works", "verdict": "missing" }
  ]
}
\`\`\`
`;
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: agentOutput, duration: 3000 });

    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    expect(result.verdict).toBe('partial');
    expect(result.parsed.findings).toHaveLength(2);
  });

  test('returns DEFAULT_VERDICT (partial) when agent output has no json fence', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'I reviewed the epic but could not produce a structured output.',
      duration: 2000,
    });

    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    expect(result.verdict).toBe('partial');
    expect(result.parsed.summary).toContain('could not be parsed');
    expect(result.parsed.findings).toHaveLength(0);
  });

  test('caps verdict at partial when at least one mergedPRUrl is null even if agent says pass', async () => {
    const agentOutput = `
\`\`\`json
{
  "verdict": "pass",
  "summary": "All evaluated criteria passed.",
  "findings": [
    { "issueNum": 10, "criterion": "Routing works", "verdict": "met" }
  ]
}
\`\`\`
`;
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: agentOutput, duration: 3000 });

    // Sub-issue 11 has no merged PR
    const input = makeInput({ mergedPRUrls: ['https://github.com/owner/repo/pull/201', null] });

    const result = await verifyEpic(input, makeConfig(), STUB_LOGS_DIR);

    // Even though agent said pass, verdict must be capped to partial
    expect(result.verdict).toBe('partial');
    // Comment should mention the cap
    expect(result.comment).toMatch(/capped/i);
  });

  test('does NOT cap verdict at partial when all mergedPRUrls are present and agent says pass', async () => {
    const agentOutput = `
\`\`\`json
{
  "verdict": "pass",
  "summary": "All criteria met.",
  "findings": []
}
\`\`\`
`;
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: agentOutput, duration: 3000 });

    // All sub-issues have merged PRs
    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    expect(result.verdict).toBe('pass');
  });

  test('normalizes invalid finding verdict strings to unclear', async () => {
    const agentOutput = `
\`\`\`json
{
  "verdict": "partial",
  "summary": "Mixed results.",
  "findings": [
    { "issueNum": 10, "criterion": "Something", "verdict": "DEFINITELY_MET", "notes": "typo in verdict" },
    { "issueNum": 11, "criterion": "Other thing", "verdict": "met" }
  ]
}
\`\`\`
`;
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: agentOutput, duration: 3000 });

    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    // Invalid verdict "DEFINITELY_MET" should be normalized to "unclear"
    const invalidFinding = result.parsed.findings.find((f) => f.issueNum === 10);
    expect(invalidFinding?.verdict).toBe('unclear');

    // Valid verdict "met" should be preserved
    const validFinding = result.parsed.findings.find((f) => f.issueNum === 11);
    expect(validFinding?.verdict).toBe('met');
  });

  test('returns DEFAULT_VERDICT when agent call throws', async () => {
    mockSpawnAgent.mockRejectedValue(new Error('Agent process crashed'));

    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    expect(result.verdict).toBe('partial');
    expect(result.parsed.summary).toContain('could not be parsed');
  });

  test('returns DEFAULT_VERDICT when agent output contains invalid JSON', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: '```json\n{ "verdict": "pass", INVALID JSON }\n```',
      duration: 2000,
    });

    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    expect(result.verdict).toBe('partial');
    expect(result.parsed.findings).toHaveLength(0);
  });

  test('picks up the last json fence when multiple fences appear in output', async () => {
    const agentOutput = `
First fence (should be ignored):
\`\`\`json
{ "verdict": "fail", "summary": "Draft", "findings": [] }
\`\`\`

Final fence (authoritative):
\`\`\`json
{ "verdict": "pass", "summary": "Authoritative result.", "findings": [] }
\`\`\`
`;
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: agentOutput, duration: 3000 });

    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    expect(result.verdict).toBe('pass');
    expect(result.parsed.summary).toBe('Authoritative result.');
  });

  test('formats comment with sub-issue table', async () => {
    const agentOutput = `
\`\`\`json
{
  "verdict": "pass",
  "summary": "All done.",
  "findings": [
    { "issueNum": 10, "criterion": "Routing works", "verdict": "met" },
    { "issueNum": 11, "criterion": "Auth works", "verdict": "met" }
  ]
}
\`\`\`
`;
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: agentOutput, duration: 3000 });

    const result = await verifyEpic(makeInput(), makeConfig(), STUB_LOGS_DIR);

    expect(result.comment).toContain('## Epic Verification');
    expect(result.comment).toContain('#10');
    expect(result.comment).toContain('#11');
    expect(result.comment).toContain('PASS');
  });

  test('uses reviewModel when set in config', async () => {
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: '```json\n{"verdict":"pass","summary":"ok","findings":[]}\n```', duration: 1000 });

    await verifyEpic(makeInput(), makeConfig({ reviewModel: 'sonnet' }), STUB_LOGS_DIR);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'sonnet' }),
    );
  });

  test('falls back to config.model when reviewModel is not set', async () => {
    mockSpawnAgent.mockResolvedValue({ exitCode: 0, output: '```json\n{"verdict":"pass","summary":"ok","findings":[]}\n```', duration: 1000 });

    await verifyEpic(makeInput(), makeConfig({ reviewModel: '', model: 'haiku' }), STUB_LOGS_DIR);

    expect(mockSpawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'haiku' }),
    );
  });
});
