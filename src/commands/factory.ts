/**
 * `alpha-loop factory` — run the parallel multi-role code factory, and the
 * small subcommands a human uses alongside it (status, idea, questions,
 * answer). `factory pm-worker` is the hidden child-process entry point the
 * supervisor spawns for the PM role.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveFactoryPaths, type Config, type FactoryPaths } from '../lib/config.js';
import { runFactory, type FactoryRunOptions, type FactoryState } from '../lib/factory.js';
import { appendIdea, readInbox } from '../lib/factory-inbox.js';
import { runPmForIdea, type PmContext } from '../lib/factory-pm.js';
import { answerQuestion, answeredQuestions, readQuestions, type FactoryQuestion } from '../lib/factory-questions.js';
import { pmProgressPath, readPmWorkerContext, writeJsonAtomic, type PmWorkerProgress, type PmWorkerResult } from '../lib/factory-workers.js';
import { listOpenIssues } from '../lib/github.js';
import { isLeaseStale, readLease, type LeasePayload } from '../lib/lease.js';
import { log } from '../lib/logger.js';
import { getVisionContext } from '../lib/vision.js';

export type FactoryCommandOptions = {
  developers?: number;
  epic?: string;
  once?: boolean;
  untilIdle?: boolean;
  maxTicks?: number;
  maxRuntime?: number;
  /** Commander sets this true by default because of `--no-pm`; only `false` is meaningful. */
  pm?: boolean;
  ship?: boolean;
  shipMerge?: boolean;
  base?: string;
  dryRun?: boolean;
  verbose?: boolean;
};

type ConfigDeps = { config?: Config; now?: () => Date };

const PROJECT_CONTEXT_MAX_CHARS = 12_000;
const OPEN_ISSUES_FOR_PM = 300;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function configFor(deps: ConfigDeps): Config {
  return deps.config ?? loadConfig();
}

