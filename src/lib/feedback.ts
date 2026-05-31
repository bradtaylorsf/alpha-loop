import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { commentIssue, labelIssue } from './github.js';
import {
  findLatestResumableSessionForIssue,
  loadSessionManifest,
  sessionManifestPath,
  updateSessionManifest,
  type DurableSessionManifest,
  type ResumableSessionRef,
} from './session.js';
import {
  appendHumanFeedbackEvent,
  applyHumanFeedbackTransition,
  classifyFeedback,
  githubLabelChangesForStatus,
  initialHumanFeedbackState,
  normalizeFeedbackClassification,
  normalizeHumanFeedbackStatus,
  type FeedbackClassification,
  type HumanFeedbackAttachment,
  type HumanFeedbackIngestRecord,
  type HumanFeedbackSessionStatus,
} from './session-state.js';

export const FEEDBACK_MARKER_NAME = 'alpha-loop-feedback';

export const FeedbackIngestPayloadSchema = z.object({
  repo: z.string().trim().min(1).optional(),
  issueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive().optional(),
  sessionId: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).default('external'),
  externalEventId: z.string().trim().min(1).optional(),
  externalThreadId: z.string().trim().min(1).optional(),
  externalMessageId: z.string().trim().min(1).optional(),
  author: z.string().trim().min(1).optional(),
  body: z.string().min(1),
  attachments: z.array(z.unknown()).default([]),
  eventTimestamp: z.string().trim().min(1).optional(),
  classification: z.string().trim().min(1).optional(),
  resumeRequested: z.boolean().default(false),
});

type FeedbackIngestPayloadShape = z.infer<typeof FeedbackIngestPayloadSchema>;

export type FeedbackIngestPayload = Omit<FeedbackIngestPayloadShape, 'attachments' | 'classification'> & {
  attachments: HumanFeedbackAttachment[];
  classification?: FeedbackClassification;
};

export type FeedbackCommentMarker = {
  version: 1;
  type: typeof FEEDBACK_MARKER_NAME;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  commentTarget: number;
  sessionId: string | null;
  sessionName: string | null;
  source: string;
  externalEventId: string | null;
  externalThreadId: string | null;
  externalMessageId: string | null;
  idempotencyKey: string;
  idempotencyHash: string;
  classification: FeedbackClassification;
  eventTimestamp: string;
  receivedAt: string;
  resumeRequested: boolean;
};

export type FeedbackIdempotencyRecord = {
  version: 1;
  status: 'processed';
  idempotencyKey: string;
  idempotencyHash: string;
  receivedAt: string;
  payload: FeedbackIngestPayload;
  classification: FeedbackClassification;
  githubComment: {
    repo: string;
    targetNumber: number;
    issueNumber: number | null;
    prNumber: number | null;
    marker: FeedbackCommentMarker;
  };
  session: {
    found: boolean;
    sessionId: string | null;
    name: string | null;
    manifestPath: string | null;
    lookup: 'session_id' | 'issue' | 'pr' | 'none';
  };
  lifecycleEventIds: string[];
  resumeCommand: string | null;
};

export type FeedbackIngestProcessedResult = {
  status: 'processed';
  idempotencyKey: string;
  idempotencyHash: string;
  recordPath: string;
  classification: FeedbackClassification;
  githubComment: FeedbackIdempotencyRecord['githubComment'];
  session: FeedbackIdempotencyRecord['session'];
  lifecycleEventIds: string[];
  resumeCommand: string | null;
};

export type FeedbackIngestAlreadyProcessedResult = {
  status: 'already_processed';
  idempotencyKey: string;
  idempotencyHash: string;
  recordPath: string;
  record: FeedbackIdempotencyRecord | null;
};

export type FeedbackIngestResult = FeedbackIngestProcessedResult | FeedbackIngestAlreadyProcessedResult;

export type IngestFeedbackInput = {
  payload: unknown;
  repo?: string;
  projectDir?: string;
  readyLabel?: string;
  requestResume?: boolean;
  receivedAt?: string;
  sessionsRoot?: string;
};

