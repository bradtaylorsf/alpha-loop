import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

/** Per-model pricing (cost per million tokens). */
export type ModelPricing = {
  input: number;
  output: number;
};

/**
 * Estimate cost in USD from token counts and a pricing table.
 * Returns 0 if the model is not in the pricing table.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  pricing: Record<string, ModelPricing>,
): number {
  const p = pricing[model];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export type Config = {
  repo: string;
  repoOwner: string;
  project: number;
  agent: 'claude' | 'codex' | 'opencode';
  model: string;
  reviewModel: string;
  pollInterval: number;
  dryRun: boolean;
  baseBranch: string;
  logDir: string;
  labelReady: string;
  maxTestRetries: number;
  testCommand: string;
  devCommand: string;
  skipTests: boolean;
  skipReview: boolean;
  skipInstall: boolean;
  skipPreflight: boolean;
  skipVerify: boolean;
  skipLearn: boolean;
  skipE2e: boolean;
  maxIssues: number;
  maxSessionDuration: number;
  milestone: string;
  autoMerge: boolean;
  mergeTo: string;
  autoCleanup: boolean;
  runFull: boolean;
  verbose: boolean;
  harnesses: string[];
  setupCommand: string;
  evalDir: string;
  evalModel: string;
  skipEval: boolean;
  evalTimeout: number;
  /** Auto-capture failures as eval cases at end of session (default: true). */
  autoCapture: boolean;
  /** Per-model pricing table (cost per million tokens). */
  pricing: Record<string, ModelPricing>;
};

const DEFAULTS: Config = {
  repo: '',
  repoOwner: '',
  project: 2,
  agent: 'claude',
  model: '',
  reviewModel: '',
  pollInterval: 60,
  dryRun: false,
  baseBranch: 'master',
  logDir: 'logs',
  labelReady: 'ready',
  maxTestRetries: 3,
  testCommand: 'pnpm test',
  devCommand: 'pnpm dev',
  skipTests: false,
  skipReview: false,
  skipInstall: false,
  skipPreflight: false,
  skipVerify: false,
  skipLearn: false,
  skipE2e: false,
  maxIssues: 0,
  maxSessionDuration: 0,
  milestone: '',
  autoMerge: true,
  mergeTo: '',
  autoCleanup: true,
  runFull: false,
  verbose: false,
  harnesses: [],
  setupCommand: '',
  evalDir: '.alpha-loop/evals',
  evalModel: '',
  skipEval: false,
  evalTimeout: 300,
  autoCapture: true,
  pricing: {
    'claude-opus-4-6': { input: 15.0, output: 75.0 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5': { input: 0.80, output: 4.0 },
    'codex-mini': { input: 1.50, output: 6.0 },
  },
};

/** Map from YAML key (snake_case) to Config key (camelCase). */
const YAML_KEY_MAP: Record<string, keyof Config> = {
  harnesses: 'harnesses',
  repo: 'repo',
  project: 'project',
  agent: 'agent',
  model: 'model',
  review_model: 'reviewModel',
  poll_interval: 'pollInterval',
  dry_run: 'dryRun',
  base_branch: 'baseBranch',
  log_dir: 'logDir',
  label: 'labelReady',
  max_test_retries: 'maxTestRetries',
  test_command: 'testCommand',
  dev_command: 'devCommand',
  skip_tests: 'skipTests',
  skip_review: 'skipReview',
  skip_install: 'skipInstall',
  skip_preflight: 'skipPreflight',
  skip_verify: 'skipVerify',
  skip_learn: 'skipLearn',
  skip_e2e: 'skipE2e',
  max_issues: 'maxIssues',
  max_session_duration: 'maxSessionDuration',
  milestone: 'milestone',
  auto_merge: 'autoMerge',
  merge_to: 'mergeTo',
  auto_cleanup: 'autoCleanup',
  run_full: 'runFull',
  verbose: 'verbose',
  setup_command: 'setupCommand',
  eval_dir: 'evalDir',
  eval_model: 'evalModel',
  skip_eval: 'skipEval',
  eval_timeout: 'evalTimeout',
  auto_capture: 'autoCapture',
};

/** Map from env var name to Config key. */
const ENV_KEY_MAP: Record<string, keyof Config> = {
  REPO: 'repo',
  PROJECT: 'project',
  AGENT: 'agent',
  MODEL: 'model',
  REVIEW_MODEL: 'reviewModel',
  POLL_INTERVAL: 'pollInterval',
  DRY_RUN: 'dryRun',
  BASE_BRANCH: 'baseBranch',
  LOG_DIR: 'logDir',
  LABEL_READY: 'labelReady',
  MAX_TEST_RETRIES: 'maxTestRetries',
  TEST_COMMAND: 'testCommand',
  DEV_COMMAND: 'devCommand',
  SKIP_TESTS: 'skipTests',
  SKIP_REVIEW: 'skipReview',
  SKIP_INSTALL: 'skipInstall',
  SKIP_PREFLIGHT: 'skipPreflight',
  SKIP_VERIFY: 'skipVerify',
  SKIP_LEARN: 'skipLearn',
  SKIP_E2E: 'skipE2e',
  MAX_ISSUES: 'maxIssues',
  MAX_SESSION_DURATION: 'maxSessionDuration',
  MILESTONE: 'milestone',
  AUTO_MERGE: 'autoMerge',
  MERGE_TO: 'mergeTo',
  AUTO_CLEANUP: 'autoCleanup',
  RUN_FULL: 'runFull',
  VERBOSE: 'verbose',
  SETUP_COMMAND: 'setupCommand',
  EVAL_DIR: 'evalDir',
  EVAL_MODEL: 'evalModel',
  SKIP_EVAL: 'skipEval',
  EVAL_TIMEOUT: 'evalTimeout',
  AUTO_CAPTURE: 'autoCapture',
};

function coerce(value: string, current: unknown): unknown {
  if (typeof current === 'number') return Number(value);
  if (typeof current === 'boolean') return value === 'true' || value === '1';
  return value;
}

/** Validate a string contains only safe shell characters. Empty strings are allowed (model is optional). */
export function assertSafeShellArg(value: string, name: string): string {
  if (value === '') return value;
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

  // Handle pricing table (nested object, not in YAML_KEY_MAP)
  if (parsed.pricing && typeof parsed.pricing === 'object') {
    const pricing: Record<string, { input: number; output: number }> = {};
    for (const [model, value] of Object.entries(parsed.pricing as Record<string, unknown>)) {
      const v = value as Record<string, unknown>;
      if (typeof v?.input === 'number' && typeof v?.output === 'number') {
        pricing[model] = { input: v.input, output: v.output };
      }
    }
    if (Object.keys(pricing).length > 0) {
      result.pricing = pricing;
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
  // Pricing is merged specially: YAML/overrides extend defaults rather than replacing
  const mergedPricing = {
    ...DEFAULTS.pricing,
    ...yamlConfig.pricing,
    ...overrides?.pricing,
  };

  const merged: Config = {
    ...DEFAULTS,
    ...autoDetect,
    ...yamlConfig,
    ...envConfig,
    ...overrides,
    pricing: mergedPricing,
  };

  // Validate agent is a known value
  const VALID_AGENTS = ['claude', 'codex', 'opencode'] as const;
  if (!VALID_AGENTS.includes(merged.agent as typeof VALID_AGENTS[number])) {
    throw new Error(`Invalid agent: "${merged.agent}". Supported agents: ${VALID_AGENTS.join(', ')}`);
  }

  // Derive repoOwner from repo
  if (merged.repo) {
    merged.repoOwner = merged.repo.split('/')[0] ?? '';
  }

  return merged;
}
