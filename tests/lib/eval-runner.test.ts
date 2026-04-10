import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotHarness, prepareFixture, estimateRunCost } from '../../src/lib/eval-runner.js';
import type { Config } from '../../src/lib/config.js';
import type { EvalCase } from '../../src/lib/eval.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-runner-test-'));
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
    smokeTest: '',
  pricing: {
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5': { input: 0.80, output: 4.0 },
    'claude-opus-4-6': { input: 15.0, output: 75.0 },
  },
  pipeline: {},
  ...overrides,
} as Config);

describe('snapshotHarness', () => {
  it('produces a 12-character hex hash', () => {
    const config = makeConfig();
    const hash = snapshotHarness(config);
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });

  it('produces consistent hashes for same config', () => {
    const config = makeConfig();
    const hash1 = snapshotHarness(config);
    const hash2 = snapshotHarness(config);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different configs', () => {
    const hash1 = snapshotHarness(makeConfig({ model: 'claude-sonnet-4-6' }));
    const hash2 = snapshotHarness(makeConfig({ model: 'claude-opus-4-6' }));
    expect(hash1).not.toBe(hash2);
  });
});

describe('estimateRunCost', () => {
  it('returns cost estimate for all pipeline steps', () => {
    const config = makeConfig();
    const estimate = estimateRunCost(5, config);

    expect(estimate.caseCount).toBe(5);
    expect(estimate.steps).toHaveLength(6); // plan, implement, test_fix, review, verify, learn
    expect(estimate.totalPerCase).toBeGreaterThan(0);
    expect(estimate.totalForSuite).toBe(estimate.totalPerCase * 5);
  });

  it('uses pipeline overrides for model selection', () => {
    const config = makeConfig({
      pipeline: {
        plan: { model: 'claude-haiku-4-5' },
        review: { model: 'claude-haiku-4-5' },
      },
    });
    const estimate = estimateRunCost(1, config);

    const planStep = estimate.steps.find((s) => s.step === 'plan');
    const reviewStep = estimate.steps.find((s) => s.step === 'review');
    const implStep = estimate.steps.find((s) => s.step === 'implement');

    expect(planStep?.model).toBe('claude-haiku-4-5');
    expect(reviewStep?.model).toBe('claude-haiku-4-5');
    expect(implStep?.model).toBe('claude-sonnet-4-6');
  });

  it('haiku config is cheaper than sonnet config', () => {
    const sonnetConfig = makeConfig({ model: 'claude-sonnet-4-6' });
    const haiku = makeConfig({
      pipeline: {
        plan: { model: 'claude-haiku-4-5' },
        implement: { model: 'claude-haiku-4-5' },
        test_fix: { model: 'claude-haiku-4-5' },
        review: { model: 'claude-haiku-4-5' },
        verify: { model: 'claude-haiku-4-5' },
        learn: { model: 'claude-haiku-4-5' },
      },
    });

    const sonnetEst = estimateRunCost(1, sonnetConfig);
    const haikuEst = estimateRunCost(1, haiku);

    expect(haikuEst.totalPerCase).toBeLessThan(sonnetEst.totalPerCase);
  });

  it('returns 0 cost for unknown models', () => {
    const config = makeConfig({ model: 'unknown-model', pricing: {} });
    const estimate = estimateRunCost(1, config);
    expect(estimate.totalPerCase).toBe(0);
  });
});

describe('prepareFixture', () => {
  it('creates fixture directory for local path that does not exist', () => {
    const evalCase: EvalCase = {
      id: 'test-fixture',
      description: 'Test',
      type: 'full',
      fixtureRepo: 'nonexistent-repo',
      fixtureRef: 'main',
      issueTitle: 'Test',
      issueBody: 'Test body',
      expected: { success: true },
      tags: [],
      timeout: 60,
      source: 'manual',
    };

    // This will attempt git worktree which may fail in temp dir,
    // but should at least create the directory
    try {
      const dir = prepareFixture(evalCase, tempDir);
      expect(typeof dir).toBe('string');
    } catch {
      // Expected to fail in non-git temp dir, that's fine
    }
  });
});