type FeedbackAssociation = {
  sessionRef: ResumableSessionRef | null;
  sessionLookup: 'session_id' | 'issue' | 'pr' | 'none';
  issueNumber: number | null;
  prNumber: number | null;
  commentTarget: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rawField(data: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (data[key] !== undefined) return data[key];
  }
  return undefined;
}

function stringField(data: Record<string, unknown>, keys: string[]): string | undefined {
  const value = rawField(data, keys);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberField(data: Record<string, unknown>, keys: string[]): number | undefined {
  const value = rawField(data, keys);
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function booleanField(data: Record<string, unknown>, keys: string[]): boolean | undefined {
  const value = rawField(data, keys);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

function normalizeAttachment(value: unknown): HumanFeedbackAttachment | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (!isRecord(value)) return null;

  const attachment: Exclude<HumanFeedbackAttachment, string> = {};
  const url = stringField(value, ['url', 'href']);
  const title = stringField(value, ['title', 'name']);
  const filename = stringField(value, ['filename', 'fileName']);
  const contentType = stringField(value, ['contentType', 'content_type', 'mimeType', 'mime_type']);
  if (url) attachment.url = url;
  if (title) attachment.title = title;
  if (filename) attachment.filename = filename;
  if (contentType) attachment.contentType = contentType;
  return Object.keys(attachment).length > 0 ? attachment : null;
}

function payloadAliases(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new Error('Feedback payload must be a JSON object or a text body.');
  }

  const attachmentsRaw = rawField(raw, ['attachments', 'files']);
  const attachments = Array.isArray(attachmentsRaw)
    ? attachmentsRaw
    : attachmentsRaw === undefined
      ? []
      : [attachmentsRaw];

  return {
    repo: stringField(raw, ['repo', 'repository']),
    issueNumber: numberField(raw, ['issueNumber', 'issueNum', 'issue', 'issue_number']),
    prNumber: numberField(raw, ['prNumber', 'pullRequestNumber', 'pr', 'pr_number', 'pull_request_number']),
    sessionId: stringField(raw, ['sessionId', 'session', 'session_id']),
    source: stringField(raw, ['source', 'provider']),
    externalEventId: stringField(raw, ['externalEventId', 'eventId', 'event_id', 'external_event_id']),
    externalThreadId: stringField(raw, ['externalThreadId', 'threadId', 'thread_id', 'external_thread_id']),
    externalMessageId: stringField(raw, ['externalMessageId', 'messageId', 'message_id', 'external_message_id']),
    author: stringField(raw, ['author', 'user', 'userName', 'username']),
    body: typeof rawField(raw, ['body', 'text', 'message']) === 'string'
      ? rawField(raw, ['body', 'text', 'message'])
      : undefined,
    attachments,
    eventTimestamp: stringField(raw, ['eventTimestamp', 'timestamp', 'createdAt', 'created_at', 'event_timestamp']),
    classification: stringField(raw, ['classification', 'type', 'intent']),
    resumeRequested: booleanField(raw, ['resumeRequested', 'requestResume', 'resume_requested', 'request_resume']),
  };
}

export function parseFeedbackPayloadText(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return { body: parsed };
    if (isRecord(parsed)) return parsed;
    throw new Error('Feedback JSON payload must be an object.');
  } catch (err) {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    return { body: raw };
  }
}

