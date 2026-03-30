import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as toYaml } from 'yaml';
import {
  ConfigSchema,
  loadConfig,
  resolveStageConfig,
  STAGE_NAMES,
  DEFAULT_AGENT,
  DEFAULT_MODEL,
} from '../../src/engine/config.js';

describe('ConfigSchema', () => {
  it('parses minimal config with defaults', () => {
    const result = ConfigSchema.parse({ repo: 'owner/repo' });
    expect(result.repo).toBe('owner/repo');
    expect(result.model).toBe('opus');
    expect(result.stages).toEqual({});
    expect(result.label).toBe('ready');
    expect(result.base_branch).toBe('master');
  });

  it('parses config with stages section', () => {
    const result = ConfigSchema.parse({
      repo: 'owner/repo',
      stages: {
        implement: { agent: 'claude', model: 'opus', maxTurns: 30 },
        review: { agent: 'codex', model: 'codex' },
      },
    });
    expect(result.stages.implement).toEqual({ agent: 'claude', model: 'opus', maxTurns: 30 });
    expect(result.stages.review).toEqual({ agent: 'codex', model: 'codex' });
  });

  it('applies defaults for partial stage config', () => {
    const result = ConfigSchema.parse({
      repo: 'owner/repo',
      stages: {
        implement: { model: 'sonnet' },
      },
    });
    // agent should default to 'claude'
    expect(result.stages.implement?.agent).toBe('claude');
    expect(result.stages.implement?.model).toBe('sonnet');
  });

  it('rejects unknown stage names', () => {
    expect(() => ConfigSchema.parse({
      repo: 'owner/repo',
      stages: {
        unknown_stage: { agent: 'claude' },
      },
    })).toThrow();
  });

  it('rejects config without repo', () => {
    expect(() => ConfigSchema.parse({ model: 'opus' })).toThrow();
  });
});

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and parses a YAML config file', () => {
    const yaml = toYaml({
      repo: 'owner/repo',
      model: 'sonnet',
      stages: {
        review: { agent: 'codex', model: 'codex' },
      },
    });
    writeFileSync(join(tmpDir, '.alpha-loop.yaml'), yaml);

    const config = loadConfig(tmpDir);
    expect(config.repo).toBe('owner/repo');
    expect(config.model).toBe('sonnet');
    expect(config.stages.review?.agent).toBe('codex');
  });

  it('throws if config file is missing', () => {
    expect(() => loadConfig(tmpDir)).toThrow();
  });
});

describe('resolveStageConfig', () => {
  const baseConfig = ConfigSchema.parse({
    repo: 'owner/repo',
    model: 'opus',
    max_turns: 25,
  });

  it('falls back to global defaults when no stage config exists', () => {
    for (const stage of STAGE_NAMES) {
      const resolved = resolveStageConfig(baseConfig, stage);
      expect(resolved.agent).toBe(DEFAULT_AGENT);
      expect(resolved.model).toBe('opus');
      expect(resolved.maxTurns).toBe(25);
    }
  });

  it('uses stage-specific agent and model when provided', () => {
    const config = ConfigSchema.parse({
      repo: 'owner/repo',
      model: 'opus',
      stages: {
        review: { agent: 'codex', model: 'codex' },
      },
    });

    const resolved = resolveStageConfig(config, 'review');
    expect(resolved.agent).toBe('codex');
    expect(resolved.model).toBe('codex');
  });

  it('falls back to global model when stage specifies only agent', () => {
    const config = ConfigSchema.parse({
      repo: 'owner/repo',
      model: 'opus',
      stages: {
        review: { agent: 'codex' },
      },
    });

    const resolved = resolveStageConfig(config, 'review');
    expect(resolved.agent).toBe('codex');
    expect(resolved.model).toBe('opus'); // global fallback
  });

  it('uses stage maxTurns over global max_turns', () => {
    const config = ConfigSchema.parse({
      repo: 'owner/repo',
      max_turns: 25,
      stages: {
        implement: { maxTurns: 30 },
      },
    });

    expect(resolveStageConfig(config, 'implement').maxTurns).toBe(30);
    expect(resolveStageConfig(config, 'fix').maxTurns).toBe(25); // global fallback
  });

  it('returns undefined maxTurns when neither stage nor global specifies it', () => {
    const config = ConfigSchema.parse({ repo: 'owner/repo' });
    expect(resolveStageConfig(config, 'review').maxTurns).toBeUndefined();
  });
});
