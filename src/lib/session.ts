/**
 * Session Management — create sessions, save results, finalize with PR.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { log } from './logger.js';
import { exec, formatTimestamp } from './shell.js';
import { ghExec } from './rate-limit.js';
import { createPR, updateProjectStatus } from './github.js';
import { repairSessionLearningArtifacts, repairSessionSummaryArtifact } from './learning.js';
import { readStageTelemetry } from './telemetry.js';
import { runDir } from './traces.js';
import {
  applyHumanFeedbackTransition,
  initialHumanFeedbackState,
  type HumanFeedbackSessionStatus,
  type HumanFeedbackStateBlock,
  type HumanFeedbackTransitionInput,
} from './session-state.js';
import type { Config } from './config.js';
import type { PipelineResult, GateResult } from './pipeline.js';
import type { QueueEpicLink, QueueSessionContext } from './epic-queue.js';
import type { AutomationPolicyDecision } from './automation-policy.js';

export type SessionContext = {
  /** Stable id used in durable manifests and trace joins. */
  id?: string;
  name: string;
  branch: string;
  startedAt?: string;
  resultsDir: string;
  logsDir: string;
  manifestPath?: string;
  results: PipelineResult[];
  sessionReviewFindings?: GateResult;
  sessionPrUrl?: string;
  /** Issue currently being processed, when known. */
  currentIssueNum?: number;
  /** Parent epic for targeted child-issue sessions, when known. */
  parentEpicNum?: number;
  /** When set, this session processes sub-issues of the given epic. */
  epic?: number;
  /** Queue metadata for multi-epic queue sessions. */
  queue?: QueueSessionContext;
};

export type SessionStatus =
  | HumanFeedbackSessionStatus
  | 'active'
  | 'paused'
  | 'waiting-for-feedback'
  | 'qa-requested'
  | 'resumed'
  | 'completed'
  | 'failed'
  | 'cleaned-up';

export type SessionStage =
  | HumanFeedbackSessionStatus
  | 'created'
  | 'status'
  | 'worktree'
  | 'plan'
  | 'context'
  | 'implement'
  | 'test'
  | 'review'
  | 'verify'
  | 'smoke'
  | 'learn'
  | 'pr'
  | 'assumptions'
  | 'trace'
  | 'merge'
  | 'cleanup'
  | 'finalize'
  | 'session-review'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'waiting-for-feedback'
  | 'qa-requested';

export type SessionPromptRef = {
  issueNum?: number;
  stage: string;
  path: string;
  hash: string;
  recordedAt: string;
};

export type SessionTranscriptRef = {
  issueNum?: number;
  stage: string;
  path: string;
  recordedAt: string;
};

export type SessionIssueManifest = {
  issueNum: number;
  title?: string;
  status?: SessionStatus | PipelineResult['status'];
  stage?: SessionStage;
  labels?: string[];
  branch?: string;
  worktreePath?: string;
  worktreeMissing?: boolean;
  resumed?: boolean;
  prUrl?: string;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  failureReason?: PipelineResult['failureReason'];
};

export type SessionWorktreeManifest = {
  path: string;
  branch: string;
  resumed: boolean;
  missing: boolean;
  lastKnownBranch: string;
  updatedAt: string;
};

export type SessionCleanupManifest = {
  status: 'removed' | 'preserved' | 'missing' | 'skipped' | 'dry-run';
  worktreePath?: string;
  reason?: string;
  at: string;
};

export type DurableSessionManifest = {
  version: 1;
  sessionId: string;
  name: string;
  issueNumber: number | null;
  issueNumbers: number[];
  parentEpicNumber: number | null;
  parentEpicTitle?: string | null;
  branch: string;
  baseBranch: string;
  prUrl: string | null;
  sessionPrUrl: string | null;
  status: SessionStatus;
  stage: SessionStage;
  labels: string[];
  feedback: HumanFeedbackStateBlock;
  harness: {
    agent: Config['agent'];
    model: string;
    reviewModel: string;
    command: string;
    testCommand: string;
  };
  command: string;
  worktree: SessionWorktreeManifest | null;
  lastKnownBranch: string | null;
  currentIssue: { issueNum: number; title?: string } | null;
  issues: SessionIssueManifest[];
  prompts: SessionPromptRef[];
  promptPath: string | null;
  promptHash: string | null;
  transcripts: SessionTranscriptRef[];
  transcriptPath: string | null;
  logs: {
    sessionDir: string;
    logsDir: string;
    traceDir: string;
    files: string[];
  };
  screenshots: string[];
  previewUrl: string | null;
  timestamps: {
    createdAt: string;
    startedAt: string;
    updatedAt: string;
    endedAt?: string;
  };
  lastEventId: string | null;
  policyDecisions?: AutomationPolicyDecision[];
  errors: Array<{
    issueNum?: number;
    stage: string;
    message: string;
    timestamp: string;
  }>;
  cleanup?: SessionCleanupManifest;
  epic?: number;
  queue?: QueueSessionContext;
};

export type ResumableSessionRef = {
  manifest: DurableSessionManifest;
  manifestPath: string;
  sessionDir: string;
  worktreePath: string | null;
  worktreeExists: boolean;
  recoveryBranch: string | null;
};

export type FindResumableSessionOptions = {
  statuses?: Iterable<SessionStatus>;
};

function isRecoveredSessionResult(
  result: PipelineResult,
): result is PipelineResult & { recoveryMode: NonNullable<PipelineResult['recoveryMode']> } {
  return result.recoveryMode !== undefined;
}

export type CrashMarker = {
  issueNum: number;
  step: string;
  branch: string;
  hasCommits: boolean;
  error: string;
  timestamp: string;
  recoverable: boolean;
};

export type CrashMarkerRef = CrashMarker & {
  sessionDir: string;
  sessionName: string;
  filePath: string;
};

export type WriteCrashMarkerInput = Omit<CrashMarker, 'timestamp'> & {
  timestamp?: string;
};

export type CreateSessionOptions = {
  milestone?: string;
  /** Targeted issue metadata, when this session was created for one issue. */
  issueNum?: number;
  issueTitle?: string;
  /** Parent epic metadata for targeted child-issue sessions. */
  parentEpicNum?: number;
  parentEpicTitle?: string;
  /** Selected issue queue once known. */
  selectedIssueNums?: number[];
  /** When set, session is scoped to an epic — drives the name slug and PR title. */
  epicNum?: number;
  /** Title of the epic, used to form a human-readable session slug. */
  epicTitle?: string;
  /** Queue metadata when this session belongs to an ordered epic queue. */
  queue?: QueueSessionContext;
};

