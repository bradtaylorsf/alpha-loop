import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

// Silence all logger output during tests
jest.mock('../../src/lib/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn(), step: jest.fn(), dry: jest.fn(), rate: jest.fn(), debug: jest.fn() },
}));

// Mock rate-limit — ghExec delegates to the shell mock so existing assertions still work
jest.mock('../../src/lib/rate-limit', () => {
  const shell = require('../../src/lib/shell');
  return {
    ghExec: jest.fn((cmd: string) => shell.exec(cmd)),
    getRateLimitStatus: jest.fn(() => ({ remaining: 5000, limit: 5000, used: 0, resetAt: 0, ratio: 1 })),
    getProjectCache: jest.fn(() => null),
    setProjectCache: jest.fn(),
    clearProjectCache: jest.fn(),
    resetRateLimitState: jest.fn(),
    parseRateLimitHeaders: jest.fn(() => null),
    stripDebugOutput: jest.fn((s: string) => s),
  };
});

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

// Mock hardware detection — default to non-Apple-Silicon so the hardware prompt
// doesn't fire in most tests. Specific tests override to exercise the prompt path.
jest.mock('../../src/lib/hardware', () => ({
  shouldOfferLocalMode: jest.fn().mockReturnValue(false),
  getTotalMemoryGB: jest.fn().mockReturnValue(16),
  detectAppleSilicon: jest.fn().mockReturnValue(false),
}));

// Mock readline so interactive prompts (label creation, project statuses) don't block tests
// Default: answer 'y' so label/status creation tests work. Override in specific tests if needed.
jest.mock('node:readline', () => ({
  createInterface: jest.fn().mockReturnValue({
    question: jest.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
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
            { name: 'epic' },
            { name: 'needs-human-input' },
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

describe('hardware-aware local mode prompt', () => {
  const hardware = jest.requireMock('../../src/lib/hardware') as {
    shouldOfferLocalMode: jest.Mock;
    getTotalMemoryGB: jest.Mock;
    detectAppleSilicon: jest.Mock;
  };
  const readline = jest.requireMock('node:readline') as {
    createInterface: jest.Mock;
  };

  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    hardware.shouldOfferLocalMode.mockReturnValue(false);
    hardware.getTotalMemoryGB.mockReturnValue(16);
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    // Restore stdin.isTTY exactly as we found it
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  }

  it('does not prompt when hardware does not qualify', async () => {
    hardware.shouldOfferLocalMode.mockReturnValue(false);
    setTTY(true);

    // Capture only questions asked from within maybeOfferLocalMode — other
    // interactive prompts (label creation) use the same mock, so inspect prompts.
    const questions: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        questions.push(prompt);
        cb('y');
      }),
      close: jest.fn(),
    });

    await initCommand();

    expect(questions.every((q) => !q.includes('Apple Silicon'))).toBe(true);
  });

  it('does not prompt when not running in a TTY, even on qualifying hardware', async () => {
    hardware.shouldOfferLocalMode.mockReturnValue(true);
    hardware.getTotalMemoryGB.mockReturnValue(128);
    setTTY(false);

    const questions: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        questions.push(prompt);
        cb('y');
      }),
      close: jest.fn(),
    });

    await initCommand();

    expect(questions.every((q) => !q.includes('Apple Silicon'))).toBe(true);
  });

  it('prompts on qualifying hardware + TTY and leaves YAML untouched on yes', async () => {
    hardware.shouldOfferLocalMode.mockReturnValue(true);
    hardware.getTotalMemoryGB.mockReturnValue(128);
    setTTY(true);

    const questions: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        questions.push(prompt);
        // First prompt (hardware) says yes; subsequent prompts (labels/statuses)
        // also say yes via default.
        cb('y');
      }),
      close: jest.fn(),
    });

    await initCommand();

    // Hardware prompt was asked
    expect(questions.some((q) => q.includes('Apple Silicon'))).toBe(true);

    // YAML is the untouched default template — hardware prompt does not modify it
    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('agent: claude');
    expect(content).not.toContain('routing:');
  });

  it('prompts on qualifying hardware but also leaves YAML untouched on no', async () => {
    hardware.shouldOfferLocalMode.mockReturnValue(true);
    hardware.getTotalMemoryGB.mockReturnValue(64);
    setTTY(true);

    const questions: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        questions.push(prompt);
        // Decline the hardware prompt; other prompts (labels) get 'n' too but
        // shell mock returns exitCode 1 for gh so they're skipped harmlessly.
        cb('n');
      }),
      close: jest.fn(),
    });

    await initCommand();

    expect(questions.some((q) => q.includes('Apple Silicon'))).toBe(true);
    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('agent: claude');
    expect(content).not.toContain('routing:');
  });
});
