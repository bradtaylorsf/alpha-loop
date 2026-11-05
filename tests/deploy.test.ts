import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('deploy CLI', () => {
  let root: string;
  let bin: string;

  const git = (...args: string[]): string => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'alpha-loop-deploy-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'scripts'));
    copyFileSync(resolve('scripts/deploy.mjs'), join(root, 'scripts', 'deploy.mjs'));
    // Only auth is permitted: these tests must never call GitHub or publish.
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1" = auth ] && [ "$2" = status ]\n', { mode: 0o755 });
    writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}\n');
    git('init', '-b', 'main');
    git('config', 'user.name', 'Deploy Test');
    git('config', 'user.email', 'deploy@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', join(root, 'no-hooks'));
    git('add', 'package.json');
    git('commit', '-m', 'chore: initial');
    git('tag', 'v1.2.3');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function deploy(...args: string[]) {
    return spawnSync(process.execPath, ['scripts/deploy.mjs', '--dry-run', ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  }

  it('keeps tag names literal when reading commit history', () => {
    git('commit', '--allow-empty', '-m', 'fix: prior change');
    git('tag', 'v1.2.3;touch${IFS}injected;#');
    git('commit', '--allow-empty', '-m', 'fix: next change');
    const result = deploy();
    expect(existsSync(join(root, 'injected'))).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Invalid stable version');
  });

  it.each([['', '1.3.0'], ['--patch', '1.2.4']])('previews conventional commits with override %s', (flag, version) => {
    git('commit', '--allow-empty', '-m', 'feat: new feature');
    const before = git('rev-parse', 'HEAD');
    const result = deploy(...(flag ? [flag] : []));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`next version:   v${version}`);
    expect(git('rev-parse', 'HEAD')).toBe(before);
    expect(git('status', '--porcelain', '--untracked-files=no')).toBe('');
  });
});