export function normalizeFeedbackIngestPayload(raw: unknown): FeedbackIngestPayload {
  const aliased = payloadAliases(raw);
  const parsed = FeedbackIngestPayloadSchema.safeParse(aliased);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid feedback payload: ${issue?.path.join('.') || 'payload'} ${issue?.message || ''}`.trim());
  }

  const explicitClassification = parsed.data.classification !== undefined
    ? normalizeFeedbackClassification(parsed.data.classification)
    : undefined;
  if (parsed.data.classification !== undefined && !explicitClassification) {
    throw new Error(`Invalid feedback classification: ${parsed.data.classification}`);
  }

  const { classification: _classification, attachments, ...rest } = parsed.data;
  return {
    ...rest,
    attachments: attachments
      .map(normalizeAttachment)
      .filter((attachment): attachment is HumanFeedbackAttachment => attachment !== null),
    ...(explicitClassification ? { classification: explicitClassification } : {}),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function feedbackIdempotencyKey(payload: FeedbackIngestPayload, repo: string): string {
  const source = payload.source.trim().toLowerCase();
  if (payload.externalEventId) {
    return `${repo}:${source}:event:${payload.externalEventId}`;
  }
  if (payload.externalThreadId && payload.externalMessageId) {
    return `${repo}:${source}:thread:${payload.externalThreadId}:message:${payload.externalMessageId}`;
  }
  if (payload.externalMessageId) {
    return `${repo}:${source}:message:${payload.externalMessageId}`;
  }

  const bodyHash = sha256(payload.body).slice(0, 16);
  return [
    repo,
    source,
    'fallback',
    payload.externalThreadId ?? '',
    payload.eventTimestamp ?? '',
    payload.author ?? '',
    bodyHash,
  ].join(':');
}

function idempotencyRecordPath(projectDir: string, idempotencyHash: string): string {
  return join(projectDir, '.alpha-loop', 'feedback', 'ingested-events', `${idempotencyHash}.json`);
}

function readIdempotencyRecord(filePath: string): FeedbackIdempotencyRecord | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as FeedbackIdempotencyRecord;
  } catch {
    return null;
  }
}

function manifestTime(manifest: DurableSessionManifest): string {
  return manifest.timestamps.updatedAt ?? manifest.timestamps.startedAt ?? manifest.timestamps.createdAt;
}

function buildSessionRef(sessionDir: string, manifestPath: string, manifest: DurableSessionManifest): ResumableSessionRef {
  const worktreePath = manifest.worktree?.path ?? null;
  return {
    manifest,
    manifestPath,
    sessionDir,
    worktreePath,
    worktreeExists: worktreePath ? existsSync(worktreePath) : false,
    recoveryBranch: manifest.worktree?.lastKnownBranch ?? manifest.lastKnownBranch ?? manifest.branch ?? null,
  };
}

function findSessionRefs(sessionsRoot: string): ResumableSessionRef[] {
  if (!existsSync(sessionsRoot)) return [];
  const refs: ResumableSessionRef[] = [];

  function readSessionDir(sessionDir: string): void {
    const manifestPath = sessionManifestPath(sessionDir);
    const manifest = loadSessionManifest(manifestPath);
    if (!manifest) return;
    refs.push(buildSessionRef(sessionDir, manifestPath, manifest));
  }

  try {
    for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDir = join(sessionsRoot, group.name);
      readSessionDir(groupDir);
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        readSessionDir(join(groupDir, entry.name));
      }
    }
  } catch {
    return refs;
  }

  return refs.sort((a, b) => manifestTime(b.manifest).localeCompare(manifestTime(a.manifest)));
}

function sessionMatchesId(manifest: DurableSessionManifest, sessionId: string): boolean {
  const timestamp = manifest.name.split('/').pop() ?? manifest.name;
  return manifest.sessionId === sessionId
    || manifest.name === sessionId
    || timestamp === sessionId
    || manifest.name.endsWith(sessionId);
}

function findSessionById(sessionId: string, sessionsRoot: string): ResumableSessionRef | null {
  return findSessionRefs(sessionsRoot).find((ref) => sessionMatchesId(ref.manifest, sessionId)) ?? null;
}

function prNumberFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)(?:\b|$)/);
  return match ? Number(match[1]) : null;
}

function manifestPrNumber(manifest: DurableSessionManifest): number | null {
  return prNumberFromUrl(manifest.prUrl)
    ?? prNumberFromUrl(manifest.sessionPrUrl)
    ?? prNumberFromUrl(manifest.feedback?.prUrl)
    ?? manifest.feedback?.latestFeedback?.prNumber
    ?? null;
}

function manifestMatchesPr(manifest: DurableSessionManifest, prNumber: number): boolean {
  if (manifestPrNumber(manifest) === prNumber) return true;
  return manifest.issues.some((issue) => prNumberFromUrl(issue.prUrl) === prNumber);
}

function findLatestSessionForPr(prNumber: number, sessionsRoot: string): ResumableSessionRef | null {
  return findSessionRefs(sessionsRoot).find((ref) => manifestMatchesPr(ref.manifest, prNumber)) ?? null;
}

function manifestIssueNumber(manifest: DurableSessionManifest): number | null {
  return manifest.currentIssue?.issueNum
    ?? manifest.issueNumber
    ?? (manifest.issueNumbers.length === 1 ? manifest.issueNumbers[0] : null)
    ?? null;
}

function resolveFeedbackAssociation(payload: FeedbackIngestPayload, sessionsRoot: string): FeedbackAssociation {
  let sessionRef: ResumableSessionRef | null = null;
  let sessionLookup: FeedbackAssociation['sessionLookup'] = 'none';

  if (payload.sessionId) {
    sessionLookup = 'session_id';
    sessionRef = findSessionById(payload.sessionId, sessionsRoot);
  }

  if (!sessionRef && payload.issueNumber) {
    sessionLookup = payload.sessionId ? 'session_id' : 'issue';
    sessionRef = findLatestResumableSessionForIssue(payload.issueNumber, sessionsRoot);
  }

  if (!sessionRef && payload.prNumber) {
    sessionLookup = payload.sessionId ? 'session_id' : 'pr';
    sessionRef = findLatestSessionForPr(payload.prNumber, sessionsRoot);
  }

  const issueNumber = payload.issueNumber ?? (sessionRef ? manifestIssueNumber(sessionRef.manifest) : null);
  const prNumber = payload.prNumber ?? (sessionRef ? manifestPrNumber(sessionRef.manifest) : null);
  const commentTarget = issueNumber ?? prNumber;

  if (!commentTarget) {
    throw new Error('Feedback must include an issue number, PR number, or resolvable session id.');
  }

  return {
    sessionRef,
    sessionLookup,
    issueNumber,
    prNumber,
    commentTarget,
  };
}

export function formatFeedbackMarker(marker: FeedbackCommentMarker): string {
  return `<!-- ${FEEDBACK_MARKER_NAME} ${JSON.stringify(marker)} -->`;
}

export function parseFeedbackCommentMarkers(commentBody: string): FeedbackCommentMarker[] {
  const markers: FeedbackCommentMarker[] = [];
  const pattern = /<!--\s*alpha-loop-feedback\s+({[\s\S]*?})\s*-->/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(commentBody)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (!isRecord(parsed)) continue;
      if (parsed.version !== 1 || parsed.type !== FEEDBACK_MARKER_NAME) continue;
      markers.push(parsed as FeedbackCommentMarker);
    } catch {
      // Ignore malformed third-party comments.
    }
  }
  return markers;
}

function attachmentLine(attachment: HumanFeedbackAttachment): string {
  if (typeof attachment === 'string') return `- ${attachment}`;
  const label = attachment.title ?? attachment.filename ?? attachment.url ?? 'Attachment';
  return attachment.url ? `- [${label}](${attachment.url})` : `- ${label}`;
}

export function formatFeedbackComment(args: {
  payload: FeedbackIngestPayload;
  classification: FeedbackClassification;
  marker: FeedbackCommentMarker;
  markerText?: string;
}): string {
  const { payload, classification, marker } = args;
  const lines = [
    '## Alpha Loop Feedback Received',
    '',
    `Source: \`${payload.source}\``,
    `Classification: \`${classification}\``,
  ];

  if (payload.author) lines.push(`Author: ${payload.author}`);
  if (marker.sessionName) lines.push(`Session: \`${marker.sessionName}\``);
  if (marker.issueNumber) lines.push(`Issue: #${marker.issueNumber}`);
  if (marker.prNumber) lines.push(`PR: #${marker.prNumber}`);
  if (payload.externalThreadId) lines.push(`External thread: \`${payload.externalThreadId}\``);
  if (payload.externalMessageId) lines.push(`External message: \`${payload.externalMessageId}\``);
  if (payload.eventTimestamp) lines.push(`Event timestamp: ${payload.eventTimestamp}`);

  lines.push('', '### Body', '', payload.body.trim());

  if (payload.attachments.length > 0) {
    lines.push('', '### Attachments', ...payload.attachments.map(attachmentLine));
  }

  lines.push('', args.markerText ?? formatFeedbackMarker(marker));
  return lines.join('\n');
}

