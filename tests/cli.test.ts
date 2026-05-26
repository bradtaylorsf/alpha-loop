import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const packageJson = require('../package.json') as { version: string };

describe('CLI version', () => {
  it('reports the package.json version from the CLI', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '--version'], {
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
