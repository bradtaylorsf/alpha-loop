import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

/** Per-model pricing (cost per million tokens). */
export type ModelPricing = {
  input: number;
  output: number;
};

/** The pipeline steps that support per-step agent/model overrides. */
export type PipelineStepName = 'plan' | 'implement' | 'test_fix' | 'review' | 'verify' | 'learn';

/** Per-step agent/model override. */
export type StepConfig = {
  agent?: string;
  model?: string;
};

/** Per-step pipeline configuration. */
export type PipelineConfig = Partial<Record<PipelineStepName, StepConfig>>;

/** The Loop stages that support per-stage routing (model + endpoint). */
export type RoutingStageName = 'plan' | 'build' | 'test_write' | 'test_exec' | 'review' | 'summary';

/** Per-stage routing configuration — targets a model on a named endpoint. */
export type RoutingStageConfig = {
  model: string;
  endpoint: string;
};

/** Endpoint protocol/API shape for a routing endpoint. */
export type RoutingEndpointType = 'anthropic' | 'anthropic_compat' | 'openai_compat';

/** A named endpoint that stages can route to. */
export type RoutingEndpoint = {
  type: RoutingEndpointType;
  base_url: string;
};

/** How the loop should behave when a routed stage errors out. */
export type RoutingFallbackMode = 'escalate' | 'retry' | 'fail';

/** Fallback behavior for routed stages. */
export type RoutingFallback = {
  on_tool_error: RoutingFallbackMode;
  escalate_to?: RoutingStageConfig;
};

/** Per-stage routing configuration for the Loop. */
export type RoutingConfig = {
  profile?: string | string[];
  stages?: Partial<Record<RoutingStageName, RoutingStageConfig>>;
  endpoints?: Record<string, RoutingEndpoint>;
  fallback?: RoutingFallback;
};

const VALID_ROUTING_STAGES: readonly RoutingStageName[] = [
  'plan',
  'build',
  'test_write',
  'test_exec',
  'review',
  'summary',
] as const;

const VALID_ENDPOINT_TYPES: readonly RoutingEndpointType[] = [
  'anthropic',
  'anthropic_compat',
  'openai_compat',
] as const;

const VALID_FALLBACK_MODES: readonly RoutingFallbackMode[] = [
  'escalate',
  'retry',
  'fail',
] as const;

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
  /** Skip post-session holistic code review (default: false). */
  skipPostSessionReview: boolean;
  /** Skip security scanning in post-session review (default: false). */
  skipPostSessionSecurity: boolean;
  /** Enable batch mode — process multiple issues per agent call (default: false). */
  batch: boolean;
  /** Number of issues per batch when batch mode is enabled (default: 5). */
  batchSize: number;
  /** Shell command to run as a final smoke test after session review (default: ''). */
  smokeTest: string;
  /** Agent timeout in seconds. Defaults to 1800 (30 minutes). */
  agentTimeout: number;
  /** Per-model pricing table (cost per million tokens). */
  pricing: Record<string, ModelPricing>;
  /** Per-step agent/model overrides. */
  pipeline: PipelineConfig;
  /** Optional per-stage Loop routing (model + endpoint). Absent => no routing applied. */
  routing?: RoutingConfig;
  /** Include repo-specific agent prompts during eval runs (default: true). */
  evalIncludeAgentPrompts: boolean;
  /** Include repo-specific skills during eval runs (default: true). */
  evalIncludeSkills: boolean;
  /**
   * When there is exactly one open epic in the repo, the picker auto-selects
   * it instead of prompting. Default: false.
   */
  preferEpics: boolean;
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
  skipPostSessionReview: false,
  skipPostSessionSecurity: false,
  batch: false,
  batchSize: 5,
  smokeTest: '',
  agentTimeout: 1800,
  pricing: {
    'claude-opus-4-6': { input: 15.0, output: 75.0 },
    'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
    'claude-haiku-4-5': { input: 0.80, output: 4.0 },
    'codex-mini': { input: 1.50, output: 6.0 },
    'gpt-4o': { input: 2.50, output: 10.0 },
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'deepseek-v3': { input: 0.27, output: 1.10 },
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'qwen3-coder-30b-a3b': { input: 0, output: 0 },
    'gemma-4-31b': { input: 0, output: 0 },
    'glm-4.6': { input: 0, output: 0 },
  },
  pipeline: {},
  evalIncludeAgentPrompts: true,
  evalIncludeSkills: true,
  preferEpics: false,
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
  batch: 'batch',
  batch_size: 'batchSize',
  smoke_test: 'smokeTest',
  agent_timeout: 'agentTimeout',
  pipeline: 'pipeline',
  eval_include_agent_prompts: 'evalIncludeAgentPrompts',
  eval_include_skills: 'evalIncludeSkills',
  prefer_epics: 'preferEpics',
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
  SKIP_POST_SESSION_REVIEW: 'skipPostSessionReview',
  SKIP_POST_SESSION_SECURITY: 'skipPostSessionSecurity',
  BATCH: 'batch',
  BATCH_SIZE: 'batchSize',
  SMOKE_TEST: 'smokeTest',
  AGENT_TIMEOUT: 'agentTimeout',
  PREFER_EPICS: 'preferEpics',
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