/** Parse `--epic 12,34` (also accepts `#12 34`). Throws on anything that is not an issue number. */
export function parseEpicList(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(/[\s,]+/).map((p) => p.trim().replace(/^#/, '')).filter(Boolean);
  const epics = parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid epic number "${p}" in --epic`);
    return n;
  });
  return epics.length > 0 ? epics : undefined;
}

/** Map CLI flags onto runFactory options. Unset flags fall through to config. */
export function toFactoryRunOptions(options: FactoryCommandOptions): FactoryRunOptions {
  const epics = parseEpicList(options.epic);
  const positive = (n: unknown): number | undefined =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
  return {
    ...(positive(options.developers) !== undefined ? { developers: Math.floor(options.developers!) } : {}),
    ...(epics ? { epics } : {}),
    ...(options.once ? { once: true } : {}),
    ...(options.untilIdle ? { untilIdle: true } : {}),
    ...(positive(options.maxTicks) !== undefined ? { maxTicks: Math.floor(options.maxTicks!) } : {}),
    ...(positive(options.maxRuntime) !== undefined ? { maxRuntimeMinutes: options.maxRuntime! } : {}),
    ...(options.pm === false ? { pm: false } : {}),
    ...(options.ship === false ? { ship: false } : {}),
    ...(options.shipMerge ? { shipMerge: true } : {}),
    ...(options.base ? { baseBranch: options.base } : {}),
    ...(options.dryRun ? { dryRun: true } : {}),
    ...(options.verbose ? { verbose: true } : {}),
  };
}

// ── factory (run) ────────────────────────────────────────────────────────────

export async function factoryRunCommand(
  options: FactoryCommandOptions,
  deps: { config?: Config; runFactory?: typeof runFactory } = {},
): Promise<void> {
  try {
    const config = configFor(deps);
    if (!config.repo) {
      throw new Error('No repository configured. Run "alpha-loop init" or set repo in .alpha-loop.yaml');
    }
    const run = deps.runFactory ?? runFactory;
    await run(config, toFactoryRunOptions(options));
  } catch (err) {
    const message = errorMessage(err);
    log.error(message);
    process.exitCode = message.startsWith('factory already running') ? 2 : 1;
  }
}

// ── factory status ───────────────────────────────────────────────────────────

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function readState(path: string): FactoryState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as FactoryState;
    return parsed && typeof parsed === 'object' && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function waitingQuestions(questions: FactoryQuestion[]): FactoryQuestion[] {
  const answered = new Set(answeredQuestions(questions).map((q) => q.id));
  return questions.filter((q) => q.status === 'open' || answered.has(q.id));
}

function firstLine(text: string, max = 100): string {
  const line = text.split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type FactoryStatusSnapshot = {
  running: boolean;
  supervisor: Pick<LeasePayload, 'pid' | 'hostname' | 'acquiredAt' | 'refreshedAt'> | null;
  state: FactoryState | null;
  openQuestions: Array<Pick<FactoryQuestion, 'id' | 'status' | 'role' | 'askedAt' | 'key' | 'question'>>;
  pendingIdeas: number;
  paths: FactoryPaths;
};

export function factoryStatusSnapshot(config: Config, now: Date = new Date()): FactoryStatusSnapshot {
  const paths = resolveFactoryPaths(config);
  const lease = readLease(paths.stateDir, 'factory');
  const running = lease !== null && !isLeaseStale(lease, { now });
  let questions: FactoryQuestion[] = [];
  try { questions = readQuestions(paths.questionsPath); } catch { /* unreadable */ }
  let pendingIdeas = 0;
  try { pendingIdeas = readInbox(paths.inboxPath).filter((i) => i.status === 'pending').length; } catch { /* unreadable */ }
  return {
    running,
    supervisor: lease
      ? { pid: lease.pid, hostname: lease.hostname, acquiredAt: lease.acquiredAt, refreshedAt: lease.refreshedAt }
      : null,
    state: readState(paths.statePath),
    openQuestions: waitingQuestions(questions).map((q) => ({
      id: q.id, status: q.status, role: q.role, askedAt: q.askedAt, key: q.key, question: q.question,
    })),
    pendingIdeas,
    paths,
  };
}

export function factoryStatusCommand(options: { json?: boolean }, deps: ConfigDeps = {}): void {
  try {
    const config = configFor(deps);
    const now = deps.now?.() ?? new Date();
    const snap = factoryStatusSnapshot(config, now);
    if (options.json) {
      console.log(JSON.stringify(snap, null, 2));
      return;
    }

    const { state } = snap;
    const lines: string[] = [];
    if (snap.running && snap.supervisor) {
      lines.push(`Factory: running (pid ${snap.supervisor.pid}${state ? `, tick ${state.tick}, ${state.status}` : ''})`);
    } else {
      lines.push(`Factory: not running${state ? ` (last state ${state.status} at ${state.updatedAt})` : ''}`);
    }
    if (state) {
      lines.push(`Base: ${state.baseBranch} · developers: ${state.developers} · epics: ${state.epics.length ? state.epics.map((e) => `#${e}`).join(', ') : 'all'}`);
      if (snap.running) {
        lines.push(`Workers (${state.workers.length}):`);
        for (const w of state.workers) {
          const target = w.issue !== undefined ? `#${w.issue}` : w.ideaId ?? '';
          const elapsed = formatAge(now.getTime() - Date.parse(w.startedAt));
          lines.push(`  ${w.id}  ${w.role}  ${target}  pid ${w.pid ?? '-'}  ${elapsed}  ${w.logPath}`);
        }
      }
      const dispatched = state.lastPlan.dispatched.map((n) => `#${n}`).join(', ') || 'nothing';
      lines.push(`Last plan: dispatched ${dispatched}; skipped ${state.lastPlan.skipped.length}`);
      for (const s of state.lastPlan.skipped.slice(0, 10)) {
        lines.push(`  #${s.issue} ${s.reason}${s.detail ? ` (${s.detail})` : ''}`);
      }
      const c = state.counts;
      lines.push(`Counts: dispatched ${c.dispatched} · succeeded ${c.succeeded} · failed ${c.failed} · waiting ${c.waiting} · merged ${c.merged} · ideas ${c.ideasIngested} · questions ${c.questionsAsked}`);
      if (state.ship.lastRunAt) {
        lines.push(`Ship: last pass ${state.ship.lastRunAt}${state.ship.error ? ` — error: ${state.ship.error}` : ''}`);
        for (const d of state.ship.decisions) lines.push(`  PR #${d.pr}: ${d.action} — ${d.reason}`);
      }
    }
    lines.push(`Open questions (${snap.openQuestions.length}):`);
    for (const q of snap.openQuestions) {
      lines.push(`  ${q.id}  ${formatAge(now.getTime() - Date.parse(q.askedAt))}  ${q.role}  ${firstLine(q.question)}${q.status === 'answered' ? '  [answered]' : ''}`);
    }
    lines.push(`Pending ideas: ${snap.pendingIdeas}`);
    lines.push(`Inbox: ${snap.paths.inboxPath}`);
    lines.push(`Questions: ${snap.paths.questionsPath}`);
    lines.push(`State: ${snap.paths.statePath}`);
    console.log(lines.join('\n'));
  } catch (err) {
    log.error(errorMessage(err));
    process.exitCode = 1;
  }
}

