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
  /** Number of recent turns to track per stage for the rolling-error guardrail (default 10). */
  escalation_window_issues?: number;
  /** Rolling-error-rate threshold that triggers a stage revert (default 0.08 = 8%). */
  escalation_error_threshold?: number;
  /** How long a stage stays pinned to the fallback after the threshold fires (default 24h). */
  escalation_revert_ms?: number;
};

/** Normalized fallback policy returned by getFallbackPolicy. */
export type FallbackPolicy = {
  on_tool_error: RoutingFallbackMode;
  escalate_to?: RoutingStageConfig;
  escalation_window_issues: number;
  escalation_error_threshold: number;
  escalation_revert_ms: number;
};

/** Default guardrail values — 10-issue rolling window, 8% error threshold, 24-hour revert. */
export const DEFAULT_ESCALATION_WINDOW = 10;
export const DEFAULT_ESCALATION_ERROR_THRESHOLD = 0.08;
export const DEFAULT_ESCALATION_REVERT_MS = 24 * 60 * 60 * 1000;

/** Per-stage routing configuration for the Loop. */
export type RoutingConfig = {
  profile?: string | string[];
  stages?: Partial<Record<RoutingStageName, RoutingStageConfig>>;
  endpoints?: Record<string, RoutingEndpoint>;
  fallback?: RoutingFallback;
};

export type SessionRetentionConfig = {
  /** 0 disables automatic cleanup for paused/waiting/QA worktrees. */
  pausedWorktreeDays: number;
  /** 0 disables automatic cleanup for completed worktrees. */
  completedWorktreeDays: number;
};

export type EventName =
  | 'session.started'
  | 'session.paused'
  | 'human_input.requested'
  | 'qa.requested'
  | 'feedback.received'
  | 'session.resumed'
  | 'session.completed'
  | 'session.failed'
  | 'daemon.started'
  | 'daemon.idle'
  | 'daemon.health'
  | 'daemon.work.selected'
  | 'daemon.work.skipped'
  | 'daemon.resume.requested'
  | 'daemon.shutdown'
  | 'daemon.failed';

export type EventFilter = EventName | '*';
export type EventFormat = 'json' | 'slack' | 'teams' | 'discord';
export type EventDestinationType = 'log' | 'webhook' | 'command';
export type CommandEventStdinFormat = 'json';

export type BaseEventDestinationConfig = {
  type: EventDestinationType;
  events: EventFilter[];
  format: EventFormat;
  required: boolean;
  timeout: number;
  retries: number;
};

export type LogEventDestinationConfig = BaseEventDestinationConfig & {
  type: 'log';
};

export type WebhookEventDestinationConfig = BaseEventDestinationConfig & {
  type: 'webhook';
  urlEnv: string;
  secretEnv?: string;
};

export type CommandEventDestinationConfig = BaseEventDestinationConfig & {
  type: 'command';
  command: string;
  stdin: CommandEventStdinFormat;
};

export type EventDestinationConfig =
  | LogEventDestinationConfig
  | WebhookEventDestinationConfig
  | CommandEventDestinationConfig;

export type EventsConfig = {
  includePromptText: boolean;
  redact: string[];
  destinations: Record<string, EventDestinationConfig>;
};

export type AutomationPolicyCategory =
  | 'auth'
  | 'billing'
  | 'production-deploy'
  | 'dependency-upgrade'
  | 'sanity-schema'
  | 'secrets'
  | 'migrations'
  | 'destructive-content'
  | 'ambiguous';

