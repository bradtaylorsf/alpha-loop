import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string };
const distCli = join(root, 'dist', 'cli.js');
const itIfDistExists = existsSync(distCli) ? it : it.skip;

describe('CLI version', () => {
  it('reads the package.json version through the release helper script', () => {
    const result = spawnSync(process.execPath, ['scripts/read-package-version.mjs'], {
      cwd: root,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(packageJson.version);
  });

  it('reports the package.json version from the CLI', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
      cwd: root,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  itIfDistExists('reports the package.json version from the built CLI', () => {
    const result = spawnSync(process.execPath, [distCli, '--version'], {
      cwd: root,
      encoding: 'utf-8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it('does not hardcode a Commander version literal', () => {
    const cliSource = readFileSync(join(root, 'src/cli.ts'), 'utf-8');

    expect(cliSource).not.toMatch(/\.version\('[^']*'\)/);
  });
});

describe('CLI factory free-text arguments', () => {
  // Runs the source CLI in a throwaway project whose factory state dir is a
  // temp directory, so the real .alpha-loop/factory/inbox.md is never touched.
  const tsxLoader = pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'alpha-loop-cli-factory-'));
    writeFileSync(join(project, '.alpha-loop.yaml'), `repo: o/r\nfactory:\n  state_dir: ${join(project, 'state')}\n`);
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('treats dash-prefixed words inside an idea as text, not options', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', tsxLoader, join(root, 'src/cli.ts'), 'factory', 'idea', 'Add', 'a', '--json', 'flag', 'and', '-v'],
      { cwd: project, encoding: 'utf-8' },
    );

    expect(result.stderr).not.toContain('unknown option');
    expect(result.status).toBe(0);
    const inbox = readFileSync(join(project, 'state', 'inbox.md'), 'utf-8');
    expect(inbox).toContain('- [ ] Add a --json flag and -v');
  });
});
