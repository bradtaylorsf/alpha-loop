import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Must mock before importing
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

import { loadConfig, detectRepo, estimateCost, resolveStepConfig } from '../../src/lib/config.js';
import type { Config, PipelineConfig } from '../../src/lib/config.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-test-'));
  process.chdir(tempDir);
  // Reset env vars that could interfere
  // Clear all env vars that map to config keys
  for (const key of [
    'REPO', 'MODEL', 'PROJECT', 'AGENT', 'DRY_RUN',
    'REVIEW_MODEL', 'POLL_INTERVAL', 'BASE_BRANCH', 'LOG_DIR',
    'LABEL_READY', 'MAX_TEST_RETRIES', 'TEST_COMMAND', 'DEV_COMMAND',
    'SKIP_TESTS', 'SKIP_REVIEW', 'SKIP_INSTALL', 'SKIP_PREFLIGHT',
    'SKIP_VERIFY', 'SKIP_LEARN', 'SKIP_E2E', 'AUTO_MERGE', 'MERGE_TO',
    'AUTO_CLEANUP', 'RUN_FULL',
  ]) {
    delete process.env[key];
  }
  // Default: no git remote
  mockedExecSync.mockImplementation(() => {
    throw new Error('not a git repo');
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('detectRepo', () => {
  it('parses HTTPS remote URL', () => {
    mockedExecSync.mockReturnValue('https://github.com/owner/repo.git\n');
    expect(detectRepo()).toBe('owner/repo');
  });

  it('parses SSH remote URL', () => {
    mockedExecSync.mockReturnValue('git@github.com:myorg/my-repo.git\n');
    expect(detectRepo()).toBe('myorg/my-repo');
  });

  it('returns null when not in a git repo', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(detectRepo()).toBeNull();
  });

  it('returns null for non-GitHub remotes', () => {
    mockedExecSync.mockReturnValue('https://gitlab.com/owner/repo.git\n');
    expect(detectRepo()).toBeNull();
  });
});

describe('loadConfig', () => {
  it('loads config from .alpha-loop.yaml', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: testowner/testrepo
project: 5
model: sonnet
review_model: haiku
label: todo
base_branch: main
test_command: npm test
`,
    );

    const config = loadConfig();
    expect(config.repo).toBe('testowner/testrepo');
    expect(config.repoOwner).toBe('testowner');
    expect(config.project).toBe(5);
    expect(config.model).toBe('sonnet');
    expect(config.reviewModel).toBe('haiku');
    expect(config.labelReady).toBe('todo');
    expect(config.baseBranch).toBe('main');
    expect(config.testCommand).toBe('npm test');
  });

  it('applies env var overrides over config file', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: fileowner/filerepo
model: opus
max_test_retries: 5
`,
    );

    process.env.MODEL = 'sonnet';

    const config = loadConfig();
    expect(config.repo).toBe('fileowner/filerepo');
    expect(config.model).toBe('sonnet');
    expect(config.maxTestRetries).toBe(5);
  });

  it('returns defaults when no config file exists', () => {
    const config = loadConfig();
    expect(config.agent).toBe('claude');
    expect(config.model).toBe('');
    expect(config.pollInterval).toBe(60);
    expect(config.baseBranch).toBe('master');
    expect(config.labelReady).toBe('ready');
    expect(config.maxTestRetries).toBe(3);
    expect(config.dryRun).toBe(false);
    expect(config.skipTests).toBe(false);
    expect(config.autoMerge).toBe(true);
    expect(config.autoCleanup).toBe(true);
  });

  it('loads agent from config file', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
agent: codex
model: gpt-5.4
`,
    );

    const config = loadConfig();
    expect(config.agent).toBe('codex');
    expect(config.model).toBe('gpt-5.4');
  });

  it('loads agent from AGENT env var', () => {
    process.env.AGENT = 'codex';
    const config = loadConfig();
    expect(config.agent).toBe('codex');
  });

  it('loads project from PROJECT env var', () => {
    process.env.PROJECT = '5';
    const config = loadConfig();
    expect(config.project).toBe(5);
  });

  it('applies CLI overrides with highest priority', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `model: sonnet
`,
    );
    process.env.MODEL = 'haiku';

    const config = loadConfig({ model: 'opus' });
    expect(config.model).toBe('opus');
  });

  it('auto-detects repo from git remote when not in config or env', () => {
    mockedExecSync.mockReturnValue('https://github.com/auto/detected.git\n');

    const config = loadConfig();
    expect(config.repo).toBe('auto/detected');
    expect(config.repoOwner).toBe('auto');
  });

  it('config file takes precedence over auto-detected repo', () => {
    mockedExecSync.mockReturnValue('https://github.com/auto/detected.git\n');
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: explicit/repo
`,
    );

    const config = loadConfig();
    expect(config.repo).toBe('explicit/repo');
  });

  it('includes default pricing table', () => {
    const config = loadConfig();
    expect(config.pricing).toBeDefined();
    expect(config.pricing['claude-opus-4-6']).toEqual({ input: 15.0, output: 75.0 });
    expect(config.pricing['claude-sonnet-4-6']).toEqual({ input: 3.0, output: 15.0 });
    expect(config.pricing['claude-haiku-4-5']).toEqual({ input: 0.80, output: 4.0 });
  });

  it('loads pricing from YAML config', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
pricing:
  custom-model:
    input: 5.0
    output: 25.0
`,
    );

    const config = loadConfig();
    expect(config.pricing['custom-model']).toEqual({ input: 5.0, output: 25.0 });
    // Defaults are still present (merged)
    expect(config.pricing['claude-opus-4-6']).toEqual({ input: 15.0, output: 75.0 });
  });

  it('YAML pricing overrides defaults for same model', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
pricing:
  claude-opus-4-6:
    input: 20.0
    output: 100.0
`,
    );

    const config = loadConfig();
    expect(config.pricing['claude-opus-4-6']).toEqual({ input: 20.0, output: 100.0 });
  });

  it('includes expanded default pricing table', () => {
    const config = loadConfig();
    expect(config.pricing['gpt-4o']).toEqual({ input: 2.50, output: 10.0 });
    expect(config.pricing['gpt-4o-mini']).toEqual({ input: 0.15, output: 0.60 });
    expect(config.pricing['deepseek-v3']).toEqual({ input: 0.27, output: 1.10 });
    expect(config.pricing['gemini-2.5-flash']).toEqual({ input: 0.15, output: 0.60 });
  });

  it('loads pipeline config from YAML', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
pipeline:
  plan:
    agent: claude
    model: claude-haiku-4-5
  implement:
    model: claude-sonnet-4-6
  review:
    model: claude-haiku-4-5
`,
    );

    const config = loadConfig();
    expect(config.pipeline.plan).toEqual({ agent: 'claude', model: 'claude-haiku-4-5' });
    expect(config.pipeline.implement).toEqual({ model: 'claude-sonnet-4-6' });
    expect(config.pipeline.review).toEqual({ model: 'claude-haiku-4-5' });
    expect(config.pipeline.verify).toBeUndefined();
  });

  it('merges pipeline overrides with YAML pipeline', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
pipeline:
  plan:
    model: claude-haiku-4-5
  review:
    model: claude-haiku-4-5
`,
    );

    const config = loadConfig({
      pipeline: {
        plan: { model: 'claude-opus-4-6' },
        implement: { model: 'claude-sonnet-4-6' },
      },
    });
    expect(config.pipeline.plan?.model).toBe('claude-opus-4-6');
    expect(config.pipeline.review?.model).toBe('claude-haiku-4-5');
    expect(config.pipeline.implement?.model).toBe('claude-sonnet-4-6');
  });

  it('defaults pipeline to empty object', () => {
    const config = loadConfig();
    expect(config.pipeline).toEqual({});
  });

  it('ignores invalid pipeline step names in YAML', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
pipeline:
  invalid_step:
    model: claude-haiku-4-5
  plan:
    model: claude-haiku-4-5
`,
    );

    const config = loadConfig();
    expect(config.pipeline.plan).toEqual({ model: 'claude-haiku-4-5' });
    expect((config.pipeline as any).invalid_step).toBeUndefined();
  });
});

describe('resolveStepConfig', () => {
  it('returns top-level agent/model when no pipeline overrides', () => {
    const config = loadConfig({ agent: 'claude', model: 'claude-sonnet-4-6' });
    const resolved = resolveStepConfig(config, 'implement');
    expect(resolved.agent).toBe('claude');
    expect(resolved.model).toBe('claude-sonnet-4-6');
  });

  it('returns pipeline override when set', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
agent: claude
model: claude-sonnet-4-6
pipeline:
  plan:
    model: claude-haiku-4-5
`,
    );
    const config = loadConfig();
    const plan = resolveStepConfig(config, 'plan');
    expect(plan.model).toBe('claude-haiku-4-5');
    expect(plan.agent).toBe('claude');

    const impl = resolveStepConfig(config, 'implement');
    expect(impl.model).toBe('claude-sonnet-4-6');
  });

  it('uses reviewModel as fallback for review step', () => {
    const config = loadConfig({ model: 'claude-sonnet-4-6', reviewModel: 'claude-haiku-4-5' });
    const resolved = resolveStepConfig(config, 'review');
    expect(resolved.model).toBe('claude-haiku-4-5');
  });

  it('pipeline override takes precedence over reviewModel for review', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
model: claude-sonnet-4-6
review_model: claude-haiku-4-5
pipeline:
  review:
    model: claude-opus-4-6
`,
    );
    const config = loadConfig();
    const resolved = resolveStepConfig(config, 'review');
    expect(resolved.model).toBe('claude-opus-4-6');
  });

  it('returns pipeline agent override', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
agent: claude
pipeline:
  implement:
    agent: codex
    model: gpt-4o
`,
    );
    const config = loadConfig();
    const resolved = resolveStepConfig(config, 'implement');
    expect(resolved.agent).toBe('codex');
    expect(resolved.model).toBe('gpt-4o');
  });
});

describe('estimateCost', () => {
  const pricing = {
    'claude-opus-4-6': { input: 15.0, output: 75.0 },
    'claude-haiku-4-5': { input: 0.80, output: 4.0 },
  };

  it('calculates cost correctly', () => {
    const cost = estimateCost('claude-opus-4-6', 1_000_000, 1_000_000, pricing);
    expect(cost).toBe(90.0); // 15 + 75
  });

  it('returns 0 for unknown model', () => {
    const cost = estimateCost('unknown-model', 10000, 5000, pricing);
    expect(cost).toBe(0);
  });

  it('handles zero tokens', () => {
    const cost = estimateCost('claude-opus-4-6', 0, 0, pricing);
    expect(cost).toBe(0);
  });

  it('calculates fractional costs', () => {
    // 10K input tokens at $15/M = $0.15
    // 3K output tokens at $75/M = $0.225
    const cost = estimateCost('claude-opus-4-6', 10000, 3000, pricing);
    expect(cost).toBeCloseTo(0.375, 3);
  });
});
