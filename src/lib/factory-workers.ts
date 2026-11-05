/**
 * Factory workers — the child processes the factory supervisor runs.
 *
 * Every git/gh call in Alpha Loop is synchronous, so parallel work has to be
 * separate processes. Each worker gets its own directory under
 * `<state_dir>/workers/<workerId>/` holding:
 *
 *   context.json  — written by the supervisor before spawn (the worker's input)
 *   result.json   — written atomically by the worker (its only output channel)
 *   worker.log    — the child's stdout + stderr
 *
 * Workers never write the inbox or questions files; the supervisor is the
 * single writer of both. A missing or unparseable result.json is a failure.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FactoryPaths } from './config.js';
import type { InboxIdea } from './factory-inbox.js';
import type { PmDecision } from './factory-pm.js';
import type { FactoryWorkerContext } from '../commands/run.js';

export type WorkerRole = 'developer' | 'pm';

export type WorkerExit = { exitCode: number; result: unknown | null; error?: string };

export type WorkerHandle = {
  id: string;
  role: WorkerRole;
  issue?: number;
  ideaId?: string;
  pid: number | null;
  startedAt: string;
  logPath: string;
  resultPath: string;
  contextPath: string;
  done: Promise<WorkerExit>;
  kill: (signal?: NodeJS.Signals) => void;
};

/** The subset of child_process.spawn the workers use (injectable for tests). */
export type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Signal a whole process group (`process.kill(-pgid, signal)`); injectable for tests. */
export type KillGroupImpl = (pgid: number, signal: NodeJS.Signals) => void;

const defaultKillGroup: KillGroupImpl = (pgid, signal) => { process.kill(-pgid, signal); };

/** Context the supervisor writes for a PM worker (`alpha-loop factory pm-worker`). */
export type PmWorkerContext = {
  version: 1;
  workerId: string;
  idea: { id: string; text: string };
  priorAnswers: string[];
  resultPath: string;
  autoReady: boolean;
  agent: string;
  model: string;
  timeoutSeconds: number;
  dryRun: boolean;
};

/** What a PM worker writes to result.json. */
export type PmWorkerResult = {
  status: 'success' | 'failure';
  decision?: PmDecision;
  createdIssues: number[];
  epic?: number;
  question?: string[];
  duplicateOf?: number;
  note: string;
  error?: string;
  /** The worker stopped because it was signalled, not because the PM failed. */
  interrupted?: boolean;
};

