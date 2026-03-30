import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

export type Config = {
  repo: string;
  repoOwner: string;
  project: number;
  model: string;
  reviewModel: string;
  maxTurns: number;
  pollInterval: number;
  dryRun: boolean;
  baseBranch: string;
  logDir: string;
  labelReady: string;
  maxTestRetries: number;
  testCommand: string;
  devCommand: string;
  port: number;
  skipTests: boolean;
  skipReview: boolean;
  skipInstall: boolean;
  skipPreflight: boolean;
  skipVerify: boolean;
  skipLearn: boolean;
  skipE2e: boolean;
  autoMerge: boolean;
  mergeTo: string;
  autoCleanup: boolean;
  runFull: boolean;
};

const DEFAULTS: Config = {
  repo: '',
  repoOwner: '',
  project: 2,
  model: 'opus',
  reviewModel: 'opus',
  maxTurns: 30,
  pollInterval: 60,
  dryRun: false,
  baseBranch: 'master',
  logDir: 'logs',
  labelReady: 'ready',
  maxTestRetries: 3,
  testCommand: 'pnpm test',
  devCommand: 'pnpm dev',
  port: 3000,
  skipTests: false,
  skipReview: false,
  skipInstall: false,
  skipPreflight: false,
  skipVerify: false,
  skipLearn: false,
  skipE2e: false,
  autoMerge: false,
  mergeTo: '',
  autoCleanup: true,
  runFull: false,
};

/** Map from YAML key (snake_case) to Config key (camelCase). */
const YAML_KEY_MAP: Record<string, keyof Config> = {
  repo: 'repo',
  project: 'project',
  model: 'model',
  review_model: 'reviewModel',
  max_turns: 'maxTurns',
  poll_interval: 'pollInterval',
  dry_run: 'dryRun',
  base_branch: 'baseBranch',
  log_dir: 'logDir',
  label: 'labelReady',
  max_test_retries: 'maxTestRetries',
  test_command: 'testCommand',
  dev_command: 'devCommand',
  port: 'port',
  skip_tests: 'skipTests',
  skip_review: 'skipReview',
  skip_install: 'skipInstall',
  skip_preflight: 'skipPreflight',
  skip_verify: 'skipVerify',
  skip_learn: 'skipLearn',
  skip_e2e: 'skipE2e',
  auto_merge: 'autoMerge',
  merge_to: 'mergeTo',
  auto_cleanup: 'autoCleanup',
  run_full: 'runFull',
};

/** Map from env var name to Config key. */
const ENV_KEY_MAP: Record<string, keyof Config> = {
  REPO: 'repo',
  PROJECT_NUM: 'project',
  MODEL: 'model',
  REVIEW_MODEL: 'reviewModel',
  MAX_TURNS: 'maxTurns',
  POLL_INTERVAL: 'pollInterval',
  DRY_RUN: 'dryRun',
  BASE_BRANCH: 'baseBranch',
  LOG_DIR: 'logDir',
  LABEL_READY: 'labelReady',
  MAX_TEST_RETRIES: 'maxTestRetries',
  TEST_COMMAND: 'testCommand',
  DEV_COMMAND: 'devCommand',
  PORT: 'port',
  SKIP_TESTS: 'skipTests',
  SKIP_REVIEW: 'skipReview',
  SKIP_INSTALL: 'skipInstall',
  SKIP_PREFLIGHT: 'skipPreflight',
  SKIP_VERIFY: 'skipVerify',
  SKIP_LEARN: 'skipLearn',
  SKIP_E2E: 'skipE2e',
  AUTO_MERGE: 'autoMerge',
  MERGE_TO: 'mergeTo',
  AUTO_CLEANUP: 'autoCleanup',
  RUN_FULL: 'runFull',
};

function coerce(value: string, current: unknown): unknown {
  if (typeof current === 'number') return Number(value);
  if (typeof current === 'boolean') return value === 'true' || value === '1';
  return value;
}

/** Validate a string contains only safe shell characters. */
export function assertSafeShellArg(value: string, name: string): string {
  if (!/^[a-zA-Z0-9._\-/]+$/.test(value)) {
    throw new Error(`Invalid ${name}: contains unsafe characters: ${value}`);
  }
  return value;
}

export function detectRepo(): string | null {
  try {
    const url = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // HTTPS: https://github.com/owner/repo.git
    const https = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (https) return `${https[1]}/${https[2]}`;

    // SSH: git@github.com:owner/repo.git
    const ssh = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;
  } catch {
    // Not a git repo or no remote
  }
  return null;
}

function loadYamlConfig(configPath: string): Partial<Config> {
  if (!existsSync(configPath)) return {};

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return {};

  const result: Partial<Config> = {};
  for (const [yamlKey, configKey] of Object.entries(YAML_KEY_MAP)) {
    if (yamlKey in parsed) {
      (result as Record<string, unknown>)[configKey] = parsed[yamlKey];
    }
  }
  return result;
}

function loadEnvConfig(): Partial<Config> {
  const result: Partial<Config> = {};
  for (const [envKey, configKey] of Object.entries(ENV_KEY_MAP)) {
    const val = process.env[envKey];
    if (val !== undefined) {
      (result as Record<string, unknown>)[configKey] = coerce(val, DEFAULTS[configKey]);
    }
  }
  return result;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const yamlConfig = loadYamlConfig('.alpha-loop.yaml');
  const envConfig = loadEnvConfig();

  // Auto-detect repo if not set by any source
  const detectedRepo = detectRepo();
  const autoDetect: Partial<Config> = {};
  if (detectedRepo) {
    autoDetect.repo = detectedRepo;
  }

  // Precedence: overrides (CLI flags) > env vars > config file > auto-detect > defaults
  const merged: Config = {
    ...DEFAULTS,
    ...autoDetect,
    ...yamlConfig,
    ...envConfig,
    ...overrides,
  };

  // Derive repoOwner from repo
  if (merged.repo) {
    merged.repoOwner = merged.repo.split('/')[0] ?? '';
  }

  return merged;
}
