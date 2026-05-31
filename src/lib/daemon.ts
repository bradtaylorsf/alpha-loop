import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { decisionAllowed, evaluateIssuePolicy, evaluateSessionCapacityPolicy, type AutomationPolicyDecision } from './automation-policy.js';
import type { Config, DaemonConfig, DaemonMode } from './config.js';
import { emitLifecycleEvent, type EventDeliverySummary } from './events.js';
import type { Issue } from './github.js';
import { hasLabel } from './labels.js';
import { log } from './logger.js';
import {
  loadSessionManifest,
  sessionManifestPath,
  type DurableSessionManifest,
  type SessionStatus,
} from './session.js';
import { isWaitingFeedbackStatus, normalizeHumanFeedbackStatus } from './session-state.js';

export type DaemonTickKind = 'triage' | 'feedback' | 'resume' | 'run' | 'health';

export type DaemonLockPayload = {
  version: 1;
  repo: string;
  cwd: string;
  pid: number;
  hostname: string;
  startedAt: string;
  updatedAt: string;
  token: string;
};

export type DaemonLockHandle = {
  path: string;
  token: string;
  payload: DaemonLockPayload;
};

export type DaemonSchedulerState = {
  lastRunAtMs: Partial<Record<DaemonTickKind, number>>;
};

export type DaemonSessionRef = {
  manifest: DurableSessionManifest;
  manifestPath: string;
  sessionDir: string;
};

export type DaemonFeedbackPollResult = {
  status: 'processed' | 'skipped';
  processed: number;
  alreadyProcessed?: number;
  reason?: string;
  policyDecision?: AutomationPolicyDecision;
};

export type DaemonRunResult = {
  ticksRun: number;
  shutdownRequested: boolean;
  lockPath: string | null;
};

export type DaemonActions = {
  triage: (config: Config) => Promise<void>;
  pollFeedback: (config: Config, daemon: DaemonConfig) => Promise<DaemonFeedbackPollResult>;
  pollIssues: (config: Config) => Issue[];
  getIssue?: (config: Config, issueNumber: number) => Issue | null;
  runIssue: (config: Config, issue: Issue) => Promise<{ status: 'success' | 'failure' | 'waiting'; issueNumber: number }>;
  resumeIssue: (config: Config, issueNumber: number, statuses?: SessionStatus[]) => Promise<boolean>;
  emitEvent?: typeof emitLifecycleEvent;
};

export type DaemonRunLoopOptions = {
  onceTick?: boolean;
  maxTicks?: number;
  acquireLock?: boolean;
  now?: () => Date;
  nowMs?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  isPidAlive?: (pid: number) => boolean;
  scheduler?: DaemonSchedulerState;
  installSignalHandlers?: boolean;
};

export class DaemonLockError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'DaemonLockError';
    this.path = path;
  }
}

const TICK_ORDER: DaemonTickKind[] = ['triage', 'feedback', 'resume', 'run', 'health'];
const DAEMON_RESUME_STATUSES: SessionStatus[] = [
  'running',
  'active',
  'paused',
  'waiting-for-feedback',
  'qa-requested',
  'human_input_requested',
  'qa_requested',
  'feedback_received',
  'resume_requested',
  'resuming',
  'resumed',
];

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function toMs(seconds: number): number {
  return Math.max(1, seconds) * 1000;
}

export function daemonLockPath(daemon: DaemonConfig, cwd = process.cwd()): string {
  return daemon.lock.path || join(cwd, '.alpha-loop', 'daemon.lock');
}

export function daemonStatePath(cwd = process.cwd()): string {
  return join(cwd, '.alpha-loop', 'daemon-state.json');
}

export function enabledDaemonTickKinds(mode: DaemonMode): DaemonTickKind[] {
  if (mode === 'triage-only') return ['triage', 'health'];
  if (mode === 'feedback-only') return ['feedback', 'resume', 'health'];
  if (mode === 'run-only') return ['run', 'health'];
  return TICK_ORDER;
}