export type PmWorkerSettings = {
  autoReady: boolean;
  agent: string;
  model: string;
  timeoutSeconds: number;
  dryRun?: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** `issue-<N>-<slug of title, max 40 chars>` — the worker's session slug. */
export function sessionSlugFor(issue: number, title: string): string {
  const slug = slugify(title).slice(0, 40).replace(/-+$/, '');
  return slug ? `issue-${issue}-${slug}` : `issue-${issue}`;
}

function makeWorkerId(prefix: string, now: Date): string {
  return `${prefix}-${now.getTime().toString(36)}`;
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/** Read a worker's result.json. Missing or unparseable → null + error. */
export function readWorkerResult(resultPath: string): { result: unknown | null; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(resultPath, 'utf-8');
  } catch {
    return { result: null, error: `worker wrote no result file (${resultPath})` };
  }
  try {
    return { result: JSON.parse(raw) as unknown };
  } catch {
    return { result: null, error: `worker result file is not valid JSON (${resultPath})` };
  }
}

/**
 * A PM worker's progress sidecar (`progress.json` next to result.json),
 * written before it starts creating GitHub issues and after every issue it
 * creates. It is how the supervisor learns what a killed PM already created.
 */
export type PmWorkerProgress = { phase: 'agent' | 'applying'; createdIssues: number[] };

export function pmProgressPath(resultPath: string): string {
  return join(dirname(resultPath), 'progress.json');
}

export function readPmProgress(resultPath: string): PmWorkerProgress | null {
  const { result } = readWorkerResult(pmProgressPath(resultPath));
  if (!result || typeof result !== 'object') return null;
  const raw = result as Partial<PmWorkerProgress>;
  const createdIssues = Array.isArray(raw.createdIssues)
    ? raw.createdIssues.filter((n): n is number => Number.isInteger(n) && n > 0)
    : [];
  return { phase: raw.phase === 'applying' ? 'applying' : 'agent', createdIssues };
}

function isInsideDirectory(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

type StartArgs = {
  id: string;
  role: WorkerRole;
  issue?: number;
  ideaId?: string;
  workerDir: string;
  args: string[];
  spawnImpl: SpawnImpl;
  /** null: signal only the direct child. Defaults to process-group kill with the real spawn. */
  killGroup: KillGroupImpl | null;
  now: Date;
};

/**
 * Spawn `process.execPath <args>` from the project root with stdout/stderr
 * appended to the worker log. `done` always resolves (never rejects).
 *
 * Each worker leads its own process group (`detached`), and kill() signals
 * the whole group: a worker blocked in execSync (tests, git, gh) cannot run
 * its own signal handlers, and killing only the worker would orphan those
 * grandchildren in the issue worktree. A terminal Ctrl-C reaches only the
 * supervisor, which forwards SIGTERM/SIGKILL to the groups on shutdown.
 */
function startWorker(start: StartArgs): WorkerHandle {
  const logPath = join(start.workerDir, 'worker.log');
  const resultPath = join(start.workerDir, 'result.json');
  const contextPath = join(start.workerDir, 'context.json');
  const base = {
    id: start.id,
    role: start.role,
    ...(start.issue !== undefined ? { issue: start.issue } : {}),
    ...(start.ideaId !== undefined ? { ideaId: start.ideaId } : {}),
    startedAt: start.now.toISOString(),
    logPath,
    resultPath,
    contextPath,
  };

  let logFd: number | null = null;
  let child: ChildProcess;
  try {
    logFd = openSync(logPath, 'a');
    child = start.spawnImpl(process.execPath, start.args, {
      cwd: process.cwd(),
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ALPHA_LOOP_FACTORY_WORKER: start.id },
      detached: true,
    });
  } catch (err) {
    const message = `failed to start worker: ${err instanceof Error ? err.message : String(err)}`;
    return {
      ...base,
      pid: null,
      done: Promise.resolve({ exitCode: 1, result: null, error: message }),
      kill: () => { /* never started */ },
    };
  } finally {
    // The child holds its own duplicate of the descriptor.
    if (logFd !== null) {
      try { closeSync(logFd); } catch { /* best effort */ }
    }
  }

  const done = new Promise<WorkerExit>((resolveDone) => {
    let settled = false;
    const finish = (exitCode: number, problem?: string): void => {
      if (settled) return;
      settled = true;
      const { result, error } = readWorkerResult(resultPath);
      const errors = [problem, result === null ? error : undefined].filter(Boolean);
      resolveDone({ exitCode, result, ...(errors.length > 0 ? { error: errors.join('; ') } : {}) });
    };
    child.once('error', (err: Error) => finish(1, `worker process error: ${err.message}`));
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code ?? 1, signal ? `worker terminated by ${signal}` : undefined);
    });
  });

  const pid = typeof child.pid === 'number' ? child.pid : null;
  let exited = false;
  void done.then(() => { exited = true; });
  return {
    ...base,
    pid,
    done,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      if (start.killGroup && pid !== null && pid > 0) {
        try {
          start.killGroup(pid, signal);
          return;
        } catch {
          // ESRCH: the group is gone — fall through to the direct child.
        }
      }
      if (exited) return;
      try { child.kill(signal); } catch { /* already gone */ }
    },
  };
}

function resolveKillGroup(spawnImpl: SpawnImpl | undefined, killGroup: KillGroupImpl | null | undefined): KillGroupImpl | null {
  if (killGroup !== undefined) return killGroup;
  // Only a real spawn creates a real process group; never signal arbitrary
  // pgids for a fake child in tests.
  return spawnImpl === undefined || spawnImpl === spawn ? defaultKillGroup : null;
}

// ── Developer worker ─────────────────────────────────────────────────────────

/**
 * Start `alpha-loop run --issue N --factory-worker <ctx>` for one issue. The
 * context is exactly the FactoryWorkerContext shape run.ts validates.
 */
export function spawnDeveloperWorker(opts: {
  paths: FactoryPaths;
  issue: number;
  title: string;
  baseBranch: string;
  model?: string;
  verbose?: boolean;
  spawnImpl?: SpawnImpl;
  killGroup?: KillGroupImpl | null;
  now?: Date;
}): WorkerHandle {
  const now = opts.now ?? new Date();
  const id = makeWorkerId(`dev-${opts.issue}`, now);
  const workerDir = join(opts.paths.workersDir, id);
  mkdirSync(workerDir, { recursive: true });
  const contextPath = join(workerDir, 'context.json');
  const context: FactoryWorkerContext = {
    version: 1,
    workerId: id,
    issueNumber: opts.issue,
    baseBranch: opts.baseBranch,
    sessionSlug: sessionSlugFor(opts.issue, opts.title),
    resultPath: join(workerDir, 'result.json'),
    ...(opts.model ? { model: opts.model } : {}),
  };
  writeJsonAtomic(contextPath, context);

  const args = [
    ...process.execArgv,
    process.argv[1],
    'run',
    '--issue', String(opts.issue),
    '--factory-worker', contextPath,
    ...(opts.verbose ? ['--verbose'] : []),
  ];
  return startWorker({
    id, role: 'developer', issue: opts.issue, workerDir, args,
    spawnImpl: opts.spawnImpl ?? spawn,
    killGroup: resolveKillGroup(opts.spawnImpl, opts.killGroup),
    now,
  });
}