const RESUMABLE_STATUSES = new Set<SessionStatus>([
  'running',
  'human_input_requested',
  'qa_requested',
  'feedback_received',
  'resume_requested',
  'resuming',
  'active',
  'paused',
  'waiting-for-feedback',
  'qa-requested',
  'resumed',
  'failed',
]);

function projectRelative(filePath: string, projectDir = process.cwd()): string {
  const rel = relative(projectDir, filePath);
  return rel && !rel.startsWith('..') ? rel : filePath;
}

function sessionIdFromName(name: string): string {
  return name.replace(/\//g, '-');
}

export function sessionManifestPath(sessionOrDir: Pick<SessionContext, 'resultsDir'> | string): string {
  const sessionDir = typeof sessionOrDir === 'string' ? sessionOrDir : sessionOrDir.resultsDir;
  return join(sessionDir, 'session.json');
}

function writeManifestFile(filePath: string, manifest: DurableSessionManifest): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + '\n');
  renameSync(tmpPath, filePath);
}

export function hashPromptText(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function parseSessionManifest(raw: unknown): DurableSessionManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (data.version !== 1) return null;
  if (typeof data.sessionId !== 'string' || !data.sessionId) return null;
  if (typeof data.name !== 'string' || !data.name) return null;
  if (typeof data.branch !== 'string' || !data.branch) return null;
  if (typeof data.status !== 'string' || !data.status) return null;
  if (typeof data.stage !== 'string' || !data.stage) return null;
  return data as DurableSessionManifest;
}