function currentFeedbackStatus(manifest: DurableSessionManifest): HumanFeedbackSessionStatus {
  const status = normalizeHumanFeedbackStatus(manifest.status);
  const feedback = normalizeHumanFeedbackStatus(manifest.feedback?.currentStatus ?? '');
  if (status && status !== 'running' && feedback === 'running') return status;
  return feedback ?? status ?? 'running';
}

function eventPayload(args: {
  payload: FeedbackIngestPayload;
  idempotencyHash: string;
  classification: FeedbackClassification;
  marker: FeedbackCommentMarker;
}): Record<string, unknown> {
  return {
    idempotencyHash: args.idempotencyHash,
    source: args.payload.source,
    externalEventId: args.payload.externalEventId ?? null,
    externalThreadId: args.payload.externalThreadId ?? null,
    externalMessageId: args.payload.externalMessageId ?? null,
    author: args.payload.author ?? null,
    classification: args.classification,
    githubCommentTarget: args.marker.commentTarget,
    issueNumber: args.marker.issueNumber,
    prNumber: args.marker.prNumber,
    attachmentCount: args.payload.attachments.length,
  };
}

function canRequestResume(classification: FeedbackClassification): boolean {
  return classification === 'clarification'
    || classification === 'change_request'
    || classification === 'approval';
}

