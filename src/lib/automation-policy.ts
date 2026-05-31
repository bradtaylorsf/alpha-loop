import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_AUTOMATION_POLICY,
  type AutomationPolicyCategory,
  type AutomationPolicyConfig,
  type Config,
} from './config.js';
import {
  loadSessionManifest,
  sessionManifestPath,
  type DurableSessionManifest,
} from './session.js';
import { isWaitingFeedbackStatus } from './session-state.js';

export type AutomationPolicyDecisionStatus = 'allowed' | 'blocked' | 'needs_human';

export type AutomationPolicyDecisionStage =
  | 'session_start'
  | 'issue_start'
  | 'command'
  | 'runtime'
  | 'budget'
  | 'diff';

export type AutomationPolicyDecision = {
  id: string;
  status: AutomationPolicyDecisionStatus;
  stage: AutomationPolicyDecisionStage;
  reason: string;
  reasons: string[];
  createdAt: string;
  issueNum?: number;
  title?: string;
  labels?: string[];
  command?: string;
  paths?: string[];
  categories?: AutomationPolicyCategory[];
  metadata?: Record<string, unknown>;
};

export type PolicyIssue = {
  number: number;
  title: string;
  body?: string;
  labels?: unknown[];
};

type SessionCounts = {
  active: number;
  paused: number;
};

