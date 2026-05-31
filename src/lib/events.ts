/**
 * Lifecycle events — canonical session payloads plus destination delivery.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { log } from './logger.js';
import {
  loadSessionManifest,
  recordSessionLogFile,
  type DurableSessionManifest,
  type SessionContext,
} from './session.js';
import {
  type CommandEventDestinationConfig,
  type Config,
  type EventDestinationConfig,
  type EventFormat,
  type EventName,
  type EventsConfig,
  type WebhookEventDestinationConfig,
} from './config.js';

const MAX_PROMPT_TEXT_CHARS = 12_000;
const MAX_RESPONSE_CHARS = 2_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const FALLBACK_EVENTS_CONFIG: EventsConfig = {
  includePromptText: false,
  redact: [],
  destinations: {},
};

class WebhookDeliveryError extends Error {
  readonly responseStatus: number;
  readonly responseBody: string;

  constructor(status: number, body: string) {
    super(`Webhook responded with HTTP ${status}${body ? `: ${body}` : ''}`);
    this.name = 'WebhookDeliveryError';
    this.responseStatus = status;
    this.responseBody = body;
  }
}

class CommandDeliveryError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;

  constructor(exitCode: number, stdout: string, stderr: string) {
    super(`Command exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`);
    this.name = 'CommandDeliveryError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export type LifecycleEventContext = {
  issueNumber?: number | null;
  issueTitle?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  branch?: string | null;
  worktreePath?: string | null;
  previewUrl?: string | null;
  qaChecklist?: string[];
  question?: string | null;
  resumeInstructions?: string | null;
  reason?: string | null;
  error?: string | null;
  feedback?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type LifecycleEvent = {
  id: string;
  type: EventName;
  createdAt: string;
  repo: {
    fullName: string;
    owner: string;
    name: string;
  };
  issue: {
    number: number;
    title: string | null;
    status: string | null;
    stage: string | null;
    labels: string[];
  } | null;
  issues: Array<{
    number: number;
    title: string | null;
    status: string | null;
    stage: string | null;
    prUrl: string | null;
  }>;
  pr: {
    url: string | null;
    number: number | null;
  };
  session: {
    id: string | null;
    name: string | null;
    status: string | null;
    stage: string | null;
    branch: string | null;
    baseBranch: string | null;
    parentEpicNumber: number | null;
    startedAt: string | null;
    updatedAt: string | null;
    endedAt: string | null;
  };
  branch: {
    name: string | null;
    base: string | null;
  };
  worktree: {
    path: string | null;
    branch: string | null;
    missing: boolean | null;
  };
  logs: {
    sessionDir: string | null;
    logsDir: string | null;
    traceDir: string | null;
    files: string[];
    eventLogPath: string | null;
  };
  screenshots: string[];
  previewUrl: string | null;
  qaChecklist: string[];
  harness: {
    agent: string | null;
    model: string | null;
    reviewModel: string | null;
    command: string | null;
    testCommand: string | null;
    promptPath: string | null;
    promptHash: string | null;
    promptText?: string;
    transcriptPath: string | null;
    transcriptPaths: string[];
    sessionLogPath: string | null;
  };
  humanInput: {
    question: string | null;
    resumeInstructions: string | null;
    reason: string | null;
  };
  feedback: Record<string, unknown> | null;
  error: string | null;
  metadata: Record<string, unknown>;
};

export type EventDeliveryRecord = {
  kind: 'delivery';
  eventId: string;
  eventType: EventName;
  destination: string;
  destinationType: EventDestinationConfig['type'];
  format: EventFormat;
  attempt: number;
  status: 'success' | 'failed' | 'skipped' | 'dry-run';
  required: boolean;
  timestamp: string;
  durationMs: number;
  responseStatus?: number;
  responseBody?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
};

export type EventDeliverySummary = {
  event: LifecycleEvent;
  deliveries: EventDeliveryRecord[];
};

type EmitLifecycleEventInput = {
  config: Config;
  type: EventName;
  session?: Pick<SessionContext, 'resultsDir' | 'logsDir' | 'manifestPath' | 'name' | 'branch'> | null;
  manifestPath?: string | null;
  manifest?: DurableSessionManifest | null;
  context?: LifecycleEventContext;
  now?: string;
};

function eventConfig(config: Config): EventsConfig {
  return config.events ?? FALLBACK_EVENTS_CONFIG;
}

function repoParts(fullName: string): { owner: string; name: string } {
  const [owner = '', name = ''] = fullName.split('/');
  return { owner, name };
}

function prNumberFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)(?:\b|$)/);
  return match ? Number(match[1]) : null;
}

function resolvePath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  return isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);
}

function readPromptText(config: Config, manifest: DurableSessionManifest | null): string | undefined {
  if (!eventConfig(config).includePromptText || !manifest?.promptPath) return undefined;
  const promptPath = resolvePath(manifest.promptPath);
  if (!promptPath || !existsSync(promptPath)) return undefined;
  try {
    const raw = readFileSync(promptPath, 'utf-8');
    if (raw.length <= MAX_PROMPT_TEXT_CHARS) return raw;
    return `${raw.slice(0, MAX_PROMPT_TEXT_CHARS)}\n[truncated: prompt exceeded ${MAX_PROMPT_TEXT_CHARS} characters]`;
  } catch {
    return undefined;
  }
}

function loadManifest(input: EmitLifecycleEventInput): DurableSessionManifest | null {
  if (Object.prototype.hasOwnProperty.call(input, 'manifest')) return input.manifest ?? null;
  if (input.manifestPath) return loadSessionManifest(input.manifestPath);
  if (input.session) return loadSessionManifest(input.session);
  return null;
}

function eventLogPath(
  session: EmitLifecycleEventInput['session'],
  manifest: DurableSessionManifest | null,
): string | null {
  const logsDir = session?.logsDir
    ?? resolvePath(manifest?.logs.logsDir ?? null);
  return logsDir ? join(logsDir, 'events.jsonl') : null;
}

function manifestIssue(
  manifest: DurableSessionManifest | null,
  issueNumber: number | null | undefined,
): DurableSessionManifest['issues'][number] | undefined {
  if (!manifest) return undefined;
  if (issueNumber !== undefined && issueNumber !== null) {
    return manifest.issues.find((issue) => issue.issueNum === issueNumber);
  }
  if (manifest.currentIssue?.issueNum !== undefined) {
    return manifest.issues.find((issue) => issue.issueNum === manifest.currentIssue?.issueNum);
  }
  return manifest.issues[0];
}

export function buildLifecycleEvent(input: EmitLifecycleEventInput): LifecycleEvent {
  const manifest = loadManifest(input);
  const context = input.context ?? {};
  const repo = input.config.repo;
  const { owner, name } = repoParts(repo);
  const eventLog = eventLogPath(input.session, manifest);
  const selectedIssueNumber = context.issueNumber
    ?? manifest?.currentIssue?.issueNum
    ?? manifest?.issueNumber
    ?? null;
  const issueEntry = manifestIssue(manifest, selectedIssueNumber);
  const issueTitle = context.issueTitle
    ?? manifest?.currentIssue?.title
    ?? issueEntry?.title
    ?? null;
  const prUrl = context.prUrl
    ?? issueEntry?.prUrl
    ?? manifest?.feedback?.prUrl
    ?? manifest?.prUrl
    ?? manifest?.sessionPrUrl
    ?? null;
  const previewUrl = context.previewUrl
    ?? manifest?.feedback?.previewUrl
    ?? manifest?.previewUrl
    ?? null;
  const qaChecklist = context.qaChecklist
    ?? manifest?.feedback?.qaChecklist
    ?? [];
  const promptText = readPromptText(input.config, manifest);

  return {
    id: randomUUID(),
    type: input.type,
    createdAt: input.now ?? new Date().toISOString(),
    repo: {
      fullName: repo,
      owner,
      name,
    },
    issue: selectedIssueNumber ? {
      number: selectedIssueNumber,
      title: issueTitle,
      status: issueEntry?.status ?? null,
      stage: issueEntry?.stage ?? null,
      labels: issueEntry?.labels ?? manifest?.labels ?? [],
    } : null,
    issues: (manifest?.issues ?? []).map((issue) => ({
      number: issue.issueNum,
      title: issue.title ?? null,
      status: issue.status ?? null,
      stage: issue.stage ?? null,
      prUrl: issue.prUrl ?? null,
    })),
    pr: {
      url: prUrl,
      number: context.prNumber ?? prNumberFromUrl(prUrl),
    },
    session: {
      id: manifest?.sessionId ?? input.session?.name ?? null,
      name: manifest?.name ?? input.session?.name ?? null,
      status: manifest?.status ?? null,
      stage: manifest?.stage ?? null,
      branch: manifest?.branch ?? input.session?.branch ?? null,
      baseBranch: manifest?.baseBranch ?? input.config.baseBranch,
      parentEpicNumber: manifest?.parentEpicNumber ?? null,
      startedAt: manifest?.timestamps.startedAt ?? null,
      updatedAt: manifest?.timestamps.updatedAt ?? null,
      endedAt: manifest?.timestamps.endedAt ?? null,
    },
    branch: {
      name: context.branch ?? manifest?.worktree?.branch ?? manifest?.lastKnownBranch ?? manifest?.branch ?? input.session?.branch ?? null,
      base: manifest?.baseBranch ?? input.config.baseBranch,
    },
    worktree: {
      path: context.worktreePath ?? manifest?.worktree?.path ?? issueEntry?.worktreePath ?? null,
      branch: context.branch ?? manifest?.worktree?.branch ?? issueEntry?.branch ?? null,
      missing: manifest?.worktree?.missing ?? issueEntry?.worktreeMissing ?? null,
    },
    logs: {
      sessionDir: manifest?.logs.sessionDir ?? (input.session?.resultsDir ?? null),
      logsDir: manifest?.logs.logsDir ?? (input.session?.logsDir ?? null),
      traceDir: manifest?.logs.traceDir ?? null,
      files: manifest?.logs.files ?? [],
      eventLogPath: eventLog,
    },
    screenshots: manifest?.screenshots ?? [],
    previewUrl,
    qaChecklist,
    harness: {
      agent: manifest?.harness.agent ?? input.config.agent ?? null,
      model: manifest?.harness.model ?? input.config.model ?? null,
      reviewModel: manifest?.harness.reviewModel ?? input.config.reviewModel ?? null,
      command: manifest?.harness.command ?? manifest?.command ?? input.config.agent ?? null,
      testCommand: manifest?.harness.testCommand ?? input.config.testCommand ?? null,
      promptPath: manifest?.promptPath ?? null,
      promptHash: manifest?.promptHash ?? null,
      ...(promptText !== undefined ? { promptText } : {}),
      transcriptPath: manifest?.transcriptPath ?? null,
      transcriptPaths: manifest?.transcripts.map((entry) => entry.path) ?? [],
      sessionLogPath: manifest?.logs.logsDir ?? (input.session?.logsDir ?? null),
    },
    humanInput: {
      question: context.question ?? manifest?.feedback?.question ?? null,
      resumeInstructions: context.resumeInstructions ?? manifest?.feedback?.resumeInstructions ?? null,
      reason: context.reason ?? null,
    },
    feedback: context.feedback ?? (manifest?.feedback.latestFeedback ? {
      source: manifest.feedback.latestFeedback.source,
      classification: manifest.feedback.latestFeedback.classification,
      author: manifest.feedback.latestFeedback.author,
      externalEventId: manifest.feedback.latestFeedback.externalEventId,
      externalThreadId: manifest.feedback.latestFeedback.externalThreadId,
      externalMessageId: manifest.feedback.latestFeedback.externalMessageId,
      receivedAt: manifest.feedback.latestFeedback.receivedAt,
    } : null),
    error: context.error ?? manifest?.errors.at(-1)?.message ?? null,
    metadata: context.metadata ?? {},
  };
}

function redactString(value: string, secretValues: string[]): string {
  return secretValues.reduce((current, secret) => (
    secret ? current.split(secret).join('[REDACTED]') : current
  ), value);
}

function redactValue(value: unknown, key: string | null, redactionKeys: Set<string>, secretValues: string[]): unknown {
  if (key && redactionKeys.has(key.toLowerCase())) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value, secretValues);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, null, redactionKeys, secretValues));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    out[childKey] = redactValue(childValue, childKey, redactionKeys, secretValues);
  }
  return out;
}

export function redactLifecycleEvent(event: LifecycleEvent, config: Config): LifecycleEvent {
  const redact = eventConfig(config).redact;
  if (redact.length === 0) return event;
  const redactionKeys = new Set(redact.map((item) => item.toLowerCase()));
  const secretValues = redact
    .flatMap((item) => [process.env[item], item])
    .filter((item): item is string => Boolean(item && item.length >= 3));
  return redactValue(event, null, redactionKeys, secretValues) as LifecycleEvent;
}

function eventSummary(event: LifecycleEvent): string {
  const issue = event.issue ? ` #${event.issue.number}` : '';
  const title = event.issue?.title ? `: ${event.issue.title}` : '';
  return `${event.type}${issue}${title}`;
}

function fieldValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'n/a';
  if (Array.isArray(value)) return value.length > 0 ? value.join('\n') : 'n/a';
  return String(value);
}

function summaryFields(event: LifecycleEvent): Array<{ title: string; value: string }> {
  return [
    { title: 'Repo', value: event.repo.fullName },
    { title: 'Session', value: fieldValue(event.session.name) },
    { title: 'Branch', value: fieldValue(event.branch.name) },
    { title: 'PR', value: fieldValue(event.pr.url) },
    { title: 'Preview', value: fieldValue(event.previewUrl) },
  ].filter((field) => field.value !== 'n/a');
}

export function formatEventPayload(event: LifecycleEvent, format: EventFormat): unknown {
  if (format === 'json') return event;
  const title = `Alpha Loop: ${eventSummary(event)}`;
  const details = summaryFields(event);

  if (format === 'slack') {
    return {
      text: title,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
        {
          type: 'section',
          fields: details.map((field) => ({
            type: 'mrkdwn',
            text: `*${field.title}:*\n${field.value}`,
          })),
        },
        ...(event.qaChecklist.length > 0 ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: `*QA checklist:*\n${event.qaChecklist.map((item) => `- ${item}`).join('\n')}` },
        }] : []),
      ],
    };
  }

  if (format === 'teams') {
    return {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: title, weight: 'Bolder', wrap: true },
            ...details.map((field) => ({
              type: 'FactSet',
              facts: [{ title: field.title, value: field.value }],
            })),
            ...(event.qaChecklist.length > 0 ? [{
              type: 'TextBlock',
              text: `QA checklist\n${event.qaChecklist.map((item) => `- ${item}`).join('\n')}`,
              wrap: true,
            }] : []),
          ],
        },
      }],
    };
  }

  return {
    content: title,
    embeds: [{
      title,
      description: event.humanInput.reason ?? event.error ?? undefined,
      color: event.type.endsWith('.failed') ? 0xd73a49 : 0x238636,
      fields: details.map((field) => ({
        name: field.title,
        value: field.value,
        inline: field.title !== 'PR' && field.title !== 'Preview',
      })),
    }],
  };
}

export function eventMatchesDestination(eventType: EventName, destination: EventDestinationConfig): boolean {
  return destination.events.includes('*') || destination.events.includes(eventType);
}

function matchingDestinations(config: Config, eventType: EventName): Array<[string, EventDestinationConfig]> {
  return Object.entries(eventConfig(config).destinations)
    .filter(([, destination]) => eventMatchesDestination(eventType, destination));
}

function responseText(response: Response): Promise<string> {
  return response.text().then((text) => text.slice(0, MAX_RESPONSE_CHARS)).catch(() => '');
}

async function deliverWebhook(
  destination: WebhookEventDestinationConfig,
  event: LifecycleEvent,
): Promise<Pick<EventDeliveryRecord, 'responseStatus' | 'responseBody'>> {
  const url = process.env[destination.urlEnv];
  if (!url) throw new Error(`Environment variable ${destination.urlEnv} is not set`);
  const body = JSON.stringify(formatEventPayload(event, destination.format));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-alpha-loop-event': event.type,
    'x-alpha-loop-event-id': event.id,
  };
  const secret = destination.secretEnv ? process.env[destination.secretEnv] : undefined;
  if (secret) {
    headers['x-alpha-loop-signature'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), destination.timeout > 0 ? destination.timeout * 1000 : DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    const bodyText = await responseText(response);
    if (!response.ok) {
      throw new WebhookDeliveryError(response.status, bodyText);
    }
    return { responseStatus: response.status, responseBody: bodyText };
  } finally {
    clearTimeout(timeout);
  }
}

async function deliverCommand(
  destination: CommandEventDestinationConfig,
  event: LifecycleEvent,
): Promise<Pick<EventDeliveryRecord, 'stdout' | 'stderr' | 'exitCode'>> {
  return new Promise((resolve, reject) => {
    const child = spawn(destination.command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = destination.timeout > 0 ? destination.timeout * 1000 : DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Command timed out after ${destination.timeout || 10}s`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = {
        stdout: stdout.trim().slice(0, MAX_RESPONSE_CHARS),
        stderr: stderr.trim().slice(0, MAX_RESPONSE_CHARS),
        exitCode: code ?? 1,
      };
      if ((code ?? 1) !== 0) {
        reject(new CommandDeliveryError(code ?? 1, result.stdout, result.stderr));
        return;
      }
      resolve(result);
    });

    child.stdin?.end(JSON.stringify(event));
  });
}

function appendEventLog(
  input: EmitLifecycleEventInput,
  manifest: DurableSessionManifest | null,
  record: Record<string, unknown>,
): void {
  const filePath = eventLogPath(input.session, manifest);
  if (!filePath) return;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(record)}\n`);
    if (input.session) {
      recordSessionLogFile(input.session, filePath);
    } else if (input.manifestPath) {
      recordSessionLogFile(input.manifestPath, filePath);
    }
  } catch (err) {
    log.warn(`Could not write lifecycle event log: ${err instanceof Error ? err.message : err}`);
  }
}

async function deliverDestination(
  name: string,
  destination: EventDestinationConfig,
  event: LifecycleEvent,
  dryRun: boolean,
): Promise<EventDeliveryRecord[]> {
  if (dryRun) {
    log.dry(`Would deliver ${event.type} to ${name} (${destination.type}, ${destination.format})`);
    return [{
      kind: 'delivery',
      eventId: event.id,
      eventType: event.type,
      destination: name,
      destinationType: destination.type,
      format: destination.format,
      attempt: 0,
      status: 'dry-run',
      required: destination.required,
      timestamp: new Date().toISOString(),
      durationMs: 0,
    }];
  }

  if (destination.type === 'log') {
    return [{
      kind: 'delivery',
      eventId: event.id,
      eventType: event.type,
      destination: name,
      destinationType: destination.type,
      format: destination.format,
      attempt: 1,
      status: 'success',
      required: destination.required,
      timestamp: new Date().toISOString(),
      durationMs: 0,
    }];
  }

  const records: EventDeliveryRecord[] = [];
  const attempts = destination.retries + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    try {
      const details = destination.type === 'webhook'
        ? await deliverWebhook(destination, event)
        : await deliverCommand(destination, event);
      records.push({
        kind: 'delivery',
        eventId: event.id,
        eventType: event.type,
        destination: name,
        destinationType: destination.type,
        format: destination.format,
        attempt,
        status: 'success',
        required: destination.required,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        ...details,
      });
      return records;
    } catch (err) {
      const deliveryDetails = err instanceof WebhookDeliveryError
        ? { responseStatus: err.responseStatus, responseBody: err.responseBody }
        : err instanceof CommandDeliveryError
          ? { stdout: err.stdout, stderr: err.stderr, exitCode: err.exitCode }
          : {};
      records.push({
        kind: 'delivery',
        eventId: event.id,
        eventType: event.type,
        destination: name,
        destinationType: destination.type,
        format: destination.format,
        attempt,
        status: 'failed',
        required: destination.required,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        ...deliveryDetails,
      });
      if (attempt >= attempts) return records;
    }
  }
  return records;
}

export async function emitLifecycleEvent(input: EmitLifecycleEventInput): Promise<EventDeliverySummary> {
  const destinations = matchingDestinations(input.config, input.type);
  if (destinations.length === 0) {
    const event = redactLifecycleEvent(buildLifecycleEvent({ ...input, manifest: null }), input.config);
    return { event, deliveries: [] };
  }

  const rawManifest = loadManifest(input);
  const event = redactLifecycleEvent(buildLifecycleEvent({ ...input, manifest: rawManifest }), input.config);
  const deliveries: EventDeliveryRecord[] = [];

  if (!input.config.dryRun) {
    appendEventLog(input, rawManifest, {
      kind: 'event',
      eventId: event.id,
      eventType: event.type,
      timestamp: event.createdAt,
      event,
    });
  }

  for (const [name, destination] of destinations) {
    const records = await deliverDestination(name, destination, event, input.config.dryRun);
    deliveries.push(...records);
    if (!input.config.dryRun) {
      for (const record of records) appendEventLog(input, rawManifest, record);
    }

    const failed = records.at(-1)?.status === 'failed';
    if (failed) {
      const message = `Lifecycle event ${event.type} failed for destination ${name}: ${records.at(-1)?.error ?? 'unknown error'}`;
      if (destination.required) {
        throw new Error(message);
      }
      log.warn(message);
    }
  }

  return { event, deliveries };
}
