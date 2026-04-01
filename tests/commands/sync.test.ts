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

afterAll(() => {
  // Cleanup is best-effort
});

describe('syncAgentAssets', () => {
  test('syncs legacy AGENTS.md to CLAUDE.md via claude-code harness', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'AGENTS.md'), '# Instructions');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(result.docSynced).toBe(true);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Instructions');

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs legacy skills/ to .agents/skills/ and .claude/skills/ via codex + claude-code harnesses', () => {
    const dir = makeTmpDir();
    mkdirSync(join(dir, 'skills', 'my-skill'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nDo stuff');

    const result = syncAgentAssets(['codex', 'claude-code'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(result.skillsDirs).toContain('.agents/skills');
    expect(result.skillsDirs).toContain('.claude/skills');
    expect(existsSync(join(dir, '.agents', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  test('reports no sync needed when already in sync', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'AGENTS.md'), '# Same');
    writeFileSync(join(dir, 'CLAUDE.md'), '# Same');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test('check mode reports drift without writing', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'AGENTS.md'), '# New');
    writeFileSync(join(dir, 'CLAUDE.md'), '# Old');

    const result = syncAgentAssets(['claude-code'], { check: true, projectDir: dir });

    expect(result.synced).toBe(true);
    expect(result.docSynced).toBe(true);
    // CLAUDE.md should NOT have been updated in check mode
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Old');

    rmSync(dir, { recursive: true, force: true });
  });

  test('does nothing when no source files exist', () => {
    const dir = makeTmpDir();

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test('syncs from .alpha-loop/templates/ when present', () => {
    const dir = makeTmpDir();
    const templatesBase = join(dir, '.alpha-loop', 'templates');
    mkdirSync(join(templatesBase, 'skills', 'demo-skill'), { recursive: true });
    writeFileSync(join(templatesBase, 'skills', 'demo-skill', 'SKILL.md'), '# Demo');
    writeFileSync(join(templatesBase, 'instructions.md'), '# Instructions');

    const result = syncAgentAssets(['claude-code'], { projectDir: dir });

    expect(result.synced).toBe(true);
    expect(existsSync(join(dir, '.claude', 'skills', 'demo-skill', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf-8')).toBe('# Instructions');

    rmSync(dir, { recursive: true, force: true });
  });

  test('skips unknown harnesses with a warning', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'AGENTS.md'), '# Instructions');

    // Should not throw
    const result = syncAgentAssets(['not-a-real-harness'], { projectDir: dir });

    expect(result.synced).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  test('returns empty result when harnesses array is empty', () => {
    const dir = makeTmpDir();
    writeFileSync(join(dir, 'AGENTS.md'), '# Instructions');

    const result = syncAgentAssets([], { projectDir: dir });

    expect(result.synced).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});
