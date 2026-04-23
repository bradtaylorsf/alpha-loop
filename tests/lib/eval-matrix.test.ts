import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runMatrix,
  loadProfileOverrides,
  applyProfileToConfig,
  aggregateTotals,
  computeDeltas,
  diffSimilarity,
  isStubPatch,
  profileDisplayName,
  toMatrixEntries,
} from '../../src/lib/eval-matrix.js';
import type { Config } from '../../src/lib/config.js';
import type { EvalSuiteResult, EvalResult } from '../../src/lib/eval.js';
import type { EvalCaseWithChecks } from '../../src/lib/eval-runner.js';

const makeConfig = (): Config => ({
  repo: 'test/repo',
  repoOwner: 'test',
  project: 2,
  agent: 'claude',
  model: 'claude-sonnet-4-6',
  reviewModel: 'claude-opus-4-6',
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
  maxIssues: 0,
  maxSessionDuration: 0,
  milestone: '',
  autoMerge: false,
  mergeTo: '',
  autoCleanup: true,
  runFull: false,
  verbose: false,
  harnesses: [],
  setupCommand: '',
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
  agentTimeout: 1800,
  pricing: {},
  pipeline: {},
  evalIncludeAgentPrompts: true,
  evalIncludeSkills: true,
  preferEpics: false,
} as Config);

const makeCase = (id: string, description = id): EvalCaseWithChecks => ({
  id,
  description,
  type: 'full',
  fixtureRepo: '',
  fixtureRef: 'main',
  issueTitle: description,
  issueBody: '',
  expected: { success: true },
  tags: ['routing-regression'],
  timeout: 0,
  source: 'routing-regression',
});

const makeResult = (caseId: string, passed: boolean, costUsd: number, duration = 10): EvalResult => ({
  caseId,
  passed,
  partialCredit: passed ? 1 : 0,
  retries: 0,
  duration,
  costUsd,
  details: {
    successMatch: passed,
    filesMatch: passed,
    testsMatch: passed,
    diffMatch: passed,
    outputMatch: passed,
  },
});

const makeSuiteResult = (cases: EvalResult[]): EvalSuiteResult => ({
  cases,
  composite: 0,
  totalDuration: cases.reduce((s, c) => s + c.duration, 0),
  totalCost: cases.reduce((s, c) => s + (c.costUsd ?? 0), 0),
  passCount: cases.filter((c) => c.passed).length,
  failCount: cases.filter((c) => !c.passed).length,
});

describe('profileDisplayName', () => {
  it('returns bare names unchanged', () => {
    expect(profileDisplayName('hybrid-v1')).toBe('hybrid-v1');
  });

  it('strips directory + extension from paths', () => {
    expect(profileDisplayName('/tmp/profiles/hybrid-v1.yaml')).toBe('hybrid-v1');
    expect(profileDisplayName('./hybrid-v1.yml')).toBe('hybrid-v1');
  });
});

