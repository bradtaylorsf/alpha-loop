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

describe('CLI factory status', () => {
  const tsxLoader = pathToFileURL(join(root, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'alpha-loop-cli-status-'));
    writeFileSync(join(project, '.alpha-loop.yaml'), `repo: o/r\nfactory:\n  state_dir: ${join(project, 'state')}\n`);
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  function status(...args: string[]) {
    return spawnSync(process.execPath,
      ['--import', tsxLoader, join(root, 'src/cli.ts'), 'factory', 'status', ...args],
      { cwd: project, encoding: 'utf-8', timeout: 10_000 });
  }

  it('documents the watch flag, default cadence, and JSON incompatibility in help', () => {
    const result = status('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--watch [seconds]');
    expect(result.stdout).toContain('default: 5 seconds');
    expect(result.stdout).toContain('Ctrl-C to stop');
    expect(result.stdout).toContain('incompatible with --json');
  });

  it.each(['0', '-1', 'NaN', 'Infinity', 'nope', '5seconds', '0.0001', '2147483.648', ''])('rejects invalid watch interval %j', (interval) => {
    const result = status('--watch', interval);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--watch seconds must be a finite positive number');
    expect(result.stdout).not.toContain('Factory:');
    expect(existsSync(join(project, 'state'))).toBe(false);
  });

  it.each([['--watch', '--json'], ['--json', '--watch', '2']])('rejects the JSON/watch conflict: %j', (...args) => {
    const result = status(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--watch cannot be combined with --json');
    expect(result.stdout).not.toContain('Factory:');
  });

  it('still exits after one text or JSON snapshot when watch is absent', () => {
    const text = status();
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Factory: not running');
    expect(text.stdout).toContain('Recent events (0):');
    expect(text.stdout).not.toContain('\x1b');
    const json = status('--json');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(expect.objectContaining({ running: false, state: null, pendingIdeas: 0 }));
    expect(existsSync(join(project, 'state'))).toBe(false);
  });
});
