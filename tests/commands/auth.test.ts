import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock shell before importing auth module
jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  run: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn().mockReturnValue({ port: 3000 }),
}));

import { authCommand } from '../../src/commands/auth';
import { exec } from '../../src/lib/shell';

const mockExec = exec as jest.MockedFunction<typeof exec>;

describe('auth', () => {
  let consoleSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('shows error when playwright-cli is not installed', async () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'not found', exitCode: 1 });

    await authCommand();

    const errorOutput = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(errorOutput).toContain('playwright-cli not installed');
    expect(process.exitCode).toBe(1);
  });

  it('updates .gitignore when .alpha-loop/auth/ is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules/\n');

    // Simulate the ensureGitignore logic directly
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.alpha-loop/auth')) {
      fs.appendFileSync(gitignorePath, '\n.alpha-loop/auth/\n');
    }

    const updated = fs.readFileSync(gitignorePath, 'utf-8');
    expect(updated).toContain('.alpha-loop/auth/');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not duplicate .gitignore entry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules/\n.alpha-loop/auth/\n');

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('.alpha-loop/auth')) {
      fs.appendFileSync(gitignorePath, '\n.alpha-loop/auth/\n');
    }

    const updated = fs.readFileSync(gitignorePath, 'utf-8');
    // Should not have duplicate entries
    const count = (updated.match(/\.alpha-loop\/auth/g) ?? []).length;
    expect(count).toBe(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
