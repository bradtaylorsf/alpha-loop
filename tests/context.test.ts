import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getProjectContext,
  contextNeedsRefresh,
  updateContextAfterRun,
  generateProjectContext,
} from '../src/lib/context.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'context-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('getProjectContext', () => {
  it('returns content when context file exists', () => {
    const contextDir = join(tempDir, '.alpha-loop');
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, 'context.md'), '## Architecture\n- stuff', 'utf-8');

    expect(getProjectContext(tempDir)).toBe('## Architecture\n- stuff');
  });

  it('returns null when context file does not exist', () => {
    expect(getProjectContext(tempDir)).toBeNull();
  });
});

describe('contextNeedsRefresh', () => {
  it('returns true when context file does not exist', () => {
    expect(contextNeedsRefresh(tempDir)).toBe(true);
  });

  it('returns false when context file is fresh (< 4 hours)', () => {
    const contextDir = join(tempDir, '.alpha-loop');
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, 'context.md'), 'content', 'utf-8');

    // File was just created, so it's fresh
    expect(contextNeedsRefresh(tempDir)).toBe(false);
  });

  it('returns true when context file is stale (>= 4 hours)', () => {
    const contextDir = join(tempDir, '.alpha-loop');
    mkdirSync(contextDir, { recursive: true });
    const filePath = join(contextDir, 'context.md');
    writeFileSync(filePath, 'content', 'utf-8');

    // Set mtime to 5 hours ago
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(filePath, fiveHoursAgo, fiveHoursAgo);

    expect(contextNeedsRefresh(tempDir)).toBe(true);
  });
});

describe('updateContextAfterRun', () => {
  it('appends entry under ## Active State', () => {
    const contextDir = join(tempDir, '.alpha-loop');
    mkdirSync(contextDir, { recursive: true });
    const filePath = join(contextDir, 'context.md');
    writeFileSync(filePath, '## Architecture\n- stuff\n\n## Active State\n- old entry\n', 'utf-8');

    updateContextAfterRun(42, 'Add login', 'merged', 5, tempDir);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('#42 Add login (merged) — 5 files changed');
    // Old entry should still be there
    expect(content).toContain('- old entry');
  });

  it('does nothing when context file does not exist', () => {
    // Should not throw
    updateContextAfterRun(1, 'test', 'done', 0, tempDir);
  });

  it('does nothing when ## Active State section is missing', () => {
    const contextDir = join(tempDir, '.alpha-loop');
    mkdirSync(contextDir, { recursive: true });
    const filePath = join(contextDir, 'context.md');
    writeFileSync(filePath, '## Architecture\n- stuff\n', 'utf-8');

    updateContextAfterRun(1, 'test', 'done', 0, tempDir);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('## Architecture\n- stuff\n');
  });
});

describe('generateProjectContext', () => {
  it('writes agent output to context file', async () => {
    const executor = async () => ({
      stdout: '## Architecture\n- generated content\n',
      stderr: '',
      exitCode: 0,
    });

    await generateProjectContext(tempDir, 'claude', executor);

    const content = readFileSync(join(tempDir, '.alpha-loop', 'context.md'), 'utf-8');
    expect(content).toBe('## Architecture\n- generated content\n');
  });

  it('does nothing on agent failure', async () => {
    const executor = async () => ({ stdout: '', stderr: 'error', exitCode: 1 });

    await generateProjectContext(tempDir, 'claude', executor);

    expect(getProjectContext(tempDir)).toBeNull();
  });

  it('creates .alpha-loop directory if needed', async () => {
    const executor = async () => ({
      stdout: 'content',
      stderr: '',
      exitCode: 0,
    });

    await generateProjectContext(tempDir, 'claude', executor);

    const content = readFileSync(join(tempDir, '.alpha-loop', 'context.md'), 'utf-8');
    expect(content).toBe('content');
  });
});
