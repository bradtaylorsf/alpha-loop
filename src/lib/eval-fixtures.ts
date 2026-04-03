/**
 * Eval Fixture Monorepo Manager — clone, cache, and extract fixture codebases.
 *
 * Fixtures live in a single monorepo (e.g. alpha-loop-evals) with multiple
 * small codebases as subdirectories. The eval runner clones the monorepo once,
 * then copies individual fixtures into isolated worktrees for each eval run.
 */
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { exec } from './shell.js';
import { log } from './logger.js';

/** Configuration for a single fixture within the monorepo. */
export type FixtureEntry = {
  /** Subdirectory path within the monorepo (e.g. 'fixtures/ts-api'). */
  path: string;
  /** Setup command to run after extraction (e.g. 'pnpm install'). */
  setup?: string;
  /** Test command for this fixture (e.g. 'pnpm test'). */
  test?: string;
  /** Start/dev command (e.g. 'pnpm dev'). */
  start?: string;
};

/** Top-level fixture repo configuration from config.yaml. */
export type FixtureConfig = {
  /** Git remote URL or local path. */
  url: string;
  /** Pinned commit hash for reproducibility. */
  commit: string;
  /** Named fixtures within the monorepo. */
  fixtures: Record<string, FixtureEntry>;
};

/** SWE-bench repo entry from config.yaml. */
export type SwebenchRepoConfig = {
  base_commits: Record<string, string>;
};

/** Full eval config loaded from .alpha-loop/evals/config.yaml. */
export type EvalConfig = {
  fixture_repo?: FixtureConfig;
  swebench_repos?: Record<string, SwebenchRepoConfig>;
};

/**
 * Load eval fixture configuration from .alpha-loop/evals/config.yaml.
 */
export function loadEvalConfig(evalDir: string): EvalConfig {
  const configPath = join(evalDir, 'config.yaml');
  if (!existsSync(configPath)) return {};

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return {};

    const result: EvalConfig = {};

    // Parse fixture_repo
    const fr = parsed.fixture_repo as Record<string, unknown> | undefined;
    if (fr && typeof fr === 'object') {
      const fixtures: Record<string, FixtureEntry> = {};
      const fixturesRaw = (fr.fixtures ?? {}) as Record<string, Record<string, unknown>>;
      for (const [name, entry] of Object.entries(fixturesRaw)) {
        if (entry && typeof entry === 'object') {
          fixtures[name] = {
            path: String(entry.path ?? ''),
            setup: entry.setup ? String(entry.setup) : undefined,
            test: entry.test ? String(entry.test) : undefined,
            start: entry.start ? String(entry.start) : undefined,
          };
        }
      }
      result.fixture_repo = {
        url: String(fr.url ?? ''),
        commit: String(fr.commit ?? 'main'),
        fixtures,
      };
    }

    // Parse swebench_repos
    const sr = parsed.swebench_repos as Record<string, Record<string, unknown>> | undefined;
    if (sr && typeof sr === 'object') {
      result.swebench_repos = {};
      for (const [repo, config] of Object.entries(sr)) {
        if (config && typeof config === 'object') {
          const commits = (config.base_commits ?? {}) as Record<string, string>;
          result.swebench_repos[repo] = {
            base_commits: Object.fromEntries(
              Object.entries(commits).map(([k, v]) => [k, String(v)]),
            ),
          };
        }
      }
    }

    return result;
  } catch (err) {
    log.warn(`Failed to load eval config: ${err instanceof Error ? err.message : err}`);
    return {};
  }
}

/**
 * Clone the fixture monorepo (or reuse a cached clone at the pinned commit).
 * Returns the path to the cached repo directory.
 */
