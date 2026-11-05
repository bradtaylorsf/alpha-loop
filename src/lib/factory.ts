/**
 * Factory supervisor — runs Alpha Loop as a parallel, multi-role code factory.
 *
 * One long-running process (singleton via a lease) ticks every
 * `factory.tick_seconds`:
 *
 *   1. reap finished workers (release leases, record results, ask questions)
 *   2. apply answered questions (issue comment + relabel, or re-queue the idea)
 *   3. PM intake: one inbox idea at a time → a PM worker child process
 *   4. planner dispatch: fill free developer slots with `run --issue` workers
 *   5. ship pass: merge green session PRs (fail closed), ask about blockers
 *   6. QA checks the remote base after the merge/time threshold
 *   7. write state.json + events.jsonl
 *
 * Everything with side effects goes through FactoryActions so tests drive the
 * whole loop with fakes, an injected clock, and an instant abortable sleep.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  getFactoryConfig,
  resolveFactoryPaths,
  type Config,
  type FactoryConfig,
  type FactoryPaths,
  FACTORY_MAX_DEVELOPERS,
} from './config.js';
import { appendTaggedIdea, ensureInboxFile, nextPendingIdeas, readInbox, recoverTakenIdeas, updateIdea, type InboxIdea } from './factory-inbox.js';
import { planDispatch, extractTouches, type DispatchCandidate, type DispatchPlan, type DispatchSkip } from './factory-planner.js';
import {
  answeredQuestions,
  askQuestion,
  markQuestion,
  openQuestionCount,
  readQuestions,
  renderQuestions,
  type FactoryQuestion,
  type NewQuestion,
} from './factory-questions.js';
import { decideShip, listShippablePrs, mergeShippablePr, updateShippablePrBranch, type ShipDecision, type ShipPolicy, type ShipPr } from './factory-ship.js';
import {
  readPmProgress,
  readWorkerResult,
  spawnDeveloperWorker,
  spawnPmWorker,
  spawnQaWorker,
  readQaWorkerContext,
  type QaWorkerContext,
  writeJsonAtomic,
  type PmWorkerResult,
  type WorkerExit,
  type WorkerHandle,
} from './factory-workers.js';
import { cleanupQaWorktree, formatQaBugIdea, isQaResult, qaFailureFingerprint, qaWorktreePath, readQaState, shouldRunQa } from './factory-qa.js';
import { parseSubIssues } from './epics.js';
import { ingestFeedback } from './feedback.js';
import { closeIssue, commentIssue, getIssueWithComments, labelIssue, pollIssues, type Issue } from './github.js';
import { acquireLease, defaultPidAlive, isLeaseStale, listLeases, readLease, refreshLease, releaseLease, type LeaseHandle } from './lease.js';
import { log } from './logger.js';
import { runPreflight } from './preflight.js';
import { ghExec } from './rate-limit.js';
import type { IssueExecutionResult } from '../commands/run.js';

// ── Public types ─────────────────────────────────────────────────────────────

export type FactoryRunOptions = {
  developers?: number;
  epics?: number[];
  /** One tick of new work, then drain running workers and exit. */
  once?: boolean;
  untilIdle?: boolean;
  maxTicks?: number;
  maxRuntimeMinutes?: number;
  pm?: boolean;
  ship?: boolean;
  shipMerge?: boolean;
  dryRun?: boolean;
  baseBranch?: string;
  verbose?: boolean;
  /** Aborting this stops the factory exactly like SIGINT. */
  signal?: AbortSignal;
  /** Install SIGINT/SIGTERM handlers (default true). */
  handleSignals?: boolean;
};

export type DeveloperSpawnRequest = { issue: number; title: string; baseBranch: string; verbose?: boolean };
export type PmSpawnRequest = { idea: InboxIdea; priorAnswers: string[] };

export type FactoryActions = {
  now(): Date;
  /** Resolve after `ms`, or as soon as `signal` aborts. Must never reject. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  pollReady(): Issue[];
  isIssueClosed(n: number): boolean | null;
  getEpicChildren(epic: number): number[];
  spawnDeveloper(req: DeveloperSpawnRequest): WorkerHandle;
  spawnPm(req: PmSpawnRequest): WorkerHandle;
  spawnQa(req: { baseBranch: string; merges: number }): WorkerHandle;
  qaProcessAlive(pid: number): boolean;
  killQaProcess(pid: number, signal: NodeJS.Signals): void;
  cleanupQa(workerId: string): string[];
  listShippable(): ShipPr[];
  updateBranch(pr: ShipPr): ReturnType<typeof updateShippablePrBranch>;
  merge(pr: ShipPr, admin: boolean): { merged: boolean; error?: string };
  /** Issue questions: comment the answer on the issue, then relabel it ready. */
  applyAnswer(q: FactoryQuestion): { applied: boolean; note: string };
  preflight(): Promise<boolean>;
  /** One-time generated-file preparation in the shared checkout (agent assets, project context). */
  prepare(): Promise<void>;
  /** The repository's default branch, or null when it cannot be read. */
  defaultBranch(): string | null;
  /** Close an issue as completed (after its session PR merged into a non-default base). */
  closeIssue(n: number): boolean;
};

export type FactoryCounts = {
  dispatched: number;
  succeeded: number;
  failed: number;
  waiting: number;
  merged: number;
  ideasIngested: number;
  questionsAsked: number;
  answersApplied: number;
};

export type FactoryEvent = { at: string; type: string; [key: string]: unknown };

export type FactoryStatus = 'running' | 'draining' | 'stopped';

/** A session PR a developer worker of this factory reported as finished. */
export type OwnedPr = { pr: number; url: string; issue: number };

/** What the supervisor must remember across restarts (persisted in state.json). */
export type FactoryMemory = {
  /** The only PRs the shipper may merge or ask about. */
  owned: OwnedPr[];
  /** ship:* question key → PR state signature it was asked for (no re-ask until it changes). */
  shipAsked: Record<string, string>;
  /** PR number → last update attempt and the head awaiting fresh CI (including uncertain update outcomes). */
  branchUpdates: Record<string, { attemptedAt: string; previousHead?: string }>;
  /** Issues whose session PR this factory merged (dependency-satisfied even if still open). */
  mergedIssues: number[];
  /** Per-base cadence and durable receipts for idempotent result recovery. */
  qa?: Record<string, { mergesSinceLastQa: number; lastQaAt: string | null; consumed: string[] }>;
};

export type FactoryState = {
  version: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  tick: number;
  status: FactoryStatus;
  baseBranch: string;
  developers: number;
  epics: number[];
  workers: Array<{ id: string; role: string; issue?: number; ideaId?: string; pid: number | null; startedAt: string; logPath: string }>;
  lastPlan: { dispatched: number[]; skipped: DispatchSkip[] };
  ship: { lastRunAt: string | null; decisions: Array<{ pr: number; action: string; reason: string }>; error?: string };
  counts: FactoryCounts;
  openQuestions: number;
  pendingIdeas: number;
  recent: FactoryEvent[];
  memory?: FactoryMemory;
};

export type FactoryDryRunPlan = {
  ideas: Array<{ id: string; text: string }>;
  answers: Array<{ id: string; key: string }>;
  dispatch: Array<{ issue: number; title: string; priority: number; epic?: number }>;
  skipped: DispatchSkip[];
  /** Eligible ready issues left for a later tick because every developer slot is taken. */
  queued: Array<{ issue: number; title: string }>;
  ship: Array<{ pr: number; action: ShipDecision['action']; reason: string }>;
  shipError?: string;
};

export type FactorySummary = {
  status: 'dry-run' | 'idle' | 'drained' | 'stopped';
  reason: string;
  ticks: number;
  counts: FactoryCounts;
  dryRun?: FactoryDryRunPlan;
};

// ── Constants ────────────────────────────────────────────────────────────────

const SUPERVISOR_LEASE_KEY = 'factory';
const SUPERVISOR_LEASE_TTL_SECONDS = 300;
const RECENT_EVENTS = 50;
const SHUTDOWN_GRACE_MS = 60_000;
const KILL_GRACE_MS = 30_000;
const POST_KILL_WAIT_MS = 5_000;
const IDLE_PENDING_CHECKS_CAP_MS = 30 * 60_000;
const RECOVER_TAKEN_AFTER_MINUTES = 30;
const PM_MAX_ATTEMPTS = 2;
const MAX_APPLY_ATTEMPTS = 3;
const NEEDS_HUMAN_LABEL = 'needs-human-input';
const FAILED_LABEL = 'failed';
/** Idea meta that only means something while the idea is taken by a PM worker. */
const TAKEN_KEYS = ['taken', 'pid', 'host', 'worker'];
const WORKER_ID_RE = /^[A-Za-z0-9._-]+$/;

// ── Default actions (real modules) ───────────────────────────────────────────

/** Abortable sleep: resolves after `ms` or immediately when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted || ms <= 0) {
      resolveSleep();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveSleep();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function issueStateClosed(repo: string, n: number): boolean | null {
  const result = ghExec(`gh issue view ${n} --repo "${repo}" --json state`);
  if (result.exitCode !== 0) return null;
  try {
    const state = String((JSON.parse(result.stdout) as { state?: string }).state ?? '').toUpperCase();
    // A dependency on a PR number reads back as MERGED: that is satisfied too.
    if (state === 'CLOSED' || state === 'MERGED') return true;
    if (state === 'OPEN') return false;
    return null;
  } catch {
    return null;
  }
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Feedback idempotency id for one answer. Question ids can repeat (the human
 * may delete sections), so the issue and the answer text are part of it: a
 * different answer, or the same id on another issue, is a new event.
 */
export function answerEventId(q: Pick<FactoryQuestion, 'id' | 'issue' | 'answer'>): string {
  return `${q.id}:${q.issue ?? 'none'}:${shortHash(q.answer.trim())}`;
}

/**
 * Comment an answer on its issue (via feedback ingest when possible) and
 * relabel it ready. When ingest reports the exact answer was already
 * processed, nothing is relabeled: re-adding `ready` to an issue that was
 * already re-dispatched would queue a second build.
 */