const FALLBACK_AUTOMATION_POLICY: AutomationPolicyConfig = {
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

const ACTIVE_SESSION_STATUSES = new Set([
  'running',
  'active',
  'resuming',
  'resumed',
]);

const CATEGORY_PATTERNS: Record<AutomationPolicyCategory, RegExp[]> = {
  auth: [
    /\bauth(?:entication|orization)?\b/i,
    /\blog\s?in\b/i,
    /\bsign\s?in\b/i,
    /\boauth\b/i,
    /\bpassword\b/i,
    /\bsession\b/i,
  ],
  billing: [
    /\bbilling\b/i,
    /\bpayment\b/i,
    /\bstripe\b/i,
    /\binvoice\b/i,
    /\bsubscription\b/i,
    /\bcheckout\b/i,
  ],
  'production-deploy': [
    /\bproduction\s+deploy\b/i,
    /\bdeploy(?:ing)?\s+to\s+prod(?:uction)?\b/i,
    /\brelease\s+to\s+production\b/i,
    /\bprod\s+deploy\b/i,
  ],
  'dependency-upgrade': [
    /\bdependency\b/i,
    /\bdependencies\b/i,
    /\bupgrade\b/i,
    /\bbump\b/i,
    /\brenovate\b/i,
    /\bpackage\.json\b/i,
    /\bpnpm-lock\.yaml\b/i,
    /\bnpm\s+install\b/i,
  ],
  'sanity-schema': [
    /\bsanity\/schema\b/i,
    /\bsanity\s+schema\b/i,
    /\bschema\s+change\b/i,
  ],
  secrets: [
    /\bsecret\b/i,
    /\bapi\s*key\b/i,
    /\btoken\b/i,
    /\bcredential\b/i,
    /\b\.env\b/i,
  ],
  migrations: [
    /\bmigration\b/i,
    /\bmigrate\b/i,
    /\bdatabase\s+schema\b/i,
    /\bdb\s+schema\b/i,
  ],
  'destructive-content': [
    /\bdelete\s+(?:all|content|pages|posts|records)\b/i,
    /\bremove\s+(?:all|content|pages|posts|records)\b/i,
    /\bwipe\b/i,
    /\bpurge\b/i,
    /\bdestructive\b/i,
  ],
  ambiguous: [
    /\bambiguous\b/i,
    /\bunclear\b/i,
    /\bnot\s+sure\b/i,
    /\btbd\b/i,
    /\bfigure\s+out\b/i,
  ],
};

export function normalizeAutomationPolicy(policy?: AutomationPolicyConfig): AutomationPolicyConfig {
  return {
    ...(DEFAULT_AUTOMATION_POLICY ?? FALLBACK_AUTOMATION_POLICY),
    ...(policy ?? {}),
  };
}

export function decisionAllowed(decision: AutomationPolicyDecision): boolean {
  return decision.status === 'allowed';
}

function makeDecision(args: {
  status: AutomationPolicyDecisionStatus;
  stage: AutomationPolicyDecisionStage;
  reasons: string[];
  issueNum?: number;
  title?: string;
  labels?: string[];
  command?: string;
  paths?: string[];
  categories?: AutomationPolicyCategory[];
  metadata?: Record<string, unknown>;
}): AutomationPolicyDecision {
  const reasons = args.reasons.filter(Boolean);
  return {
    id: `policy-${randomUUID()}`,
    status: args.status,
    stage: args.stage,
    reason: reasons[0] ?? (args.status === 'allowed' ? 'Automation policy allowed this action.' : 'Automation policy blocked this action.'),
    reasons,
    createdAt: new Date().toISOString(),
    ...(args.issueNum !== undefined ? { issueNum: args.issueNum } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.labels !== undefined ? { labels: args.labels } : {}),
    ...(args.command !== undefined ? { command: args.command } : {}),
    ...(args.paths !== undefined ? { paths: args.paths } : {}),
    ...(args.categories !== undefined ? { categories: args.categories } : {}),
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
  };
}

function allowedDecision(stage: AutomationPolicyDecisionStage, metadata?: Record<string, unknown>): AutomationPolicyDecision {
  return makeDecision({
    status: 'allowed',
    stage,
    reasons: ['Automation policy allowed this action.'],
    metadata,
  });
}

function labelName(label: unknown): string | null {
  if (typeof label === 'string') return label;
  if (label && typeof label === 'object' && 'name' in label) {
    const name = (label as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function issueLabelSet(issue: PolicyIssue): Set<string> {
  return new Set((issue.labels ?? [])
    .map(labelName)
    .filter((label): label is string => Boolean(label))
    .map(normalizeLabel));
}

export function evaluateIssuePolicy(
  config: Config,
  issue: PolicyIssue,
): AutomationPolicyDecision {
  const policy = normalizeAutomationPolicy(config.automationPolicy);
  const labels = Array.from(issueLabelSet(issue));
  const labelSet = new Set(labels);
  const reasons: string[] = [];

  for (const required of policy.requireLabels.map(normalizeLabel)) {
    if (!labelSet.has(required)) {
      reasons.push(`Missing required label "${required}".`);
    }
  }

  for (const blocked of policy.blockLabels.map(normalizeLabel)) {
    if (labelSet.has(blocked)) {
      reasons.push(`Issue has blocked label "${blocked}".`);
    }
  }

  const text = `${issue.title}\n${issue.body ?? ''}`;
  const categories = policy.requireHumanFor.filter((category) => (
    CATEGORY_PATTERNS[category].some((pattern) => pattern.test(text))
  ));
  for (const category of categories) {
    reasons.push(`Issue appears to involve "${category}", which requires human input.`);
  }

  if (reasons.length === 0) {
    return makeDecision({
      status: 'allowed',
      stage: 'issue_start',
      reasons: ['Issue passed automation policy.'],
      issueNum: issue.number,
      title: issue.title,
      labels,
    });
  }

  return makeDecision({
    status: categories.length > 0 ? 'needs_human' : 'blocked',
    stage: 'issue_start',
    reasons,
    issueNum: issue.number,
    title: issue.title,
    labels,
    categories: categories.length > 0 ? categories : undefined,
  });
}

function normalizePathForPolicy(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function escapeRegex(char: string): string {
  return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
}

export function globMatches(path: string, pattern: string): boolean {
  const normalizedPath = normalizePathForPolicy(path);
  const normalizedPattern = normalizePathForPolicy(pattern);
  if (!normalizedPattern) return false;
  if (!/[*?]/.test(normalizedPattern)) {
    return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern.replace(/\/+$/, '')}/`);
  }

  let source = '';
  for (let i = 0; i < normalizedPattern.length; i++) {
    const char = normalizedPattern[i];
    const next = normalizedPattern[i + 1];
    const afterNext = normalizedPattern[i + 2];
    if (char === '*' && next === '*' && afterNext === '/') {
      source += '(?:.*/)?';
      i += 2;
      continue;
    }
    if (char === '*' && next === '*') {
      source += '.*';
      i += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`).test(normalizedPath);
}

function matchingPaths(paths: string[], patterns: string[]): string[] {
  return paths.filter((path) => patterns.some((pattern) => globMatches(path, pattern)));
}

export function parseDiffNameOnly(output: string): string[] {
  return output
    .split('\n')
    .map((line) => normalizePathForPolicy(line))
    .filter(Boolean);
}

export function evaluateDiffPolicy(
  config: Config,
  paths: string[],
  args: { issueNum?: number; title?: string; stage?: AutomationPolicyDecisionStage } = {},
): AutomationPolicyDecision {
  const policy = normalizeAutomationPolicy(config.automationPolicy);
  const normalizedPaths = Array.from(new Set(paths.map(normalizePathForPolicy).filter(Boolean)));
  if (normalizedPaths.length === 0) {
    return makeDecision({
      status: 'allowed',
      stage: args.stage ?? 'diff',
      reasons: ['No changed paths to evaluate.'],
      issueNum: args.issueNum,
      title: args.title,
      paths: [],
    });
  }

  const protectedMatches = matchingPaths(normalizedPaths, policy.protectedPaths);
  const outsideAllowed = policy.allowedPaths.length > 0
    ? normalizedPaths.filter((path) => !policy.allowedPaths.some((pattern) => globMatches(path, pattern)))
    : [];

  const reasons: string[] = [];
  if (protectedMatches.length > 0) {
    reasons.push(`Changed protected path(s): ${protectedMatches.join(', ')}.`);
  }
  if (outsideAllowed.length > 0) {
    reasons.push(`Changed path(s) outside allowed_paths: ${outsideAllowed.join(', ')}.`);
  }

  if (reasons.length === 0) {
    return makeDecision({
      status: 'allowed',
      stage: args.stage ?? 'diff',
      reasons: ['Changed paths passed automation policy.'],
      issueNum: args.issueNum,
      title: args.title,
      paths: normalizedPaths,
    });
  }

  return makeDecision({
    status: 'needs_human',
    stage: args.stage ?? 'diff',
    reasons,
    issueNum: args.issueNum,
    title: args.title,
    paths: Array.from(new Set([...protectedMatches, ...outsideAllowed])),
  });
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function hasShellControlOperator(commandSuffix: string): boolean {
  return /[;&|<>`]/.test(commandSuffix)
    || commandSuffix.includes('$(')
    || /[\r\n]/.test(commandSuffix);
}

function suffixAllowedAsArguments(commandSuffix: string): boolean {
  const suffix = commandSuffix.trim();
  return suffix.length === 0 || !hasShellControlOperator(suffix);
}

function commandAllowed(command: string, allowedCommand: string): boolean {
  const normalized = normalizeCommand(command);
  const allowed = normalizeCommand(allowedCommand);
  if (!allowed) return false;
  if (allowed.endsWith('*')) {
    const prefix = allowed.slice(0, -1).trimEnd();
    if (!normalized.startsWith(prefix)) return false;
    return suffixAllowedAsArguments(normalized.slice(prefix.length));
  }
  if (normalized === allowed) return true;
  if (!normalized.startsWith(`${allowed} `)) return false;
  return suffixAllowedAsArguments(normalized.slice(allowed.length));
}

export function evaluateCommandPolicy(
  config: Config,
  command: string,
  args: { issueNum?: number; title?: string; stage?: AutomationPolicyDecisionStage } = {},
): AutomationPolicyDecision {
  const policy = normalizeAutomationPolicy(config.automationPolicy);
  const normalized = normalizeCommand(command);
  if (!normalized || policy.allowedCommands.length === 0) {
    return makeDecision({
      status: 'allowed',
      stage: args.stage ?? 'command',
      reasons: ['Command policy has no allowlist or command is empty.'],
      issueNum: args.issueNum,
      title: args.title,
      command: normalized,
    });
  }

  if (policy.allowedCommands.some((allowed) => commandAllowed(normalized, allowed))) {
    return makeDecision({
      status: 'allowed',
      stage: args.stage ?? 'command',
      reasons: ['Command matched automation policy allowed_commands.'],
      issueNum: args.issueNum,
      title: args.title,
      command: normalized,
    });
  }

  return makeDecision({
    status: 'blocked',
    stage: args.stage ?? 'command',
    reasons: [`Command is not in automation_policy.allowed_commands: ${normalized}.`],
    issueNum: args.issueNum,
    title: args.title,
    command: normalized,
    metadata: { allowedCommands: policy.allowedCommands },
  });
}

export function evaluateRuntimePolicy(
  config: Config,
  elapsedMs: number,
): AutomationPolicyDecision {
  const policy = normalizeAutomationPolicy(config.automationPolicy);
  if (policy.maxSessionMinutes <= 0) return allowedDecision('runtime');
  const elapsedMinutes = elapsedMs / 60_000;
  if (elapsedMinutes < policy.maxSessionMinutes) {
    return allowedDecision('runtime', { elapsedMinutes, maxSessionMinutes: policy.maxSessionMinutes });
  }
  return makeDecision({
    status: 'blocked',
    stage: 'runtime',
    reasons: [`Maximum automation runtime reached (${Math.floor(elapsedMinutes)}m / ${policy.maxSessionMinutes}m).`],
    metadata: { elapsedMinutes, maxSessionMinutes: policy.maxSessionMinutes },
  });
}

export function evaluateCostPolicy(
  config: Config,
  args: { issueCostUsd?: number; sessionCostUsd?: number; issueNum?: number; title?: string },
): AutomationPolicyDecision {
  const policy = normalizeAutomationPolicy(config.automationPolicy);
  const reasons: string[] = [];
  if (
    policy.maxIssueCostUsd > 0
    && args.issueCostUsd !== undefined
    && args.issueCostUsd >= policy.maxIssueCostUsd
  ) {
    reasons.push(`Maximum issue budget reached ($${args.issueCostUsd.toFixed(4)} / $${policy.maxIssueCostUsd.toFixed(4)}).`);
  }
  if (
    policy.maxSessionCostUsd > 0
    && args.sessionCostUsd !== undefined
    && args.sessionCostUsd >= policy.maxSessionCostUsd
  ) {
    reasons.push(`Maximum session budget reached ($${args.sessionCostUsd.toFixed(4)} / $${policy.maxSessionCostUsd.toFixed(4)}).`);
  }

  if (reasons.length === 0) {
    return allowedDecision('budget', {
      issueCostUsd: args.issueCostUsd ?? null,
      sessionCostUsd: args.sessionCostUsd ?? null,
    });
  }

  return makeDecision({
    status: 'blocked',
    stage: 'budget',
    reasons,
    issueNum: args.issueNum,
    title: args.title,
    metadata: {
      issueCostUsd: args.issueCostUsd ?? null,
      sessionCostUsd: args.sessionCostUsd ?? null,
      maxIssueCostUsd: policy.maxIssueCostUsd,
      maxSessionCostUsd: policy.maxSessionCostUsd,
    },
  });
}

function readSessionManifests(
  sessionsRoot = join(process.cwd(), '.alpha-loop', 'sessions'),
): DurableSessionManifest[] {
  if (!existsSync(sessionsRoot)) return [];
  const manifests: DurableSessionManifest[] = [];
  try {
    for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDir = join(sessionsRoot, group.name);
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifest = loadSessionManifest(sessionManifestPath(join(groupDir, entry.name)));
        if (manifest) manifests.push(manifest);
      }
    }
  } catch {
    return manifests;
  }
  return manifests;
}

function countSessions(manifests: DurableSessionManifest[], excludeSessionId?: string): SessionCounts {
  const filtered = excludeSessionId
    ? manifests.filter((manifest) => manifest.sessionId !== excludeSessionId)
    : manifests;
  let active = 0;
  let paused = 0;
  for (const manifest of filtered) {
    const manifestStatus = String(manifest.status);
    const feedbackStatus = String(manifest.feedback?.currentStatus ?? '');
    const status = manifestStatus !== 'running' && feedbackStatus === 'running'
      ? manifestStatus
      : (feedbackStatus || manifestStatus);
    if (ACTIVE_SESSION_STATUSES.has(status)) active++;
    if (isWaitingFeedbackStatus(status)) paused++;
  }
  return { active, paused };
}

export function evaluateSessionCapacityPolicy(
  config: Config,
  args: { sessionsRoot?: string; excludeSessionId?: string } = {},
): AutomationPolicyDecision {
  const policy = normalizeAutomationPolicy(config.automationPolicy);
  if (policy.maxActiveSessions <= 0 && policy.maxPausedSessions <= 0) {
    return allowedDecision('session_start');
  }
  const counts = countSessions(readSessionManifests(args.sessionsRoot), args.excludeSessionId);
  const reasons: string[] = [];
  if (policy.maxActiveSessions > 0 && counts.active >= policy.maxActiveSessions) {
    reasons.push(`Maximum active sessions reached (${counts.active} / ${policy.maxActiveSessions}).`);
  }
  if (policy.maxPausedSessions > 0 && counts.paused >= policy.maxPausedSessions) {
    reasons.push(`Maximum paused sessions reached (${counts.paused} / ${policy.maxPausedSessions}).`);
  }

  if (reasons.length === 0) {
    return allowedDecision('session_start', {
      activeSessions: counts.active,
      pausedSessions: counts.paused,
    });
  }

  return makeDecision({
    status: 'blocked',
    stage: 'session_start',
    reasons,
    metadata: {
      activeSessions: counts.active,
      pausedSessions: counts.paused,
      maxActiveSessions: policy.maxActiveSessions,
      maxPausedSessions: policy.maxPausedSessions,
    },
  });
}

export function maxIssuesPerPolicySession(config: Config): number {
  return normalizeAutomationPolicy(config.automationPolicy).maxIssuesPerSession;
}

export function formatAutomationPolicyComment(decision: AutomationPolicyDecision): string {
  const lines = [
    '## Alpha Loop paused for human input',
    '',
    `Automation policy stopped this work at \`${decision.stage}\`.`,
    '',
    'Reasons:',
    ...decision.reasons.map((reason) => `- ${reason}`),
  ];

  if (decision.command) {
    lines.push('', `Command: \`${decision.command.replace(/`/g, '\\`')}\``);
  }
  if (decision.paths && decision.paths.length > 0) {
    lines.push('', 'Paths:', ...decision.paths.map((path) => `- \`${path.replace(/`/g, '\\`')}\``));
  }
  if (decision.categories && decision.categories.length > 0) {
    lines.push('', `Categories: ${decision.categories.map((category) => `\`${category}\``).join(', ')}`);
  }

  lines.push('', 'A human can adjust the issue, labels, or `.alpha-loop.yaml`, then resume the session.');
  return lines.join('\n');
}
