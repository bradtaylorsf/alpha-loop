/**
 * Integration tests for eval-runner: runEvalSuite and runStepEval orchestration.
 *
 * Mocks spawnAgent to verify cost accumulation, check execution, and overall flow.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import { runEvalSuite } from '../../src/lib/eval-runner.js';
import type { EvalCaseWithChecks } from '../../src/lib/eval-runner.js';
import type { Config } from '../../src/lib/config.js';
import type { AgentResult } from '../../src/lib/agent.js';

// Mock spawnAgent to return controlled results
const mockSpawnAgent = jest.fn<Promise<AgentResult>, [unknown]>();
jest.mock('../../src/lib/agent.js', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(args[0]),
}));

// Mock processIssue (for e2e evals) — not directly tested here
jest.mock('../../src/lib/pipeline.js', () => ({
  processIssue: jest.fn(),
}));

// Mock traces to avoid filesystem side effects
jest.mock('../../src/lib/traces.js', () => ({
  writeConfigSnapshot: jest.fn(),
  writeTraceScores: jest.fn(),
  writeScores: jest.fn(),
  computeScores: jest.fn().mockReturnValue({ composite_score: 0, issues: {}, aggregate: {} }),
  writeRunManifest: jest.fn(),
}));

// Mock score.appendScore to avoid writing to real filesystem
const mockAppendScore = jest.fn();
jest.mock('../../src/lib/score.js', () => {
  const actual = jest.requireActual('../../src/lib/score.js');
  return {
    ...actual,
    appendScore: (...args: unknown[]) => mockAppendScore(...args),
  };
});

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-runner-int-'));
  mockSpawnAgent.mockReset();
  mockAppendScore.mockReset();
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const makeConfig = (overrides?: Partial<Config>): Config => ({
  agent: 'claude',
  model: 'claude-sonnet-4-6',
  reviewModel: '',
  maxTestRetries: 2,
  testCommand: 'npm test',
  baseBranch: 'main',
  repo: 'test/repo',
  project: 'test',
  logDir: '.alpha-loop/logs',
  autoMerge: false,
  verbose: false,
  skipTests: false,
  skipReview: false,
  skipVerify: true,
  evalDir: '.alpha-loop/evals',
  evalModel: '',
  skipEval: false,
  evalTimeout: 300,
  autoCapture: true,
  skipPostSessionReview: false,
  skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
  pricing: {
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  },
  pipeline: {},
  ...overrides,
} as Config);

const makeStepCase = (overrides?: Partial<EvalCaseWithChecks>): EvalCaseWithChecks => ({
  id: 'test-step-001',
  description: 'Test step case',
  type: 'step',
  step: 'review',
  fixtureRepo: '',
  fixtureRef: 'main',
  issueTitle: 'Test issue',
  issueBody: 'Test body',
  inputText: 'Review this diff:\n```diff\n-old\n+new\n```',
  expected: { success: true },
  tags: ['test'],
  timeout: 30,
  source: 'manual',
  checks: [
    { type: 'keyword_present', keywords: ['approved'] },
  ],
  ...overrides,
});

describe('runEvalSuite integration', () => {
  it('accumulates real costs from agent results', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'Code review: approved. The changes look good.',
      duration: 5000,
      costUsd: 0.0042,
      inputTokens: 1500,
      outputTokens: 200,
      model: 'claude-sonnet-4-6',
    });

    const cases = [
      makeStepCase({ id: 'cost-case-1' }),
      makeStepCase({ id: 'cost-case-2' }),
    ];

    const result = await runEvalSuite(cases, makeConfig());

    expect(result.totalCost).toBeCloseTo(0.0084); // 2 * 0.0042
    expect(result.cases).toHaveLength(2);

    // Verify the score entry written to history includes real cost
    expect(mockAppendScore).toHaveBeenCalledTimes(1);
    const scoreEntry = mockAppendScore.mock.calls[0][1];
    expect(scoreEntry.totalCost).toBeCloseTo(0.0084);
  });

  it('handles cases where agent returns no cost data', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'approved changes look good',
      duration: 3000,
      // No costUsd, inputTokens, outputTokens
    });

    const result = await runEvalSuite([makeStepCase()], makeConfig());

    expect(result.totalCost).toBe(0);
    expect(result.cases[0].costUsd).toBeUndefined();
  });

  it('runs keyword_present checks against agent output', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'I have reviewed the code and approved the changes.',
      duration: 2000,
      costUsd: 0.001,
    });

    const result = await runEvalSuite([makeStepCase()], makeConfig());

    expect(result.cases[0].passed).toBe(true);
    expect(result.cases[0].partialCredit).toBe(1);
  });

  it('fails keyword_present checks when keywords are missing', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'The code has some issues that need to be fixed.',
      duration: 2000,
      costUsd: 0.001,
    });

    const result = await runEvalSuite([makeStepCase()], makeConfig());

    expect(result.cases[0].passed).toBe(false);
    expect(result.cases[0].partialCredit).toBe(0); // 0/1 keywords found
  });

  it('filters cases by caseId prefix', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'approved',
      duration: 1000,
    });

    const cases = [
      makeStepCase({ id: 'alpha-001' }),
      makeStepCase({ id: 'beta-001' }),
      makeStepCase({ id: 'alpha-002' }),
    ];

    const result = await runEvalSuite(cases, makeConfig(), { caseId: 'alpha' });

    // Only alpha-* cases should have been run (spawnAgent called twice)
    expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
    expect(result.cases).toHaveLength(2);
    expect(result.cases.map((c) => c.caseId)).toEqual(['alpha-001', 'alpha-002']);
  });

  it('handles agent crash gracefully', async () => {
    mockSpawnAgent.mockRejectedValue(new Error('Agent process crashed'));

    const result = await runEvalSuite([makeStepCase()], makeConfig());

    // Agent crash is caught internally — case fails but suite doesn't crash
    expect(result.cases[0].passed).toBe(false);
    expect(result.passCount).toBe(0);
    expect(result.failCount).toBe(1);
  });

  it('computes composite score correctly', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'approved',
      duration: 10000, // 10s
    });

    const cases = [
      makeStepCase({ id: 'pass-1' }),
      makeStepCase({ id: 'pass-2' }),
    ];

    const result = await runEvalSuite(cases, makeConfig());

    // 2/2 passing = 100, minus duration penalty
    expect(result.composite).toBeLessThanOrEqual(100);
    expect(result.composite).toBeGreaterThan(90);
    expect(result.passCount).toBe(2);
    expect(result.failCount).toBe(0);
  });

  it('routes plan step to correct prompt builder', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'Plan: implement the feature by modifying src/api.ts',
      duration: 2000,
      costUsd: 0.002,
      inputTokens: 500,
      outputTokens: 100,
    });

    const planCase = makeStepCase({
      id: 'plan-case',
      step: 'plan',
      checks: [{ type: 'keyword_present', keywords: ['Plan'] }],
    });

    const result = await runEvalSuite([planCase], makeConfig());

    expect(result.cases[0].passed).toBe(true);
    expect(result.cases[0].costUsd).toBeCloseTo(0.002);
    expect(result.cases[0].inputTokens).toBe(500);
    expect(result.cases[0].outputTokens).toBe(100);

    // Verify spawnAgent was called with plan-related prompt
    const callArgs = mockSpawnAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(String(callArgs.prompt)).toContain('Plan the implementation');
  });

  it('uses pipeline config overrides for model selection', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'approved',
      duration: 1000,
    });

    const config = makeConfig({
      pipeline: {
        review: { model: 'claude-haiku-4-5' },
      },
    });

    await runEvalSuite([makeStepCase()], config);

    const callArgs = mockSpawnAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs.model).toBe('claude-haiku-4-5');
  });

  it('falls back to legacy outputContains when no checks defined', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'The result contains expected_keyword in the output',
      duration: 1000,
    });

    const legacyCase = makeStepCase({
      id: 'legacy-case',
      checks: undefined,
      expected: {
        success: true,
        outputContains: ['expected_keyword'],
      },
    });

    const result = await runEvalSuite([legacyCase], makeConfig());
    expect(result.cases[0].passed).toBe(true);
  });

  it('fails legacy outputContains when keyword missing', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'The result does not have what we need',
      duration: 1000,
    });

    const legacyCase = makeStepCase({
      id: 'legacy-fail',
      checks: undefined,
      expected: {
        success: true,
        outputContains: ['missing_keyword'],
      },
    });

    const result = await runEvalSuite([legacyCase], makeConfig());
    expect(result.cases[0].passed).toBe(false);
  });

  it('supports contains_any check type', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'The function returns a Promise<string>',
      duration: 1000,
      costUsd: 0.001,
    });

    const caseWithContainsAny = makeStepCase({
      id: 'contains-any',
      checks: [{ type: 'contains_any', values: ['Promise', 'Observable', 'Stream'] }],
    });

    const result = await runEvalSuite([caseWithContainsAny], makeConfig());
    expect(result.cases[0].passed).toBe(true);
  });

  it('supports not_contains check type', async () => {
    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: 'Clean implementation with no issues',
      duration: 1000,
    });

    const caseWithNotContains = makeStepCase({
      id: 'not-contains',
      checks: [{ type: 'not_contains', values: ['TODO', 'FIXME', 'HACK'] }],
    });

    const result = await runEvalSuite([caseWithNotContains], makeConfig());
    expect(result.cases[0].passed).toBe(true);
  });

  it('mixed pass/fail cases produce correct summary', async () => {
    let callCount = 0;
    mockSpawnAgent.mockImplementation(async () => {
      callCount++;
      return {
        exitCode: 0,
        output: callCount === 1 ? 'approved' : 'needs changes',
        duration: 5000,
        costUsd: callCount === 1 ? 0.003 : 0.005,
        inputTokens: 1000,
        outputTokens: callCount === 1 ? 100 : 200,
      };
    });

    const cases = [
      makeStepCase({ id: 'pass-case' }),
      makeStepCase({ id: 'fail-case' }),
    ];

    const result = await runEvalSuite(cases, makeConfig());

    expect(result.passCount).toBe(1);
    expect(result.failCount).toBe(1);
    expect(result.totalCost).toBeCloseTo(0.008);
    // 1/2 passing = 50, minus penalties
    expect(result.composite).toBeLessThan(55);
    expect(result.composite).toBeGreaterThan(40);
  });
});
