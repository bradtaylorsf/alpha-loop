import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