function upsertLatestFeedback(
  manifest: DurableSessionManifest,
  record: HumanFeedbackIngestRecord,
  at: string,
): DurableSessionManifest {
  const prior = manifest.feedback ?? initialHumanFeedbackState(currentFeedbackStatus(manifest), at);
  const feedbackHistory = [...(prior.feedbackHistory ?? []), record].slice(-50);
  return {
    ...manifest,
    feedback: {
      ...prior,
      classification: record.classification,
      latestFeedback: record,
      feedbackHistory,
      updatedAt: at,
    },
  };
}

function recordFeedbackInSession(args: {
  association: FeedbackAssociation;
  payload: FeedbackIngestPayload;
  marker: FeedbackCommentMarker;
  markerText: string;
  idempotencyKey: string;
  idempotencyHash: string;
  classification: FeedbackClassification;
  receivedAt: string;
  requestResume: boolean;
}): { manifest: DurableSessionManifest | null; lifecycleEventIds: string[]; resumeCommand: string | null } {
  if (!args.association.sessionRef) {
    return { manifest: null, lifecycleEventIds: [], resumeCommand: null };
  }

  let resumeCommand: string | null = null;
  const basePayload = eventPayload({
    payload: args.payload,
    idempotencyHash: args.idempotencyHash,
    classification: args.classification,
    marker: args.marker,
  });

  const updated = updateSessionManifest(args.association.sessionRef.manifestPath, (manifest) => {
    let next: DurableSessionManifest = {
      ...manifest,
      feedback: {
        ...(manifest.feedback ?? initialHumanFeedbackState(currentFeedbackStatus(manifest), args.receivedAt)),
        currentStatus: currentFeedbackStatus(manifest),
      },
    };

    const current = currentFeedbackStatus(next);
    if (current === 'human_input_requested' || current === 'qa_requested') {
      next = applyHumanFeedbackTransition(next, {
        to: 'feedback_received',
        reason: `Feedback received from ${args.payload.source}`,
        issueNum: args.association.issueNumber ?? undefined,
        classification: args.classification,
        prUrl: args.association.prNumber ? `#${args.association.prNumber}` : undefined,
        eventType: 'feedback.received',
        eventPayload: basePayload,
        at: args.receivedAt,
      });
    } else {
      next = appendHumanFeedbackEvent(next, {
        type: 'feedback.received',
        status: current,
        issueNum: args.association.issueNumber ?? undefined,
        payload: basePayload,
        at: args.receivedAt,
      });
    }

    next = appendHumanFeedbackEvent(next, {
      type: 'feedback.classified',
      status: currentFeedbackStatus(next),
      issueNum: args.association.issueNumber ?? undefined,
      payload: {
        ...basePayload,
        classification: args.classification,
      },
      at: args.receivedAt,
    });

    let record: HumanFeedbackIngestRecord = {
      idempotencyKey: args.idempotencyKey,
      idempotencyHash: args.idempotencyHash,
      repo: args.marker.repo,
      issueNumber: args.association.issueNumber,
      prNumber: args.association.prNumber,
      sessionId: next.sessionId,
      sessionName: next.name,
      source: args.payload.source,
      externalEventId: args.payload.externalEventId ?? null,
      externalThreadId: args.payload.externalThreadId ?? null,
      externalMessageId: args.payload.externalMessageId ?? null,
      author: args.payload.author ?? null,
      body: args.payload.body,
      attachments: args.payload.attachments,
      eventTimestamp: args.payload.eventTimestamp ?? args.receivedAt,
      receivedAt: args.receivedAt,
      classification: args.classification,
      githubCommentTarget: args.association.commentTarget,
      commentMarker: args.markerText,
      resumeRequested: false,
      resumeCommand: null,
    };

    if (args.requestResume && canRequestResume(args.classification) && args.association.issueNumber) {
      const status = currentFeedbackStatus(next);
      if (status === 'feedback_received' || status === 'completed' || status === 'failed') {
        resumeCommand = `alpha-loop resume --issue ${args.association.issueNumber}`;
        record = { ...record, resumeRequested: true, resumeCommand };
        next = applyHumanFeedbackTransition(next, {
          to: 'resume_requested',
          reason: `Resume requested after ${args.classification} feedback from ${args.payload.source}`,
          issueNum: args.association.issueNumber,
          classification: args.classification,
          eventType: 'session.resume_requested',
          eventPayload: {
            ...basePayload,
            resumeCommand,
          },
          at: args.receivedAt,
        });
      } else if (status === 'resume_requested') {
        resumeCommand = `alpha-loop resume --issue ${args.association.issueNumber}`;
        record = { ...record, resumeRequested: true, resumeCommand };
        next = appendHumanFeedbackEvent(next, {
          type: 'session.resume_requested',
          status,
          issueNum: args.association.issueNumber,
          payload: {
            ...basePayload,
            resumeCommand,
          },
          at: args.receivedAt,
        });
      }
    }

    return upsertLatestFeedback(next, record, args.receivedAt);
  });

  const lifecycleEventIds = updated?.feedback.events
    .filter((event) => event.createdAt === args.receivedAt)
    .filter((event) => (
      event.type === 'feedback.received'
      || event.type === 'feedback.classified'
      || event.type === 'session.resume_requested'
    ))
    .map((event) => event.id) ?? [];

  return { manifest: updated, lifecycleEventIds, resumeCommand };
}

