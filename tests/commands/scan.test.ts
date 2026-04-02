import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock shell.exec before importing scan module
jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  run: jest.fn(),
}));

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn().mockReturnValue({ agent: 'claude', model: '' }),
  assertSafeShellArg: jest.fn((value: string) => value),
}));

jest.mock('../../src/lib/agent', () => ({
  buildOneShotCommand: jest.fn(() => 'claude -p --dangerously-skip-permissions --output-format text'),
}));

import { scanCommand } from '../../src/commands/scan';
import { exec } from '../../src/lib/shell';

const mockExec = exec as jest.MockedFunction<typeof exec>;

describe('scan', () => {
  let tmpDir: string;
  let origCwd: () => string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    origCwd = process.cwd;
    process.cwd = () => tmpDir;
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    process.cwd = origCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('generates context.md from Claude output', () => {
    mockExec.mockReturnValue({
      stdout: '## Architecture\n- Entry point: src/index.ts',
      stderr: '',
      exitCode: 0,
    });

    scanCommand();

    const contextFile = path.join(tmpDir, '.alpha-loop', 'context.md');
    expect(fs.existsSync(contextFile)).toBe(true);
    expect(fs.readFileSync(contextFile, 'utf-8')).toContain('## Architecture');
  });

  it('overwrites existing context file on re-run', () => {
    const contextDir = path.join(tmpDir, '.alpha-loop');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'context.md'), 'old content');

    mockExec.mockReturnValue({ stdout: 'new content', stderr: '', exitCode: 0 });

    scanCommand();

    const contextFile = path.join(contextDir, 'context.md');
    expect(fs.readFileSync(contextFile, 'utf-8')).toContain('new content');
  });

  it('handles Claude CLI failure gracefully', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'claude not found', exitCode: 1 });

    scanCommand();

    const contextFile = path.join(tmpDir, '.alpha-loop', 'context.md');
    expect(fs.existsSync(contextFile)).toBe(false);
  });
});