export type AutomationPolicyConfig = {
  /** Labels that must be present before hosted automation can start an issue. */
  requireLabels: string[];
  /** Labels that always block automation and request human input. */
  blockLabels: string[];
  /** If set, changed files must match one of these globs. Empty means no allowlist. */
  allowedPaths: string[];
  /** Changed files matching these globs require human input. */
  protectedPaths: string[];
  /** Configured shell commands allowed to run. Empty means no command allowlist. */
  allowedCommands: string[];
  /** Categories that require a human before automation can proceed. */
  requireHumanFor: AutomationPolicyCategory[];
  /** Maximum active session manifests allowed. 0 disables the cap. */
  maxActiveSessions: number;
  /** Maximum paused/waiting session manifests allowed. 0 disables the cap. */
  maxPausedSessions: number;
  /** Maximum issues to process in one session. 0 disables the cap. */
  maxIssuesPerSession: number;
  /** Maximum wall-clock runtime in minutes. 0 disables the cap. */
  maxSessionMinutes: number;
  /** Maximum estimated cost for one session. 0 disables the cap. */
  maxSessionCostUsd: number;
  /** Maximum estimated cost for one issue. 0 disables the cap. */
  maxIssueCostUsd: number;
};

export type DaemonMode = 'full' | 'triage-only' | 'feedback-only' | 'run-only';

export type DaemonLockConfig = {
  enabled: boolean;
  /** Seconds before a still-live lock can be treated as stale. 0 disables age-based staleness. */
  staleAfterSeconds: number;
  /** Optional override for the repo lock path. Defaults to .alpha-loop/daemon.lock. */
  path: string;
};

export type DaemonConfig = {
  mode: DaemonMode;
  triageIntervalSeconds: number;
  feedbackIntervalSeconds: number;
  runIntervalSeconds: number;
  healthIntervalSeconds: number;
  idleSleepSeconds: number;
  feedbackPollCommand: string;
  lock: DaemonLockConfig;
};

export type WebAppViewportPreset = 'desktop' | 'tablet' | 'mobile';

export type WebAppScreenshotConfig = {
  name: string;
  url: string;
  viewport: WebAppViewportPreset;
  width?: number;
  height?: number;
};

export type WebAppPreviewConfig = {
  url: string;
  command: string;
  required: boolean;
};

export type WebAppConfig = {
  setupCommand: string;
  buildCommand: string;
  testCommand: string;
  devCommand: string;
  devUrl: string;
  smokeTest: string;
  screenshots: WebAppScreenshotConfig[];
  preview: WebAppPreviewConfig;
};

export const DEFAULT_SESSION_RETENTION: SessionRetentionConfig = {
  pausedWorktreeDays: 0,
  completedWorktreeDays: 30,
};

export const DEFAULT_EVENTS_CONFIG: EventsConfig = {
  includePromptText: false,
  redact: [],
  destinations: {},
};

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicyConfig = {
  requireLabels: [],
  blockLabels: ['do-not-automate', 'needs-human-input'],
  allowedPaths: [],
  protectedPaths: [],
  allowedCommands: [],
  requireHumanFor: [],
  maxActiveSessions: 0,
  maxPausedSessions: 0,
  maxIssuesPerSession: 0,
  maxSessionMinutes: 0,
  maxSessionCostUsd: 0,
  maxIssueCostUsd: 0,
};

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = {
  mode: 'full',
  triageIntervalSeconds: 15 * 60,
  feedbackIntervalSeconds: 60,
  runIntervalSeconds: 2 * 60,
  healthIntervalSeconds: 5 * 60,
  idleSleepSeconds: 30,
  feedbackPollCommand: '',
  lock: {
    enabled: true,
    staleAfterSeconds: 24 * 60 * 60,
    path: '',
  },
};