export function loadSessionManifest(sessionOrPath: Pick<SessionContext, 'resultsDir' | 'manifestPath'> | string): DurableSessionManifest | null {
  const filePath = typeof sessionOrPath === 'string'
    ? (sessionOrPath.endsWith('.json') ? sessionOrPath : sessionManifestPath(sessionOrPath))
    : (sessionOrPath.manifestPath ?? sessionManifestPath(sessionOrPath));
  try {
    if (!existsSync(filePath)) return null;
    return parseSessionManifest(JSON.parse(readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

function mergeManifest(
  current: DurableSessionManifest,
  patch: Partial<DurableSessionManifest>,
): DurableSessionManifest {
  return {
    ...current,
    ...patch,
    harness: {
      ...current.harness,
      ...(patch.harness ?? {}),
    },
    logs: {
      ...current.logs,
      ...(patch.logs ?? {}),
      files: patch.logs?.files ?? current.logs.files,
    },
    timestamps: {
      ...current.timestamps,
      ...(patch.timestamps ?? {}),
    },
    feedback: patch.feedback ? {
      ...(current.feedback ?? initialHumanFeedbackState()),
      ...patch.feedback,
      transitionHistory: patch.feedback.transitionHistory ?? current.feedback?.transitionHistory ?? [],
      events: patch.feedback.events ?? current.feedback?.events ?? [],
    } : current.feedback,
  };
}

export function updateSessionManifest(
  sessionOrPath: Pick<SessionContext, 'resultsDir' | 'manifestPath'> | string,
  updater: Partial<DurableSessionManifest> | ((manifest: DurableSessionManifest) => DurableSessionManifest),
): DurableSessionManifest | null {
  const filePath = typeof sessionOrPath === 'string'
    ? (sessionOrPath.endsWith('.json') ? sessionOrPath : sessionManifestPath(sessionOrPath))
    : (sessionOrPath.manifestPath ?? sessionManifestPath(sessionOrPath));
  const current = loadSessionManifest(filePath);
  if (!current) return null;

  const next = typeof updater === 'function'
    ? updater({ ...current })
    : mergeManifest(current, updater);
  next.timestamps = {
    ...next.timestamps,
    updatedAt: new Date().toISOString(),
  };
  writeManifestFile(filePath, next);
  return next;
}

function upsertIssue(
  manifest: DurableSessionManifest,
  issueNum: number,
  patch: Partial<SessionIssueManifest>,
): DurableSessionManifest {
  const now = new Date().toISOString();
  const existingIndex = manifest.issues.findIndex((issue) => issue.issueNum === issueNum);
  const issue: SessionIssueManifest = {
    ...(existingIndex >= 0 ? manifest.issues[existingIndex] : { issueNum, startedAt: now }),
    ...patch,
    issueNum,
    updatedAt: now,
  };
  const issues = existingIndex >= 0
    ? manifest.issues.map((entry, index) => index === existingIndex ? issue : entry)
    : [...manifest.issues, issue];
  const issueNumbers = Array.from(new Set([...manifest.issueNumbers, issueNum]));
  return {
    ...manifest,
    issues,
    issueNumbers,
    issueNumber: manifest.issueNumber ?? issueNum,
  };
}

export function recordSessionIssue(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'>,
  issueNum: number,
  patch: Partial<SessionIssueManifest>,
): DurableSessionManifest | null {
  return updateSessionManifest(session, (manifest) => upsertIssue(manifest, issueNum, patch));
}

export function recordSessionStage(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'>,
  stage: SessionStage,
  patch: Partial<DurableSessionManifest> = {},
): DurableSessionManifest | null {
  return updateSessionManifest(session, {
    ...patch,
    stage,
  });
}

export function transitionSessionStatus(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'> | string,
  status: SessionStatus,
  stage?: SessionStage,
  patch: Partial<DurableSessionManifest> = {},
): DurableSessionManifest | null {
  return updateSessionManifest(session, (manifest) => ({
    ...mergeManifest(manifest, patch),
    status,
    ...(stage ? { stage } : {}),
    timestamps: {
      ...manifest.timestamps,
      ...(patch.timestamps ?? {}),
      ...(status === 'completed' || status === 'failed' || status === 'cleaned-up'
        ? { endedAt: new Date().toISOString() }
        : {}),
    },
  }));
}

export function transitionHumanFeedbackSessionStatus(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'> | string,
  input: HumanFeedbackTransitionInput,
): DurableSessionManifest | null {
  return updateSessionManifest(session, (manifest) => applyHumanFeedbackTransition(manifest, input));
}

export function recordSessionError(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'>,
  args: { issueNum?: number; stage: string; message: string },
): DurableSessionManifest | null {
  return updateSessionManifest(session, (manifest) => ({
    ...manifest,
    status: manifest.status === 'cleaned-up' ? manifest.status : 'failed',
    stage: 'failed',
    errors: [
      ...manifest.errors,
      {
        issueNum: args.issueNum,
        stage: args.stage,
        message: args.message,
        timestamp: new Date().toISOString(),
      },
    ],
  }));
}

export function recordSessionWorktree(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'>,
  args: { issueNum: number; title?: string; path: string; branch: string; resumed: boolean },
): DurableSessionManifest | null {
  const now = new Date().toISOString();
  return updateSessionManifest(session, (manifest) => {
    const updated = upsertIssue(manifest, args.issueNum, {
      title: args.title,
      status: args.resumed ? 'resuming' : 'running',
      stage: 'worktree',
      branch: args.branch,
      worktreePath: args.path,
      worktreeMissing: !existsSync(args.path),
      resumed: args.resumed,
    });
    return {
      ...updated,
      status: args.resumed ? 'resuming' : 'running',
      stage: 'worktree',
      worktree: {
        path: args.path,
        branch: args.branch,
        resumed: args.resumed,
        missing: !existsSync(args.path),
        lastKnownBranch: args.branch,
        updatedAt: now,
      },
      lastKnownBranch: args.branch,
      currentIssue: { issueNum: args.issueNum, title: args.title },
    };
  });
}

export function recordSessionPrompt(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'>,
  args: { issueNum?: number; stage: string; path: string; prompt: string },
): DurableSessionManifest | null {
  const promptRef: SessionPromptRef = {
    issueNum: args.issueNum,
    stage: args.stage,
    path: args.path,
    hash: hashPromptText(args.prompt),
    recordedAt: new Date().toISOString(),
  };
  return updateSessionManifest(session, (manifest) => {
    const prompts = manifest.prompts.filter((entry) => !(
      entry.issueNum === promptRef.issueNum &&
      entry.stage === promptRef.stage &&
      entry.path === promptRef.path
    ));
    prompts.push(promptRef);
    return {
      ...manifest,
      prompts,
      promptPath: promptRef.path,
      promptHash: promptRef.hash,
    };
  });
}

export function recordSessionTranscript(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'>,
  args: { issueNum?: number; stage: string; path: string },
): DurableSessionManifest | null {
  const transcriptRef: SessionTranscriptRef = {
    issueNum: args.issueNum,
    stage: args.stage,
    path: args.path,
    recordedAt: new Date().toISOString(),
  };
  return updateSessionManifest(session, (manifest) => {
    const transcripts = manifest.transcripts.filter((entry) => !(
      entry.issueNum === transcriptRef.issueNum &&
      entry.stage === transcriptRef.stage &&
      entry.path === transcriptRef.path
    ));
    transcripts.push(transcriptRef);
    return {
      ...manifest,
      transcripts,
      transcriptPath: transcriptRef.path,
    };
  });
}

export function recordSessionLogFile(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'> | string,
  filePath: string,
): DurableSessionManifest | null {
  const relPath = projectRelative(filePath);
  return updateSessionManifest(session, (manifest) => ({
    ...manifest,
    logs: {
      ...manifest.logs,
      files: Array.from(new Set([...manifest.logs.files, relPath])),
    },
  }));
}

export function recordSessionCleanup(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'>,
  cleanup: SessionCleanupManifest,
): DurableSessionManifest | null {
  return updateSessionManifest(session, (manifest) => ({
    ...manifest,
    stage: 'cleanup',
    cleanup,
    worktree: manifest.worktree
      ? {
          ...manifest.worktree,
          missing: cleanup.status === 'removed' || cleanup.status === 'missing',
          updatedAt: cleanup.at,
        }
      : manifest.worktree,
  }));
}

export function recordSessionPolicyDecision(
  session: Pick<SessionContext, 'manifestPath' | 'resultsDir'> | string,
  decision: AutomationPolicyDecision,
): DurableSessionManifest | null {
  return updateSessionManifest(session, (manifest) => {
    const currentPolicyDecisions = manifest.policyDecisions ?? [];
    const policyDecisions = currentPolicyDecisions.some((entry) => entry.id === decision.id)
      ? currentPolicyDecisions
      : [...currentPolicyDecisions, decision];
    if (decision.issueNum === undefined) {
      return { ...manifest, policyDecisions };
    }
    const issuePatch: Partial<SessionIssueManifest> = {
      title: decision.title,
      status: decision.status === 'allowed' ? 'running' : 'human_input_requested',
      stage: decision.stage === 'diff' ? 'review' : 'paused',
      ...(decision.status === 'allowed' ? {} : { labels: ['needs-human-input'] }),
    };
    const updated = upsertIssue(manifest, decision.issueNum, issuePatch);
    return { ...updated, policyDecisions };
  });
}

function issueMatchesManifest(manifest: DurableSessionManifest, issueNum: number): boolean {
  return manifest.issueNumber === issueNum
    || manifest.currentIssue?.issueNum === issueNum
    || manifest.issueNumbers.includes(issueNum)
    || manifest.issues.some((issue) => issue.issueNum === issueNum);
}

export function findLatestResumableSessionForIssue(
  issueNum: number,
  sessionsRoot = join(process.cwd(), '.alpha-loop', 'sessions'),
  options: FindResumableSessionOptions = {},
): ResumableSessionRef | null {
  if (!existsSync(sessionsRoot)) return null;
  const refs: ResumableSessionRef[] = [];
  const statuses = options.statuses ? new Set(options.statuses) : RESUMABLE_STATUSES;

  try {
    for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDir = join(sessionsRoot, group.name);
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = join(groupDir, entry.name);
        const manifestPath = sessionManifestPath(sessionDir);
        const manifest = loadSessionManifest(manifestPath);
        if (!manifest) continue;
        const feedbackStatus = manifest.feedback?.currentStatus;
        if (!statuses.has(manifest.status) && (!feedbackStatus || !statuses.has(feedbackStatus))) continue;
        if (!issueMatchesManifest(manifest, issueNum)) continue;
        const worktreePath = manifest.worktree?.path ?? null;
        refs.push({
          manifest,
          manifestPath,
          sessionDir,
          worktreePath,
          worktreeExists: worktreePath ? existsSync(worktreePath) : false,
          recoveryBranch: manifest.worktree?.lastKnownBranch ?? manifest.lastKnownBranch ?? manifest.branch ?? null,
        });
      }
    }
  } catch {
    return refs[0] ?? null;
  }

  refs.sort((a, b) => {
    const aTime = a.manifest.timestamps.updatedAt ?? a.manifest.timestamps.startedAt;
    const bTime = b.manifest.timestamps.updatedAt ?? b.manifest.timestamps.startedAt;
    return bTime.localeCompare(aTime);
  });
  return refs[0] ?? null;
}

function readSessionResults(sessionDir: string): PipelineResult[] {
  try {
    return readdirSync(sessionDir)
      .filter((file) => file.startsWith('result-') && file.endsWith('.json'))
      .sort()
      .map((file) => {
        try {
          return JSON.parse(readFileSync(join(sessionDir, file), 'utf-8')) as PipelineResult;
        } catch {
          return null;
        }
      })
      .filter((result): result is PipelineResult => result !== null);
  } catch {
    return [];
  }
}

export function rehydrateSessionContextFromManifest(ref: ResumableSessionRef): SessionContext {
  const { manifest, manifestPath, sessionDir } = ref;
  return {
    id: manifest.sessionId,
    name: manifest.name,
    branch: manifest.branch,
    startedAt: manifest.timestamps.startedAt,
    resultsDir: sessionDir,
    logsDir: join(sessionDir, 'logs'),
    manifestPath,
    results: readSessionResults(sessionDir),
    sessionPrUrl: manifest.sessionPrUrl ?? manifest.prUrl ?? undefined,
    currentIssueNum: manifest.currentIssue?.issueNum ?? manifest.issueNumber ?? undefined,
    parentEpicNum: manifest.parentEpicNumber ?? undefined,
    epic: manifest.epic,
    queue: manifest.queue,
  };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function draftSessionPrTitle(name: string, milestone: string | undefined, epicNum: number | undefined, epicTitle: string | undefined): string {
  if (epicNum !== undefined) {
    return `Epic #${epicNum}${epicTitle ? `: ${epicTitle}` : ''}`;
  }
  return milestone ? `Milestone: ${milestone}` : `Session: ${name}`;
}

function formatEpicLink(epic: QueueEpicLink | null): string {
  if (!epic) return 'None';
  const title = epic.title ? ` - ${epic.title}` : '';
  const pr = epic.sessionPrUrl ? ` ([session PR](${epic.sessionPrUrl}))` : '';
  const branch = !epic.sessionPrUrl && epic.sessionBranch ? ` (${epic.sessionBranch})` : '';
  return `#${epic.number}${title}${pr}${branch}`;
}

function previousPrLabel(queue: QueueSessionContext): string {
  if (queue.dependsOnSessionPrUrl) {
    return `[the previous session PR](${queue.dependsOnSessionPrUrl})`;
  }
  if (queue.previousSessionPrUrl) {
    return `[the previous session PR](${queue.previousSessionPrUrl})`;
  }
  if (queue.previousEpic) {
    return `the previous session PR for #${queue.previousEpic.number}`;
  }
  return 'the previous session PR';
}

function formatPathList(paths: string[] | undefined): string {
  if (!paths || paths.length === 0) return '(paths unavailable)';
  return paths.map((path) => `\`${path.replace(/`/g, '\\`')}\``).join(', ');
}

export function formatAutoCommittedResultsSection(results: PipelineResult[]): string[] {
  const autoCommitted = results.filter((result) => result.autoCommittedByPipeline);
  if (autoCommitted.length === 0) return [];

  const lines = ['### Auto-Committed By Pipeline', ''];
  for (const result of autoCommitted) {
    const pr = result.prUrl ? ` ([PR](${result.prUrl}))` : '';
    lines.push(`- #${result.issueNum}: ${result.title}${pr} — ${formatPathList(result.autoCommittedPaths)}`);
  }
  lines.push('');
  return lines;
}

function crashMarkerPath(sessionDir: string, issueNum: number): string {
  return join(sessionDir, `crash-${issueNum}.json`);
}

function parseCrashMarker(raw: unknown): CrashMarker | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const issueNum = typeof data.issueNum === 'number'
    ? data.issueNum
    : Number(data.issueNum);

  if (!Number.isInteger(issueNum) || issueNum <= 0) return null;
  if (typeof data.step !== 'string' || !data.step) return null;
  if (typeof data.branch !== 'string' || !data.branch) return null;
  if (typeof data.hasCommits !== 'boolean') return null;
  if (typeof data.error !== 'string') return null;
  if (typeof data.timestamp !== 'string' || !data.timestamp) return null;
  if (typeof data.recoverable !== 'boolean') return null;

  return {
    issueNum,
    step: data.step,
    branch: data.branch,
    hasCommits: data.hasCommits,
    error: data.error,
    timestamp: data.timestamp,
    recoverable: data.recoverable,
  };
}