// ── factory idea ─────────────────────────────────────────────────────────────

export function factoryIdeaCommand(textParts: string[], deps: ConfigDeps = {}): void {
  try {
    const text = textParts.join(' ').trim();
    if (!text) throw new Error('Idea text is empty. Usage: alpha-loop factory idea <text...>');
    const paths = resolveFactoryPaths(configFor(deps));
    const idea = appendIdea(paths.inboxPath, text);
    console.log(`Added idea ${idea.id} to ${paths.inboxPath}`);
  } catch (err) {
    log.error(errorMessage(err));
    process.exitCode = 1;
  }
}

// ── factory questions ────────────────────────────────────────────────────────

export function factoryQuestionsCommand(options: { all?: boolean }, deps: ConfigDeps = {}): void {
  try {
    const paths = resolveFactoryPaths(configFor(deps));
    const now = deps.now?.() ?? new Date();
    const questions = readQuestions(paths.questionsPath);
    const shown = options.all ? questions : waitingQuestions(questions);
    if (shown.length === 0) {
      console.log(`No ${options.all ? '' : 'open '}questions. (${paths.questionsPath})`);
      return;
    }
    const lines: string[] = [];
    for (const q of shown) {
      const target = [q.issue !== undefined ? `issue #${q.issue}` : '', q.pr !== undefined ? `PR #${q.pr}` : '', q.idea ?? '']
        .filter(Boolean).join(', ');
      lines.push(`${q.id} · ${q.status} · ${q.role || 'factory'}${target ? ` · ${target}` : ''} · ${formatAge(now.getTime() - Date.parse(q.askedAt))} ago`);
      lines.push(`  ${firstLine(q.question, 200)}`);
      if (q.answer) lines.push(`  answer: ${firstLine(q.answer, 200)}`);
    }
    lines.push('');
    lines.push(`Answer with: alpha-loop factory answer <id> "<text>"  (or edit ${paths.questionsPath})`);
    console.log(lines.join('\n'));
  } catch (err) {
    log.error(errorMessage(err));
    process.exitCode = 1;
  }
}

// ── factory answer ───────────────────────────────────────────────────────────

export function factoryAnswerCommand(id: string, textParts: string[], deps: ConfigDeps = {}): void {
  try {
    const paths = resolveFactoryPaths(configFor(deps));
    const question = readQuestions(paths.questionsPath).find((q) => q.id === id);
    if (!question) {
      throw new Error(`Unknown question id "${id}". Run "alpha-loop factory questions --all" to list ids.`);
    }
    if (question.status === 'applied' || question.status === 'dismissed') {
      throw new Error(`Question ${id} is already ${question.status}; it no longer takes answers.`);
    }
    const text = textParts.join(' ').trim();
    if (!answerQuestion(paths.questionsPath, id, text)) {
      throw new Error('Answer is empty (blank, "-", "TODO" and "_(none)_" do not count).');
    }
    console.log(`Answered ${id}. A running factory applies it on its next tick.`);
  } catch (err) {
    log.error(errorMessage(err));
    process.exitCode = 1;
  }
}

// ── factory pm-worker (hidden) ───────────────────────────────────────────────

export type PmWorkerDeps = {
  config?: Config;
  runPm?: typeof runPmForIdea;
  listOpenIssues?: typeof listOpenIssues;
  /** Test seam: where SIGINT/SIGTERM handlers are installed (default process). */
  signals?: Pick<NodeJS.Process, 'on' | 'removeListener'>;
  /** Test seam: process.exit. */
  exit?: (code: number) => void;
};

export function buildPmWorkerContext(config: Config, priorAnswers: string[], deps: PmWorkerDeps = {}): PmContext {
  const root = process.cwd();
  const visionMarkdown = getVisionContext(root) ?? '';
  const contextPath = join(root, '.alpha-loop', 'context.md');
  let projectContextMarkdown = '';
  if (existsSync(contextPath)) {
    try {
      projectContextMarkdown = readFileSync(contextPath, 'utf-8').slice(0, PROJECT_CONTEXT_MAX_CHARS);
    } catch { /* optional */ }
  }
  let openIssues: PmContext['openIssues'] = [];
  try {
    openIssues = (deps.listOpenIssues ?? listOpenIssues)(config.repo, OPEN_ISSUES_FOR_PM)
      .map((issue) => ({ number: issue.number, title: issue.title, labels: issue.labels ?? [] }));
  } catch (err) {
    log.warn(`Factory PM: could not list open issues (${errorMessage(err)}); duplicate detection is weaker`);
  }
  return { visionMarkdown, projectContextMarkdown, openIssues, ...(priorAnswers.length > 0 ? { priorAnswers } : {}) };
}