function parseRoutingStage(raw: unknown): RoutingStageConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.model !== 'string' || typeof r.endpoint !== 'string') return undefined;
  return { model: r.model, endpoint: r.endpoint };
}

function parseRoutingConfig(raw: unknown): RoutingConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const result: RoutingConfig = {};
  let populated = false;

  if (typeof r.profile === 'string') {
    result.profile = r.profile;
    populated = true;
  } else if (Array.isArray(r.profile) && r.profile.every((p) => typeof p === 'string')) {
    result.profile = r.profile as string[];
    populated = true;
  }

  const endpoints: Record<string, RoutingEndpoint> = {};
  if (r.endpoints && typeof r.endpoints === 'object') {
    for (const [name, value] of Object.entries(r.endpoints as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      if (typeof v.type !== 'string' || typeof v.base_url !== 'string') {
        console.warn(`[config] routing.endpoints.${name}: expected { type, base_url }`);
        continue;
      }
      if (!VALID_ENDPOINT_TYPES.includes(v.type as RoutingEndpointType)) {
        console.warn(
          `[config] routing.endpoints.${name}: invalid type "${v.type}" (expected one of ${VALID_ENDPOINT_TYPES.join(', ')})`,
        );
        continue;
      }
      endpoints[name] = { type: v.type as RoutingEndpointType, base_url: v.base_url };
    }
    if (Object.keys(endpoints).length > 0) {
      result.endpoints = endpoints;
      populated = true;
    }
  }

  const stages: Partial<Record<RoutingStageName, RoutingStageConfig>> = {};
  if (r.stages && typeof r.stages === 'object') {
    const stagesRaw = r.stages as Record<string, unknown>;
    for (const [key, value] of Object.entries(stagesRaw)) {
      if (!VALID_ROUTING_STAGES.includes(key as RoutingStageName)) {
        console.warn(`[config] routing.stages.${key}: unknown stage name (ignored)`);
        continue;
      }
      const parsed = parseRoutingStage(value);
      if (!parsed) {
        console.warn(`[config] routing.stages.${key}: expected { model, endpoint }`);
        continue;
      }
      if (result.endpoints && !(parsed.endpoint in result.endpoints)) {
        console.warn(
          `[config] routing.stages.${key}: endpoint "${parsed.endpoint}" is not defined in routing.endpoints (ignored)`,
        );
        continue;
      }
      stages[key as RoutingStageName] = parsed;
    }
    if (Object.keys(stages).length > 0) {
      result.stages = stages;
      populated = true;
    }
  }

  if (r.fallback && typeof r.fallback === 'object') {
    const f = r.fallback as Record<string, unknown>;
    if (typeof f.on_tool_error === 'string' && VALID_FALLBACK_MODES.includes(f.on_tool_error as RoutingFallbackMode)) {
      const fallback: RoutingFallback = { on_tool_error: f.on_tool_error as RoutingFallbackMode };
      const escalate = parseRoutingStage(f.escalate_to);
      if (escalate) {
        if (result.endpoints && !(escalate.endpoint in result.endpoints)) {
          console.warn(
            `[config] routing.fallback.escalate_to: endpoint "${escalate.endpoint}" is not defined in routing.endpoints (ignored)`,
          );
        } else {
          fallback.escalate_to = escalate;
        }
      }
      result.fallback = fallback;
      populated = true;
    } else if (f.on_tool_error !== undefined) {
      console.warn(
        `[config] routing.fallback.on_tool_error: invalid value "${String(f.on_tool_error)}" (expected one of ${VALID_FALLBACK_MODES.join(', ')})`,
      );
    }
  }

  return populated ? result : undefined;
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

  // Handle pipeline nested config (per-step agent/model overrides)
  if (parsed.pipeline && typeof parsed.pipeline === 'object') {
    const pipelineRaw = parsed.pipeline as Record<string, unknown>;
    const pipeline: PipelineConfig = {};
    const validSteps: PipelineStepName[] = ['plan', 'implement', 'test_fix', 'review', 'verify', 'learn'];
    for (const step of validSteps) {
      const entry = pipelineRaw[step];
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const stepCfg: StepConfig = {};
        if (typeof e.agent === 'string') stepCfg.agent = e.agent;
        if (typeof e.model === 'string') stepCfg.model = e.model;
        if (Object.keys(stepCfg).length > 0) pipeline[step] = stepCfg;
      }
    }
    if (Object.keys(pipeline).length > 0) {
      result.pipeline = pipeline;
    }
  }

  // Handle post_session nested config
  if (parsed.post_session && typeof parsed.post_session === 'object') {
    const ps = parsed.post_session as Record<string, unknown>;
    if (ps.review === false) result.skipPostSessionReview = true;
    if (ps.security_scan === false) result.skipPostSessionSecurity = true;
  }

  // Handle eval nested config (include_agent_prompts, include_skills)
  if (parsed.eval && typeof parsed.eval === 'object') {
    const ev = parsed.eval as Record<string, unknown>;
    if (ev.include_agent_prompts === false) result.evalIncludeAgentPrompts = false;
    if (ev.include_skills === false) result.evalIncludeSkills = false;
  }

  // Handle routing nested config (per-stage model + endpoint)
  if (parsed.routing !== undefined) {
    const routing = parseRoutingConfig(parsed.routing);
    if (routing) {
      result.routing = routing;
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

  // Pipeline is merged specially: overrides extend YAML rather than replacing
  const mergedPipeline: PipelineConfig = {};
  const allSteps = new Set([
    ...Object.keys(yamlConfig.pipeline ?? {}),
    ...Object.keys(overrides?.pipeline ?? {}),
  ]) as Set<PipelineStepName>;
  for (const step of allSteps) {
    mergedPipeline[step] = {
      ...(yamlConfig.pipeline?.[step] ?? {}),
      ...(overrides?.pipeline?.[step] ?? {}),
    };
  }

  // Routing precedence is whole-object replacement (overrides > yaml > undefined).
  const routing = overrides?.routing ?? yamlConfig.routing;

  const merged: Config = {
    ...DEFAULTS,
    ...autoDetect,
    ...yamlConfig,
    ...envConfig,
    ...overrides,
    pricing: mergedPricing,
    pipeline: mergedPipeline,
    routing,
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

/**
 * Resolve the agent and model for a specific pipeline step.
 * Checks pipeline[step] overrides first, then falls back to top-level config.
 * For 'review', falls back to reviewModel before model.
 */
export function resolveStepConfig(
  config: Config,
  step: PipelineStepName,
): { agent: string; model: string } {
  const stepOverride = config.pipeline[step];
  const agent = stepOverride?.agent ?? config.agent;
  const fallbackModel = step === 'review'
    ? (config.reviewModel || config.model)
    : config.model;
  const model = stepOverride?.model ?? fallbackModel;
  return { agent, model };
}

// FNV-1a 32-bit hash of a string. Stable across runs so A/B profile selection
// is deterministic for a given issueId — needed for reproducible reruns.
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Resolve the model and endpoint for a specific Loop routing stage.
 *
 * Returns undefined when `config.routing` is absent — callers should fall back
 * to the existing top-level `agent`/`model` behavior in that case.
 *
 * When `routing.profile` is an array, the profile is chosen deterministically
 * from `issueId` so reruns of the same issue pick the same profile (required
 * for reproducible A/B evaluation).
 */
export function resolveRoutingStage(
  config: Config,
  stage: RoutingStageName,
  _issueId?: number,
): { model: string; endpoint?: RoutingEndpoint } | undefined {
  const routing = config.routing;
  if (!routing) return undefined;
  const stageCfg = routing.stages?.[stage];
  if (!stageCfg) return undefined;
  const endpoint = routing.endpoints?.[stageCfg.endpoint];
  return { model: stageCfg.model, endpoint };
}

/**
 * Deterministically pick a profile name when `routing.profile` is a list.
 *
 * Returns the string profile directly if `profile` is a single string, or a
 * deterministic choice based on `issueId` when it's an array — so reruns of
 * the same issue pick the same profile for reproducible A/B evaluation.
 */
export function selectRoutingProfile(
  config: Config,
  issueId?: number,
): string | undefined {
  const profile = config.routing?.profile;
  if (!profile) return undefined;
  if (typeof profile === 'string') return profile;
  if (profile.length === 0) return undefined;
  if (profile.length === 1 || issueId === undefined) return profile[0];
  return profile[fnv1a32(String(issueId)) % profile.length];
}