function intervalMsForTick(daemon: DaemonConfig, kind: DaemonTickKind): number {
  if (kind === 'triage') return toMs(daemon.triageIntervalSeconds);
  if (kind === 'feedback' || kind === 'resume') return toMs(daemon.feedbackIntervalSeconds);
  if (kind === 'run') return toMs(daemon.runIntervalSeconds);
  return toMs(daemon.healthIntervalSeconds);
}

export function createDaemonScheduler(
  daemon: DaemonConfig,
  nowMs: number,
  options: { markEnabledTicksRun?: boolean } = {},
): DaemonSchedulerState {
  if (!options.markEnabledTicksRun) return { lastRunAtMs: {} };
  return {
    lastRunAtMs: Object.fromEntries(enabledDaemonTickKinds(daemon.mode).map((kind) => [kind, nowMs])),
  };
}

export function dueDaemonTicks(
  daemon: DaemonConfig,
  scheduler: DaemonSchedulerState,
  nowMs: number,
): DaemonTickKind[] {
  const enabled = new Set(enabledDaemonTickKinds(daemon.mode));
  return TICK_ORDER.filter((kind) => {
    if (!enabled.has(kind)) return false;
    const last = scheduler.lastRunAtMs[kind];
    return last === undefined || nowMs - last >= intervalMsForTick(daemon, kind);
  });
}

export function markDaemonTickRun(
  scheduler: DaemonSchedulerState,
  kind: DaemonTickKind,
  nowMs: number,
): void {
  scheduler.lastRunAtMs[kind] = nowMs;
}

function parseLock(raw: string): DaemonLockPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonLockPayload>;
    if (parsed.version !== 1) return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return null;
    if (typeof parsed.repo !== 'string' || typeof parsed.startedAt !== 'string') return null;
    return parsed as DaemonLockPayload;
  } catch {
    return null;
  }
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

function lockIsStale(lock: DaemonLockPayload | null, daemon: DaemonConfig, now: Date, isPidAlive: (pid: number) => boolean): boolean {
  if (!lock) return true;
  if (!isPidAlive(lock.pid)) return true;
  if (daemon.lock.staleAfterSeconds <= 0) return false;
  const updated = Date.parse(lock.updatedAt || lock.startedAt);
  if (!Number.isFinite(updated)) return true;
  return now.getTime() - updated > daemon.lock.staleAfterSeconds * 1000;
}

export function acquireDaemonLock(
  config: Config,
  daemon: DaemonConfig,
  options: { now?: Date; isPidAlive?: (pid: number) => boolean; cwd?: string } = {},
): DaemonLockHandle {
  const cwd = options.cwd ?? process.cwd();
  const lockPath = daemonLockPath(daemon, cwd);
  const now = options.now ?? new Date();
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;
  const payload: DaemonLockPayload = {
    version: 1,
    repo: config.repo,
    cwd,
    pid: process.pid,
    hostname: hostname(),
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    token: randomUUID(),
  };

  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
    return { path: lockPath, token: payload.token, payload };
  } catch {
    let existing: DaemonLockPayload | null = null;
    try {
      existing = parseLock(readFileSync(lockPath, 'utf-8'));
    } catch {
      existing = null;
    }

    if (lockIsStale(existing, daemon, now, isPidAlive)) {
      try { unlinkSync(lockPath); } catch { /* best effort */ }
      writeFileSync(lockPath, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
      return { path: lockPath, token: payload.token, payload };
    }

    throw new DaemonLockError(
      lockPath,
      `Another alpha-loop daemon is already running for ${existing?.repo ?? config.repo} (pid ${existing?.pid ?? 'unknown'}). Lock: ${lockPath}`,
    );
  }
}

export function releaseDaemonLock(lock: DaemonLockHandle | null): boolean {
  if (!lock) return false;
  try {
    const current = parseLock(readFileSync(lock.path, 'utf-8'));
    if (current?.token !== lock.token) return false;
    unlinkSync(lock.path);
    return true;
  } catch {
    return false;
  }
}

