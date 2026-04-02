import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;

// Mock process.exit to prevent Jest from actually exiting
const mockExit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as () => never);

import { initCommand } from '../../src/commands/init.js';

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

describe('init command', () => {
  it('creates .alpha-loop.yaml with auto-detected repo', async () => {
    mockedExecSync.mockReturnValue('https://github.com/myorg/myrepo.git\n');

    await initCommand();

    const configPath = join(tempDir, '.alpha-loop.yaml');
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('repo: myorg/myrepo');
    expect(content).toContain('model: opus');
    expect(content).toContain('test_command: pnpm test');
  });

  it('creates config with placeholder when no git remote', async () => {
    await initCommand();

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('repo: owner/repo');
  });

  it('skips config creation when config already exists', async () => {
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), 'repo: existing/repo\n');

    await initCommand();

    // Config should not be overwritten
    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('repo: existing/repo');
  });
});