/**
 * Write a crash marker for a half-finished issue so session state can detect it.
 */
export function writeCrashMarker(session: SessionContext, marker: WriteCrashMarkerInput): void {
  const crash: CrashMarker = {
    ...marker,
    timestamp: marker.timestamp ?? new Date().toISOString(),
  };
  mkdirSync(session.resultsDir, { recursive: true });
  const filePath = crashMarkerPath(session.resultsDir, crash.issueNum);
  writeFileSync(filePath, JSON.stringify(crash, null, 2) + '\n');
  recordSessionError(session, {
    issueNum: crash.issueNum,
    stage: crash.step,
    message: crash.error,
  });
  recordSessionIssue(session, crash.issueNum, {
    status: 'failed',
    stage: 'failed',
    branch: crash.branch,
    worktreeMissing: false,
  });
  log.warn(`Crash marker saved: ${filePath}`);
}

/**
 * Load valid crash markers from one session directory.
 * Invalid or unreadable markers are ignored so recovery can fall back to branch walking.
 */
export function loadCrashMarkers(sessionDir: string): CrashMarker[] {
  try {
    if (!existsSync(sessionDir)) return [];
    return readdirSync(sessionDir)
      .filter((file) => /^crash-\d+\.json$/.test(file))
      .map((file) => {
        try {
          return parseCrashMarker(JSON.parse(readFileSync(join(sessionDir, file), 'utf-8')));
        } catch {
          return null;
        }
      })
      .filter((marker): marker is CrashMarker => marker !== null);
  } catch {
    return [];
  }
}