export const DEFAULT_WEB_APP_CONFIG: WebAppConfig = {
  setupCommand: '',
  buildCommand: '',
  testCommand: '',
  devCommand: '',
  devUrl: '',
  smokeTest: '',
  screenshots: [],
  preview: {
    url: '',
    command: '',
    required: false,
  },
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

const VALID_EVENT_NAMES: readonly EventName[] = [
  'session.started',
  'session.paused',
  'human_input.requested',
  'qa.requested',
  'feedback.received',
  'session.resumed',
  'session.completed',
  'session.failed',
  'daemon.started',
  'daemon.idle',
  'daemon.health',
  'daemon.work.selected',
  'daemon.work.skipped',
  'daemon.resume.requested',
  'daemon.shutdown',
  'daemon.failed',
] as const;

const VALID_DAEMON_MODES: readonly DaemonMode[] = [
  'full',
  'triage-only',
  'feedback-only',
  'run-only',
] as const;

const VALID_EVENT_FORMATS: readonly EventFormat[] = ['json', 'slack', 'teams', 'discord'] as const;
const VALID_EVENT_DESTINATION_TYPES: readonly EventDestinationType[] = ['log', 'webhook', 'command'] as const;
const VALID_AUTOMATION_POLICY_CATEGORIES: readonly AutomationPolicyCategory[] = [
  'auth',
  'billing',
  'production-deploy',
  'dependency-upgrade',
  'sanity-schema',
  'secrets',
  'migrations',
  'destructive-content',
  'ambiguous',
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
  agent: 'claude' | 'codex' | 'opencode' | 'lmstudio' | 'ollama';
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
  /** Worktree retention policy for durable session state. */
  sessionRetention?: SessionRetentionConfig;
  /** Lifecycle event destinations for hosted/session automation. */
  events?: EventsConfig;
  /** Hosted automation guardrails for issue selection, commands, diffs, runtime, and budget. */
  automationPolicy?: AutomationPolicyConfig;
  /** Long-running hosted daemon mode configuration. */
  daemon?: DaemonConfig;
  /** Optional web/app verification and QA handoff profile. */
  webApp?: WebAppConfig;
  /**
   * When there is exactly one open epic in the repo, the picker auto-selects
   * it instead of prompting. Default: false.
   */
  preferEpics: boolean;
};

const DEFAULTS: Config = {
  repo: '',
  repoOwner: '',
  project: 0,
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
  sessionRetention: DEFAULT_SESSION_RETENTION,
  events: DEFAULT_EVENTS_CONFIG,
  automationPolicy: DEFAULT_AUTOMATION_POLICY,
  daemon: DEFAULT_DAEMON_CONFIG,
  webApp: undefined,
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

function parsePositiveDayValue(value: unknown, key: string): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    console.warn(`[config] ${key}: expected a non-negative number of days (got ${String(value)})`);
    return undefined;
  }
  return Math.floor(value);
}

function parseSessionRetention(raw: unknown): Partial<SessionRetentionConfig> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const retention: Partial<SessionRetentionConfig> = {};
  const paused = parsePositiveDayValue(r.paused_worktree_days, 'session_retention.paused_worktree_days');
  const completed = parsePositiveDayValue(r.completed_worktree_days, 'session_retention.completed_worktree_days');
  if (paused !== undefined) retention.pausedWorktreeDays = paused;
  if (completed !== undefined) retention.completedWorktreeDays = completed;
  return Object.keys(retention).length > 0 ? retention : undefined;
}

function parseEventList(raw: unknown, key: string): EventFilter[] {
  if (raw === undefined) return ['*'];
  const values = Array.isArray(raw) ? raw : [raw];
  const filters: EventFilter[] = [];
  for (const item of values) {
    if (item === '*') {
      filters.push('*');
      continue;
    }
    if (typeof item === 'string' && VALID_EVENT_NAMES.includes(item as EventName)) {
      filters.push(item as EventName);
      continue;
    }
    console.warn(`[config] ${key}: unknown event "${String(item)}" (ignored)`);
  }
  return filters.length > 0 ? filters : ['*'];
}

function parseEventFormat(raw: unknown, key: string): EventFormat {
  if (raw === undefined) return 'json';
  if (typeof raw === 'string' && VALID_EVENT_FORMATS.includes(raw as EventFormat)) {
    return raw as EventFormat;
  }
  console.warn(`[config] ${key}: invalid format "${String(raw)}" (expected one of ${VALID_EVENT_FORMATS.join(', ')})`);
  return 'json';
}

function parseNonNegativeInteger(raw: unknown, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  console.warn(`[config] ${key}: expected a non-negative number (got ${String(raw)})`);
  return fallback;
}

