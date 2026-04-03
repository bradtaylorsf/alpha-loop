import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  loadEvalConfig,
  cloneOrCacheFixtureRepo,
  extractFixture,
  setupFixture,
  cleanupFixture,
  resolveFixture,
} from '../../src/lib/eval-fixtures.js';
import type { EvalConfig, FixtureConfig, FixtureEntry } from '../../src/lib/eval-fixtures.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-fixtures-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('loadEvalConfig', () => {
  it('returns empty config when no config.yaml exists', () => {
    const config = loadEvalConfig(tempDir);
    expect(config).toEqual({});
  });

  it('parses fixture_repo config', () => {
    const configYaml = stringifyYaml({
      fixture_repo: {
        url: 'bradtaylorsf/alpha-loop-evals',
        commit: 'abc1234',
        fixtures: {
          'ts-api': {
            path: 'fixtures/ts-api',
            setup: 'pnpm install',
            test: 'pnpm test',
            start: 'pnpm dev',
          },
          'python-cli': {
            path: 'fixtures/python-cli',
            setup: 'uv sync',
            test: 'uv run pytest',
          },
        },
      },
    });
    writeFileSync(join(tempDir, 'config.yaml'), configYaml);

    const config = loadEvalConfig(tempDir);
    expect(config.fixture_repo).toBeDefined();
    expect(config.fixture_repo!.url).toBe('bradtaylorsf/alpha-loop-evals');
    expect(config.fixture_repo!.commit).toBe('abc1234');
    expect(Object.keys(config.fixture_repo!.fixtures)).toEqual(['ts-api', 'python-cli']);
    expect(config.fixture_repo!.fixtures['ts-api'].path).toBe('fixtures/ts-api');
    expect(config.fixture_repo!.fixtures['ts-api'].setup).toBe('pnpm install');
    expect(config.fixture_repo!.fixtures['ts-api'].test).toBe('pnpm test');
    expect(config.fixture_repo!.fixtures['ts-api'].start).toBe('pnpm dev');
    expect(config.fixture_repo!.fixtures['python-cli'].start).toBeUndefined();
  });

  it('parses swebench_repos config', () => {
    const configYaml = stringifyYaml({
      swebench_repos: {
        'django/django': {
          base_commits: {
            'django__django-11848': 'a1b2c3d4e5f6',
            'django__django-12345': 'deadbeef1234',
          },
        },
      },
    });
    writeFileSync(join(tempDir, 'config.yaml'), configYaml);

    const config = loadEvalConfig(tempDir);
    expect(config.swebench_repos).toBeDefined();
    expect(config.swebench_repos!['django/django']).toBeDefined();
    expect(config.swebench_repos!['django/django'].base_commits['django__django-11848']).toBe('a1b2c3d4e5f6');
  });

  it('handles malformed YAML gracefully', () => {
    writeFileSync(join(tempDir, 'config.yaml'), 'not: [valid: yaml: here');
    const config = loadEvalConfig(tempDir);
    // Should not throw, may return partial or empty
    expect(typeof config).toBe('object');
  });

  it('handles empty config.yaml', () => {
    writeFileSync(join(tempDir, 'config.yaml'), '');
    const config = loadEvalConfig(tempDir);
    expect(config).toEqual({});
  });

  it('parses combined fixture_repo and swebench_repos', () => {
    const configYaml = stringifyYaml({
      fixture_repo: {
        url: 'owner/evals',
        commit: 'main',
        fixtures: {
          'react-app': { path: 'fixtures/react-app', setup: 'pnpm install' },
        },
      },
      swebench_repos: {
        'flask/flask': {
          base_commits: { 'flask__flask-4045': 'aabbccdd' },
        },
      },
    });
    writeFileSync(join(tempDir, 'config.yaml'), configYaml);

    const config = loadEvalConfig(tempDir);
    expect(config.fixture_repo).toBeDefined();
    expect(config.swebench_repos).toBeDefined();
    expect(config.fixture_repo!.fixtures['react-app']).toBeDefined();
    expect(config.swebench_repos!['flask/flask'].base_commits['flask__flask-4045']).toBe('aabbccdd');
  });
});