/**
 * Find crash markers across .alpha-loop/sessions.
 */
export function findCrashMarkers(sessionsRoot = join(process.cwd(), '.alpha-loop', 'sessions')): CrashMarkerRef[] {
  if (!existsSync(sessionsRoot)) return [];

  const markers: CrashMarkerRef[] = [];
  try {
    for (const group of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDir = join(sessionsRoot, group.name);
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = join(groupDir, entry.name);
        const sessionName = `${group.name}/${entry.name}`;
        for (const marker of loadCrashMarkers(sessionDir)) {
          markers.push({
            ...marker,
            sessionDir,
            sessionName,
            filePath: crashMarkerPath(sessionDir, marker.issueNum),
          });
        }
      }
    }
  } catch {
    return markers;
  }

  markers.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return markers;
}

/**
 * Remove a crash marker after a normal result or recovered result is written.
 */
export function clearCrashMarker(sessionOrDir: Pick<SessionContext, 'resultsDir'> | string, issueNum: number): void {
  const sessionDir = typeof sessionOrDir === 'string' ? sessionOrDir : sessionOrDir.resultsDir;
  const filePath = crashMarkerPath(sessionDir, issueNum);
  try {
    if (!existsSync(filePath)) return;
    unlinkSync(filePath);
    log.info(`Crash marker cleared: ${filePath}`);
  } catch {
    log.warn(`Could not clear crash marker: ${filePath}`);
  }
}

function buildQueueSection(queue: QueueSessionContext, branch: string, baseBranch: string): string[] {
  const lines: string[] = [
    '## Execution Queue',
    '',
    `**Queue:** ${queue.queueId}`,
    `**Position:** ${queue.queueIndex} of ${queue.queueTotal}`,
    `**Parent epic:** ${formatEpicLink(queue.currentEpic)}`,
    `**Previous queued epic:** ${formatEpicLink(queue.previousEpic)}`,
    `**Next queued epic:** ${formatEpicLink(queue.nextEpic)}`,
    `**Branch ancestry:** ${queue.branchAncestryMode}`,
  ];

  if (queue.branchAncestryMode === 'stacked') {
    if (queue.dependsOnSessionBranch) {
      lines.push(`**Branched from:** ${queue.dependsOnSessionBranch}`);
      lines.push(`**Depends on:** ${queue.dependsOnSessionPrUrl ? `[${queue.dependsOnSessionBranch}](${queue.dependsOnSessionPrUrl})` : queue.dependsOnSessionBranch}`);
    } else {
      lines.push(`**Branched from:** ${queue.branchedFromBranch}`);
      lines.push('**Depends on:** None - this is the first queued session branch.');
    }
  } else {
    lines.push(`**Branched from:** ${queue.branchedFromBranch}`);
    lines.push('**Depends on:** None - no branch ancestry dependency was created.');
  }

  lines.push('');
  lines.push('### Merge Order');
  lines.push('');

  if (queue.branchAncestryMode === 'stacked' && queue.dependsOnSessionBranch) {
    const rebaseTarget = queue.rebaseOntoBranch ?? baseBranch;
    lines.push(`- Merge ${previousPrLabel(queue)} first; after it lands on ${rebaseTarget}, rebase \`${branch}\` onto \`${rebaseTarget}\` before final review/merge.`);
    lines.push(`- This PR still targets \`${baseBranch}\`, but its branch was created from \`${queue.dependsOnSessionBranch}\`.`);
  } else if (queue.branchAncestryMode === 'stacked') {
    lines.push(`- This is the first queued session PR. Merge it before later queued session PRs.`);
    if (queue.nextEpic) {
      lines.push(`- Later queued sessions may be branched from \`${branch}\`; review ${formatEpicLink(queue.nextEpic)} after this PR.`);
    }
  } else {
    lines.push(`- Review this PR in queue order, but it can merge independently once ready.`);
    lines.push(`- No branch ancestry dependency was created; this branch starts from \`${queue.branchedFromBranch}\`.`);
  }

  lines.push('');
  lines.push('### Dependency And Overlap Notes');
  lines.push('');
  const riskLines = [
    ...queue.dependencyWarnings.map((warning) => `- Dependency: ${warning}`),
    ...queue.overlapWarnings.map((warning) => `- File overlap: ${warning}`),
  ];
  if (riskLines.length > 0) {
    lines.push(...riskLines);
  } else {
    lines.push('- No queued dependency or file-overlap risks detected.');
  }

  return lines;
}

function buildDraftSessionPrBody(args: {
  branch: string;
  startedAt: string;
  milestone?: string;
  epicNum?: number;
  epicTitle?: string;
  queue?: QueueSessionContext;
  baseBranch: string;
}): string {
  const lines: string[] = ['## Session In Progress', ''];
  if (args.epicNum !== undefined) {
    lines.push(`**Epic:** #${args.epicNum}${args.epicTitle ? ` — ${args.epicTitle}` : ''}`);
  } else if (args.milestone) {
    lines.push(`**Milestone:** ${args.milestone}`);
  }
  lines.push(`**Branch:** ${args.branch}`);
  lines.push(`**Started:** ${args.startedAt}`);
  lines.push('');

  if (args.queue) {
    lines.push(...buildQueueSection(args.queue, args.branch, args.baseBranch));
    lines.push('');
  }

  lines.push('This PR will be updated as issues are processed.');
  lines.push('');
  lines.push('---');
  lines.push('*Automated by alpha-loop*');
  return lines.join('\n');
}

/**
 * Create a new session context with timestamp-based name.
 * Optionally creates a session branch when autoMerge is enabled.
 */