export async function factoryPmWorkerCommand(options: { context?: string }, deps: PmWorkerDeps = {}): Promise<void> {
  let config: Config;
  let ctx: ReturnType<typeof readPmWorkerContext>;
  try {
    config = deps.config ?? loadConfig();
    ctx = readPmWorkerContext(resolveFactoryPaths(config), options.context ?? '');
  } catch (err) {
    // No valid context → no result file; the supervisor treats that as a failure.
    log.error(errorMessage(err));
    process.exitCode = 1;
    return;
  }

  // Signals. A terminal Ctrl-C is the supervisor's to handle (it forwards
  // SIGTERM), so SIGINT is ignored here. SIGTERM before any GitHub write writes
  // a failure result and exits at once; during the apply phase it only sets a
  // flag that applyPmDecision checks before each write, so the worker always
  // finishes with a result.json listing every issue it created.
  const signals = deps.signals ?? process;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let phase: PmWorkerProgress['phase'] = 'agent';
  let stopRequested = false;
  let created: number[] = [];
  let resultWritten = false;
  const writeResult = (value: PmWorkerResult): void => {
    if (resultWritten) return;
    resultWritten = true;
    writeJsonAtomic(ctx.resultPath, value);
  };
  const writeProgress = (): void => {
    try {
      writeJsonAtomic(pmProgressPath(ctx.resultPath), { phase, createdIssues: created } satisfies PmWorkerProgress);
    } catch (err) {
      log.warn(`Factory PM worker: could not write progress (${errorMessage(err)})`);
    }
  };
  const onSigint = (): void => { /* the supervisor decides; it forwards SIGTERM */ };
  const onSigterm = (): void => {
    stopRequested = true;
    if (phase === 'agent') {
      log.warn('Factory PM worker: SIGTERM before creating any issues; exiting');
      writeResult({ status: 'failure', createdIssues: [], note: '', error: 'PM worker interrupted before creating any issues', interrupted: true });
      exit(1);
    } else {
      log.warn('Factory PM worker: SIGTERM while creating issues; stopping before the next GitHub write');
    }
  };
  signals.on('SIGINT', onSigint);
  signals.on('SIGTERM', onSigterm);

  let result: PmWorkerResult;
  try {
    const pmCtx = buildPmWorkerContext(config, ctx.priorAnswers, deps);
    const outcome = await (deps.runPm ?? runPmForIdea)(config, ctx.idea, {
      ctx: pmCtx,
      ...(ctx.agent ? { agent: ctx.agent } : {}),
      ...(ctx.model ? { model: ctx.model } : {}),
      timeoutMs: ctx.timeoutSeconds * 1000,
      autoReady: ctx.autoReady,
      dryRun: ctx.dryRun,
      onApplyStart: () => { phase = 'applying'; writeProgress(); },
      onIssueCreated: (all) => { created = [...all]; writeProgress(); },
      shouldStop: () => stopRequested,
    });
    result = {
      status: 'success',
      decision: outcome.decision,
      createdIssues: outcome.createdIssues,
      ...(outcome.epic !== undefined ? { epic: outcome.epic } : {}),
      ...(outcome.question ? { question: outcome.question } : {}),
      ...(outcome.duplicateOf !== undefined ? { duplicateOf: outcome.duplicateOf } : {}),
      note: outcome.note,
    };
  } catch (err) {
    // applyPmDecision attaches the issues it created before failing, so the
    // supervisor can note them instead of re-creating them.
    const attached = (err as { createdIssues?: unknown } | null)?.createdIssues;
    const fromError = Array.isArray(attached) ? attached.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
    result = {
      status: 'failure',
      createdIssues: [...new Set([...created, ...fromError])],
      note: '',
      error: errorMessage(err),
      ...(stopRequested ? { interrupted: true } : {}),
    };
    log.error(`Factory PM worker: ${result.error}`);
  } finally {
    signals.removeListener('SIGINT', onSigint);
    signals.removeListener('SIGTERM', onSigterm);
  }
  writeResult(result);
  if (result.status !== 'success') process.exitCode = 1;
}