function parsePositiveInteger(raw: unknown, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  console.warn(`[config] ${key}: expected a positive number (got ${String(raw)})`);
  return fallback;
}

function parseBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function parseStringList(raw: unknown, key: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn(`[config] ${key}: expected a list of strings`);
    return undefined;
  }
  return raw.map(String).map((item) => item.trim()).filter(Boolean);
}

function parseStringValue(raw: unknown, key: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw.trim();
  console.warn(`[config] ${key}: expected a string (got ${String(raw)})`);
  return undefined;
}

function parseWebAppViewport(raw: unknown, key: string): WebAppViewportPreset {
  if (raw === undefined) return 'desktop';
  if (raw === 'desktop' || raw === 'tablet' || raw === 'mobile') return raw;
  console.warn(`[config] ${key}: invalid viewport "${String(raw)}" (expected desktop, tablet, or mobile)`);
  return 'desktop';
}

function parsePositiveDimension(raw: unknown, key: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  console.warn(`[config] ${key}: expected a positive number (got ${String(raw)})`);
  return undefined;
}

function parseWebAppScreenshots(raw: unknown): WebAppScreenshotConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn('[config] web_app.screenshots: expected a list of screenshot definitions');
    return undefined;
  }

  const screenshots: WebAppScreenshotConfig[] = [];
  raw.forEach((item, index) => {
    const key = `web_app.screenshots[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      console.warn(`[config] ${key}: expected an object`);
      return;
    }
    const entry = item as Record<string, unknown>;
    const name = parseStringValue(entry.name, `${key}.name`);
    if (!name) {
      console.warn(`[config] ${key}.name: required`);
      return;
    }
    const url = parseStringValue(entry.url, `${key}.url`) ?? '/';
    const screenshot: WebAppScreenshotConfig = {
      name,
      url: url || '/',
      viewport: parseWebAppViewport(entry.viewport, `${key}.viewport`),
    };
    const width = parsePositiveDimension(entry.width, `${key}.width`);
    const height = parsePositiveDimension(entry.height, `${key}.height`);
    if (width !== undefined) screenshot.width = width;
    if (height !== undefined) screenshot.height = height;
    screenshots.push(screenshot);
  });

  return screenshots;
}

function parseWebAppPreview(raw: unknown): WebAppPreviewConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn('[config] web_app.preview: expected an object');
    return undefined;
  }

  const r = raw as Record<string, unknown>;
  return {
    ...DEFAULT_WEB_APP_CONFIG.preview,
    url: parseStringValue(r.url, 'web_app.preview.url') ?? DEFAULT_WEB_APP_CONFIG.preview.url,
    command: parseStringValue(r.command, 'web_app.preview.command') ?? DEFAULT_WEB_APP_CONFIG.preview.command,
    required: parseBoolean(r.required, DEFAULT_WEB_APP_CONFIG.preview.required),
  };
}

function parseWebAppConfig(raw: unknown): WebAppConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn('[config] web_app: expected an object');
    return undefined;
  }

  const r = raw as Record<string, unknown>;
  return {
    ...DEFAULT_WEB_APP_CONFIG,
    setupCommand: parseStringValue(r.setup_command, 'web_app.setup_command') ?? DEFAULT_WEB_APP_CONFIG.setupCommand,
    buildCommand: parseStringValue(r.build_command, 'web_app.build_command') ?? DEFAULT_WEB_APP_CONFIG.buildCommand,
    testCommand: parseStringValue(r.test_command, 'web_app.test_command') ?? DEFAULT_WEB_APP_CONFIG.testCommand,
    devCommand: parseStringValue(r.dev_command, 'web_app.dev_command') ?? DEFAULT_WEB_APP_CONFIG.devCommand,
    devUrl: parseStringValue(r.dev_url, 'web_app.dev_url') ?? DEFAULT_WEB_APP_CONFIG.devUrl,
    smokeTest: parseStringValue(r.smoke_test, 'web_app.smoke_test') ?? DEFAULT_WEB_APP_CONFIG.smokeTest,
    screenshots: parseWebAppScreenshots(r.screenshots) ?? DEFAULT_WEB_APP_CONFIG.screenshots,
    preview: parseWebAppPreview(r.preview) ?? DEFAULT_WEB_APP_CONFIG.preview,
  };
}

function parseAutomationPolicyCategories(raw: unknown): AutomationPolicyCategory[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn('[config] automation_policy.require_human_for: expected a list of category names');
    return undefined;
  }

  const categories: AutomationPolicyCategory[] = [];
  for (const item of raw) {
    const category = String(item).trim().toLowerCase().replace(/_/g, '-') as AutomationPolicyCategory;
    if (!VALID_AUTOMATION_POLICY_CATEGORIES.includes(category)) {
      console.warn(
        `[config] automation_policy.require_human_for: unknown category "${String(item)}" (ignored)`,
      );
      continue;
    }
    categories.push(category);
  }
  return categories;
}

function parseNonNegativeMoney(raw: unknown, key: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  console.warn(`[config] ${key}: expected a non-negative number (got ${String(raw)})`);
  return undefined;
}

function parseAutomationPolicy(raw: unknown): AutomationPolicyConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const policy: AutomationPolicyConfig = { ...DEFAULT_AUTOMATION_POLICY };

  const requireLabels = parseStringList(r.require_labels, 'automation_policy.require_labels');
  if (requireLabels !== undefined) policy.requireLabels = requireLabels;

  const blockLabels = parseStringList(r.block_labels, 'automation_policy.block_labels');
  if (blockLabels !== undefined) policy.blockLabels = blockLabels;

  const allowedPaths = parseStringList(r.allowed_paths, 'automation_policy.allowed_paths');
  if (allowedPaths !== undefined) policy.allowedPaths = allowedPaths;

  const protectedPaths = parseStringList(r.protected_paths, 'automation_policy.protected_paths');
  if (protectedPaths !== undefined) policy.protectedPaths = protectedPaths;

  const allowedCommands = parseStringList(r.allowed_commands, 'automation_policy.allowed_commands');
  if (allowedCommands !== undefined) policy.allowedCommands = allowedCommands;

  const requireHumanFor = parseAutomationPolicyCategories(r.require_human_for);
  if (requireHumanFor !== undefined) policy.requireHumanFor = requireHumanFor;

  policy.maxActiveSessions = parseNonNegativeInteger(
    r.max_active_sessions,
    'automation_policy.max_active_sessions',
    policy.maxActiveSessions,
  );
  policy.maxPausedSessions = parseNonNegativeInteger(
    r.max_paused_sessions,
    'automation_policy.max_paused_sessions',
    policy.maxPausedSessions,
  );
  policy.maxIssuesPerSession = parseNonNegativeInteger(
    r.max_issues_per_session,
    'automation_policy.max_issues_per_session',
    policy.maxIssuesPerSession,
  );
  policy.maxSessionMinutes = parseNonNegativeInteger(
    r.max_session_minutes,
    'automation_policy.max_session_minutes',
    policy.maxSessionMinutes,
  );

  const maxSessionCost = parseNonNegativeMoney(
    r.max_session_cost_usd,
    'automation_policy.max_session_cost_usd',
  );
  if (maxSessionCost !== undefined) policy.maxSessionCostUsd = maxSessionCost;

  const maxIssueCost = parseNonNegativeMoney(
    r.max_issue_cost_usd,
    'automation_policy.max_issue_cost_usd',
  );
  if (maxIssueCost !== undefined) policy.maxIssueCostUsd = maxIssueCost;

  return policy;
}

function parseDaemonMode(raw: unknown, fallback: DaemonMode): DaemonMode {
  if (raw === undefined) return fallback;
  if (typeof raw === 'string' && VALID_DAEMON_MODES.includes(raw as DaemonMode)) {
    return raw as DaemonMode;
  }
  console.warn(`[config] daemon.mode: invalid mode "${String(raw)}" (expected one of ${VALID_DAEMON_MODES.join(', ')})`);
  return fallback;
}

function parseDaemonConfig(raw: unknown): DaemonConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const daemon: DaemonConfig = {
    ...DEFAULT_DAEMON_CONFIG,
    lock: { ...DEFAULT_DAEMON_CONFIG.lock },
  };

  daemon.mode = parseDaemonMode(r.mode, daemon.mode);
  daemon.triageIntervalSeconds = parsePositiveInteger(
    r.triage_interval,
    'daemon.triage_interval',
    daemon.triageIntervalSeconds,
  );
  daemon.feedbackIntervalSeconds = parsePositiveInteger(
    r.feedback_interval,
    'daemon.feedback_interval',
    daemon.feedbackIntervalSeconds,
  );
  daemon.runIntervalSeconds = parsePositiveInteger(
    r.run_interval,
    'daemon.run_interval',
    daemon.runIntervalSeconds,
  );
  daemon.healthIntervalSeconds = parsePositiveInteger(
    r.health_interval,
    'daemon.health_interval',
    daemon.healthIntervalSeconds,
  );
  daemon.idleSleepSeconds = parsePositiveInteger(
    r.idle_sleep,
    'daemon.idle_sleep',
    daemon.idleSleepSeconds,
  );

  if (typeof r.feedback_poll_command === 'string') {
    daemon.feedbackPollCommand = r.feedback_poll_command.trim();
  } else if (r.feedback_poll_command !== undefined) {
    console.warn(`[config] daemon.feedback_poll_command: expected a string (got ${String(r.feedback_poll_command)})`);
  }

  if (typeof r.lock === 'boolean') {
    daemon.lock.enabled = r.lock;
  } else if (r.lock !== undefined && r.lock && typeof r.lock === 'object' && !Array.isArray(r.lock)) {
    const lock = r.lock as Record<string, unknown>;
    daemon.lock.enabled = parseBoolean(lock.enabled, daemon.lock.enabled);
    daemon.lock.staleAfterSeconds = parseNonNegativeInteger(
      lock.stale_after,
      'daemon.lock.stale_after',
      daemon.lock.staleAfterSeconds,
    );
    if (typeof lock.path === 'string') daemon.lock.path = lock.path.trim();
    else if (lock.path !== undefined) console.warn(`[config] daemon.lock.path: expected a string (got ${String(lock.path)})`);
  } else if (r.lock !== undefined) {
    console.warn('[config] daemon.lock: expected a boolean or object');
  }

  if (r.lock_enabled !== undefined) {
    daemon.lock.enabled = parseBoolean(r.lock_enabled, daemon.lock.enabled);
  }
  daemon.lock.staleAfterSeconds = parseNonNegativeInteger(
    r.lock_stale_after,
    'daemon.lock_stale_after',
    daemon.lock.staleAfterSeconds,
  );
  if (typeof r.lock_path === 'string') daemon.lock.path = r.lock_path.trim();

  return daemon;
}

function parseEventsConfig(raw: unknown): EventsConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const destinations: Record<string, EventDestinationConfig> = {};

  if (r.destinations !== undefined) {
    if (!r.destinations || typeof r.destinations !== 'object' || Array.isArray(r.destinations)) {
      console.warn('[config] events.destinations: expected an object keyed by destination name');
    } else {
      for (const [name, value] of Object.entries(r.destinations as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          console.warn(`[config] events.destinations.${name}: expected an object`);
          continue;
        }
        const entry = value as Record<string, unknown>;
        const type = entry.type;
        if (typeof type !== 'string' || !VALID_EVENT_DESTINATION_TYPES.includes(type as EventDestinationType)) {
          console.warn(
            `[config] events.destinations.${name}.type: invalid type "${String(type)}" (expected one of ${VALID_EVENT_DESTINATION_TYPES.join(', ')})`,
          );
          continue;
        }

        const base = {
          events: parseEventList(entry.events, `events.destinations.${name}.events`),
          format: parseEventFormat(entry.format, `events.destinations.${name}.format`),
          required: parseBoolean(entry.required, false),
          timeout: parseNonNegativeInteger(entry.timeout, `events.destinations.${name}.timeout`, 10),
          retries: parseNonNegativeInteger(entry.retries, `events.destinations.${name}.retries`, 0),
        };

        if (type === 'log') {
          destinations[name] = { ...base, type: 'log' };
          continue;
        }

        if (type === 'webhook') {
          if (typeof entry.url_env !== 'string' || !entry.url_env.trim()) {
            console.warn(`[config] events.destinations.${name}.url_env: required for webhook destinations`);
            continue;
          }
          destinations[name] = {
            ...base,
            type: 'webhook',
            urlEnv: entry.url_env.trim(),
            ...(typeof entry.secret_env === 'string' && entry.secret_env.trim()
              ? { secretEnv: entry.secret_env.trim() }
              : {}),
          };
          continue;
        }

        if (typeof entry.command !== 'string' || !entry.command.trim()) {
          console.warn(`[config] events.destinations.${name}.command: required for command destinations`);
          continue;
        }
        const stdin = entry.stdin === undefined || entry.stdin === 'json'
          ? 'json'
          : undefined;
        if (!stdin) {
          console.warn(`[config] events.destinations.${name}.stdin: invalid value "${String(entry.stdin)}" (expected json)`);
          continue;
        }
        destinations[name] = {
          ...base,
          type: 'command',
          command: entry.command.trim(),
          stdin,
        };
      }
    }
  }

  const redact = Array.isArray(r.redact)
    ? r.redact.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
  if (r.redact !== undefined && !Array.isArray(r.redact)) {
    console.warn('[config] events.redact: expected a list of env var names or literal values');
  }

  return {
    includePromptText: r.include_prompt_text === true,
    redact,
    destinations,
  };
}

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
      if (f.escalation_window_issues !== undefined) {
        if (typeof f.escalation_window_issues === 'number' && Number.isFinite(f.escalation_window_issues) && f.escalation_window_issues > 0) {
          fallback.escalation_window_issues = Math.floor(f.escalation_window_issues);
        } else {
          console.warn(
            `[config] routing.fallback.escalation_window_issues: expected a positive number (got ${String(f.escalation_window_issues)})`,
          );
        }
      }
      if (f.escalation_error_threshold !== undefined) {
        if (
          typeof f.escalation_error_threshold === 'number' &&
          Number.isFinite(f.escalation_error_threshold) &&
          f.escalation_error_threshold >= 0 &&
          f.escalation_error_threshold <= 1
        ) {
          fallback.escalation_error_threshold = f.escalation_error_threshold;
        } else {
          console.warn(
            `[config] routing.fallback.escalation_error_threshold: expected a number between 0 and 1 (got ${String(f.escalation_error_threshold)})`,
          );
        }
      }
      if (f.escalation_revert_ms !== undefined) {
        if (typeof f.escalation_revert_ms === 'number' && Number.isFinite(f.escalation_revert_ms) && f.escalation_revert_ms > 0) {
          fallback.escalation_revert_ms = Math.floor(f.escalation_revert_ms);
        } else {
          console.warn(
            `[config] routing.fallback.escalation_revert_ms: expected a positive number of milliseconds (got ${String(f.escalation_revert_ms)})`,
          );
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

  // Handle session retention nested config
  if (parsed.session_retention !== undefined) {
    const sessionRetention = parseSessionRetention(parsed.session_retention);
    if (sessionRetention) {
      result.sessionRetention = {
        ...DEFAULT_SESSION_RETENTION,
        ...sessionRetention,
      };
    }
  }

  // Handle routing nested config (per-stage model + endpoint)
  if (parsed.routing !== undefined) {
    const routing = parseRoutingConfig(parsed.routing);
    if (routing) {
      result.routing = routing;
    }
  }

  // Handle lifecycle event destinations.
  if (parsed.events !== undefined) {
    const events = parseEventsConfig(parsed.events);
    if (events) {
      result.events = events;
    }
  }

  // Handle hosted automation policy guardrails.
  if (parsed.automation_policy !== undefined) {
    const automationPolicy = parseAutomationPolicy(parsed.automation_policy);
    if (automationPolicy) {
      result.automationPolicy = automationPolicy;
    }
  }

  // Handle hosted daemon mode configuration.
  if (parsed.daemon !== undefined) {
    const daemon = parseDaemonConfig(parsed.daemon);
    if (daemon) {
      result.daemon = daemon;
    }
  }

  // Handle web/app verification profile.
  if (parsed.web_app !== undefined) {
    const webApp = parseWebAppConfig(parsed.web_app);
    if (webApp) {
      result.webApp = webApp;
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
  const paused = process.env.SESSION_RETENTION_PAUSED_WORKTREE_DAYS;
  const completed = process.env.SESSION_RETENTION_COMPLETED_WORKTREE_DAYS;
  if (paused !== undefined || completed !== undefined) {
    result.sessionRetention = {
      ...DEFAULT_SESSION_RETENTION,
      ...(paused !== undefined ? { pausedWorktreeDays: Number(paused) } : {}),
      ...(completed !== undefined ? { completedWorktreeDays: Number(completed) } : {}),
    };
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
  const sessionRetention = {
    ...DEFAULT_SESSION_RETENTION,
    ...yamlConfig.sessionRetention,
    ...envConfig.sessionRetention,
    ...overrides?.sessionRetention,
  };
  const events = overrides?.events ?? yamlConfig.events ?? DEFAULTS.events;
  const webApp = overrides?.webApp ?? yamlConfig.webApp;
  const automationPolicy = {
    ...DEFAULT_AUTOMATION_POLICY,
    ...yamlConfig.automationPolicy,
    ...overrides?.automationPolicy,
  };
  const daemon = {
    ...DEFAULT_DAEMON_CONFIG,
    ...yamlConfig.daemon,
    ...overrides?.daemon,
    lock: {
      ...DEFAULT_DAEMON_CONFIG.lock,
      ...yamlConfig.daemon?.lock,
      ...overrides?.daemon?.lock,
    },
  };

  const merged: Config = {
    ...DEFAULTS,
    ...autoDetect,
    ...yamlConfig,
    ...envConfig,
    ...overrides,
    pricing: mergedPricing,
    pipeline: mergedPipeline,
    routing,
    sessionRetention,
    events,
    webApp,
    automationPolicy,
    daemon,
  };

  // Validate agent is a known value
  const VALID_AGENTS = ['claude', 'codex', 'opencode', 'lmstudio', 'ollama'] as const;
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
 * Returns undefined when `config.routing` is absent or the stage isn't
 * configured — callers should fall back to the existing top-level
 * `agent`/`model` behavior in that case.
 */
export function resolveRoutingStage(
  config: Config,
  stage: RoutingStageName,
): { model: string; endpoint?: RoutingEndpoint } | undefined {
  const routing = config.routing;
  if (!routing) return undefined;
  const stageCfg = routing.stages?.[stage];
  if (!stageCfg) return undefined;
  const endpoint = routing.endpoints?.[stageCfg.endpoint];
  return { model: stageCfg.model, endpoint };
}

/**
 * Return the normalized fallback policy for a config, or null when routing has
 * no fallback configured. Fills guardrail fields with defaults.
 */
export function getFallbackPolicy(config: Config): FallbackPolicy | null {
  const fallback = config.routing?.fallback;
  if (!fallback) return null;
  return {
    on_tool_error: fallback.on_tool_error,
    escalate_to: fallback.escalate_to,
    escalation_window_issues: fallback.escalation_window_issues ?? DEFAULT_ESCALATION_WINDOW,
    escalation_error_threshold: fallback.escalation_error_threshold ?? DEFAULT_ESCALATION_ERROR_THRESHOLD,
    escalation_revert_ms: fallback.escalation_revert_ms ?? DEFAULT_ESCALATION_REVERT_MS,
  };
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