export function createSession(config: Config, options?: CreateSessionOptions): SessionContext {
  const now = new Date();
  const timestamp = formatTimestamp(now);
  const startedAt = now.toISOString();
  const milestone = options?.milestone;
  const epicNum = options?.epicNum;
  const epicTitle = options?.epicTitle;
  const queue = options?.queue;

  let slug: string;
  if (epicNum !== undefined) {
    const titleSlug = epicTitle ? slugify(epicTitle) : '';
    slug = titleSlug ? `epic-${epicNum}-${titleSlug}` : `epic-${epicNum}`;
  } else if (milestone) {
    slug = slugify(milestone);
  } else {
    slug = timestamp;
  }
  const name = `session/${slug}`;
  const branch = config.mergeTo || name;

  const projectDir = process.cwd();
  const resultsDir = join(projectDir, '.alpha-loop', 'sessions', name);
  const logsDir = join(resultsDir, 'logs');
  const manifestPath = sessionManifestPath(resultsDir);
  const id = sessionIdFromName(name);
  let sessionPrUrl: string | undefined;
  const branchSource = queue?.branchedFromBranch ?? config.baseBranch;

  if (!config.dryRun) {
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
  }

  // Create session branch and draft PR if auto-merge is enabled
  if (config.autoMerge && !config.dryRun) {
    // Fetch latest to ensure we have remote refs
    exec('git fetch origin', { cwd: projectDir });

    const branchExists = exec(`git rev-parse --verify "${branch}"`, { cwd: projectDir });
    if (branchExists.exitCode !== 0) {
      // Create from the queue ancestry branch (or base branch) first, fall back to local.
      const fromRemote = exec(
        `git checkout -b "${branch}" "origin/${branchSource}"`,
        { cwd: projectDir },
      );
      if (fromRemote.exitCode !== 0) {
        exec(`git checkout -b "${branch}" "${branchSource}"`, { cwd: projectDir });
      }
      // Create an initial commit so the branch has a diff from base (required for PR creation)
      exec(`git commit --allow-empty -m "chore: start session ${name}"`, { cwd: projectDir });
      // Push session branch to remote so PRs can target it
      exec(`git push origin "${branch}"`, { cwd: projectDir });
      // Switch back to the original branch
      exec(`git checkout -`, { cwd: projectDir });
      log.info(`Created session branch: ${branch}`);

      // Create a draft PR immediately so the session is visible in GitHub
      try {
        const draftPR = createPR({
          repo: config.repo,
          base: config.baseBranch,
          head: branch,
          title: draftSessionPrTitle(name, milestone, epicNum, epicTitle),
          body: buildDraftSessionPrBody({
            branch,
            startedAt: new Date().toISOString(),
            milestone,
            epicNum,
            epicTitle,
            queue,
            baseBranch: config.baseBranch,
          }),
          cwd: projectDir,
        });
        sessionPrUrl = draftPR;
        log.success(`Session PR (draft): ${draftPR}`);
      } catch {
        // Non-fatal — PR can be created later during finalization
        log.warn('Could not create draft session PR — will create during finalization');
      }
    } else {
      // Ensure session branch exists on remote (may have been deleted after a previous merge)
      const remoteCheck = exec(`git ls-remote --heads origin "${branch}"`, { cwd: projectDir });
      if (!remoteCheck.stdout.trim()) {
        log.warn(`Session branch "${branch}" exists locally but not on remote — recreating from ${branchSource}`);
        // Ensure we're not on the branch we're about to delete
        exec(`git checkout "${branchSource}"`, { cwd: projectDir });
        // Delete stale local branch and recreate from current base (the old one is behind after merge)
        exec(`git branch -D "${branch}"`, { cwd: projectDir });
        const fromRemote = exec(
          `git checkout -b "${branch}" "origin/${branchSource}"`,
          { cwd: projectDir },
        );
        if (fromRemote.exitCode !== 0) {
          exec(`git checkout -b "${branch}" "${branchSource}"`, { cwd: projectDir });
        }
        exec(`git commit --allow-empty -m "chore: start session ${name}"`, { cwd: projectDir });
        const pushResult = exec(`git push origin "${branch}"`, { cwd: projectDir });
        if (pushResult.exitCode !== 0) {
          log.error(`Failed to push recreated session branch: ${pushResult.stderr}`);
        }
        exec(`git checkout -`, { cwd: projectDir });
        log.info(`Recreated session branch: ${branch}`);

        // Recreate draft PR for the session
        try {
          const draftPR = createPR({
            repo: config.repo,
            base: config.baseBranch,
            head: branch,
            title: draftSessionPrTitle(name, milestone, epicNum, epicTitle),
            body: buildDraftSessionPrBody({
              branch,
              startedAt: new Date().toISOString(),
              milestone,
              epicNum,
              epicTitle,
              queue,
              baseBranch: config.baseBranch,
            }),
            cwd: projectDir,
          });
          sessionPrUrl = draftPR;
          log.success(`Session PR (draft): ${draftPR}`);
        } catch {
          log.warn('Could not create draft session PR — will create during finalization');
        }
      } else {
        log.info(`Session branch already exists: ${branch}`);
      }
    }
  }

  const session: SessionContext = {
    id,
    name,
    branch,
    startedAt,
    resultsDir,
    logsDir,
    manifestPath,
    results: [],
    sessionPrUrl,
    currentIssueNum: options?.issueNum,
    parentEpicNum: options?.parentEpicNum,
    epic: epicNum,
    queue,
  };

  if (!config.dryRun) {
    const traceDir = runDir(name, projectDir);
    const initialIssueNumbers = Array.from(new Set([
      ...(options?.selectedIssueNums ?? []),
      ...(options?.issueNum !== undefined ? [options.issueNum] : []),
    ]));
    const initialIssues: SessionIssueManifest[] = initialIssueNumbers.map((issueNum) => ({
      issueNum,
      ...(issueNum === options?.issueNum && options.issueTitle ? { title: options.issueTitle } : {}),
      status: 'running',
      stage: 'created',
      startedAt,
      updatedAt: startedAt,
    }));
    const manifest: DurableSessionManifest = {
      version: 1,
      sessionId: id,
      name,
      issueNumber: options?.issueNum ?? null,
      issueNumbers: initialIssueNumbers,
      parentEpicNumber: options?.parentEpicNum ?? epicNum ?? null,
      parentEpicTitle: options?.parentEpicTitle ?? epicTitle ?? null,
      branch,
      baseBranch: config.baseBranch,
      prUrl: sessionPrUrl ?? null,
      sessionPrUrl: sessionPrUrl ?? null,
      status: 'running',
      stage: 'created',
      labels: [],
      feedback: initialHumanFeedbackState('running', startedAt),
      harness: {
        agent: config.agent,
        model: config.model,
        reviewModel: config.reviewModel,
        command: config.agent,
        testCommand: config.testCommand,
      },
      command: config.agent,
      worktree: null,
      lastKnownBranch: branch,
      currentIssue: options?.issueNum !== undefined
        ? { issueNum: options.issueNum, title: options.issueTitle }
        : null,
      issues: initialIssues,
      prompts: [],
      promptPath: null,
      promptHash: null,
      transcripts: [],
      transcriptPath: null,
      logs: {
        sessionDir: projectRelative(resultsDir, projectDir),
        logsDir: projectRelative(logsDir, projectDir),
        traceDir: projectRelative(traceDir, projectDir),
        files: [],
      },
      screenshots: [],
      previewUrl: null,
      timestamps: {
        createdAt: startedAt,
        startedAt,
        updatedAt: startedAt,
      },
      lastEventId: null,
      policyDecisions: [],
      errors: [],
      ...(epicNum !== undefined ? { epic: epicNum } : {}),
      ...(queue ? { queue } : {}),
    };
    writeManifestFile(manifestPath, manifest);
    log.info(`Session manifest saved: ${manifestPath}`);
  }

  return session;
}

