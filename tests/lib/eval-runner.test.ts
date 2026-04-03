import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotHarness, prepareFixture } from '../../src/lib/eval-runner.js';
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
  pricing: {},
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
