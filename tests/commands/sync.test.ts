import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncAgentAssets } from '../../src/commands/sync';
import { log } from '../../src/lib/logger';

jest.mock('../../src/lib/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('syncAgentAssets', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('syncs skills from .alpha-loop/templates/ to harness paths', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'demo-skill', 'SKILL.md'), '# Demo');

    const result = syncAgentAssets(['claude-code', 'codex'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'demo-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.agents', 'skills', 'demo-skill', 'SKILL.md'))).toBe(true);
    expect(result.skillsDirs).toContain('.claude/skills');
    expect(result.skillsDirs).toContain('.agents/skills');

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs alpha-loop-runner skill into Claude and Codex harness dirs', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    const skillContent = [
      '---',
      'name: alpha-loop-runner',
      'auto_load: true',
      'priority: high',
      '---',
      '# Alpha Loop Runner',
      '',
    ].join('\n');
    mkdirSync(join(templatesBase, 'skills', 'alpha-loop-runner'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'alpha-loop-runner', 'SKILL.md'), skillContent);

    const result = syncAgentAssets(['claude-code', 'codex'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(readFileSync(join(dir, '.claude', 'skills', 'alpha-loop-runner', 'SKILL.md'), 'utf-8')).toBe(skillContent);
    expect(readFileSync(join(dir, '.agents', 'skills', 'alpha-loop-runner', 'SKILL.md'), 'utf-8')).toBe(skillContent);

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs alpha-loop-setup skill into Claude and Codex harness dirs', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    const skillContent = [
      '---',
      'name: alpha-loop-setup',
      'auto_load: false',
      'priority: medium',
      '---',
      '# Alpha Loop Setup',
      '',
    ].join('\n');
    mkdirSync(join(templatesBase, 'skills', 'alpha-loop-setup'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'alpha-loop-setup', 'SKILL.md'), skillContent);

    const result = syncAgentAssets(['claude-code', 'codex'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(readFileSync(join(dir, '.claude', 'skills', 'alpha-loop-setup', 'SKILL.md'), 'utf-8')).toBe(skillContent);
    expect(readFileSync(join(dir, '.agents', 'skills', 'alpha-loop-setup', 'SKILL.md'), 'utf-8')).toBe(skillContent);

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs alpha-loop-issue-author skill into Claude and Codex harness dirs', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    const skillContent = [
      '---',
      'name: alpha-loop-issue-author',
      'auto_load: true',
      'priority: high',
      '---',
      '# Alpha Loop Issue Author',
      '',
    ].join('\n');
    mkdirSync(join(templatesBase, 'skills', 'alpha-loop-issue-author'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'alpha-loop-issue-author', 'SKILL.md'), skillContent);

    const result = syncAgentAssets(['claude-code', 'codex'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(readFileSync(join(dir, '.claude', 'skills', 'alpha-loop-issue-author', 'SKILL.md'), 'utf-8')).toBe(skillContent);
    expect(readFileSync(join(dir, '.agents', 'skills', 'alpha-loop-issue-author', 'SKILL.md'), 'utf-8')).toBe(skillContent);

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs alpha-loop-learning-review skill into Claude and Codex harness dirs', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    const skillContent = [
      '---',
      'name: alpha-loop-learning-review',
      'auto_load: true',
      'priority: high',
      '---',
      '# Alpha Loop Learning Review',
      '',
    ].join('\n');
    mkdirSync(join(templatesBase, 'skills', 'alpha-loop-learning-review'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'alpha-loop-learning-review', 'SKILL.md'), skillContent);

    const result = syncAgentAssets(['claude-code', 'codex'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(readFileSync(join(dir, '.claude', 'skills', 'alpha-loop-learning-review', 'SKILL.md'), 'utf-8')).toBe(skillContent);
    expect(readFileSync(join(dir, '.agents', 'skills', 'alpha-loop-learning-review', 'SKILL.md'), 'utf-8')).toBe(skillContent);

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs agents from templates to .claude/agents/', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'agents'), { recursive: true });
    writeFileSync(join(templatesBase, 'agents', 'implementer.md'), '# Implementer');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(readFileSync(join(dir, '.claude', 'agents', 'implementer.md'), 'utf-8')).toBe('# Implementer');

    rmSync(dir, { recursive: true, force: true });
  });

  test('does not overwrite unmanaged CLAUDE.md (no marker)', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'test-skill'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'test-skill', 'SKILL.md'), '# Test');
    writeFileSync(join(templatesBase, 'instructions.md'), '<!-- managed by alpha-loop -->\n# New');

    // Pre-existing CLAUDE.md WITHOUT marker must not be touched
    writeFileSync(join(dir, 'CLAUDE.md'), '# My Project Instructions');

    syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# My Project Instructions');

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs instructions.md to CLAUDE.md when marker is present', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(templatesBase, { recursive: true });
    writeFileSync(join(templatesBase, 'instructions.md'), '<!-- managed by alpha-loop -->\n# Updated');

    // CLAUDE.md with marker — safe to overwrite
    writeFileSync(join(dir, 'CLAUDE.md'), '<!-- managed by alpha-loop -->\n# Old');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.docSynced).toBe(true);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('<!-- managed by alpha-loop -->\n# Updated');

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs instructions.md to AGENTS.md for codex harness', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(templatesBase, { recursive: true });
    writeFileSync(join(templatesBase, 'instructions.md'), '<!-- managed by alpha-loop -->\n# Project');

    const result = syncAgentAssets(['codex'], { projectDir: dir });

    expect(result.docSynced).toBe(true);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toBe('<!-- managed by alpha-loop -->\n# Project');

    rmSync(dir, { recursive: true, force: true });
  });

  test('creates CLAUDE.md when it does not exist', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(templatesBase, { recursive: true });
    writeFileSync(join(templatesBase, 'instructions.md'), '<!-- managed by alpha-loop -->\n# Fresh');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.docSynced).toBe(true);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('<!-- managed by alpha-loop -->\n# Fresh');

    rmSync(dir, { recursive: true, force: true });
  });

  test('falls back to legacy skills/ with warning', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'skills', 'my-skill'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'my-skill', 'SKILL.md'), '# Legacy');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test('reports no sync needed when already in sync', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'a'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'a', 'SKILL.md'), '# Same');
    mkdirSync(join(dir, '.claude', 'skills', 'a'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'a', 'SKILL.md'), '# Same');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test('preserves target-only harness files by default', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'a'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'a', 'SKILL.md'), '# Same');
    mkdirSync(join(dir, '.claude', 'skills', 'a'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'a', 'SKILL.md'), '# Same');
    mkdirSync(join(dir, '.claude', 'skills', 'harness-only'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'harness-only', 'SKILL.md'), '# Harness Only');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(false);
    expect(readFileSync(join(dir, '.claude', 'skills', 'harness-only', 'SKILL.md'), 'utf-8')).toBe('# Harness Only');

    rmSync(dir, { recursive: true, force: true });
  });

  test('check mode reports target-only harness files as drift without deleting them', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'a'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'a', 'SKILL.md'), '# Same');
    mkdirSync(join(dir, '.claude', 'skills', 'a'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'a', 'SKILL.md'), '# Same');
    mkdirSync(join(dir, '.claude', 'skills', 'harness-only'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'harness-only', 'SKILL.md'), '# Harness Only');

    const result = syncAgentAssets(['claude-code'], { check: true, projectDir: dir });

    expect(result.synced).toBe(true);
    expect(readFileSync(join(dir, '.claude', 'skills', 'harness-only', 'SKILL.md'), 'utf-8')).toBe('# Harness Only');

    rmSync(dir, { recursive: true, force: true });
  });

  test('removes target-only harness files only when prune is enabled', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'a'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'a', 'SKILL.md'), '# Same');
    mkdirSync(join(dir, '.claude', 'skills', 'a'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'a', 'SKILL.md'), '# Same');
    mkdirSync(join(dir, '.claude', 'skills', 'harness-only', 'references'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'harness-only', 'SKILL.md'), '# Harness Only');
    writeFileSync(join(dir, '.claude', 'skills', 'harness-only', 'references', 'guide.md'), '# Guide');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir, prune: true });

    expect(result.synced).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'harness-only'))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(join('.claude', 'skills', 'harness-only', 'SKILL.md')));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(join('.claude', 'skills', 'harness-only', 'references', 'guide.md')));

    rmSync(dir, { recursive: true, force: true });
  });

  test('check mode reports drift without writing', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'a'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'a', 'SKILL.md'), '# New');
    mkdirSync(join(dir, '.claude', 'skills', 'a'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'a', 'SKILL.md'), '# Old');

    const result = syncAgentAssets(['claude-code'], { check: true, projectDir: dir });

    expect(result.synced).toBe(true);
    // Should NOT have been updated in check mode
    expect(readFileSync(join(dir, '.claude', 'skills', 'a', 'SKILL.md'), 'utf-8')).toBe('# Old');

    rmSync(dir, { recursive: true, force: true });
  });

  test('does nothing when no source files exist', () => {
    const dir = makeTmpDir();

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test('skips unknown harnesses with a warning', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'a'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'a', 'SKILL.md'), '# Test');

    const result = syncAgentAssets(['not-a-real-harness'], { projectDir: dir });

    expect(result.synced).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test('returns empty result when harnesses array is empty', () => {
    const dir = makeTmpDir();

    const result = syncAgentAssets([], { projectDir: dir });

    expect(result.synced).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});