function writeIdempotencyRecord(filePath: string, record: FeedbackIdempotencyRecord): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n');
}

function classifyPayload(payload: FeedbackIngestPayload): FeedbackClassification {
  return payload.classification ?? classifyFeedback(payload.body);
}

export function ingestFeedback(input: IngestFeedbackInput): FeedbackIngestResult {
  const projectDir = input.projectDir ?? process.cwd();
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const normalized = normalizeFeedbackIngestPayload(input.payload);
  const repo = normalized.repo ?? input.repo;
  if (!repo) {
    throw new Error('Feedback payload must include repo, or repo must be configured.');
  }

  const payload: FeedbackIngestPayload = {
    ...normalized,
    repo,
    eventTimestamp: normalized.eventTimestamp ?? receivedAt,
  };
  const idempotencyKey = feedbackIdempotencyKey(payload, repo);
  const idempotencyHash = sha256(idempotencyKey);
  const recordPath = idempotencyRecordPath(projectDir, idempotencyHash);

  if (existsSync(recordPath)) {
    return {
      status: 'already_processed',
      idempotencyKey,
      idempotencyHash,
      recordPath,
      record: readIdempotencyRecord(recordPath),
    };
  }

  const sessionsRoot = input.sessionsRoot ?? join(projectDir, '.alpha-loop', 'sessions');
  const association = resolveFeedbackAssociation(payload, sessionsRoot);
  const classification = classifyPayload(payload);
  const requestResume = Boolean(input.requestResume || payload.resumeRequested);
  const marker: FeedbackCommentMarker = {
    version: 1,
    type: FEEDBACK_MARKER_NAME,
    repo,
    issueNumber: association.issueNumber,
    prNumber: association.prNumber,
    commentTarget: association.commentTarget,
    sessionId: association.sessionRef?.manifest.sessionId ?? payload.sessionId ?? null,
    sessionName: association.sessionRef?.manifest.name ?? null,
    source: payload.source,
    externalEventId: payload.externalEventId ?? null,
    externalThreadId: payload.externalThreadId ?? null,
    externalMessageId: payload.externalMessageId ?? null,
    idempotencyKey,
    idempotencyHash,
    classification,
    eventTimestamp: payload.eventTimestamp ?? receivedAt,
    receivedAt,
    resumeRequested: requestResume,
  };
  const markerText = formatFeedbackMarker(marker);
  const commentBody = formatFeedbackComment({
    payload,
    classification,
    marker,
    markerText,
  });

  if (!commentIssue(repo, association.commentTarget, commentBody)) {
    throw new Error(`Failed to write feedback comment to ${repo}#${association.commentTarget}.`);
  }

  const sessionUpdate = recordFeedbackInSession({
    association,
    payload,
    marker,
    markerText,
    idempotencyKey,
    idempotencyHash,
    classification,
    receivedAt,
    requestResume,
  });

  if (sessionUpdate.resumeCommand && association.issueNumber) {
    for (const change of githubLabelChangesForStatus('resume_requested', input.readyLabel ?? 'ready')) {
      labelIssue(repo, association.issueNumber, change.add, change.remove);
    }
  }

  const record: FeedbackIdempotencyRecord = {
    version: 1,
    status: 'processed',
    idempotencyKey,
    idempotencyHash,
    receivedAt,
    payload,
    classification,
    githubComment: {
      repo,
      targetNumber: association.commentTarget,
      issueNumber: association.issueNumber,
      prNumber: association.prNumber,
      marker,
    },
    session: {
      found: Boolean(association.sessionRef),
      sessionId: association.sessionRef?.manifest.sessionId ?? payload.sessionId ?? null,
      name: association.sessionRef?.manifest.name ?? null,
      manifestPath: association.sessionRef?.manifestPath ?? null,
      lookup: association.sessionLookup,
    },
    lifecycleEventIds: sessionUpdate.lifecycleEventIds,
    resumeCommand: sessionUpdate.resumeCommand,
  };
  writeIdempotencyRecord(recordPath, record);

  return {
    status: 'processed',
    idempotencyKey,
    idempotencyHash,
    recordPath,
    classification,
    githubComment: record.githubComment,
    session: record.session,
    lifecycleEventIds: sessionUpdate.lifecycleEventIds,
    resumeCommand: sessionUpdate.resumeCommand,
  };
}