export function refreshDaemonLock(lock: DaemonLockHandle | null, now = new Date()): boolean {
  if (!lock) return false;
  try {
    const current = parseLock(readFileSync(lock.path, 'utf-8'));
    if (current?.token !== lock.token) return false;
    const payload: DaemonLockPayload = {
      ...current,
      updatedAt: now.toISOString(),
    };
    const tmpPath = `${lock.path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n');
    renameSync(tmpPath, lock.path);
    lock.payload = payload;
    return true;
  } catch {
    return false;
  }
}

function writeDaemonState(
  config: Config,
  daemon: DaemonConfig,
  state: {
    status: 'starting' | 'running' | 'idle' | 'stopping' | 'stopped' | 'failed';
    startedAt: string;
    lockPath: string | null;
    ticksRun: number;
    currentTick?: DaemonTickKind | null;
    shutdownRequested?: boolean;
    error?: string | null;
  },
  now: Date,
): void {
  if (config.dryRun) return;
  const filePath = daemonStatePath();
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = {
    version: 1,
    repo: config.repo,
    mode: daemon.mode,
    pid: process.pid,
    status: state.status,
    lockPath: state.lockPath,
    startedAt: state.startedAt,
    updatedAt: now.toISOString(),
    ticksRun: state.ticksRun,
    currentTick: state.currentTick ?? null,
    shutdownRequested: Boolean(state.shutdownRequested),
    error: state.error ?? null,
  };
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n');
  renameSync(tmpPath, filePath);
}

function emitDaemonEvent(
  actions: DaemonActions,
  config: Config,
  type: Parameters<typeof emitLifecycleEvent>[0]['type'],
  metadata: Record<string, unknown> = {},
): Promise<EventDeliverySummary> {
  const emit = actions.emitEvent ?? emitLifecycleEvent;
  return emit({
    config,
    type,
    context: {
      metadata,
      reason: typeof metadata.reason === 'string' ? metadata.reason : null,
      error: typeof metadata.error === 'string' ? metadata.error : null,
      issueNumber: typeof metadata.issueNumber === 'number' ? metadata.issueNumber : undefined,
      issueTitle: typeof metadata.issueTitle === 'string' ? metadata.issueTitle : undefined,
    },
  });
}

function sessionsRoot(cwd = process.cwd()): string {
  return join(cwd, '.alpha-loop', 'sessions');
}

export function listDaemonSessionManifests(root = sessionsRoot()): DaemonSessionRef[] {
  if (!existsSync(root)) return [];
  const refs: DaemonSessionRef[] = [];
  try {
    for (const group of readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const groupDir = join(root, group.name);
      for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = join(groupDir, entry.name);
        const manifestPath = sessionManifestPath(sessionDir);
        const manifest = loadSessionManifest(manifestPath);
        if (manifest) refs.push({ manifest, manifestPath, sessionDir });
      }
    }
  } catch {
    return refs;
  }
  refs.sort((a, b) => {
    const aTime = a.manifest.timestamps.updatedAt ?? a.manifest.timestamps.startedAt;
    const bTime = b.manifest.timestamps.updatedAt ?? b.manifest.timestamps.startedAt;
    return bTime.localeCompare(aTime);
  });
  return refs;
}

function currentManifestStatus(manifest: DurableSessionManifest): string {
  const status = normalizeHumanFeedbackStatus(manifest.status);
  const feedback = normalizeHumanFeedbackStatus(manifest.feedback?.currentStatus ?? '');
  if (status && status !== 'running' && feedback === 'running') return status;
  return feedback ?? status ?? manifest.status;
}

function manifestIssueNumbers(manifest: DurableSessionManifest): number[] {
  return Array.from(new Set([
    ...(manifest.issueNumber !== null ? [manifest.issueNumber] : []),
    ...(manifest.currentIssue?.issueNum !== undefined ? [manifest.currentIssue.issueNum] : []),
    ...manifest.issueNumbers,
    ...manifest.issues.map((issue) => issue.issueNum),
  ]));
}

function fallbackIssueFromManifest(manifest: DurableSessionManifest, issueNumber: number): Issue {
  const issue = manifest.issues.find((entry) => entry.issueNum === issueNumber);
  return {
    number: issueNumber,
    title: manifest.currentIssue?.issueNum === issueNumber
      ? manifest.currentIssue.title ?? issue?.title ?? `Issue #${issueNumber}`
      : issue?.title ?? `Issue #${issueNumber}`,
    body: '',
    labels: issue?.labels ?? manifest.labels,
    comments: [],
  };
}