export function cloneOrCacheFixtureRepo(config: FixtureConfig, projectDir: string): string {
  const cacheDir = resolve(projectDir, '.worktrees', 'eval-fixtures');

  // Check if cache exists and is at the right commit
  if (existsSync(join(cacheDir, '.git'))) {
    const currentCommit = exec('git rev-parse HEAD', { cwd: cacheDir, timeout: 5000 });
    if (currentCommit.exitCode === 0 && currentCommit.stdout.startsWith(config.commit)) {
      log.info(`Using cached fixture repo at ${config.commit.slice(0, 8)}`);
      return cacheDir;
    }

    // Wrong commit — reset to correct one
    log.info(`Updating fixture repo to ${config.commit.slice(0, 8)}...`);
    const fetch = exec('git fetch origin', { cwd: cacheDir, timeout: 120_000 });
    if (fetch.exitCode !== 0) {
      // Fetch failed, re-clone
      rmSync(cacheDir, { recursive: true, force: true });
    } else {
      const checkout = exec(`git checkout ${config.commit}`, { cwd: cacheDir, timeout: 30_000 });
      if (checkout.exitCode === 0) return cacheDir;
      // Checkout failed, re-clone
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }

  // Clone fresh
  mkdirSync(cacheDir, { recursive: true });
  rmSync(cacheDir, { recursive: true, force: true });

  const url = config.url.includes('://')
    ? config.url
    : `https://github.com/${config.url}.git`;

  log.info(`Cloning fixture repo from ${url}...`);
  const cloneResult = exec(`git clone ${url} ${cacheDir}`, { timeout: 120_000 });
  if (cloneResult.exitCode !== 0) {
    throw new Error(`Failed to clone fixture repo: ${cloneResult.stderr}`);
  }

  // Checkout the pinned commit
  const checkout = exec(`git checkout ${config.commit}`, { cwd: cacheDir, timeout: 30_000 });
  if (checkout.exitCode !== 0) {
    throw new Error(`Failed to checkout commit ${config.commit}: ${checkout.stderr}`);
  }

  return cacheDir;
}

/**
 * Extract a specific fixture subdirectory from the monorepo into an isolated target directory.
 */
export function extractFixture(repoDir: string, fixtureName: string, fixtureConfig: FixtureConfig, targetDir: string): string {
  const entry = fixtureConfig.fixtures[fixtureName];
  if (!entry) {
    throw new Error(`Unknown fixture '${fixtureName}'. Available: ${Object.keys(fixtureConfig.fixtures).join(', ')}`);
  }

  const srcDir = join(repoDir, entry.path);
  if (!existsSync(srcDir)) {
    throw new Error(`Fixture path not found: ${srcDir}`);
  }

  // Clean and create target
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });

  // Copy fixture files
  cpSync(srcDir, targetDir, { recursive: true });

  // Initialize git in the extracted fixture so eval runner can track changes
  exec('git init', { cwd: targetDir, timeout: 10_000 });
  exec('git add -A', { cwd: targetDir, timeout: 10_000 });
  exec('git commit -m "Initial fixture state" --allow-empty', { cwd: targetDir, timeout: 10_000 });

  return targetDir;
}

/**
 * Run the fixture's setup command (install dependencies, etc.).
 */
export function setupFixture(targetDir: string, entry: FixtureEntry): void {
  if (!entry.setup) return;

  log.info(`Running fixture setup: ${entry.setup}`);
  const result = exec(entry.setup, { cwd: targetDir, timeout: 300_000 });
  if (result.exitCode !== 0) {
    log.warn(`Fixture setup warning: ${result.stderr.slice(0, 500)}`);
  }
}

/**
 * Clean up an extracted fixture directory.
 */
export function cleanupFixture(targetDir: string): void {
  try {
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Resolve a fixture name (e.g. 'ts-api') to its FixtureEntry from config.
 * Returns null if no fixture_repo is configured or fixture not found.
 */
export function resolveFixture(evalConfig: EvalConfig, fixtureName: string): FixtureEntry | null {
  if (!evalConfig.fixture_repo) return null;
  return evalConfig.fixture_repo.fixtures[fixtureName] ?? null;
}