export function applyIssueAnswer(config: Config, q: FactoryQuestion): { applied: boolean; note: string } {
  if (!q.issue) return { applied: false, note: 'question has no issue' };
  const ready = config.labelReady || 'ready';
  let note: string;
  try {
    const ingested = ingestFeedback({
      payload: {
        repo: config.repo,
        issueNumber: q.issue,
        body: q.answer,
        source: 'factory-questions',
        externalEventId: answerEventId(q),
        resumeRequested: true,
      },
      repo: config.repo,
      readyLabel: ready,
      requestResume: true,
    });
    if (ingested.status === 'already_processed') {
      return { applied: true, note: `answer already recorded on #${q.issue}; not relabeled` };
    }
    note = `answer recorded on #${q.issue} via feedback ingest`;
  } catch (err) {
    log.debug(`Factory: feedback ingest for ${q.id} failed (${err instanceof Error ? err.message : String(err)}); commenting directly`);
    const body = `**Answer from the factory questions file (${q.id}):**\n\n${q.answer}\n\n<!-- factory:answer=${q.id} -->`;
    if (!commentIssue(config.repo, q.issue, body)) {
      return { applied: false, note: `could not comment on #${q.issue}` };
    }
    note = `answer commented on #${q.issue}`;
  }
  labelIssue(config.repo, q.issue, ready, NEEDS_HUMAN_LABEL);
  labelIssue(config.repo, q.issue, ready, FAILED_LABEL);
  return { applied: true, note: `${note}; relabeled ${ready}` };
}

function shipPolicyFor(factory: FactoryConfig, shipMerge: boolean): ShipPolicy {
  return { ...factory.ship, headPrefixes: [...factory.ship.headPrefixes], merge: shipMerge };
}

export function createDefaultFactoryActions(
  config: Config,
  ctx: { paths: FactoryPaths; baseBranch: string; shipMerge: boolean; dryRun: boolean },
): FactoryActions {
  const factory = getFactoryConfig(config);
  return {
    now: () => new Date(),
    sleep: abortableSleep,
    // Strict: a gh failure must throw, not look like "nothing is ready".
    pollReady: () => pollIssues(config.repo, config.labelReady, 100, { strict: true }),
    isIssueClosed: (n) => issueStateClosed(config.repo, n),
    getEpicChildren: (epic) => {
      const epicIssue = getIssueWithComments(config.repo, epic);
      if (!epicIssue) throw new Error(`could not read epic #${epic}`);
      return parseSubIssues(epicIssue.body).map((ref) => ref.number);
    },
    spawnDeveloper: (req) => spawnDeveloperWorker({ paths: ctx.paths, ...req }),
    spawnPm: (req) => spawnPmWorker({
      paths: ctx.paths,
      idea: req.idea,
      priorAnswers: req.priorAnswers,
      pm: { ...factory.pm, dryRun: ctx.dryRun },
    }),
    spawnQa: (req) => spawnQaWorker({ paths: ctx.paths, ...req }),
    qaProcessAlive: (pid) => {
      try { process.kill(-pid, 0); return true; }
      catch (err) { return (err as NodeJS.ErrnoException).code !== 'ESRCH'; }
    },
    killQaProcess: (pid, signal) => { try { process.kill(-pid, signal); } catch { /* already gone */ } },
    cleanupQa: (workerId) => cleanupQaWorktree({ projectDir: process.cwd(), stateDir: ctx.paths.stateDir,
      worktreePath: qaWorktreePath(ctx.paths.stateDir, workerId) }),
    listShippable: () => listShippablePrs(config.repo, ctx.baseBranch, factory.ship.headPrefixes, {
      requiredChecks: factory.ship.adminMerge,
    }),
    merge: (pr, admin) => mergeShippablePr(config.repo, pr, shipPolicyFor(factory, ctx.shipMerge), admin),
    updateBranch: (pr) => updateShippablePrBranch(config.repo, pr),
    applyAnswer: (q) => applyIssueAnswer(config, q),
    preflight: async () => {
      const result = await runPreflight({
        testCommand: config.testCommand,
        skipPreflight: config.skipPreflight,
        skipTests: config.skipTests,
        dryRun: config.dryRun,
      });
      if (!result.passed) {
        log.warn(`Factory preflight: ${result.preExistingFailures.length} pre-existing test failure(s) recorded; workers will ignore them`);
      }
      return result.passed;
    },
    prepare: async () => {
      const { prepareCoordinatorCheckout } = await import('../commands/run.js');
      await prepareCoordinatorCheckout(config);
    },
    defaultBranch: (() => {
      let cached: string | null | undefined;
      return () => {
        if (cached !== undefined) return cached;
        const result = ghExec(`gh repo view "${config.repo}" --json defaultBranchRef --jq .defaultBranchRef.name`);
        const name = result.exitCode === 0 ? result.stdout.trim() : '';
        if (name) cached = name; // failures are retried on the next call
        return name || null;
      };
    })(),
    closeIssue: (n) => {
      closeIssue(config.repo, n, 'completed');
      return true;
    },
  };
}

// ── Internal state ───────────────────────────────────────────────────────────

type DevWorker = {
  handle: WorkerHandle;
  issue: number;
  title: string;
  touches: string[];
  lease: LeaseHandle | null;
  startedMs: number;
  exit?: WorkerExit;
  timedOut: boolean;
  termSentMs?: number;
  killSent: boolean;
};

type QaWorker = {
  handle: WorkerHandle;
  baseBranch: string;
  merges: number;
  startedMs: number;
  recovered: boolean;
  exit?: WorkerExit;
  timedOut: boolean;
  termSentMs?: number;
  killSent: boolean;
};

type PmWorker = {
  handle: Pick<WorkerHandle, 'id' | 'resultPath' | 'logPath'> & Partial<WorkerHandle>;
  idea: InboxIdea;
  startedMs: number;
  exit?: WorkerExit;
  timedOut: boolean;
  termSentMs?: number;
  killSent: boolean;
};