function manifestForIssue(issueNumber: number): DaemonSessionRef | null {
  return listDaemonSessionManifests().find((ref) => manifestIssueNumbers(ref.manifest).includes(issueNumber)) ?? null;
}

function issueIsBlockedBySession(issue: Issue): { blocked: boolean; reason: string; manifest?: DurableSessionManifest } {
  const ref = manifestForIssue(issue.number);
  if (!ref) return { blocked: false, reason: '' };
  const status = currentManifestStatus(ref.manifest);
  if (status === 'completed' || status === 'failed' || status === 'cleaned-up') return { blocked: false, reason: '' };
  if (isWaitingFeedbackStatus(status)) {
    return { blocked: true, reason: `Issue #${issue.number} already has a waiting session (${status}).`, manifest: ref.manifest };
  }
  return { blocked: true, reason: `Issue #${issue.number} already has an active session (${status}).`, manifest: ref.manifest };
}

function runCandidatesFromIssues(issues: Issue[]): Issue[] {
  return issues.filter((issue) => !hasLabel(issue.labels, 'epic'));
}

async function runTriageTick(config: Config, actions: DaemonActions): Promise<void> {
  log.step('Daemon triage tick');
  await actions.triage(config);
}

async function runFeedbackTick(config: Config, daemon: DaemonConfig, actions: DaemonActions): Promise<void> {
  log.step('Daemon feedback tick');
  const result = await actions.pollFeedback(config, daemon);
  if (result.status === 'skipped') {
    await emitDaemonEvent(actions, config, 'daemon.work.skipped', {
      tick: 'feedback',
      reason: result.reason ?? 'Feedback polling skipped.',
      policyDecision: result.policyDecision ?? null,
    });
    return;
  }
  if (result.processed === 0 && (result.alreadyProcessed ?? 0) === 0) {
    await emitDaemonEvent(actions, config, 'daemon.idle', {
      tick: 'feedback',
      reason: 'Feedback poll returned no payloads.',
    });
    return;
  }
  await emitDaemonEvent(actions, config, 'feedback.received', {
    tick: 'feedback',
    processed: result.processed,
    alreadyProcessed: result.alreadyProcessed ?? 0,
  });
}

async function runResumeTick(config: Config, actions: DaemonActions): Promise<void> {
  log.step('Daemon resume tick');
  const candidates = listDaemonSessionManifests()
    .filter((ref) => {
      const status = currentManifestStatus(ref.manifest);
      return status === 'feedback_received'
        || status === 'resume_requested'
        || status === 'active'
        || status === 'running'
        || status === 'resuming'
        || status === 'paused'
        || status === 'waiting-for-feedback'
        || status === 'qa-requested';
    });

  if (candidates.length === 0) return;

  for (const ref of candidates) {
    const issueNumber = ref.manifest.currentIssue?.issueNum ?? ref.manifest.issueNumber ?? ref.manifest.issueNumbers[0];
    if (!issueNumber) continue;

    const capacityDecision = evaluateSessionCapacityPolicy(config, {
      sessionsRoot: sessionsRoot(),
      excludeSessionId: ref.manifest.sessionId,
    });
    if (!decisionAllowed(capacityDecision)) {
      await emitDaemonEvent(actions, config, 'daemon.work.skipped', {
        tick: 'resume',
        issueNumber,
        sessionId: ref.manifest.sessionId,
        sessionName: ref.manifest.name,
        reason: capacityDecision.reason,
        policyDecision: capacityDecision,
      });
      continue;
    }

    const issue = actions.getIssue?.(config, issueNumber) ?? fallbackIssueFromManifest(ref.manifest, issueNumber);
    const issueDecision = evaluateIssuePolicy(config, issue);
    if (!decisionAllowed(issueDecision)) {
      await emitDaemonEvent(actions, config, 'daemon.work.skipped', {
        tick: 'resume',
        issueNumber,
        issueTitle: issue.title,
        sessionId: ref.manifest.sessionId,
        sessionName: ref.manifest.name,
        reason: issueDecision.reason,
        policyDecision: issueDecision,
      });
      continue;
    }

    await emitDaemonEvent(actions, config, 'daemon.resume.requested', {
      tick: 'resume',
      issueNumber,
      issueTitle: issue.title,
      sessionId: ref.manifest.sessionId,
      sessionName: ref.manifest.name,
      priorStatus: currentManifestStatus(ref.manifest),
    });
    const handled = await actions.resumeIssue(config, issueNumber, DAEMON_RESUME_STATUSES);
    if (handled) return;
  }
}