/**
 * Save a pipeline result to the session directory as JSON.
 */
export function saveResult(session: SessionContext, result: PipelineResult): void {
  const filePath = join(session.resultsDir, `result-${result.issueNum}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n');
  recordSessionIssue(session, result.issueNum, {
    title: result.title,
    status: result.status,
    prUrl: result.prUrl,
    failureReason: result.failureReason,
    endedAt: new Date().toISOString(),
  });
  log.info(`Session result saved: ${filePath}`);
  clearCrashMarker(session, result.issueNum);
}

/**
 * Get the previous issue result formatted for prompt context.
 * Returns null if no previous results exist.
 */
export function getPreviousResult(session: SessionContext): string | null {
  if (session.results.length === 0) return null;

  const prev = session.results[session.results.length - 1];
  return `## Previous Issue in This Session
- Issue #${prev.issueNum}: ${prev.title}
- Status: ${prev.status}
- Tests: ${prev.testsPassing ? 'PASSING' : 'FAILING'}
- Files changed: ${prev.filesChanged}
- Duration: ${prev.duration}s
${prev.prUrl ? `- PR: ${prev.prUrl}` : ''}

Build on what was already done. Avoid duplicating work.`;
}

/**
 * Finalize session: commit learnings to session branch, create session PR.
 * Only runs when autoMerge is enabled and issues were processed.
 */
export async function finalizeSession(
  session: SessionContext,
  config: Config,
): Promise<string | null> {
  if (!config.autoMerge) return null;
  if (session.branch === config.baseBranch) return null;
  if (session.results.length === 0) return null;

  if (config.dryRun) {
    log.dry(`Would finalize session: ${session.branch} -> ${config.baseBranch}`);
    return null;
  }

  log.step(`Finalizing session: ${session.branch}`);
  recordSessionStage(session, 'finalize');

  const projectDir = process.cwd();

  // Ensure we're on the session branch and up to date with remote
  // (batch PRs may have been auto-merged into the remote session branch)
  exec('git fetch origin', { cwd: projectDir });
  const checkout = exec(`git checkout "${session.branch}"`, { cwd: projectDir });
  if (checkout.exitCode !== 0) {
    log.warn('Could not checkout session branch for finalization');
    return null;
  }
  // Pull remote changes (auto-merged batch PRs) into local branch
  const pull = exec(`git pull origin "${session.branch}" --no-edit`, { cwd: projectDir });
  if (pull.exitCode !== 0) {
    log.warn(`Could not pull remote session branch — trying rebase`);
    exec(`git rebase "origin/${session.branch}"`, { cwd: projectDir });
  }

  // Save session manifest to learnings directory (tracked in git, shared with team)
  const learningsDir = join(projectDir, '.alpha-loop', 'learnings');
  mkdirSync(learningsDir, { recursive: true });
  repairSessionLearningArtifacts({
    sessionName: session.name,
    issues: session.results.map((r) => ({
      issueNum: r.issueNum,
      title: r.title,
      status: r.status,
      duration: r.duration,
    })),
    learningsDir,
    sessionLogsDir: session.logsDir,
  });
  repairSessionSummaryArtifact({
    sessionName: session.name,
    learningsDir,
  });

  const manifestName = `session-${session.name.replace(/\//g, '-')}.json`;
  const stageEntries = (() => {
    try {
      return readStageTelemetry(runDir(session.name, projectDir));
    } catch {
      return [];
    }
  })();
  const manifest: Record<string, unknown> = {
    name: session.name,
    branch: session.branch,
    completed: new Date().toISOString(),
    results: session.results.map((r) => ({
      issueNum: r.issueNum,
      title: r.title,
      status: r.status,
      prUrl: r.prUrl,
      testsPassing: r.testsPassing,
      verifyPassing: r.verifyPassing,
      recoveryMode: r.recoveryMode,
      autoCommittedByPipeline: r.autoCommittedByPipeline,
      autoCommittedPaths: r.autoCommittedPaths,
      duration: r.duration,
      filesChanged: r.filesChanged,
    })),
  };
  if (session.queue) {
    manifest.queue = session.queue;
  }
  if (stageEntries.length > 0) {
    manifest.stages = stageEntries;
  }
  writeFileSync(join(learningsDir, manifestName), JSON.stringify(manifest, null, 2) + '\n');
  log.info(`Session manifest saved: ${manifestName}`);

  // Stage learnings (including session manifest)
  exec('git add .alpha-loop/learnings/', { cwd: projectDir });

  // Commit if there are staged changes
  const diffResult = exec('git diff --cached --quiet', { cwd: projectDir });
  if (diffResult.exitCode !== 0) {
    const commitIssueCount = session.results.length;
    exec(
      `git commit -m "chore: learnings from ${session.name}\n\nProcessed ${commitIssueCount} issue(s) in this session."`,
      { cwd: projectDir },
    );
    exec(`git push origin "${session.branch}"`, { cwd: projectDir });
  }

  // Create or update session PR
  const recovered = session.results.filter(isRecoveredSessionResult);
  const naturalResults = session.results.filter((r) => !isRecoveredSessionResult(r));
  const successes = naturalResults.filter((r) => r.status === 'success');
  const permanentFailures = naturalResults.filter((r) => r.status === 'failure' && r.failureReason !== 'transient');
  const transientFailures = naturalResults.filter((r) => r.status === 'failure' && r.failureReason === 'transient');
  const waitingResults = naturalResults.filter((r) => r.status === 'waiting');
  const totalDuration = naturalResults.reduce((sum, r) => sum + r.duration, 0);

  // Only count completed issues (not transient failures that were re-queued)
  const completedCount = successes.length + permanentFailures.length;
  const titleStatus = completedCount > 0
    ? `${successes.length}/${completedCount} succeeded`
    : `${successes.length} succeeded`;
  const prTitle = `Session: ${session.name} — ${titleStatus}${recovered.length > 0 ? `, ${recovered.length} recovered` : ''}`;

  const prLines: string[] = [
    '## Session Summary',
    '',
    `**Branch:** ${session.branch}`,
    `**Issues processed:** ${session.results.length} (${successes.length} succeeded, ${permanentFailures.length} failed, ${waitingResults.length} waiting, ${recovered.length} recovered)`,
    `**Total duration:** ${Math.round(totalDuration / 60)} minutes`,
    `**Completed:** ${new Date().toISOString()}`,
    '',
  ];

  if (session.queue) {
    prLines.push(...buildQueueSection(session.queue, session.branch, config.baseBranch));
    prLines.push('');
  }

  // Successes — the main content
  if (successes.length > 0) {
    prLines.push('### Issues');
    for (const r of successes) {
      prLines.push(`- #${r.issueNum}: ${r.title} — SUCCESS${r.prUrl ? ` ([PR](${r.prUrl}))` : ''}`);
    }
    prLines.push('');
    prLines.push(...successes.map((r) => `Closes #${r.issueNum}`));
    prLines.push('');
  }

  // Recovered issues — visible, but not natural successes/failures.
  if (recovered.length > 0) {
    prLines.push('### Recovered Issues');
    for (const r of recovered) {
      const mode = r.recoveryMode.toUpperCase();
      prLines.push(`- #${r.issueNum}: ${r.title} — RECOVERED BY ${mode}${r.prUrl ? ` ([PR](${r.prUrl}))` : ''}`);
    }
    prLines.push('');
    prLines.push('*Recovered issues were not counted as succeeded or failed because recovery did not run the full pipeline verification path.*');
    prLines.push('');
  }

  prLines.push(...formatAutoCommittedResultsSection(session.results));

  if (waitingResults.length > 0) {
    prLines.push('### Waiting for Human Feedback');
    for (const r of waitingResults) {
      const state = r.waitingStatus ? ` (${r.waitingStatus})` : '';
      prLines.push(`- #${r.issueNum}: ${r.title}${state}${r.prUrl ? ` ([PR](${r.prUrl}))` : ''}`);
      if (r.humanInputQuestion) prLines.push(`  - Question: ${r.humanInputQuestion}`);
      if (r.qaChecklist && r.qaChecklist.length > 0) {
        prLines.push(`  - QA: ${r.qaChecklist.join('; ')}`);
      }
      if (r.followUpIssueUrl) prLines.push(`  - Follow-up: ${r.followUpIssueUrl}`);
    }
    prLines.push('');
  }

  // Permanent failures — collapsed
  if (permanentFailures.length > 0) {
    prLines.push('<details>');
    prLines.push(`<summary>Failed Issues (${permanentFailures.length})</summary>`);
    prLines.push('');
    for (const r of permanentFailures) {
      prLines.push(`- #${r.issueNum}: ${r.title} — FAILURE`);
    }
    prLines.push('');
    prLines.push('</details>');
    prLines.push('');
  }

  // Transient failures — brief note, these were re-queued
  if (transientFailures.length > 0) {
    prLines.push(`*${transientFailures.length} issue(s) were re-queued due to agent rate limits.*`);
    prLines.push('');
  }

  // Session review findings
  if (session.sessionReviewFindings) {
    const gate = session.sessionReviewFindings;
    prLines.push('### Session Review');
    prLines.push('');
    prLines.push(`**Status:** ${gate.passed ? 'PASSED' : 'NEEDS ATTENTION'}`);
    prLines.push(`**Summary:** ${gate.summary || 'No summary'}`);
    if (gate.findings.length > 0) {
      prLines.push('');
      for (const f of gate.findings) {
        const fixedTag = f.fixed ? ' (fixed)' : '';
        prLines.push(`- [${f.severity.toUpperCase()}] ${f.description}${fixedTag}${f.file ? ` — \`${f.file}\`` : ''}`);
      }
    }
    prLines.push('');
  }

  prLines.push('---');
  prLines.push(`This PR collects all changes from this session for final review before merging to ${config.baseBranch}.`);
  prLines.push('');
  prLines.push('Automated by alpha-loop');

  const prBody = prLines.join('\n');

  try {
    const prUrl = createPR({
      repo: config.repo,
      base: config.baseBranch,
      head: session.branch,
      title: prTitle,
      body: prBody,
      cwd: projectDir,
    });
    session.sessionPrUrl = prUrl;
    updateSessionManifest(session, {
      prUrl,
      sessionPrUrl: prUrl,
      stage: 'finalize',
    });
    log.success(`Session PR: ${prUrl}`);

    // Mark successful issues on the project board
    // When autoMerge is enabled, session PR still needs review — keep issues "In Review"
    // When not auto-merging, individual PRs were already created, so mark as "Done"
    const boardStatus = config.autoMerge ? 'In Review' : 'Done';
    for (const r of session.results) {
      if (r.status === 'success' && !isRecoveredSessionResult(r) && config.project > 0) {
        updateProjectStatus(config.repo, config.project, config.repoOwner, r.issueNum, boardStatus);
      }
    }

    return prUrl;
  } catch (err) {
    // If createPR failed (e.g. nothing to compare), try creating via gh directly
    log.warn(`createPR failed: ${err instanceof Error ? err.message : err}`);
    try {
      const fallback = ghExec(
        `gh pr create --repo "${config.repo}" --base "${config.baseBranch}" --head "${session.branch}" --title "${prTitle}" --body "Session finalization — see branch for details"`,
        { cwd: projectDir }, true,
      );
      if (fallback.exitCode === 0 && fallback.stdout.trim()) {
        const fallbackPrUrl = fallback.stdout.trim();
        session.sessionPrUrl = fallbackPrUrl;
        updateSessionManifest(session, {
          prUrl: fallbackPrUrl,
          sessionPrUrl: fallbackPrUrl,
          stage: 'finalize',
        });
        log.success(`Session PR (fallback): ${fallbackPrUrl}`);
        return fallbackPrUrl;
      }
    } catch {
      // Fall through
    }
    log.warn('Could not create session PR — check branch manually');
    return null;
  }
}