// ── PM worker ────────────────────────────────────────────────────────────────

/** Start `alpha-loop factory pm-worker --context <ctx>` for one idea. */
export function spawnPmWorker(opts: {
  paths: FactoryPaths;
  idea: InboxIdea;
  priorAnswers: string[];
  pm: PmWorkerSettings;
  spawnImpl?: SpawnImpl;
  killGroup?: KillGroupImpl | null;
  now?: Date;
}): WorkerHandle {
  const now = opts.now ?? new Date();
  const id = makeWorkerId(`pm-${opts.idea.id}`, now);
  const workerDir = join(opts.paths.workersDir, id);
  mkdirSync(workerDir, { recursive: true });
  const contextPath = join(workerDir, 'context.json');
  const context: PmWorkerContext = {
    version: 1,
    workerId: id,
    idea: { id: opts.idea.id, text: opts.idea.text },
    priorAnswers: opts.priorAnswers,
    resultPath: join(workerDir, 'result.json'),
    autoReady: opts.pm.autoReady,
    agent: opts.pm.agent,
    model: opts.pm.model,
    timeoutSeconds: opts.pm.timeoutSeconds,
    dryRun: opts.pm.dryRun ?? false,
  };
  writeJsonAtomic(contextPath, context);

  const args = [...process.execArgv, process.argv[1], 'factory', 'pm-worker', '--context', contextPath];
  return startWorker({
    id, role: 'pm', ideaId: opts.idea.id, workerDir, args,
    spawnImpl: opts.spawnImpl ?? spawn,
    killGroup: resolveKillGroup(opts.spawnImpl, opts.killGroup),
    now,
  });
}

/**
 * Read and validate a PM worker context. Like run.ts readFactoryWorkerContext,
 * the context must be `<workersDir>/<workerId>/context.json` and name its
 * sibling result.json, so a worker can never be aimed at an arbitrary file.
 */
export function readPmWorkerContext(paths: Pick<FactoryPaths, 'workersDir'>, contextPath: string): PmWorkerContext {
  const fail = (message: string): never => {
    throw new Error(`Invalid factory PM worker context: ${message}`);
  };
  const resolvedContextPath = resolve(process.cwd(), contextPath);
  const workerDir = dirname(resolvedContextPath);
  const workerId = basename(workerDir);
  if (
    dirname(workerDir) !== paths.workersDir
    || !isInsideDirectory(paths.workersDir, resolvedContextPath)
    || basename(resolvedContextPath) !== 'context.json'
  ) {
    fail('context must be <state_dir>/workers/<workerId>/context.json');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolvedContextPath, 'utf-8'));
  } catch (err) {
    fail(`could not read ${resolvedContextPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected a JSON object');
  const ctx = raw as Record<string, unknown>;
  if (ctx.version !== 1) fail(`unsupported version ${String(ctx.version)}`);
  if (ctx.workerId !== workerId) fail(`workerId ${String(ctx.workerId)} does not match worker directory ${workerId}`);
  const idea = ctx.idea as Record<string, unknown> | undefined;
  if (!idea || typeof idea.id !== 'string' || !idea.id || typeof idea.text !== 'string' || !idea.text.trim()) {
    fail('idea must be { id, text } with non-empty strings');
  }
  const expectedResultPath = join(workerDir, 'result.json');
  if (typeof ctx.resultPath !== 'string' || resolve(process.cwd(), ctx.resultPath) !== expectedResultPath) {
    fail('resultPath must be the sibling result.json of the context file');
  }
  const priorAnswers = Array.isArray(ctx.priorAnswers)
    ? ctx.priorAnswers.filter((a): a is string => typeof a === 'string')
    : [];
  const timeoutSeconds = typeof ctx.timeoutSeconds === 'number' && ctx.timeoutSeconds > 0 ? ctx.timeoutSeconds : 600;

  return {
    version: 1,
    workerId,
    idea: { id: idea!.id as string, text: idea!.text as string },
    priorAnswers,
    resultPath: expectedResultPath,
    autoReady: ctx.autoReady !== false,
    agent: typeof ctx.agent === 'string' ? ctx.agent : '',
    model: typeof ctx.model === 'string' ? ctx.model : '',
    timeoutSeconds,
    dryRun: ctx.dryRun === true,
  };
}