async function runWorkTick(config: Config, actions: DaemonActions): Promise<void> {
  log.step('Daemon run tick');
  const capacityDecision = evaluateSessionCapacityPolicy(config, { sessionsRoot: sessionsRoot() });
  if (!decisionAllowed(capacityDecision)) {
    await emitDaemonEvent(actions, config, 'daemon.work.skipped', {
      tick: 'run',
      reason: capacityDecision.reason,
      policyDecision: capacityDecision,
    });
    return;
  }

  const issues = runCandidatesFromIssues(actions.pollIssues(config));
  if (issues.length === 0) {
    await emitDaemonEvent(actions, config, 'daemon.idle', {
      tick: 'run',
      reason: 'No eligible ready issues found.',
    });
    return;
  }

  for (const issue of issues) {
    const sessionBlock = issueIsBlockedBySession(issue);
    if (sessionBlock.blocked) {
      await emitDaemonEvent(actions, config, 'daemon.work.skipped', {
        tick: 'run',
        issueNumber: issue.number,
        issueTitle: issue.title,
        sessionId: sessionBlock.manifest?.sessionId ?? null,
        sessionName: sessionBlock.manifest?.name ?? null,
        reason: sessionBlock.reason,
      });
      continue;
    }

    const issueDecision = evaluateIssuePolicy(config, issue);
    if (!decisionAllowed(issueDecision)) {
      await emitDaemonEvent(actions, config, 'daemon.work.skipped', {
        tick: 'run',
        issueNumber: issue.number,
        issueTitle: issue.title,
        reason: issueDecision.reason,
        policyDecision: issueDecision,
      });
      continue;
    }

    await emitDaemonEvent(actions, config, 'daemon.work.selected', {
      tick: 'run',
      issueNumber: issue.number,
      issueTitle: issue.title,
      policyDecision: issueDecision,
    });
    await actions.runIssue(config, issue);
    return;
  }

  await emitDaemonEvent(actions, config, 'daemon.idle', {
    tick: 'run',
    reason: 'All ready issues were skipped.',
  });
}

