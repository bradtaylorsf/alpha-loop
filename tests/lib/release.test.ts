import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bumpVersion, computeBump, planRelease, type ReleaseBump } from '../../src/lib/release.js';

const cases: Array<[string[], ReleaseBump]> = [
  [[], 'patch'],
  [['docs: clarify setup', 'chore: refresh deps'], 'patch'],
  [['fix: bug', 'feat(factory): cadence'], 'minor'],
  [['feat: new feature', 'fix(api)!: change response'], 'major'],
  [['refactor: migrate\n\nBREAKING CHANGE: old configuration is unsupported'], 'major'],
  [['feat!: new contract'], 'major'],
];

describe('release planning', () => {
  it.each(cases)('computes the bump for %j', (commits, bump) => {
    expect(computeBump(commits)).toBe(bump);
  });

  it.each<[ReleaseBump, string]>([['major', '2.0.0'], ['minor', '1.3.0'], ['patch', '1.2.4']])('bumps %s', (bump, version) => {
    expect(bumpVersion('v1.2.3', bump)).toBe(version);
    expect(bumpVersion('1.2.3', bump)).toBe(version);
  });

  it('counts complete messages once, including docs and chores, and excludes wrappers and release metadata', () => {
    const commits = ['docs: guide\n\nMany lines\nfeat: example\nfix: example', 'chore: deps', '', '  ',
      'Merge pull request #12 from feature\n\nfeat!: wrapper', 'chore(release): release v1.2.3\n\nBREAKING CHANGE: old notes'];
    expect(planRelease({ lastTag: 'v1.2.3', commits, releaseEvery: 3 })).toBeNull();
    expect(planRelease({ lastTag: 'v1.2.3', commits, releaseEvery: 2 })).toEqual({ version: '1.3.0', bump: 'minor', branch: 'chore/release-v1.3.0' });
  });

  it('returns null when disabled or there is nothing releasable', () => {
    expect(planRelease({ lastTag: null, commits: ['feat: first'], releaseEvery: 0 })).toBeNull();
    expect(planRelease({ lastTag: null, commits: [], releaseEvery: 1 })).toBeNull();
    expect(planRelease({ lastTag: null, commits: ['Merge branch main', 'chore(release): release v1.0.0'], releaseEvery: 1 })).toBeNull();
  });

  it('starts from 0.0.0 without a tag and accepts unprefixed stable tags', () => {
    expect(planRelease({ lastTag: null, commits: ['fix: first'], releaseEvery: 1 })?.version).toBe('0.0.1');
    expect(planRelease({ lastTag: '1.2.3', commits: ['docs: explain'], releaseEvery: 1 })?.version).toBe('1.2.4');
  });

  it.each(['1.2', 'v1.2.3-rc.1', '1.2.3+build', '01.2.3', 'hello', '', '1.2.3\n', '1.2.9007199254740992'])('rejects malformed version %s', (version) => {
    expect(() => bumpVersion(version, 'patch')).toThrow(/version/i);
    expect(() => planRelease({ lastTag: version, commits: ['fix: x'], releaseEvery: 1 })).toThrow(/version/i);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid cadence %s', (releaseEvery) => {
    expect(() => planRelease({ lastTag: null, commits: [], releaseEvery })).toThrow(/releaseEvery/);
  });

  it('rejects invalid bumps and numeric overflow', () => {
    expect(() => bumpVersion('1.2.3', 'bad' as ReleaseBump)).toThrow(/bump/i);
    expect(() => bumpVersion('1.2.9007199254740991', 'patch')).toThrow(/version/i);
  });

  it('keeps the build-free deploy helpers pure, import-safe, and in sync', () => {
    // Native ESM in a subprocess: importing deploy must not invoke git/gh or its CLI.
    const script = `import { computeBump, bumpVersion } from ${JSON.stringify(pathToFileURL(resolve('scripts/deploy.mjs')).href)};
      const cases = ${JSON.stringify(cases)};
      const invalid = ['1.2', '01.2.3', 'v1.2.3-rc.1', '', '1.2.9007199254740992', '1.2.3\\n'];
      console.log(JSON.stringify({
        bumps: cases.map(([messages]) => computeBump(messages)),
        versions: ['major', 'minor', 'patch'].map(b => bumpVersion('v1.2.3', b)),
        invalid: invalid.map(v => { try { bumpVersion(v, 'patch'); return false; } catch { return true; } }),
        invalidBump: (() => { try { bumpVersion('1.2.3', 'bad'); return false; } catch { return true; } })()
      }));`;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script, '--', '--major'], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual({
      bumps: cases.map(([messages]) => computeBump(messages)),
      versions: ['major', 'minor', 'patch'].map(b => bumpVersion('v1.2.3', b as ReleaseBump)),
      invalid: [true, true, true, true, true, true], invalidBump: true,
    });
  });
});
