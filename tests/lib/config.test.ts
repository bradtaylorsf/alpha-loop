import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

// Must mock before importing
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

import {
  loadConfig,
  detectRepo,
  estimateCost,
  resolveStepConfig,
  resolveRoutingStage,
  selectRoutingProfile,
  getFallbackPolicy,
  DEFAULT_ESCALATION_WINDOW,
  DEFAULT_ESCALATION_ERROR_THRESHOLD,
  DEFAULT_ESCALATION_REVERT_MS,
} from '../../src/lib/config.js';
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

  it('accepts agent: lmstudio (single-agent local mode)', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
agent: lmstudio
model: qwen3-coder-30b-a3b
`,
    );

    const config = loadConfig();
    expect(config.agent).toBe('lmstudio');
    expect(config.model).toBe('qwen3-coder-30b-a3b');
  });

  it('accepts agent: ollama (single-agent local mode)', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
agent: ollama
model: llama3.1:70b
`,
    );

    const config = loadConfig();
    expect(config.agent).toBe('ollama');
    expect(config.model).toBe('llama3.1:70b');
  });

  it('rejects unknown agent values with a descriptive error', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
agent: bogus-agent
`,
    );

    expect(() => loadConfig()).toThrow(/Invalid agent: "bogus-agent"/);
    expect(() => loadConfig()).toThrow(/lmstudio, ollama/);
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

describe('routing config', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('is undefined when no routing key is present', () => {
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), `repo: owner/repo\nagent: claude\nmodel: claude-sonnet-4-6\n`);
    const config = loadConfig();
    expect(config.routing).toBeUndefined();
    // Existing behavior unchanged
    expect(config.agent).toBe('claude');
    expect(resolveStepConfig(config, 'implement').model).toBe('claude-sonnet-4-6');
  });

  it('loads the full hybrid-v1 example shape', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  profile: hybrid-v1
  stages:
    plan:       { model: claude-opus-4-7,      endpoint: anthropic }
    build:      { model: qwen3-coder-30b-a3b,  endpoint: lmstudio_local }
    test_write: { model: qwen3-coder-30b-a3b,  endpoint: lmstudio_local }
    test_exec:  { model: qwen3-coder-30b-a3b,  endpoint: lmstudio_local }
    review:     { model: claude-sonnet-4-6,    endpoint: anthropic }
    summary:    { model: gemma-4-31b,          endpoint: lmstudio_local }
  endpoints:
    anthropic:      { type: anthropic,        base_url: "https://api.anthropic.com" }
    lmstudio_local: { type: anthropic_compat, base_url: "http://localhost:1234" }
    ollama_local:   { type: openai_compat,    base_url: "http://localhost:11434/v1" }
  fallback:
    on_tool_error: escalate
    escalate_to: { model: claude-sonnet-4-6, endpoint: anthropic }
`,
    );
    const config = loadConfig();
    expect(config.routing).toBeDefined();
    expect(config.routing?.profile).toBe('hybrid-v1');
    expect(config.routing?.stages?.plan).toEqual({ model: 'claude-opus-4-7', endpoint: 'anthropic' });
    expect(config.routing?.stages?.build).toEqual({ model: 'qwen3-coder-30b-a3b', endpoint: 'lmstudio_local' });
    expect(config.routing?.stages?.test_write).toEqual({ model: 'qwen3-coder-30b-a3b', endpoint: 'lmstudio_local' });
    expect(config.routing?.stages?.test_exec).toEqual({ model: 'qwen3-coder-30b-a3b', endpoint: 'lmstudio_local' });
    expect(config.routing?.stages?.review).toEqual({ model: 'claude-sonnet-4-6', endpoint: 'anthropic' });
    expect(config.routing?.stages?.summary).toEqual({ model: 'gemma-4-31b', endpoint: 'lmstudio_local' });
    expect(config.routing?.endpoints?.anthropic).toEqual({ type: 'anthropic', base_url: 'https://api.anthropic.com' });
    expect(config.routing?.endpoints?.lmstudio_local).toEqual({ type: 'anthropic_compat', base_url: 'http://localhost:1234' });
    expect(config.routing?.endpoints?.ollama_local).toEqual({ type: 'openai_compat', base_url: 'http://localhost:11434/v1' });
    expect(config.routing?.fallback).toEqual({
      on_tool_error: 'escalate',
      escalate_to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic' },
    });
  });

  it('preserves profile as a list of strings', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  profile:
    - hybrid-v1
    - all-local
    - all-frontier
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  stages:
    plan: { model: claude-opus-4-7, endpoint: anthropic }
`,
    );
    const config = loadConfig();
    expect(config.routing?.profile).toEqual(['hybrid-v1', 'all-local', 'all-frontier']);
  });

  it('drops unknown stage names without throwing', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  stages:
    foobar: { model: claude-opus-4-7, endpoint: anthropic }
    plan:   { model: claude-opus-4-7, endpoint: anthropic }
`,
    );
    const config = loadConfig();
    expect(config.routing?.stages?.plan).toEqual({ model: 'claude-opus-4-7', endpoint: 'anthropic' });
    expect((config.routing?.stages as Record<string, unknown>).foobar).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('foobar'));
  });

  it('drops stages that reference an unknown endpoint', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  stages:
    plan:  { model: claude-opus-4-7, endpoint: anthropic }
    build: { model: mystery-model,   endpoint: nonexistent }
`,
    );
    const config = loadConfig();
    expect(config.routing?.stages?.plan).toBeDefined();
    expect(config.routing?.stages?.build).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
  });

  it('rejects endpoints with invalid type', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    bogus: { type: not_a_real_type, base_url: "http://localhost:1234" }
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
`,
    );
    const config = loadConfig();
    expect(config.routing?.endpoints?.bogus).toBeUndefined();
    expect(config.routing?.endpoints?.anthropic).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not_a_real_type'));
  });

  it('throws on malformed YAML', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  stages: [ { { this is invalid
`,
    );
    expect(() => loadConfig()).toThrow();
  });

  it('includes zero-cost local model entries in default pricing', () => {
    const config = loadConfig();
    expect(config.pricing['qwen3-coder-30b-a3b']).toEqual({ input: 0, output: 0 });
    expect(config.pricing['gemma-4-31b']).toEqual({ input: 0, output: 0 });
    expect(config.pricing['glm-4.6']).toEqual({ input: 0, output: 0 });
  });

  it('rejects fallback.on_tool_error with invalid value', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  fallback:
    on_tool_error: bogus_mode
`,
    );
    const config = loadConfig();
    expect(config.routing?.fallback).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bogus_mode'));
  });

  it('routing overrides from CLI replace YAML routing wholesale', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  profile: hybrid-v1
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  stages:
    plan: { model: claude-opus-4-7, endpoint: anthropic }
`,
    );
    const config = loadConfig({
      routing: {
        profile: 'all-frontier',
        stages: { plan: { model: 'claude-opus-4-7', endpoint: 'anthropic' } },
        endpoints: { anthropic: { type: 'anthropic', base_url: 'https://api.anthropic.com' } },
      },
    });
    expect(config.routing?.profile).toBe('all-frontier');
  });

  it('parses guardrail fields under fallback', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  fallback:
    on_tool_error: escalate
    escalate_to: { model: claude-sonnet-4-6, endpoint: anthropic }
    escalation_window_issues: 20
    escalation_error_threshold: 0.05
    escalation_revert_ms: 3600000
`,
    );
    const config = loadConfig();
    expect(config.routing?.fallback?.escalation_window_issues).toBe(20);
    expect(config.routing?.fallback?.escalation_error_threshold).toBe(0.05);
    expect(config.routing?.fallback?.escalation_revert_ms).toBe(3_600_000);
  });

  it('drops invalid guardrail values and warns', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  fallback:
    on_tool_error: escalate
    escalate_to: { model: claude-sonnet-4-6, endpoint: anthropic }
    escalation_window_issues: -3
    escalation_error_threshold: 1.5
    escalation_revert_ms: "not a number"
`,
    );
    const config = loadConfig();
    expect(config.routing?.fallback?.escalation_window_issues).toBeUndefined();
    expect(config.routing?.fallback?.escalation_error_threshold).toBeUndefined();
    expect(config.routing?.fallback?.escalation_revert_ms).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('getFallbackPolicy', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('returns null when routing has no fallback', () => {
    const config = loadConfig();
    expect(getFallbackPolicy(config)).toBeNull();
  });

  it('fills defaults when only on_tool_error is configured', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  fallback:
    on_tool_error: escalate
    escalate_to: { model: claude-sonnet-4-6, endpoint: anthropic }
`,
    );
    const policy = getFallbackPolicy(loadConfig());
    expect(policy).not.toBeNull();
    expect(policy!.on_tool_error).toBe('escalate');
    expect(policy!.escalation_window_issues).toBe(DEFAULT_ESCALATION_WINDOW);
    expect(policy!.escalation_error_threshold).toBe(DEFAULT_ESCALATION_ERROR_THRESHOLD);
    expect(policy!.escalation_revert_ms).toBe(DEFAULT_ESCALATION_REVERT_MS);
  });

  it('respects explicit overrides from config', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  fallback:
    on_tool_error: escalate
    escalate_to: { model: claude-sonnet-4-6, endpoint: anthropic }
    escalation_window_issues: 5
    escalation_error_threshold: 0.2
    escalation_revert_ms: 1000
`,
    );
    const policy = getFallbackPolicy(loadConfig());
    expect(policy!.escalation_window_issues).toBe(5);
    expect(policy!.escalation_error_threshold).toBe(0.2);
    expect(policy!.escalation_revert_ms).toBe(1000);
  });
});

describe('resolveRoutingStage', () => {
  it('returns undefined when routing is absent', () => {
    const config = loadConfig();
    expect(resolveRoutingStage(config, 'plan')).toBeUndefined();
    expect(resolveRoutingStage(config, 'build')).toBeUndefined();
  });

  it('returns undefined for stages not declared in routing.stages', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic: { type: anthropic, base_url: "https://api.anthropic.com" }
  stages:
    plan: { model: claude-opus-4-7, endpoint: anthropic }
`,
    );
    const config = loadConfig();
    expect(resolveRoutingStage(config, 'plan')).toEqual({
      model: 'claude-opus-4-7',
      endpoint: { type: 'anthropic', base_url: 'https://api.anthropic.com' },
    });
    expect(resolveRoutingStage(config, 'build')).toBeUndefined();
  });

  it('returns model and resolved endpoint for each configured stage', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  endpoints:
    anthropic:      { type: anthropic,        base_url: "https://api.anthropic.com" }
    lmstudio_local: { type: anthropic_compat, base_url: "http://localhost:1234" }
  stages:
    plan:  { model: claude-opus-4-7,     endpoint: anthropic }
    build: { model: qwen3-coder-30b-a3b, endpoint: lmstudio_local }
`,
    );
    const config = loadConfig();
    expect(resolveRoutingStage(config, 'plan')).toEqual({
      model: 'claude-opus-4-7',
      endpoint: { type: 'anthropic', base_url: 'https://api.anthropic.com' },
    });
    expect(resolveRoutingStage(config, 'build')).toEqual({
      model: 'qwen3-coder-30b-a3b',
      endpoint: { type: 'anthropic_compat', base_url: 'http://localhost:1234' },
    });
  });
});

describe('selectRoutingProfile', () => {
  it('returns undefined when routing or profile is unset', () => {
    const noRouting = loadConfig();
    expect(selectRoutingProfile(noRouting, 1)).toBeUndefined();
  });

  it('returns the single string profile unchanged', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  profile: hybrid-v1
  endpoints: { anthropic: { type: anthropic, base_url: "https://api.anthropic.com" } }
  stages: { plan: { model: claude-opus-4-7, endpoint: anthropic } }
`,
    );
    const config = loadConfig();
    expect(selectRoutingProfile(config, 42)).toBe('hybrid-v1');
    expect(selectRoutingProfile(config)).toBe('hybrid-v1');
  });

  it('deterministically picks the same profile from an array for a given issueId', () => {
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      `repo: owner/repo
routing:
  profile:
    - hybrid-v1
    - all-local
    - all-frontier
  endpoints: { anthropic: { type: anthropic, base_url: "https://api.anthropic.com" } }
  stages: { plan: { model: claude-opus-4-7, endpoint: anthropic } }
`,
    );
    const config = loadConfig();
    const a = selectRoutingProfile(config, 158);
    const b = selectRoutingProfile(config, 158);
    expect(a).toBe(b);
    expect(['hybrid-v1', 'all-local', 'all-frontier']).toContain(a);
    // Different issueIds can land on different profiles — at least two of the
    // three sampled ids should map to different profiles.
    const picks = [100, 200, 300, 400, 500, 600, 700].map((id) => selectRoutingProfile(config, id));
    const unique = new Set(picks);
    expect(unique.size).toBeGreaterThan(1);
  });
});