function emptyCounts(): FactoryCounts {
  return { dispatched: 0, succeeded: 0, failed: 0, waiting: 0, merged: 0, ideasIngested: 0, questionsAsked: 0, answersApplied: 0 };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function clampDevelopers(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(FACTORY_MAX_DEVELOPERS, Math.max(1, Math.floor(n)));
}

function issueKeyNumber(key: string): number | null {
  const m = /^issue-(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}


function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeTextAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Create the questions file (header only) when it does not exist yet. */
export function ensureQuestionsFile(path: string): void {
  if (existsSync(path)) return;
  writeTextAtomic(path, renderQuestions([]));
}

/** Idea meta without the per-attempt bookkeeping keys. */
function ideaMeta(meta: Record<string, string>, drop: string[]): Record<string, string> {
  const next = { ...meta };
  for (const key of drop) delete next[key];
  return next;
}

function emptyMemory(): FactoryMemory {
  return { owned: [], shipAsked: {}, branchUpdates: {}, mergedIssues: [] };
}

/** The memory a previous supervisor persisted in state.json (empty when absent or unreadable). */
export function readFactoryMemory(statePath: string): FactoryMemory {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as { memory?: Partial<FactoryMemory> };
    const m = raw.memory ?? {};
    const owned = Array.isArray(m.owned)
      ? m.owned.filter((o): o is OwnedPr => !!o && typeof o.url === 'string' && Number.isInteger(o.pr) && Number.isInteger(o.issue))
      : [];
    const shipAsked: Record<string, string> = {};
    if (m.shipAsked && typeof m.shipAsked === 'object') {
      for (const [k, v] of Object.entries(m.shipAsked)) if (typeof v === 'string') shipAsked[k] = v;
    }
    const mergedIssues = Array.isArray(m.mergedIssues) ? m.mergedIssues.filter((n) => Number.isInteger(n) && n > 0) : [];
    const branchUpdates: FactoryMemory['branchUpdates'] = {};
    if (m.branchUpdates && typeof m.branchUpdates === 'object') {
      for (const [pr, update] of Object.entries(m.branchUpdates)) {
        if (!/^\d+$/.test(pr) || Number(pr) <= 0 || !update || typeof update.attemptedAt !== 'string'
          || !Number.isFinite(Date.parse(update.attemptedAt))
          || (update.previousHead !== undefined && typeof update.previousHead !== 'string')) continue;
        branchUpdates[pr] = {
          attemptedAt: update.attemptedAt,
          ...(update.previousHead !== undefined ? { previousHead: update.previousHead } : {}),
        };
      }
    }
    const qa: NonNullable<FactoryMemory['qa']> = {};
    if (m.qa && typeof m.qa === 'object') {
      for (const [base, entry] of Object.entries(m.qa)) {
        if (!base.startsWith('refs/heads/') || !entry || !Number.isSafeInteger(entry.mergesSinceLastQa) || entry.mergesSinceLastQa < 0) continue;
        qa[base] = { mergesSinceLastQa: entry.mergesSinceLastQa,
          lastQaAt: typeof entry.lastQaAt === 'string' && Number.isFinite(Date.parse(entry.lastQaAt)) ? entry.lastQaAt : null,
          consumed: Array.isArray(entry.consumed) ? entry.consumed.filter((id): id is string => typeof id === 'string' && /^qa-[A-Za-z0-9-]+$/.test(id)) : [] };
      }
    }
    return { owned, shipAsked, branchUpdates, mergedIssues, ...(Object.keys(qa).length ? { qa } : {}) };
  } catch {
    return emptyMemory();
  }
}

function prNumberFromUrl(url: string): number {
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? Number(m[1]) : 0;
}

/** `session/issue-<N>-<slug>` (or `session/issue-<N>`) → N. */
function issueFromHead(head: string): number | undefined {
  const m = /^session\/issue-(\d+)(?:-|$)/.exec(head);
  return m ? Number(m[1]) : undefined;
}

function findOwned(owned: OwnedPr[], pr: ShipPr): OwnedPr | undefined {
  return owned.find((o) => (o.pr > 0 && o.pr === pr.number) || (o.url !== '' && o.url === pr.url));
}

/** The PR state a ship question was asked for; a change in any of these allows re-asking. */
function prSignature(pr: ShipPr): string {
  return [
    pr.headRefOid ?? '',
    pr.mergeable,
    pr.mergeStateStatus,
    pr.reviewDecision ?? '',
    pr.checks,
    (pr.requiredChecksMissing ?? []).join(','),
  ].join('|');
}

/** Why the shipper must leave a PR alone, or null when it may consider it. */
function shipGate(pr: ShipPr, owned: OwnedPr[], inFlightIssues: Set<number>): string | null {
  const headIssue = issueFromHead(pr.headRefName);
  if (headIssue !== undefined && inFlightIssues.has(headIssue)) return `issue #${headIssue} is still being worked on`;
  if (!findOwned(owned, pr)) return 'not a session PR this factory finished';
  return null;
}

function awaitingUpdatedChecks(pr: ShipPr, update: FactoryMemory['branchUpdates'][string] | undefined): boolean {
  return update?.previousHead !== undefined
    && (!update.previousHead || !pr.headRefOid || pr.headRefOid === update.previousHead || pr.checks !== 'success');
}

/** Apply persisted update throttling and require fresh CI, including in dry-run reports. */
function decideRememberedShip(pr: ShipPr, policy: ShipPolicy, now: Date, memory: FactoryMemory, intervalSeconds: number): ShipDecision {
  const update = memory.branchUpdates[pr.number];
  // New CI gets its own timeout, independent of the PR's age. Checks remain
  // mandatory after an update, even when ordinary PRs may merge without them.
  const decision = update?.previousHead !== undefined
    ? decideShip({ ...pr, createdAt: update.attemptedAt }, { ...policy, requireChecks: true }, now)
    : decideShip(pr, policy, now);
  if (decision.action === 'skip') return decision;
  if (decision.action === 'update-branch') {
    if (update && now.getTime() - Date.parse(update.attemptedAt) < intervalSeconds * 1000) {
      return { action: 'wait', reason: 'branch update throttled until ship.interval_seconds has elapsed' };
    }
    // A crash can leave the persisted intent without ever calling gh. A still
    // green BEHIND head may retry after the interval; this does not permit merging.
    return decision;
  }
  if (decision.action !== 'ask' && awaitingUpdatedChecks(pr, update)) {
    return { action: 'wait', reason: 'branch updated; waiting for a new head with successful CI checks' };
  }
  return decision;
}

function pendingIdeaCount(path: string): number {
  try {
    return readInbox(path).filter((idea) => idea.status === 'pending' && idea.text.trim() !== '').length;
  } catch {
    return 0;
  }
}

// ── Resolution ───────────────────────────────────────────────────────────────

export type ResolvedFactoryRun = {
  factory: FactoryConfig;
  paths: FactoryPaths;
  developers: number;
  epics: number[];
  pmEnabled: boolean;
  shipEnabled: boolean;
  shipMerge: boolean;
  baseBranch: string;
  maxTicks?: number;
  maxRuntimeMs: number;
  untilIdle: boolean;
  dryRun: boolean;
  verbose: boolean;
};

/** Merge CLI options over the factory config (options win). */
export function resolveFactoryRun(config: Config, options: FactoryRunOptions = {}): ResolvedFactoryRun {
  const factory = getFactoryConfig(config);
  const maxTicks = options.once
    ? 1
    : options.maxTicks !== undefined && Number.isFinite(options.maxTicks) && options.maxTicks > 0
      ? Math.floor(options.maxTicks)
      : undefined;
  const runtimeMinutes = options.maxRuntimeMinutes ?? factory.maxRuntimeMinutes;
  return {
    factory,
    paths: resolveFactoryPaths(config),
    developers: clampDevelopers(options.developers ?? factory.developers),
    epics: options.epics ?? factory.epics,
    pmEnabled: options.pm ?? factory.pm.enabled,
    shipEnabled: options.ship ?? factory.ship.enabled,
    shipMerge: options.shipMerge ?? factory.ship.merge,
    baseBranch: options.baseBranch || config.baseBranch,
    ...(maxTicks !== undefined ? { maxTicks } : {}),
    maxRuntimeMs: Number.isFinite(runtimeMinutes) && runtimeMinutes > 0 ? runtimeMinutes * 60_000 : 0,
    untilIdle: options.untilIdle ?? false,
    dryRun: Boolean(options.dryRun || config.dryRun),
    verbose: options.verbose ?? false,
  };
}

// ── Planning (shared by dry run and live dispatch) ───────────────────────────

/**
 * A dispatch plan plus whether its inputs could be trusted. `degraded` means a
 * ready-issue poll or an epic read failed, so "nothing to dispatch" may be a
 * lie — idle detection must not believe it.
 */
type ComputedDispatchPlan = DispatchPlan & { degraded: boolean; ready: Issue[] };

function computeDispatchPlan(args: {
  config: Config;
  run: ResolvedFactoryRun;
  actions: FactoryActions;
  slots: number;
  inFlight: Array<{ issue: number; touches: string[] }>;
  failedThisRun: Set<number>;
  mergedIssues?: Set<number>;
  now: Date;
}): ComputedDispatchPlan {
  const { actions, run } = args;
  let degraded = false;
  let ready: Issue[] = [];
  try {
    ready = actions.pollReady();
  } catch (err) {
    degraded = true;
    log.warn(`Factory: could not poll ready issues (${errorMessage(err)})`);
  }

  const preSkipped: DispatchSkip[] = [];
  const candidates = ready.filter((issue) => {
    if (!args.failedThisRun.has(issue.number)) return true;
    preSkipped.push({ issue: issue.number, reason: 'failed', detail: 'failed earlier in this factory run' });
    return false;
  });

  const closedCache = new Map<number, boolean | null>();
  const isIssueClosed = (n: number): boolean | null => {
    // A session PR this factory merged satisfies the dependency even when the
    // issue stays open (no `Closes #N` auto-close off the default branch).
    if (args.mergedIssues?.has(n)) return true;
    if (!closedCache.has(n)) {
      let closed: boolean | null = null;
      try { closed = actions.isIssueClosed(n); } catch { closed = null; }
      closedCache.set(n, closed);
    }
    return closedCache.get(n) ?? null;
  };

  let epicScope: Map<number, number[]> | undefined;
  if (run.epics.length > 0) {
    epicScope = new Map();
    for (const epic of run.epics) {
      let children: number[] = [];
      try {
        children = actions.getEpicChildren(epic);
      } catch (err) {
        degraded = true;
        log.warn(`Factory: could not read children of epic #${epic} (${errorMessage(err)})`);
      }
      epicScope.set(epic, children);
    }
  }

  const leasedIssues = new Set<number>();
  for (const lease of listLeases(run.paths.leasesDir)) {
    if (isLeaseStale(lease, { now: args.now })) continue;
    const n = issueKeyNumber(lease.key);
    if (n !== null) leasedIssues.add(n);
  }

  const plan = planDispatch({
    readyIssues: candidates,
    slots: args.slots,
    inFlight: args.inFlight,
    leasedIssues,
    isIssueClosed,
    ...(epicScope ? { epicScope } : {}),
    avoidOverlap: run.factory.avoidOverlap,
    labels: { ready: args.config.labelReady || 'ready' },
  });
  return { dispatch: plan.dispatch, skipped: [...preSkipped, ...plan.skipped], degraded, ready };
}

// ── Dry run ──────────────────────────────────────────────────────────────────

async function dryRunFactory(config: Config, run: ResolvedFactoryRun, actions: FactoryActions): Promise<FactorySummary> {
  const now = actions.now();
  const plan: FactoryDryRunPlan = { ideas: [], answers: [], dispatch: [], skipped: [], queued: [], ship: [] };

  if (run.pmEnabled) {
    plan.ideas = nextPendingIdeas(readInbox(run.paths.inboxPath), 1).map((idea) => ({ id: idea.id, text: idea.text }));
  }
  plan.answers = answeredQuestions(readQuestions(run.paths.questionsPath)).map((q) => ({ id: q.id, key: q.key }));

  const dispatchPlan = computeDispatchPlan({
    config, run, actions, slots: run.developers, inFlight: [], failedThisRun: new Set(),
    mergedIssues: new Set(readFactoryMemory(run.paths.statePath).mergedIssues), now,
  });
  plan.dispatch = dispatchPlan.dispatch.map((c: DispatchCandidate) => ({
    issue: c.issue.number,
    title: c.issue.title,
    priority: c.priority,
    ...(c.epic !== undefined ? { epic: c.epic } : {}),
  }));
  plan.skipped = dispatchPlan.skipped;
  // The planner does not record slot overflow as a skip; surface it here so a
  // dry run accounts for every ready issue it saw.
  const accounted = new Set([...plan.dispatch.map((d) => d.issue), ...plan.skipped.map((s) => s.issue)]);
  for (const issue of dispatchPlan.ready) {
    if (accounted.has(issue.number)) continue;
    accounted.add(issue.number);
    plan.queued.push({ issue: issue.number, title: issue.title });
  }

  if (run.shipEnabled) {
    try {
      const policy = shipPolicyFor(run.factory, run.shipMerge);
      const memory = readFactoryMemory(run.paths.statePath);
      for (const pr of actions.listShippable()) {
        const gate = shipGate(pr, memory.owned, new Set());
        if (gate) {
          plan.ship.push({ pr: pr.number, action: 'skip', reason: gate });
          continue;
        }
        const d = decideRememberedShip(pr, policy, now, memory, run.factory.ship.intervalSeconds);
        plan.ship.push({ pr: pr.number, action: d.action, reason: d.action === 'ask' ? d.question : d.reason });
      }
    } catch (err) {
      plan.shipError = errorMessage(err);
    }
  }

  log.dry(`Factory dry run — base ${run.baseBranch}, ${run.developers} developer slot(s)${run.epics.length ? `, epics ${run.epics.map((e) => `#${e}`).join(', ')}` : ''}`);
  if (!run.pmEnabled) log.dry('PM: disabled');
  else if (plan.ideas.length === 0) log.dry('PM: no pending ideas');
  for (const idea of plan.ideas) log.dry(`PM would ingest ${idea.id}: ${idea.text.split('\n')[0]}`);
  for (const answer of plan.answers) log.dry(`Would apply answer ${answer.id} (${answer.key})`);
  if (plan.dispatch.length === 0) log.dry('Planner: nothing to dispatch');
  for (const d of plan.dispatch) log.dry(`Would dispatch #${d.issue} (p${d.priority}${d.epic !== undefined ? `, epic #${d.epic}` : ''}): ${d.title}`);
  if (plan.queued.length > 0) {
    log.dry(`Queued for a free slot (${plan.queued.length}): ${plan.queued.map((q) => `#${q.issue}`).join(', ')}`);
  }
  const outOfScope = plan.skipped.filter((s) => s.reason === 'out-of-scope');
  for (const s of plan.skipped) {
    if (s.reason !== 'out-of-scope') log.dry(`Skip #${s.issue}: ${s.reason}${s.detail ? ` (${s.detail})` : ''}`);
  }
  if (outOfScope.length > 0) log.dry(`Skip ${outOfScope.length} ready issue(s) outside the epic scope`);
  if (!run.shipEnabled) log.dry('Shipper: disabled');
  else if (plan.shipError) log.dry(`Shipper: could not list PRs (${plan.shipError})`);
  else if (plan.ship.length === 0) log.dry('Shipper: no open session PRs');
  for (const s of plan.ship) log.dry(`Ship PR #${s.pr}: ${s.action} — ${s.reason}`);

  return { status: 'dry-run', reason: 'dry run', ticks: 0, counts: emptyCounts(), dryRun: plan };
}

// ── Supervisor ───────────────────────────────────────────────────────────────

type DeveloperOutcome = { status: 'success' | 'failure' | 'waiting'; messages: string[]; prUrl: string | null };

function classifyDeveloperExit(w: DevWorker, timeoutMinutes: number): DeveloperOutcome {
  if (w.timedOut) {
    return { status: 'failure', messages: [`worker killed after exceeding ${timeoutMinutes} minute(s)`], prUrl: null };
  }
  const exit = w.exit!;
  const res = exit.result as Partial<IssueExecutionResult> | null;
  if (!res || typeof res !== 'object' || !['success', 'failure', 'waiting'].includes(String(res.status))) {
    return {
      status: 'failure',
      messages: [exit.error ?? 'worker result has no valid status', `exit code ${exit.exitCode}`],
      prUrl: null,
    };
  }
  const messages = Array.isArray(res.failures)
    ? res.failures.map((f) => (f && typeof f.message === 'string' ? f.message : '')).filter(Boolean)
    : [];
  return {
    status: res.status as DeveloperOutcome['status'],
    messages,
    prUrl: typeof res.sessionPrUrl === 'string' ? res.sessionPrUrl : null,
  };
}

async function superviseFactory(
  config: Config,
  run: ResolvedFactoryRun,
  actions: FactoryActions,
  options: FactoryRunOptions,
): Promise<FactorySummary> {
  const { paths, factory } = run;
  mkdirSync(paths.stateDir, { recursive: true });
  const startNow = actions.now();
  const supervisorLease = acquireLease(paths.stateDir, SUPERVISOR_LEASE_KEY, {
    owner: 'factory-supervisor',
    ttlSeconds: SUPERVISOR_LEASE_TTL_SECONDS,
    // A long preflight or tick must not let a second supervisor take over
    // while this one is alive; the TTL still frees it on other hosts.
    aliveOverridesTtl: true,
    now: startNow,
    meta: { baseBranch: run.baseBranch },
  });
  if (!supervisorLease) {
    const held = readLease(paths.stateDir, SUPERVISOR_LEASE_KEY);
    throw new Error(`factory already running (pid ${held?.pid ?? 'unknown'}${held?.hostname ? ` on ${held.hostname}` : ''})`);
  }

  const counts = emptyCounts();
  const recent: FactoryEvent[] = [];
  const devWorkers = new Map<number, DevWorker>();
  let pmWorker: PmWorker | null = null;
  let qaWorker: QaWorker | null = null;
  const failedThisRun = new Set<number>();
  const applyAttempts = new Map<string, number>();
  /** `${id}|${key}|${answer hash}` of answers applied in this run (survives a stale-buffer revert of the file). */
  const appliedThisRun = new Set<string>();
  const memory = readFactoryMemory(paths.statePath);
  memory.qa ??= {};
  const qaMemoryFor = (base: string): NonNullable<FactoryMemory['qa']>[string] =>
    memory.qa![`refs/heads/${base}`] ??= { mergesSinceLastQa: 0, lastQaAt: null, consumed: [] };
  const qaMemory = qaMemoryFor(run.baseBranch);
  const mergedIssues = new Set(memory.mergedIssues);
  let lastPlan: FactoryState['lastPlan'] = { dispatched: [], skipped: [] };
  let lastDispatchDegraded = false;
  let shipState: FactoryState['ship'] = { lastRunAt: null, decisions: [] };
  let lastShipMs: number | null = null;
  let shipTriggered = false;
  let pendingChecks = false;
  let lastWorkerFinishedMs = startNow.getTime();
  let tick = 0;
  let status: FactoryStatus = 'running';
  let finalStatus: FactorySummary['status'] = 'stopped';
  let stopReason = '';
  let drainReason = '';
  let stopRequested = false;
  const stopController = new AbortController();
  const graceController = new AbortController();
  const startedAt = startNow.toISOString();
  const startedMs = startNow.getTime();
  const workerTimeoutMs = factory.workerTimeoutMinutes * 60_000;
  const pmTimeoutMs = (factory.pm.timeoutSeconds * 2 + 300) * 1000;
  const staggerMs = factory.spawnStaggerSeconds * 1000;

  const record = (type: string, data: Record<string, unknown> = {}): void => {
    const event: FactoryEvent = { at: actions.now().toISOString(), type, ...data };
    recent.push(event);
    if (recent.length > RECENT_EVENTS) recent.shift();
    try {
      appendFileSync(paths.eventsPath, JSON.stringify(event) + '\n');
    } catch (err) {
      log.debug(`Factory: could not append event (${errorMessage(err)})`);
    }
  };

  const ask = (q: NewQuestion): FactoryQuestion | null => {
    try {
      const { question, created } = askQuestion(paths.questionsPath, q, { now: actions.now() });
      if (created) {
        counts.questionsAsked += 1;
        record('question.asked', { id: question.id, key: question.key, role: question.role });
        log.warn(`Factory question ${question.id}: ${question.question.split('\n')[0]}`);
      }
      return question;
    } catch (err) {
      log.warn(`Factory: could not write question ${q.key} (${errorMessage(err)})`);
      return null;
    }
  };

  /**
   * Ask a shipper question at most once per PR state: a question the human
   * answered or dismissed is not re-asked until the PR (head, checks,
   * mergeability, review) changes. Returns false when it was suppressed.
   */
  const askShip = (q: NewQuestion, pr: ShipPr): boolean => {
    const signature = prSignature(pr);
    if (memory.shipAsked[q.key] === signature) return false;
    const asked = ask(q);
    if (asked) memory.shipAsked[q.key] = signature;
    return true;
  };

  const setIdea = (id: string, patch: Parameters<typeof updateIdea>[2], line?: number): boolean => {
    try {
      if (updateIdea(paths.inboxPath, id, patch, line !== undefined ? { line } : {})) return true;
      log.warn(`Factory: idea ${id} is no longer in the inbox`);
    } catch (err) {
      log.warn(`Factory: could not update idea ${id} (${errorMessage(err)})`);
    }
    return false;
  };

  const liveHandles = (): WorkerHandle[] => [
    ...[...devWorkers.values()].filter((w) => !w.exit).map((w) => w.handle),
    ...(pmWorker && !pmWorker.exit ? [pmWorker.handle as WorkerHandle] : []),
    ...(qaWorker && !qaWorker.exit ? [qaWorker.handle] : []),
  ];
  const workerCount = (): number => devWorkers.size + (pmWorker ? 1 : 0) + (qaWorker ? 1 : 0);
  const killAll = (signal: NodeJS.Signals): void => {
    for (const handle of liveHandles()) handle.kill(signal);
  };

  const requestStop = (reason: string): void => {
    if (stopRequested) return;
    stopRequested = true;
    stopReason = reason;
    stopController.abort();
  };

  /** Bump the supervisor lease; on loss, stop (another supervisor took over). */
  const refreshSupervisor = (): boolean => {
    if (refreshLease(supervisorLease, { now: actions.now() })) return true;
    log.error('Factory: lost the supervisor lease; another supervisor may have taken over. Stopping.');
    requestStop('lease-lost');
    return false;
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopRequested) {
      log.warn(`Factory received ${signal} again — killing workers now`);
      killAll('SIGKILL');
      graceController.abort();
      return;
    }
    log.warn(`Factory received ${signal}; stopping dispatch and shutting down workers (repeat to force)`);
    requestStop('signal');
  };
  const onAbort = (): void => requestStop('aborted');
  if (options.signal) {
    if (options.signal.aborted) requestStop('aborted');
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const handleSignals = options.handleSignals !== false;
  if (handleSignals) {
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  const writeState = (): boolean => {
    for (const pr of Object.keys(memory.branchUpdates)) {
      if (!memory.owned.some((o) => o.pr === Number(pr) || prNumberFromUrl(o.url) === Number(pr))) delete memory.branchUpdates[pr];
    }
    let openQuestions = 0;
    try { openQuestions = openQuestionCount(readQuestions(paths.questionsPath)); } catch { /* unreadable → 0 */ }
    const state: FactoryState = {
      version: 1,
      pid: process.pid,
      startedAt,
      updatedAt: actions.now().toISOString(),
      tick,
      status,
      baseBranch: run.baseBranch,
      developers: run.developers,
      epics: run.epics,
      workers: [
        ...[...devWorkers.values()].map((w) => w.handle),
        ...(pmWorker ? [pmWorker.handle] : []),
        ...(qaWorker ? [qaWorker.handle] : []),
      ].map((h) => ({
        id: h.id,
        role: h.role ?? 'pm',
        ...(h.issue !== undefined ? { issue: h.issue } : {}),
        ...(h.ideaId !== undefined ? { ideaId: h.ideaId } : {}),
        pid: h.pid ?? null,
        startedAt: h.startedAt ?? '',
        logPath: h.logPath,
      })),
      lastPlan,
      ship: shipState,
      counts: { ...counts },
      openQuestions,
      pendingIdeas: pendingIdeaCount(paths.inboxPath),
      recent: [...recent],
      memory: { ...memory, mergedIssues: [...mergedIssues] },
    };
    try {
      writeJsonAtomic(paths.statePath, state);
      return true;
    } catch (err) {
      log.warn(`Factory: could not write state (${errorMessage(err)})`);
      return false;
    }
  };

  // ── Tick steps ──

  const rememberOwned = (prUrl: string | null, issue: number): void => {
    if (!prUrl) return;
    const pr = prNumberFromUrl(prUrl);
    memory.owned = memory.owned.filter((o) => o.issue !== issue && o.url !== prUrl && !(pr > 0 && o.pr === pr));
    memory.owned.push({ pr, url: prUrl, issue });
  };

  /**
   * Reap one exited developer. `interrupted`: the supervisor itself SIGTERMed
   * it during shutdown, so a failure is our doing — it is recorded as stopped,
   * not counted or asked about. A success that still landed is honoured.
   */
  const reapDeveloper = (w: DevWorker, interrupted: boolean): void => {
    devWorkers.delete(w.issue);
    if (w.lease) {
      releaseLease(w.lease);
      w.lease = null;
    }
    lastWorkerFinishedMs = actions.now().getTime();
    const outcome = classifyDeveloperExit(w, factory.workerTimeoutMinutes);
    const n = w.issue;
    if (interrupted && outcome.status !== 'success') {
      record('worker.stopped', { workerId: w.handle.id, issue: n, exitCode: w.exit?.exitCode ?? null });
      return;
    }
    const contextLines = [
      ...outcome.messages,
      `Issue: https://github.com/${config.repo}/issues/${n}`,
      ...(outcome.prUrl ? [`PR: ${outcome.prUrl}`] : []),
      `Worker log: ${w.handle.logPath}`,
    ];
    if (outcome.status === 'success') {
      counts.succeeded += 1;
      shipTriggered = true;
      rememberOwned(outcome.prUrl, n);
      record('worker.succeeded', { workerId: w.handle.id, issue: n, prUrl: outcome.prUrl });
      log.success(`Factory: #${n} finished${outcome.prUrl ? ` — ${outcome.prUrl}` : ''}`);
    } else if (outcome.status === 'waiting') {
      counts.waiting += 1;
      // Like a failure, a paused issue is not re-dispatched until its question
      // is answered; otherwise the planner picks it again on the next tick.
      failedThisRun.add(n);
      record('worker.waiting', { workerId: w.handle.id, issue: n });
      ask({
        role: 'developer',
        key: `dev:${n}:waiting`,
        issue: n,
        question: `Issue #${n} paused and needs your input`,
        context: contextLines.join('\n'),
      });
    } else {
      counts.failed += 1;
      failedThisRun.add(n);
      record('worker.failed', { workerId: w.handle.id, issue: n, messages: outcome.messages, exitCode: w.exit?.exitCode ?? null });
      log.warn(`Factory: #${n} failed — ${outcome.messages[0] ?? 'unknown error'}`);
      ask({
        role: 'developer',
        key: `dev:${n}:failed`,
        issue: n,
        question: `Issue #${n} failed in the factory. Answer with guidance and it is re-queued as ready, or set the status to dismissed.`,
        context: contextLines.join('\n'),
      });
    }
  };

  const reapDevelopers = (interrupted = false): void => {
    for (const w of [...devWorkers.values()]) {
      if (w.exit) reapDeveloper(w, interrupted);
    }
  };

  /**
   * Turn a finished PM worker into an inbox status. Never re-queues an idea
   * blindly once it may have created issues:
   *   success                         → done / question / rejected
   *   created issues (result or progress sidecar) → `partial` question
   *   killed while applying, none recorded         → `interrupted` question
   *   stopped by our shutdown before applying      → pending (not an attempt)
   *   otherwise                                    → failed attempt (retry, then ask)
   */
  const reapPmWorker = (worker: PmWorker, mode: 'tick' | 'shutdown' | 'orphan'): void => {
    const { idea, timedOut, handle } = worker;
    const exit = worker.exit!;
    lastWorkerFinishedMs = actions.now().getTime();
    const res = exit.result as Partial<PmWorkerResult> | null;
    const meta = ideaMeta(idea.meta, TAKEN_KEYS);
    const line = idea.line;

    if (res && res.status === 'success' && res.decision) {
      const decision = res.decision;
      const note = (res.note ?? '').trim();
      if (decision.decision === 'issue' || decision.decision === 'epic') {
        counts.ideasIngested += 1;
        setIdea(idea.id, { status: 'done', note, meta: ideaMeta(meta, ['attempts']) }, line);
        record('idea.ingested', { idea: idea.id, createdIssues: res.createdIssues ?? [], epic: res.epic, note });
      } else if (decision.decision === 'question') {
        const questions = (res.question ?? decision.questions ?? []).filter((q) => typeof q === 'string' && q.trim());
        const q = ask({
          role: 'pm',
          key: `pm:${idea.id}`,
          idea: idea.id,
          question: questions.length > 0 ? questions.join('\n') : 'The PM needs more detail before it can plan this idea.',
          context: idea.text,
        });
        setIdea(idea.id, { status: 'question', note: q?.id ?? 'question pending', meta: ideaMeta(meta, ['attempts']) }, line);
        record('idea.question', { idea: idea.id, question: q?.id });
      } else {
        setIdea(idea.id, { status: 'rejected', note: note || decision.reason, meta: ideaMeta(meta, ['attempts']) }, line);
        record('idea.rejected', { idea: idea.id, decision: decision.decision, note: note || decision.reason });
      }
      return;
    }

    const error = timedOut
      ? 'PM worker timed out'
      : (res && typeof res.error === 'string' && res.error) || exit.error || `PM worker exited with code ${exit.exitCode}`;
    const progress = readPmProgress(handle.resultPath);
    const fromResult = res && Array.isArray(res.createdIssues)
      ? res.createdIssues.filter((n): n is number => Number.isInteger(n) && n > 0)
      : [];
    const created = [...new Set([...fromResult, ...(progress?.createdIssues ?? [])])];
    if (created.length > 0) {
      // Never re-run blindly: that would create the same issues again.
      const list = created.map((n) => `#${n}`).join(', ');
      const q = ask({
        role: 'pm',
        key: `pm:${idea.id}:partial`,
        idea: idea.id,
        question: `The PM created ${list} for this idea and then failed: ${error}. Finish the breakdown by hand and dismiss this, or answer to re-run the PM (it will see the issues it already created).`,
        context: idea.text,
      });
      setIdea(idea.id, { status: 'question', note: `partial ${list}; see ${q?.id ?? 'questions'}`, meta }, line);
      record('idea.partial', { idea: idea.id, createdIssues: created, error, log: handle.logPath });
      return;
    }

    if (progress?.phase === 'applying') {
      // Killed between "start creating" and recording a number: an issue may
      // exist on GitHub that nothing here knows about.
      const q = ask({
        role: 'pm',
        key: `pm:${idea.id}:interrupted`,
        idea: idea.id,
        question: `The PM was stopped while creating issues for this idea (${error}). It may have created issues the factory could not record — search issues for "factory:idea=${idea.id}". Finish by hand and dismiss this, or answer to re-run the PM.`,
        context: `${idea.text}\n\nWorker log: ${handle.logPath}`,
      });
      setIdea(idea.id, { status: 'question', note: q?.id ?? 'PM interrupted while applying', meta }, line);
      record('idea.interrupted', { idea: idea.id, applying: true, error, log: handle.logPath });
      return;
    }

    if (mode === 'shutdown') {
      // Stopped by us before any GitHub write: back to the queue, not a failed attempt.
      setIdea(idea.id, { status: 'pending', meta }, line);
      record('worker.stopped', { workerId: handle.id, idea: idea.id });
      return;
    }

    const attempts = (Number(idea.meta.attempts) || 0) + 1;
    const nextMeta = { ...meta, attempts: String(attempts) };
    record('idea.failed', { idea: idea.id, attempts, error, log: handle.logPath });
    if (attempts >= PM_MAX_ATTEMPTS) {
      const q = ask({
        role: 'pm',
        key: `pm:${idea.id}:failed`,
        idea: idea.id,
        question: `The PM failed ${attempts} times on this idea (${error}). Answer with a clearer description to retry, or dismiss it.`,
        context: `${idea.text}\n\nWorker log: ${handle.logPath}`,
      });
      setIdea(idea.id, { status: 'question', note: q?.id ?? 'PM failed', meta: nextMeta }, line);
    } else {
      log.warn(`Factory: PM failed on ${idea.id} (${error}); will retry`);
      setIdea(idea.id, { status: 'pending', meta: nextMeta }, line);
    }
  };

  const reapPm = (mode: 'tick' | 'shutdown' = 'tick'): void => {
    if (!pmWorker?.exit) return;
    const worker = pmWorker;
    pmWorker = null;
    reapPmWorker(worker, mode);
  };

  /**
   * Ideas left `taken` by a previous (crashed) supervisor. One whose recorded
   * PM worker has died is reaped from that worker's result.json / progress
   * sidecar, exactly like a live worker would have been; anything else stale
   * (no worker recorded, older than the recovery window) goes back to pending.
   * The idea this supervisor's own PM worker holds is never touched.
   */
  const recoverOrphanedIdeas = (): void => {
    const skip = pmWorker ? [pmWorker.idea.id] : [];
    try {
      for (const idea of readInbox(paths.inboxPath)) {
        if (idea.status !== 'taken' || skip.includes(idea.id)) continue;
        const workerId = idea.meta.worker;
        const pid = Number(idea.meta.pid);
        if (!workerId || !WORKER_ID_RE.test(workerId) || idea.meta.host !== hostname()) continue;
        if (Number.isInteger(pid) && pid > 0 && defaultPidAlive(pid)) continue;
        const workerDir = join(paths.workersDir, workerId);
        const resultPath = join(workerDir, 'result.json');
        const { result, error } = readWorkerResult(resultPath);
        record('idea.orphan-reaped', { idea: idea.id, workerId });
        reapPmWorker({
          idea,
          handle: { id: workerId, resultPath, logPath: join(workerDir, 'worker.log') },
          exit: { exitCode: result ? 0 : 1, result, ...(error ? { error: `orphaned PM worker: ${error}` } : {}) },
          startedMs: 0,
          timedOut: false,
          killSent: false,
        }, 'orphan');
      }
    } catch (err) {
      log.warn(`Factory: could not check orphaned ideas (${errorMessage(err)})`);
    }
    try {
      const recovered = recoverTakenIdeas(paths.inboxPath, {
        olderThanMinutes: RECOVER_TAKEN_AFTER_MINUTES,
        now: actions.now(),
        skipIds: pmWorker ? [pmWorker.idea.id] : [],
      });
      if (recovered.length > 0) record('ideas.recovered', { ids: recovered });
    } catch (err) {
      log.warn(`Factory: could not recover taken ideas (${errorMessage(err)})`);
    }
  };

  const qaReceipt = (base: string, id: string): boolean => qaMemoryFor(base).consumed.includes(id);

  const reapQa = (interrupted = false): void => {
    const w = qaWorker;
    if (!w?.exit) return;
    const raw = w.exit.result;
    const result = isQaResult(raw) && raw.baseBranch === w.baseBranch ? raw : null;
    const attempted = result !== null || existsSync(join(paths.workersDir, w.handle.id, 'attempted.json'));
    const cadence = qaMemoryFor(w.baseBranch);
    let cleanupErrors = result?.cleanupErrors ?? [];
    if (cleanupErrors.length > 0 || (!result && (attempted || existsSync(qaWorktreePath(paths.stateDir, w.handle.id))))) {
      try { cleanupErrors = [...cleanupErrors, ...actions.cleanupQa(w.handle.id)]; }
      catch (err) { cleanupErrors.push(errorMessage(err)); }
    }
    if (cleanupErrors.length) log.warn(`Factory QA cleanup: ${cleanupErrors.join('; ')}`);
    if (!qaReceipt(w.baseBranch, w.handle.id)) {
      // Append before the receipt. A crash between them repeats only the locked dedupe lookup.
      if (result?.status === 'failure' && !interrupted) {
        const { idea, created } = appendTaggedIdea(paths.inboxPath, formatQaBugIdea(result), {
          source: 'qa', fingerprint: qaFailureFingerprint(result.failure!),
        });
        record('qa.bug', { workerId: w.handle.id, idea: idea.id, created });
      }
      if (attempted) {
        cadence.mergesSinceLastQa = Math.max(0, cadence.mergesSinceLastQa - w.merges);
        cadence.lastQaAt = result?.startedAt ?? w.handle.startedAt;
      }
      cadence.consumed.push(w.handle.id);
      // Persist counter and receipt atomically before acknowledging the worker.
      if (!writeState()) throw new Error('Could not persist QA result receipt');
    }
    record(interrupted ? 'qa.stopped' : result ? `qa.${result.status}` : 'qa.worker-failed', {
      workerId: w.handle.id, baseBranch: w.baseBranch, testedSha: result?.testedSha,
      error: result ? undefined : w.exit.error ?? 'missing or invalid QA result', cleanupErrors,
    });
    if (!result && !interrupted) log.warn(`Factory QA: ${w.exit.error ?? 'missing or invalid worker result'} (${w.handle.logPath})`);
    // Periodic QA creates no PR whose CI needs a fresh idle wait budget.
    qaWorker = null;
  };

  /** Adopt unconsumed QA children, including a child surviving its old supervisor. */
  const recoverQa = (): void => {
    if (qaWorker && !qaWorker.recovered) return;
    if (!qaWorker) {
      let names: string[] = [];
      try { names = readdirSync(paths.workersDir).filter(id => /^qa-[A-Za-z0-9-]+$/.test(id)).sort(); } catch { return; }
      for (const id of names) {
        let ctx: QaWorkerContext;
        try { ctx = readQaWorkerContext(paths, join(paths.workersDir, id, 'context.json')); } catch { continue; }
        if (qaReceipt(ctx.baseBranch, id)) continue;
        const resultPath = ctx.resultPath;
        // Polling is driven by the existing tick, never a background timer.
        const handle: WorkerHandle = { id, role: 'qa', pid: null, startedAt: ctx.startedAt,
          resultPath, contextPath: join(paths.workersDir, id, 'context.json'), logPath: join(paths.workersDir, id, 'worker.log'),
          done: new Promise(() => {}),
          kill: (signal = 'SIGTERM') => { if (handle.pid) actions.killQaProcess(handle.pid, signal); } };
        qaWorker = { handle, baseBranch: ctx.baseBranch, merges: ctx.merges, recovered: true,
          startedMs: Date.parse(ctx.startedAt), timedOut: false, killSent: false };
        record('qa.recovered', { workerId: id });
        break;
      }
    }
    const w = qaWorker;
    if (!w) return;
    let ctx: QaWorkerContext;
    try { ctx = readQaWorkerContext(paths, w.handle.contextPath); } catch { return; }
    // PIDs are meaningful only on the host which spawned the worker. Fail closed elsewhere.
    if (ctx.hostname !== hostname()) return;
    const dir = join(paths.workersDir, w.handle.id);
    const started = readWorkerResult(join(dir, 'started.json')).result as { pid?: unknown } | null;
    const spawned = readWorkerResult(join(dir, 'process.json')).result as { pid?: unknown } | null;
    const pid = started?.pid ?? spawned?.pid;
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      w.handle.pid = pid;
      if (actions.qaProcessAlive(pid)) return;
    } else if (spawned?.pid === null) {
      // Spawn failed; no checks attempted, no merges consumed.
    } else {
      // A crash between spawn and recording its PID is ambiguous. The child's
      // started.json resolves it; until then do not start or clean another run.
      return;
    }
    const { result, error } = readWorkerResult(w.handle.resultPath);
    w.exit = { exitCode: isQaResult(result) ? 0 : 1, result, error };
    reapQa();
    recoverQa();
  };

  const qaPass = (dispatchedThisTick: number): void => {
    if (qaWorker || (status !== 'running' && qaMemory.mergesSinceLastQa < factory.qa.afterMerges)) return;
    // A long check can outlast its own interval. Honour idle exit before
    // starting another interval-only run, while still checking due merges.
    if (run.untilIdle && tick > 1 && qaMemory.mergesSinceLastQa < factory.qa.afterMerges && isIdle(dispatchedThisTick)) return;
    const state = readQaState(paths.stateDir, run.baseBranch);
    const lastQaAt = [state.lastQaAt, qaMemory.lastQaAt].filter((at): at is string => at !== null)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    if (!shouldRunQa({ mergesSinceLastQa: qaMemory.mergesSinceLastQa, lastQaAt, now: actions.now(), config: factory.qa })) return;
    try {
      const merges = qaMemory.mergesSinceLastQa;
      const handle = actions.spawnQa({ baseBranch: run.baseBranch, merges });
      const w: QaWorker = { handle, baseBranch: run.baseBranch, merges, startedMs: actions.now().getTime(),
        recovered: false, timedOut: false, killSent: false };
      handle.done.then(exit => { w.exit = exit; }, err => { w.exit = { exitCode: 1, result: null, error: errorMessage(err) }; });
      qaWorker = w;
      record('qa.started', { workerId: handle.id, baseBranch: run.baseBranch, merges });
    } catch (err) { record('qa.spawn-failed', { error: errorMessage(err) }); log.warn(`Factory QA: ${errorMessage(err)}`); }
  };

  const enforceTimeouts = (): void => {
    const now = actions.now().getTime();
    const check = (w: { handle: Pick<WorkerHandle, 'id'> & { kill?: WorkerHandle['kill'] }; startedMs: number; exit?: WorkerExit; timedOut: boolean; termSentMs?: number; killSent: boolean }, limitMs: number, label: string): void => {
      if (w.exit) return;
      if (!w.timedOut && now - w.startedMs > limitMs) {
        w.timedOut = true;
        w.termSentMs = now;
        log.warn(`Factory: ${label} exceeded its time limit; sending SIGTERM`);
        record('worker.timeout', { workerId: w.handle.id });
        w.handle.kill?.('SIGTERM');
      } else if (w.timedOut && !w.killSent && w.termSentMs !== undefined && now - w.termSentMs >= KILL_GRACE_MS) {
        w.killSent = true;
        log.warn(`Factory: ${label} ignored SIGTERM; sending SIGKILL`);
        w.handle.kill?.('SIGKILL');
      }
    };
    for (const w of devWorkers.values()) check(w, workerTimeoutMs, `developer worker for #${w.issue}`);
    if (pmWorker) check(pmWorker, pmTimeoutMs, `PM worker for ${pmWorker.idea.id}`);
    if (qaWorker) check(qaWorker, workerTimeoutMs, 'QA worker');
  };

  const requeueIdea = (q: FactoryQuestion): { applied: boolean; note: string } | null => {
    if (pmWorker && pmWorker.idea.id === q.idea) return null; // retry once the PM worker is done
    const idea = readInbox(paths.inboxPath).find((candidate) => candidate.id === q.idea);
    if (!idea) return { applied: true, note: `idea ${q.idea} is no longer in the inbox` };
    const ok = updateIdea(paths.inboxPath, idea.id, {
      status: 'pending',
      note: '',
      meta: { ...ideaMeta(idea.meta, [...TAKEN_KEYS, 'attempts']), answered: q.id },
    }, { line: idea.line });
    return ok ? { applied: true, note: `idea ${idea.id} re-queued for the PM` } : { applied: false, note: `could not update idea ${idea.id}` };
  };

  const answerKey = (q: FactoryQuestion): string => `${q.id}|${q.key}|${shortHash(q.answer.trim())}`;

  const applyAnswers = (): void => {
    let questions: FactoryQuestion[];
    try {
      questions = readQuestions(paths.questionsPath);
    } catch (err) {
      log.warn(`Factory: could not read questions (${errorMessage(err)})`);
      return;
    }
    for (const q of answeredQuestions(questions)) {
      // Applied already in this run: the file's `applied` status was lost (an
      // editor saved a stale buffer). Restore it; never act twice.
      if (appliedThisRun.has(answerKey(q))) {
        try { markQuestion(paths.questionsPath, q.id, 'applied'); } catch { /* retried next tick */ }
        continue;
      }
      // Never relabel an issue a developer is building right now.
      if (q.issue !== undefined && !q.key.startsWith('ship:') && devWorkers.has(q.issue)) continue;
      const attempts = applyAttempts.get(q.id) ?? 0;
      if (attempts >= MAX_APPLY_ATTEMPTS) continue;
      try {
        let outcome: { applied: boolean; note: string } | null;
        if (q.key.startsWith('ship:')) {
          outcome = { applied: true, note: 'recorded; the next ship pass re-evaluates the PR' };
        } else if (q.idea && q.issue === undefined && q.pr === undefined) {
          outcome = requeueIdea(q);
        } else if (q.issue !== undefined) {
          outcome = actions.applyAnswer(q);
          if (outcome.applied) failedThisRun.delete(q.issue);
        } else {
          outcome = { applied: true, note: 'nothing to act on' };
        }
        if (outcome === null) continue;
        if (outcome.applied) {
          appliedThisRun.add(answerKey(q));
          markQuestion(paths.questionsPath, q.id, 'applied');
          counts.answersApplied += 1;
          record('answer.applied', { id: q.id, key: q.key, note: outcome.note, answer: q.answer.slice(0, 500) });
          log.info(`Factory: applied answer ${q.id} — ${outcome.note}`);
        } else {
          applyAttempts.set(q.id, attempts + 1);
          record('answer.failed', { id: q.id, key: q.key, note: outcome.note });
          log.warn(`Factory: could not apply answer ${q.id} (${outcome.note})`);
        }
      } catch (err) {
        applyAttempts.set(q.id, attempts + 1);
        record('answer.failed', { id: q.id, key: q.key, note: errorMessage(err) });
        log.warn(`Factory: applying answer ${q.id} failed (${errorMessage(err)})`);
      }
    }
  };

  const pmIntake = (): void => {
    if (!run.pmEnabled || pmWorker || status !== 'running') return;
    let ideas: InboxIdea[];
    try {
      ideas = readInbox(paths.inboxPath);
    } catch (err) {
      log.warn(`Factory: could not read inbox (${errorMessage(err)})`);
      return;
    }
    // One PM worker at a time keeps duplicate detection honest.
    const [idea] = nextPendingIdeas(ideas, Math.min(1, factory.pm.maxIdeasPerTick));
    if (!idea) return;
    let priorAnswers: string[] = [];
    try {
      priorAnswers = readQuestions(paths.questionsPath)
        .filter((q) => q.idea === idea.id && q.answer.trim() !== '' && q.status !== 'dismissed')
        .map((q) => q.answer);
    } catch { /* no prior answers */ }

    const now = actions.now();
    const baseMeta = ideaMeta(idea.meta, TAKEN_KEYS);
    const takenMeta = { ...baseMeta, taken: isoSeconds(now) };
    // Mark it taken before spawning, and never spawn for a bullet we could not mark.
    if (!setIdea(idea.id, { status: 'taken', meta: takenMeta }, idea.line)) return;
    let handle: WorkerHandle;
    try {
      handle = actions.spawnPm({ idea, priorAnswers });
    } catch (err) {
      log.warn(`Factory: could not start PM worker for ${idea.id} (${errorMessage(err)})`);
      setIdea(idea.id, { status: 'pending', meta: baseMeta }, idea.line);
      return;
    }
    // Record the worker so a restarted supervisor can reap it (or know it is still alive).
    if (handle.pid !== null) {
      setIdea(idea.id, {
        status: 'taken',
        meta: { ...takenMeta, pid: String(handle.pid), host: hostname(), worker: handle.id },
      }, idea.line);
    }
    const worker: PmWorker = { handle, idea, startedMs: now.getTime(), timedOut: false, killSent: false };
    handle.done.then(
      (exit) => { worker.exit = exit; },
      (err) => { worker.exit = { exitCode: 1, result: null, error: errorMessage(err) }; },
    );
    pmWorker = worker;
    record('pm.started', { workerId: handle.id, idea: idea.id });
    log.step(`Factory: PM working on ${idea.id}: ${idea.text.split('\n')[0]}`);
  };

  const dispatch = async (): Promise<number> => {
    const free = run.developers - devWorkers.size;
    lastDispatchDegraded = false;
    if (free <= 0) return 0;
    const now = actions.now();
    const plan = computeDispatchPlan({
      config,
      run,
      actions,
      slots: free,
      inFlight: [...devWorkers.values()].map((w) => ({ issue: w.issue, touches: w.touches })),
      failedThisRun,
      mergedIssues,
      now,
    });
    lastDispatchDegraded = plan.degraded;
    const dispatched: number[] = [];
    const skipped = [...plan.skipped];
    for (const candidate of plan.dispatch) {
      if (stopRequested || status !== 'running') break;
      if (dispatched.length > 0 && staggerMs > 0) {
        await actions.sleep(staggerMs, stopController.signal);
        if (stopRequested) break;
      }
      // A long stagger must not let the supervisor lease lapse mid-dispatch.
      if (!refreshSupervisor()) break;
      const n = candidate.issue.number;
      const spawnNow = actions.now();
      const lease = acquireLease(paths.leasesDir, `issue-${n}`, {
        owner: `factory:${process.pid}`,
        ttlSeconds: factory.workerTimeoutMinutes * 60 + 600,
        now: spawnNow,
        meta: { issue: n, title: candidate.issue.title },
      });
      if (!lease) {
        skipped.push({ issue: n, reason: 'claimed', detail: 'lease held by another process' });
        continue;
      }
      let handle: WorkerHandle;
      try {
        handle = actions.spawnDeveloper({ issue: n, title: candidate.issue.title, baseBranch: run.baseBranch, verbose: run.verbose });
      } catch (err) {
        releaseLease(lease);
        failedThisRun.add(n);
        record('worker.spawn-failed', { issue: n, error: errorMessage(err) });
        log.warn(`Factory: could not start a worker for #${n} (${errorMessage(err)})`);
        continue;
      }
      refreshLease(lease, {
        now: spawnNow,
        ...(handle.pid !== null ? { workerPid: handle.pid } : {}),
        meta: { issue: n, title: candidate.issue.title, workerId: handle.id },
      });
      const worker: DevWorker = {
        handle,
        issue: n,
        title: candidate.issue.title,
        touches: candidate.touches.length > 0 ? candidate.touches : extractTouches(candidate.issue.body ?? ''),
        lease,
        startedMs: spawnNow.getTime(),
        timedOut: false,
        killSent: false,
      };
      handle.done.then(
        (exit) => { worker.exit = exit; },
        (err) => { worker.exit = { exitCode: 1, result: null, error: errorMessage(err) }; },
      );
      devWorkers.set(n, worker);
      counts.dispatched += 1;
      dispatched.push(n);
      record('worker.started', { workerId: handle.id, issue: n, pid: handle.pid });
      log.step(`Factory: dispatched #${n} ${candidate.issue.title} (worker ${handle.id})`);
    }
    lastPlan = { dispatched, skipped };
    return dispatched.length;
  };

  /** Issues a merged session PR completes: its closing refs, the owning worker's issue, or its head branch. */
  const issuesForPr = (pr: ShipPr): number[] => {
    if (pr.closingIssues.length > 0) return pr.closingIssues;
    const owned = findOwned(memory.owned, pr);
    if (owned && owned.issue > 0) return [owned.issue];
    const fromHead = issueFromHead(pr.headRefName);
    return fromHead !== undefined ? [fromHead] : [];
  };

  const afterMerge = (pr: ShipPr, issues: number[]): void => {
    for (const n of issues) mergedIssues.add(n);
    memory.owned = memory.owned.filter((o) => o !== findOwned(memory.owned, pr));
    // GitHub honours `Closes #N` only for PRs into the default branch.
    let defaultBranch: string | null = null;
    try { defaultBranch = actions.defaultBranch(); } catch { defaultBranch = null; }
    if (defaultBranch !== null && pr.baseRefName === defaultBranch) return;
    for (const n of issues) {
      try {
        if (actions.closeIssue(n)) record('issue.closed', { issue: n, pr: pr.number });
      } catch (err) {
        log.warn(`Factory ship: could not close #${n} after merging PR #${pr.number} (${errorMessage(err)})`);
      }
    }
  };

  const shipPass = (): void => {
    if (!run.shipEnabled) return;
    const now = actions.now();
    const due = shipTriggered || lastShipMs === null || now.getTime() - lastShipMs >= factory.ship.intervalSeconds * 1000;
    if (!due) return;
    shipTriggered = false;
    lastShipMs = now.getTime();
    const lastRunAt = now.toISOString();

    let prs: ShipPr[];
    try {
      prs = actions.listShippable();
    } catch (err) {
      const error = errorMessage(err);
      log.warn(`Factory ship: could not list PRs (${error}); skipping this pass`);
      shipState = { lastRunAt, decisions: [], error };
      record('ship.error', { error });
      return;
    }

    // Forget owned PRs that are no longer open (merged or closed elsewhere).
    memory.owned = memory.owned.filter((o) => prs.some((pr) => (o.pr > 0 && o.pr === pr.number) || o.url === pr.url));

    const policy = shipPolicyFor(factory, run.shipMerge);
    const inFlight = new Set(devWorkers.keys());
    const decisions: FactoryState['ship']['decisions'] = [];
    let pending = false;
    for (const pr of prs) {
      const gate = shipGate(pr, memory.owned, inFlight);
      if (gate) {
        decisions.push({ pr: pr.number, action: 'skip', reason: gate });
        continue;
      }
      const issues = issuesForPr(pr);
      const issue = issues[0];
      let decision: ShipDecision;
      try {
        decision = decideRememberedShip(pr, policy, actions.now(), memory, factory.ship.intervalSeconds);
      } catch (err) {
        decisions.push({ pr: pr.number, action: 'skip', reason: `could not decide (${errorMessage(err)})` });
        continue;
      }
      if (decision.action === 'update-branch') {
        if (stopRequested || !refreshSupervisor()) {
          decisions.push({ pr: pr.number, action: 'skip', reason: 'supervisor stopping' });
          continue;
        }
        // Persist before the mutation: a crash after gh accepts it must not let a
        // restart repeat the update or merge using checks from the old head.
        const previousUpdate = memory.branchUpdates[pr.number];
        const update = { attemptedAt: actions.now().toISOString(), previousHead: pr.headRefOid ?? '' };
        memory.branchUpdates[pr.number] = update;
        if (!writeState()) {
          if (previousUpdate) memory.branchUpdates[pr.number] = previousUpdate;
          else delete memory.branchUpdates[pr.number];
          pending = true;
          const error = 'could not persist branch update intent; retrying on the next ship pass';
          decisions.push({ pr: pr.number, action: 'wait', reason: error });
          record('ship.branch-update-failed', { pr: pr.number, updated: false, conflict: false, error });
          continue;
        }
        let result: ReturnType<FactoryActions['updateBranch']>;
        try {
          result = actions.updateBranch(pr);
        } catch (err) {
          result = { updated: false, conflict: false, error: errorMessage(err) };
        }
        if (!result.updated) {
          if (previousUpdate && awaitingUpdatedChecks(pr, previousUpdate)) {
            // A stale snapshot can trigger a retry after the earlier update
            // already succeeded. A no-op or failed retry cannot discharge its CI gate.
            memory.branchUpdates[pr.number] = { ...previousUpdate, attemptedAt: update.attemptedAt };
          } else if (result.conflict || !result.error) {
            memory.branchUpdates[pr.number] = { attemptedAt: update.attemptedAt };
          }
          // Other errors can be lost responses to accepted updates. Retain the
          // persisted intent until a later snapshot proves fresh CI succeeded.
        }
        if (result.updated) {
          pending = true;
          decisions.push({ pr: pr.number, action: 'update-branch', reason: decision.reason });
          record('ship.branch-updated', { pr: pr.number, ...result });
          log.info(`Factory ship: updated PR #${pr.number}; waiting for fresh CI`);
        } else if (!result.conflict && !result.error) {
          pending = true;
          decisions.push({ pr: pr.number, action: 'branch-update-skipped', reason: 'branch already up-to-date; re-evaluate on the next ship pass' });
          record('ship.branch-update-skipped', { pr: pr.number, ...result });
          log.info(`Factory ship: PR #${pr.number} is already up-to-date; re-evaluating next pass`);
        } else {
          // Keep --until-idle alive for retryable failures under its existing cap.
          if (!result.conflict) pending = true;
          const error = result.error ?? 'branch update did not complete';
          decisions.push({ pr: pr.number, action: 'branch-update-failed', reason: error });
          record('ship.branch-update-failed', { pr: pr.number, ...result, error });
          log.warn(`Factory ship: could not update PR #${pr.number} (${error})`);
          if (result.conflict) {
            const ownerIssue = findOwned(memory.owned, pr)?.issue;
            askShip({
              role: 'shipper',
              key: `ship:${pr.number}:conflict`,
              pr: pr.number,
              ...(ownerIssue !== undefined ? { issue: ownerIssue } : {}),
              question: `PR #${pr.number} has merge conflicts with ${pr.baseRefName}. Resolve them, or close and re-queue the issue?`,
              context: `${pr.title}\n${pr.url}\n${error}`,
            }, pr);
          }
        }
      } else if (decision.action === 'merge') {
        if (stopRequested || !refreshSupervisor()) {
          decisions.push({ pr: pr.number, action: 'skip', reason: 'supervisor stopping' });
          continue;
        }
        let result: { merged: boolean; error?: string };
        try {
          result = actions.merge(pr, decision.admin);
        } catch (err) {
          result = { merged: false, error: errorMessage(err) };
        }
        if (result.merged) {
          counts.merged += 1;
          qaMemory.mergesSinceLastQa += 1;
          decisions.push({ pr: pr.number, action: 'merge', reason: decision.reason });
          record('ship.merged', { pr: pr.number, admin: decision.admin, issue });
          log.success(`Factory ship: merged PR #${pr.number}${decision.admin ? ' (admin)' : ''}`);
          afterMerge(pr, issues);
        } else {
          const error = result.error ?? 'merge did not complete';
          decisions.push({ pr: pr.number, action: 'merge-failed', reason: error });
          record('ship.merge-failed', { pr: pr.number, error });
          askShip({
            role: 'shipper',
            key: `ship:${pr.number}:merge-failed`,
            pr: pr.number,
            ...(issue !== undefined ? { issue } : {}),
            question: `Merging PR #${pr.number} failed: ${error}. Merge it by hand, or answer with what the factory should do.`,
            context: `${pr.title}\n${pr.url}`,
          }, pr);
        }
      } else if (decision.action === 'ask') {
        const asked = askShip({
          role: 'shipper',
          key: decision.key,
          pr: pr.number,
          ...(issue !== undefined ? { issue } : {}),
          question: decision.question,
          context: decision.context,
        }, pr);
        decisions.push({ pr: pr.number, action: 'ask', reason: asked ? decision.key : `${decision.key} (already asked for this PR state)` });
      } else {
        const waitingForUpdate = memory.branchUpdates[pr.number] !== undefined
          && pr.mergeStateStatus.toUpperCase() === 'BEHIND'
          && memory.shipAsked[`ship:${pr.number}:conflict`] !== prSignature(pr);
        if (decision.action === 'wait' && (pr.checks === 'pending' || pr.checks === 'none'
          || memory.branchUpdates[pr.number]?.previousHead !== undefined || waitingForUpdate)) pending = true;
        decisions.push({ pr: pr.number, action: decision.action, reason: decision.reason });
      }
    }
    pendingChecks = pending;
    shipState = { lastRunAt, decisions };
    record('ship.pass', { prs: prs.length, merged: decisions.filter((d) => d.action === 'merge').length });
  };

  const refreshDevLeases = (): void => {
    const now = actions.now();
    for (const w of devWorkers.values()) {
      if (!w.lease) continue;
      if (!refreshLease(w.lease, { now })) {
        log.warn(`Factory: lost the lease for #${w.issue}`);
        w.lease = null;
      }
    }
  };

  const isIdle = (dispatchedThisTick: number): boolean => {
    if (workerCount() > 0 || dispatchedThisTick > 0) return false;
    // A failed poll or epic read means "nothing ready" is unverified.
    if (lastDispatchDegraded) return false;
    if (run.pmEnabled && pendingIdeaCount(paths.inboxPath) > 0) return false;
    try {
      const unapplied = answeredQuestions(readQuestions(paths.questionsPath))
        .filter((q) => (applyAttempts.get(q.id) ?? 0) < MAX_APPLY_ATTEMPTS && !appliedThisRun.has(answerKey(q)));
      if (unapplied.length > 0) return false;
    } catch { /* unreadable questions do not block idling */ }
    if (run.shipEnabled && pendingChecks && actions.now().getTime() - lastWorkerFinishedMs < IDLE_PENDING_CHECKS_CAP_MS) {
      return false;
    }
    return true;
  };

  const sleepTick = async (): Promise<void> => {
    if (stopController.signal.aborted) return;
    const tickAbort = new AbortController();
    const onStop = (): void => tickAbort.abort();
    stopController.signal.addEventListener('abort', onStop, { once: true });
    const dones = liveHandles().map((h) => h.done);
    try {
      await Promise.race([actions.sleep(factory.tickSeconds * 1000, tickAbort.signal), ...dones]);
    } finally {
      tickAbort.abort();
      stopController.signal.removeEventListener('abort', onStop);
    }
  };

  /** Wait for `dones` or `ms`, whichever first; the timer never outlives the wait. */
  const waitFor = async (dones: Array<Promise<unknown>>, ms: number, force?: AbortSignal): Promise<void> => {
    const waitAbort = new AbortController();
    const onForce = (): void => waitAbort.abort();
    if (force) {
      if (force.aborted) waitAbort.abort();
      else force.addEventListener('abort', onForce, { once: true });
    }
    try {
      await Promise.race([Promise.all(dones), actions.sleep(ms, waitAbort.signal)]);
    } finally {
      waitAbort.abort();
      force?.removeEventListener('abort', onForce);
    }
    await flushMicrotasks();
  };

  const shutdown = async (): Promise<void> => {
    // Results that landed before the stop are honoured exactly as a tick would.
    await flushMicrotasks();
    reapDevelopers();
    reapPm('tick');
    try {
      recoverQa();
      reapQa();
    } catch (err) {
      // A result/inbox write failure must not bypass signalling live workers.
      // Leave the exited child's files unacknowledged for recovery on restart;
      // it must not be discarded as an interrupted check below.
      record('qa.reap-failed', { workerId: qaWorker?.handle.id, error: errorMessage(err) });
      log.warn(`Factory QA: could not reap result during shutdown (${errorMessage(err)}); retained for recovery`);
      if (qaWorker?.exit) qaWorker = null;
    }

    const live = liveHandles();
    if (live.length > 0) {
      log.warn(`Factory: stopping ${live.length} worker(s)`);
      for (const handle of live) handle.kill('SIGTERM');
      await waitFor(live.map((h) => h.done), SHUTDOWN_GRACE_MS, graceController.signal);
      const stragglers = liveHandles();
      if (stragglers.length > 0) {
        log.warn(`Factory: ${stragglers.length} worker(s) still running after the grace period; sending SIGKILL`);
        for (const handle of stragglers) handle.kill('SIGKILL');
        await waitFor(stragglers.map((h) => h.done), POST_KILL_WAIT_MS);
      }
    }

    // Workers that exited during shutdown: keep successes, never count our own kill as a failure.
    reapDevelopers(true);
    if (qaWorker?.recovered) {
      const w = qaWorker;
      if (w.handle.pid && !actions.qaProcessAlive(w.handle.pid)) w.exit = { exitCode: 1, ...readWorkerResult(w.handle.resultPath) };
    }
    reapQa(true);
    for (const w of devWorkers.values()) {
      // Still not exited even after SIGKILL: keep its lease so the issue is not
      // re-dispatched into a worktree something is still writing to. The lease
      // goes stale on its own once the worker pid is gone.
      record('worker.stopped', { workerId: w.handle.id, issue: w.issue, exitCode: null, leaseKept: true });
      log.warn(`Factory: worker for #${w.issue} did not exit; its lease is kept until it dies`);
    }
    devWorkers.clear();
    if (pmWorker) {
      if (pmWorker.exit) {
        reapPm('shutdown');
      } else {
        // Still running: leave the idea taken (pid recorded) — the next
        // supervisor reaps it from its result once the worker has died.
        record('worker.stopped', { workerId: pmWorker.handle.id, idea: pmWorker.idea.id, exited: false });
        pmWorker = null;
      }
    }
  };

  // ── Main loop ──

  try {
    ensureInboxFile(paths.inboxPath);
    ensureQuestionsFile(paths.questionsPath);
    record('factory.started', {
      pid: process.pid,
      baseBranch: run.baseBranch,
      developers: run.developers,
      epics: run.epics,
      pm: run.pmEnabled,
      ship: run.shipEnabled,
      shipMerge: run.shipMerge,
    });
    log.step(`Factory started — base ${run.baseBranch}, ${run.developers} developer(s), PM ${run.pmEnabled ? 'on' : 'off'}, ship ${run.shipEnabled ? (run.shipMerge ? 'merging' : 'report-only') : 'off'}`);
    // Workers skip generated-file preparation; the coordinator does it once.
    await actions.prepare();
    try {
      await actions.preflight();
    } catch (err) {
      log.warn(`Factory preflight failed to run (${errorMessage(err)}); continuing`);
    }
    refreshSupervisor();
    recoverOrphanedIdeas();
    recoverQa();
    writeState();

    while (!stopRequested) {
      tick += 1;
      await flushMicrotasks();
      if (!refreshSupervisor()) break;
      reapDevelopers();
      reapPm();
      recoverQa();
      reapQa();
      recoverOrphanedIdeas();
      enforceTimeouts();
      applyAnswers();
      let dispatchedThisTick = 0;
      if (status === 'running' && !stopRequested) {
        pmIntake();
        dispatchedThisTick = await dispatch();
      }
      if (!stopRequested) { shipPass(); qaPass(dispatchedThisTick); }
      refreshDevLeases();

      if (status === 'running') {
        if (run.maxTicks !== undefined && tick >= run.maxTicks) {
          status = 'draining';
          drainReason = 'max-ticks';
        } else if (run.maxRuntimeMs > 0 && actions.now().getTime() - startedMs >= run.maxRuntimeMs) {
          status = 'draining';
          drainReason = 'max-runtime';
        }
        if (status === 'draining') {
          record('factory.draining', { reason: drainReason, workers: workerCount() });
          if (workerCount() > 0) log.info(`Factory: ${drainReason} reached; waiting for ${workerCount()} worker(s) to finish`);
        }
      }
      writeState();

      if (stopRequested) break;
      if (status === 'draining' && workerCount() === 0) {
        finalStatus = 'drained';
        stopReason = drainReason;
        break;
      }
      if (run.untilIdle && status === 'running' && isIdle(dispatchedThisTick)) {
        finalStatus = 'idle';
        stopReason = 'until-idle';
        log.success('Factory: idle — nothing running, nothing ready, no pending ideas or answers');
        break;
      }
      await sleepTick();
    }
  } catch (err) {
    stopReason = `error: ${errorMessage(err)}`;
    throw err;
  } finally {
    try {
      await shutdown();
    } finally {
      status = 'stopped';
      if (handleSignals) {
        process.removeListener('SIGINT', onSignal);
        process.removeListener('SIGTERM', onSignal);
      }
      options.signal?.removeEventListener('abort', onAbort);
      record('factory.stopped', { reason: stopReason || 'stopped', counts: { ...counts } });
      writeState();
      releaseLease(supervisorLease);
    }
  }

  log.info(`Factory stopped (${stopReason || 'stopped'}): ${counts.dispatched} dispatched, ${counts.succeeded} succeeded, ${counts.failed} failed, ${counts.merged} merged, ${counts.questionsAsked} question(s) asked`);
  return { status: finalStatus, reason: stopReason || 'stopped', ticks: tick, counts: { ...counts } };
}

/**
 * Run the factory supervisor until it is stopped, idle (`untilIdle`), or has
 * drained after `maxTicks` / `maxRuntimeMinutes`. `dryRun` computes and
 * prints one plan without leases, spawns, or writes.
 */
export async function runFactory(
  config: Config,
  options: FactoryRunOptions = {},
  overrides: Partial<FactoryActions> = {},
): Promise<FactorySummary> {
  const run = resolveFactoryRun(config, options);
  const actions: FactoryActions = {
    ...createDefaultFactoryActions(config, {
      paths: run.paths,
      baseBranch: run.baseBranch,
      shipMerge: run.shipMerge,
      dryRun: run.dryRun,
    }),
    ...overrides,
  };
  if (run.dryRun) return dryRunFactory(config, run, actions);
  return superviseFactory(config, run, actions, options);
}
