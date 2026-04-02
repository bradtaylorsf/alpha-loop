import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

// Silence all logger output during tests
jest.mock('../../src/lib/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn(), step: jest.fn(), dry: jest.fn() },
}));

// Mock shell exec so init steps that shell out (scan, sync, git) don't run real commands
jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn().mockReturnValue({ exitCode: 1, stdout: '', stderr: '' }),
  formatTimestamp: jest.fn().mockReturnValue('20260401-100000'),
}));

// Mock scan so Step 7 doesn't spawn Claude
jest.mock('../../src/commands/scan', () => ({
  scanCommand: jest.fn(),
  generateInstructions: jest.fn(),
}));

// Mock sync so Step 8 doesn't do real file operations
jest.mock('../../src/commands/sync', () => ({
  syncAgentAssets: jest.fn().mockReturnValue({ synced: false, docSynced: false, skillsDirs: [] }),
  migrateToTemplates: jest.fn(),
  resolveHarnesses: jest.fn((harnesses: string[], _agent: string) => harnesses.length > 0 ? harnesses : ['claude']),
}));

// Mock vision helpers
jest.mock('../../src/lib/vision', () => ({
  hasVision: jest.fn().mockReturnValue(true),
}));

// Mock templates finder (no distribution templates in test)
jest.mock('../../src/lib/templates', () => ({
  findDistributionTemplatesDir: jest.fn().mockReturnValue(null),
}));

// Mock readline so interactive prompts (label creation, project statuses) don't block tests
jest.mock('node:readline', () => ({
  createInterface: jest.fn().mockReturnValue({
    question: jest.fn((_prompt: string, cb: (answer: string) => void) => cb('n')),
    close: jest.fn(),
  }),
}));

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

// Mock process.exit to prevent Jest from actually exiting
const mockExit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as () => never);

import { initCommand, ensureLabels } from '../../src/commands/init.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-init-'));
  process.chdir(tempDir);
  mockedExecSync.mockImplementation(() => {
    throw new Error('not a git repo');
  });
  mockExit.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

const { exec: mockExec } = jest.requireMock('../../src/lib/shell') as { exec: jest.Mock };

describe('ensureLabels', () => {
  it('skips creation when all labels exist', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh label list')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { name: 'ready' },
            { name: 'in-progress' },
            { name: 'in-review' },
            { name: 'failed' },
          ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ensureLabels('owner/repo', 'ready');
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining('gh label create'));
  });

  it('creates missing labels', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh label list')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ name: 'ready' }]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ensureLabels('owner/repo', 'ready');
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh label create "in-progress"'));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh label create "in-review"'));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh label create "failed"'));
  });

  it('uses configured label name instead of default "ready"', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh label list')) {
        return { exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ensureLabels('owner/repo', 'todo');
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh label create "todo"'));
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining('gh label create "ready"'));
  });

  it('handles gh CLI failure gracefully', async () => {
    mockExec.mockReturnValue({ exitCode: 1, stdout: '', stderr: 'error' });
    await ensureLabels('owner/repo', 'ready');
    // Should not throw, just warn
  });
});

describe('init command', () => {
  it('creates .alpha-loop.yaml with auto-detected repo', async () => {
    mockedExecSync.mockReturnValue('https://github.com/myorg/myrepo.git\n');

    await initCommand();

    const configPath = join(tempDir, '.alpha-loop.yaml');
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('repo: myorg/myrepo');
    expect(content).toContain('agent: claude');
    expect(content).toContain('test_command: pnpm test');
    expect(content).toContain('harnesses:');
  });

  it('creates config with placeholder when no git remote', async () => {
    await initCommand();

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('repo: owner/repo');
  });

  it('skips config creation when config already exists', async () => {
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), 'repo: existing/repo\n');

    await initCommand();

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('repo: existing/repo');
  });

  it('creates .gitignore with correct entries', async () => {
    await initCommand();

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.alpha-loop/sessions/');
    expect(gitignore).toContain('.alpha-loop/auth/');
    expect(gitignore).toContain('.worktrees/');
    expect(gitignore).toContain('.alpha-loop/templates/*.bak');
  });

  it('removes stale learnings gitignore entry', async () => {
    writeFileSync(join(tempDir, '.gitignore'), '.alpha-loop/learnings/\n');

    await initCommand();

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).not.toContain('.alpha-loop/learnings/');
  });
});