export async function runDaemonTick(
  config: Config,
  daemon: DaemonConfig,
  kind: DaemonTickKind,
  actions: DaemonActions,
): Promise<void> {
  try {
    if (kind === 'triage') await runTriageTick(config, actions);
    else if (kind === 'feedback') await runFeedbackTick(config, daemon, actions);
    else if (kind === 'resume') await runResumeTick(config, actions);
    else if (kind === 'run') await runWorkTick(config, actions);
    else {
      await emitDaemonEvent(actions, config, 'daemon.health', {
        tick: 'health',
        mode: daemon.mode,
      });
    }
  } catch (err) {
    await emitDaemonEvent(actions, config, 'daemon.failed', {
      tick: kind,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function runDaemonLoop(
  config: Config,
  daemon: DaemonConfig,
  actions: DaemonActions,
  options: DaemonRunLoopOptions = {},
): Promise<DaemonRunResult> {
  const now = options.now ?? (() => new Date());
  const nowMs = options.nowMs ?? (() => now().getTime());
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now().toISOString();
  const scheduler = options.scheduler ?? createDaemonScheduler(daemon, nowMs());
  const shouldAcquireLock = options.acquireLock ?? daemon.lock.enabled;
  let lock: DaemonLockHandle | null = null;
  let lockHeartbeat: NodeJS.Timeout | null = null;
  let ticksRun = 0;
  let shutdownRequested = false;
  const shutdownController = new AbortController();
  const installSignals = options.installSignalHandlers ?? true;

  const requestShutdown = (): void => {
    shutdownRequested = true;
    shutdownController.abort();
  };

  if (installSignals) {
    process.on('SIGINT', requestShutdown);
    process.on('SIGTERM', requestShutdown);
  }

  try {
    if (shouldAcquireLock) {
      lock = acquireDaemonLock(config, daemon, { now: now(), isPidAlive: options.isPidAlive });
      if (daemon.lock.staleAfterSeconds > 0) {
        const heartbeatMs = Math.max(1000, Math.min(60_000, Math.floor(daemon.lock.staleAfterSeconds * 500)));
        lockHeartbeat = setInterval(() => {
          refreshDaemonLock(lock);
        }, heartbeatMs);
      }
    }

    writeDaemonState(config, daemon, {
      status: 'starting',
      startedAt,
      lockPath: lock?.path ?? null,
      ticksRun,
    }, now());
    await emitDaemonEvent(actions, config, 'daemon.started', {
      mode: daemon.mode,
      lockPath: lock?.path ?? null,
      pid: process.pid,
    });

    while (!shutdownRequested) {
      const due = dueDaemonTicks(daemon, scheduler, nowMs());
      if (due.length === 0) {
        refreshDaemonLock(lock, now());
        writeDaemonState(config, daemon, {
          status: 'idle',
          startedAt,
          lockPath: lock?.path ?? null,
          ticksRun,
        }, now());
        await emitDaemonEvent(actions, config, 'daemon.idle', {
          mode: daemon.mode,
          idleSleepSeconds: daemon.idleSleepSeconds,
        });
        await sleep(toMs(daemon.idleSleepSeconds), shutdownController.signal);
        continue;
      }

      for (const kind of due) {
        if (shutdownRequested) break;
        if (options.maxTicks !== undefined && ticksRun >= options.maxTicks) break;
        refreshDaemonLock(lock, now());
        writeDaemonState(config, daemon, {
          status: 'running',
          startedAt,
          lockPath: lock?.path ?? null,
          ticksRun,
          currentTick: kind,
        }, now());
        await runDaemonTick(config, daemon, kind, actions);
        markDaemonTickRun(scheduler, kind, nowMs());
        ticksRun += 1;
        refreshDaemonLock(lock, now());
        writeDaemonState(config, daemon, {
          status: 'running',
          startedAt,
          lockPath: lock?.path ?? null,
          ticksRun,
          currentTick: null,
        }, now());
        if (options.onceTick) {
          shutdownRequested = true;
          break;
        }
      }

      if (options.maxTicks !== undefined && ticksRun >= options.maxTicks) break;
    }

    writeDaemonState(config, daemon, {
      status: 'stopping',
      startedAt,
      lockPath: lock?.path ?? null,
      ticksRun,
      shutdownRequested,
    }, now());
    await emitDaemonEvent(actions, config, 'daemon.shutdown', {
      mode: daemon.mode,
      ticksRun,
      lockPath: lock?.path ?? null,
      shutdownRequested,
    });
    return {
      ticksRun,
      shutdownRequested,
      lockPath: lock?.path ?? null,
    };
  } catch (err) {
    writeDaemonState(config, daemon, {
      status: 'failed',
      startedAt,
      lockPath: lock?.path ?? null,
      ticksRun,
      error: err instanceof Error ? err.message : String(err),
    }, now());
    if (!(err instanceof DaemonLockError)) {
      await emitDaemonEvent(actions, config, 'daemon.failed', {
        mode: daemon.mode,
        ticksRun,
        lockPath: lock?.path ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  } finally {
    if (lockHeartbeat) clearInterval(lockHeartbeat);
    writeDaemonState(config, daemon, {
      status: 'stopped',
      startedAt,
      lockPath: lock?.path ?? null,
      ticksRun,
      shutdownRequested,
    }, now());
    releaseDaemonLock(lock);
    if (installSignals) {
      process.off('SIGINT', requestShutdown);
      process.off('SIGTERM', requestShutdown);
    }
  }
}
