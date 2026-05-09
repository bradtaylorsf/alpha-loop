import { normalizeScriptArgv } from '../../src/lib/cli-args';

describe('normalizeScriptArgv', () => {
  it('removes a package-manager separator before the command name', () => {
    expect(normalizeScriptArgv(['node', 'cli.js', '--', 'triage', '--dry-run'])).toEqual([
      'node',
      'cli.js',
      'triage',
      '--dry-run',
    ]);
  });

  it('leaves normal argv unchanged', () => {
    const argv = ['node', 'cli.js', 'triage', '--dry-run'];
    expect(normalizeScriptArgv(argv)).toBe(argv);
  });
});