describe('loadProfileOverrides', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-matrix-'));
    mkdirSync(join(tempDir, '.alpha-loop', 'evals', 'profiles'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('loads agent, model, review_model, and pipeline overrides from YAML', () => {
    const profilePath = join(tempDir, '.alpha-loop', 'evals', 'profiles', 'hybrid-v1.yaml');
    writeFileSync(profilePath, `agent: claude
model: claude-sonnet-4-6
review_model: claude-opus-4-6
pipeline:
  implement:
    agent: lmstudio
    model: qwen3-coder-30b
  review:
    model: claude-opus-4-6
`);
    const overrides = loadProfileOverrides(profilePath);
    expect(overrides.agent).toBe('claude');
    expect(overrides.model).toBe('claude-sonnet-4-6');
    expect(overrides.reviewModel).toBe('claude-opus-4-6');
    expect(overrides.pipeline?.implement).toEqual({ agent: 'lmstudio', model: 'qwen3-coder-30b' });
    expect(overrides.pipeline?.review).toEqual({ model: 'claude-opus-4-6' });
  });

  it('throws a clear error when the profile file is missing', () => {
    expect(() => loadProfileOverrides(join(tempDir, 'nope.yaml'))).toThrow(/not found/);
  });
});

describe('applyProfileToConfig', () => {
  it('merges pipeline overrides per-step without dropping base entries', () => {
    const base = makeConfig();
    base.pipeline = { plan: { model: 'claude-sonnet-4-6' } };
    const merged = applyProfileToConfig(base, {
      pipeline: { implement: { model: 'qwen3-coder-30b' } },
    });
    expect(merged.pipeline.plan).toEqual({ model: 'claude-sonnet-4-6' });
    expect(merged.pipeline.implement).toEqual({ model: 'qwen3-coder-30b' });
  });

  it('replaces top-level fields when overridden', () => {
    const merged = applyProfileToConfig(makeConfig(), { model: 'claude-opus-4-6' });
    expect(merged.model).toBe('claude-opus-4-6');
  });
});

describe('toMatrixEntries + aggregateTotals', () => {
  it('aggregates case costs and pass counts into totals', () => {
    const suite = makeSuiteResult([
      makeResult('001', true, 1.5, 12),
      makeResult('002', false, 2.0, 20),
      makeResult('003', true, 0.5, 8),
    ]);
    const entries = toMatrixEntries(suite);
    const totals = aggregateTotals('hybrid-v1', entries);
    expect(totals.caseCount).toBe(3);
    expect(totals.passCount).toBe(2);
    expect(totals.passRate).toBeCloseTo(2 / 3, 5);
    expect(totals.totalCostUsd).toBeCloseTo(4.0, 5);
    expect(totals.meanWallTimeS).toBeCloseTo((12 + 20 + 8) / 3, 5);
  });
});

describe('computeDeltas', () => {
  it('computes pass-rate and cost-per-issue deltas vs baseline', () => {
    const totals = [
      { profile: 'all-frontier', caseCount: 10, passCount: 10, passRate: 1, totalCostUsd: 20, meanWallTimeS: 30, meanToolErrorRate: 0 },
      { profile: 'hybrid-v1', caseCount: 10, passCount: 9, passRate: 0.9, totalCostUsd: 8, meanWallTimeS: 45, meanToolErrorRate: 0 },
    ];
    const deltas = computeDeltas(totals, 'all-frontier');
    expect(deltas['all-frontier']).toEqual({ pipelineSuccessDelta: 0, costPerIssueDelta: 0 });
    expect(deltas['hybrid-v1'].pipelineSuccessDelta).toBeCloseTo(-0.1, 5);
    expect(deltas['hybrid-v1'].costPerIssueDelta).toBeCloseTo(-1.2, 5);
  });

  it('returns empty when baseline profile missing', () => {
    const deltas = computeDeltas([], 'all-frontier');
    expect(deltas).toEqual({});
  });
});

describe('diffSimilarity', () => {
  it('returns 1 for identical diffs', () => {
    const diff = 'diff --git a/x b/x\n+hello\n+world';
    expect(diffSimilarity(diff, diff)).toBe(1);
  });

  it('returns 0 for completely different diffs', () => {
    expect(diffSimilarity('+foo', '+bar')).toBe(0);
  });

  it('ignores diff headers', () => {
    expect(diffSimilarity('diff --git a/x b/x\n+foo', 'diff --git a/y b/y\n+foo')).toBe(1);
  });

  it('handles partial overlap via Jaccard', () => {
    const a = '+a\n+b\n+c';
    const b = '+b\n+c\n+d';
    // Overlap {b,c}, union {a,b,c,d}, similarity = 2/4 = 0.5
    expect(diffSimilarity(a, b)).toBeCloseTo(0.5, 5);
  });
});

describe('isStubPatch', () => {
  it('detects TODO-only patches', () => {
    expect(isStubPatch('# TODO: backfill — run gh pr diff 177')).toBe(true);
  });

  it('treats whitespace-only as stub', () => {
    expect(isStubPatch('\n\n')).toBe(true);
  });

  it('real diff is not a stub', () => {
    expect(isStubPatch('diff --git a/x b/x\n+hello')).toBe(false);
  });
});

describe('runMatrix', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-matrix-'));
    const profilesDir = join(tempDir, '.alpha-loop', 'evals', 'profiles');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, 'all-frontier.yaml'), 'agent: claude\nmodel: claude-sonnet-4-6\n');
    writeFileSync(join(profilesDir, 'hybrid-v1.yaml'), 'agent: claude\nmodel: claude-sonnet-4-6\npipeline:\n  implement:\n    agent: lmstudio\n    model: qwen3-coder-30b\n');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.chdir(originalCwd);
  });

  const originalCwd = process.cwd();

  it('runs every profile × every case and aggregates totals + deltas', async () => {
    process.chdir(tempDir);
    const cases = [makeCase('001'), makeCase('002'), makeCase('003')];

    // Injected runner returns different numbers per profile so we can
    // verify the plumbing without spinning up any real agents.
    const stubRunner = jest.fn().mockImplementation(async (_cases, config: Config) => {
      const usesLocal = config.pipeline?.implement?.agent === 'lmstudio';
      if (usesLocal) {
        return makeSuiteResult([
          makeResult('001', true, 0.30, 45),
          makeResult('002', false, 0.30, 50),
          makeResult('003', true, 0.30, 40),
        ]);
      }
      return makeSuiteResult([
        makeResult('001', true, 1.50, 20),
        makeResult('002', true, 1.60, 22),
        makeResult('003', true, 1.40, 18),
      ]);
    });

    const baseConfig = makeConfig();
    const result = await runMatrix(
      cases,
      { profiles: ['all-frontier', 'hybrid-v1'], baseline: 'all-frontier', dryRun: false },
      baseConfig,
      stubRunner,
    );

    expect(stubRunner).toHaveBeenCalledTimes(2);
    expect(result.profiles).toEqual(['all-frontier', 'hybrid-v1']);
    expect(result.cases).toHaveLength(3);

    const frontierTotals = result.totals.find((t) => t.profile === 'all-frontier')!;
    const hybridTotals = result.totals.find((t) => t.profile === 'hybrid-v1')!;
    expect(frontierTotals.passCount).toBe(3);
    expect(hybridTotals.passCount).toBe(2);

    expect(result.deltas['hybrid-v1'].pipelineSuccessDelta).toBeCloseTo(-1 / 3, 5);
    expect(result.deltas['hybrid-v1'].costPerIssueDelta).toBeLessThan(0);

    // Per-case cells present for every profile
    for (const caseRow of result.cases) {
      expect(Object.keys(caseRow.perProfile).sort()).toEqual(['all-frontier', 'hybrid-v1']);
    }
  });

  it('throws when given no profiles', async () => {
    await expect(
      runMatrix([makeCase('001')], { profiles: [] }, makeConfig(), jest.fn()),
    ).rejects.toThrow(/at least one profile/);
  });

  it('dry-run skips the runner and marks every entry as skipped', async () => {
    process.chdir(tempDir);
    const cases = [makeCase('001'), makeCase('002')];
    const runner = jest.fn();

    const result = await runMatrix(
      cases,
      { profiles: ['all-frontier', 'hybrid-v1'], baseline: 'all-frontier', dryRun: true },
      makeConfig(),
      runner,
    );

    expect(runner).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    for (const caseRow of result.cases) {
      for (const profile of result.profiles) {
        expect(caseRow.perProfile[profile].skipped).toBe(true);
        expect(caseRow.perProfile[profile].passed).toBe(false);
        expect(caseRow.perProfile[profile].costUsd).toBe(0);
      }
    }
    for (const t of result.totals) {
      expect(t.passCount).toBe(0);
      expect(t.totalCostUsd).toBe(0);
      expect(t.caseCount).toBe(2);
    }
  });
});