describe('extractFixture', () => {
  it('copies fixture subdirectory to target and initializes git', () => {
    // Create a fake monorepo structure
    const repoDir = join(tempDir, 'monorepo');
    mkdirSync(join(repoDir, 'fixtures', 'ts-api', 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'fixtures', 'ts-api', 'package.json'), '{"name":"ts-api"}');
    writeFileSync(join(repoDir, 'fixtures', 'ts-api', 'src', 'index.ts'), 'console.log("hello")');

    const fixtureConfig: FixtureConfig = {
      url: 'test/repo',
      commit: 'abc123',
      fixtures: {
        'ts-api': { path: 'fixtures/ts-api', setup: 'echo setup', test: 'echo test' },
      },
    };

    const targetDir = join(tempDir, 'extracted');
    extractFixture(repoDir, 'ts-api', fixtureConfig, targetDir);

    expect(existsSync(join(targetDir, 'package.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(targetDir, '.git'))).toBe(true);

    const pkgJson = readFileSync(join(targetDir, 'package.json'), 'utf-8');
    expect(JSON.parse(pkgJson).name).toBe('ts-api');
  });

  it('throws for unknown fixture name', () => {
    const fixtureConfig: FixtureConfig = {
      url: 'test/repo',
      commit: 'abc123',
      fixtures: { 'ts-api': { path: 'fixtures/ts-api' } },
    };

    expect(() => {
      extractFixture(tempDir, 'unknown', fixtureConfig, join(tempDir, 'out'));
    }).toThrow(/Unknown fixture 'unknown'/);
  });

  it('throws when fixture path does not exist in repo', () => {
    const fixtureConfig: FixtureConfig = {
      url: 'test/repo',
      commit: 'abc123',
      fixtures: { 'missing': { path: 'fixtures/missing' } },
    };

    expect(() => {
      extractFixture(tempDir, 'missing', fixtureConfig, join(tempDir, 'out'));
    }).toThrow(/Fixture path not found/);
  });

  it('cleans up existing target directory before extracting', () => {
    const repoDir = join(tempDir, 'monorepo');
    mkdirSync(join(repoDir, 'fixtures', 'ts-api'), { recursive: true });
    writeFileSync(join(repoDir, 'fixtures', 'ts-api', 'index.ts'), 'new');

    const targetDir = join(tempDir, 'extracted');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'old-file.txt'), 'should be removed');

    const fixtureConfig: FixtureConfig = {
      url: 'test/repo',
      commit: 'abc123',
      fixtures: { 'ts-api': { path: 'fixtures/ts-api' } },
    };

    extractFixture(repoDir, 'ts-api', fixtureConfig, targetDir);
    expect(existsSync(join(targetDir, 'old-file.txt'))).toBe(false);
    expect(existsSync(join(targetDir, 'index.ts'))).toBe(true);
  });
});

describe('setupFixture', () => {
  it('runs setup command in fixture directory', () => {
    mkdirSync(join(tempDir, 'fixture'), { recursive: true });
    const entry: FixtureEntry = { path: 'test', setup: 'echo "setup done" > setup-marker.txt' };
    setupFixture(join(tempDir, 'fixture'), entry);
    expect(existsSync(join(tempDir, 'fixture', 'setup-marker.txt'))).toBe(true);
  });

  it('does nothing when no setup command', () => {
    const entry: FixtureEntry = { path: 'test' };
    // Should not throw
    setupFixture(tempDir, entry);
  });
});

describe('cleanupFixture', () => {
  it('removes the fixture directory', () => {
    const dir = join(tempDir, 'to-remove');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'test');
    cleanupFixture(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('does not throw for non-existent directory', () => {
    expect(() => cleanupFixture(join(tempDir, 'nonexistent'))).not.toThrow();
  });
});

describe('resolveFixture', () => {
  it('returns fixture entry when configured', () => {
    const config: EvalConfig = {
      fixture_repo: {
        url: 'test/repo',
        commit: 'abc123',
        fixtures: {
          'ts-api': { path: 'fixtures/ts-api', setup: 'pnpm install', test: 'pnpm test' },
        },
      },
    };

    const entry = resolveFixture(config, 'ts-api');
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe('fixtures/ts-api');
    expect(entry!.setup).toBe('pnpm install');
  });

  it('returns null when fixture not found', () => {
    const config: EvalConfig = {
      fixture_repo: {
        url: 'test/repo',
        commit: 'abc123',
        fixtures: { 'ts-api': { path: 'fixtures/ts-api' } },
      },
    };
    expect(resolveFixture(config, 'unknown')).toBeNull();
  });

  it('returns null when no fixture_repo configured', () => {
    expect(resolveFixture({}, 'ts-api')).toBeNull();
  });
});
