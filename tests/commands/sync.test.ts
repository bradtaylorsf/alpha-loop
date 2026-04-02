import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncAgentAssets } from '../../src/commands/sync';

jest.mock('../../src/lib/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() },
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('syncAgentAssets', () => {
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
