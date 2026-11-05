/** Post-merge QA. Checks an immutable remote-base snapshot; never invokes an agent. */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { FactoryQaConfig } from './config.js';
import { writeJsonAtomic } from './factory-workers.js';
import { gitLockPath, withFileLockSync } from './lease.js';
import { exec as shellExec, shellQuote, type ExecResult } from './shell.js';

export type QaState = { version: 1; baseBranch: string; lastQaAt: string | null; lastGreenSha: string | null };
export type QaFailure = { command: string; exitCode: number; output: string };
export type QaResult = {
  version: 1;
  status: 'success' | 'failure';
  baseBranch: string;
  testedSha: string | null;
  /** Baseline before this attempt, even on success. */
  lastGreenSha: string | null;
  startedAt: string;
  completedAt: string;
  failure?: QaFailure;
  commits: string[];
  historyKind: 'since-green' | 'recent' | 'unavailable';
  cleanupErrors: string[];
};
const SHA_RE = /^[a-f0-9]{40,64}$/;

export function shouldRunQa(args: { mergesSinceLastQa: number; lastQaAt: string | null; now: Date; config: FactoryQaConfig }): boolean {
  if (!args.config.enabled) return false;
  const last = Date.parse(args.lastQaAt ?? '');
  return !Number.isFinite(last) || args.mergesSinceLastQa >= args.config.afterMerges
    || args.now.getTime() - last >= args.config.intervalMinutes * 60_000;
}

export function readQaState(stateDir: string, baseBranch: string): QaState {
  const empty: QaState = { version: 1, baseBranch, lastQaAt: null, lastGreenSha: null };
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, 'qa.json'), 'utf8')) as Partial<QaState>;
    if (raw.version !== 1 || raw.baseBranch !== baseBranch) return empty;
    return { ...empty,
      lastQaAt: typeof raw.lastQaAt === 'string' && Number.isFinite(Date.parse(raw.lastQaAt)) ? raw.lastQaAt : null,
      lastGreenSha: typeof raw.lastGreenSha === 'string' && SHA_RE.test(raw.lastGreenSha) ? raw.lastGreenSha : null,
    };
  } catch { return empty; }
}

function cleanOutput(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
}

/** Compute before truncating evidence. Banners and trailing logs do not change the key. */
export function qaFailureFingerprint(failure: Pick<QaFailure, 'command' | 'output'>): string {
  const lines = cleanOutput(failure.output).split('\n').map(line => line.trim()).filter(Boolean);
  const diagnostic = lines.find(line => /\b(error|err(?:_[\w]+)?|fatal|fail(?:ed|ure)?|exception|assertion)\b/i.test(line))
    ?? lines[0] ?? '(no diagnostic output)';
  return createHash('sha256').update(`${cleanOutput(failure.command).trim().replace(/\s+/g, ' ')}\n${diagnostic}`).digest('hex');
}

export function formatQaBugIdea(result: QaResult): string {
  if (!result.failure) throw new Error('Cannot format a passing QA run as a bug');
  const failure = result.failure;
  const output = cleanOutput(failure.output).split('\n').slice(-60).join('\n') || '(no diagnostic output)';
  // A longer fence keeps arbitrary command output (including markdown) literal.
  const fence = '`'.repeat(Math.max(3, ...Array.from(output.matchAll(/`+/g), m => m[0].length + 1)));
  return [
    `Bug: QA failed on ${result.baseBranch}: ${failure.command}`,
    'Post-merge QA detected a failure. Create a bug issue with this reproduction and evidence.',
    `Base: origin/${result.baseBranch}`,
    `Tested SHA: ${result.testedSha ?? 'unavailable (setup failed)'}`,
    `Last green SHA: ${result.lastGreenSha ?? 'unavailable (initial baseline)'}`,
    `Failing command: ${failure.command}`,
    `Exit code: ${failure.exitCode}`,
    'Last 60 output lines:', fence, output, fence,
    result.historyKind === 'since-green' ? 'First-parent commits since last green (includes squash/rebase merges):'
      : result.historyKind === 'recent' ? 'Green baseline unavailable; recent first-parent history (at most 60 commits):'
        : 'Green baseline unavailable; commit history unavailable.',
    ...result.commits,
    ...result.cleanupErrors.map(error => `Cleanup error: ${error}`),
  ].join('\n');
}

/** Validate untrusted worker JSON before handing it to the inbox. */
export function isQaResult(value: unknown): value is QaResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as QaResult;
  return r.version === 1 && ['success', 'failure'].includes(r.status)
    && typeof r.baseBranch === 'string' && r.baseBranch.length > 0
    && (r.testedSha === null || (typeof r.testedSha === 'string' && SHA_RE.test(r.testedSha)))
    && (r.lastGreenSha === null || (typeof r.lastGreenSha === 'string' && SHA_RE.test(r.lastGreenSha)))
    && typeof r.startedAt === 'string' && Number.isFinite(Date.parse(r.startedAt))
    && typeof r.completedAt === 'string' && Number.isFinite(Date.parse(r.completedAt))
    && Array.isArray(r.commits) && r.commits.every(c => typeof c === 'string')
    && ['since-green', 'recent', 'unavailable'].includes(r.historyKind)
    && Array.isArray(r.cleanupErrors) && r.cleanupErrors.every(c => typeof c === 'string')
    && (r.status === 'success' ? r.testedSha !== null && r.failure === undefined
      : !!r.failure && typeof r.failure.command === 'string' && r.failure.command.length > 0
        && Number.isInteger(r.failure.exitCode) && r.failure.exitCode !== 0 && typeof r.failure.output === 'string');
}

function execute(exec: typeof shellExec, command: string, cwd: string, timeout: number): ExecResult {
  try { return exec(command, { cwd, timeout }); }
  catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    return { exitCode: e?.status || 1, stdout: String(e?.stdout ?? ''),
      stderr: [e?.stderr ? String(e.stderr) : '', err instanceof Error ? err.message : String(err)].filter(Boolean).join('\n') };
  }
}

export function qaWorktreePath(stateDir: string, id: string): string {
  if (!/^qa-[A-Za-z0-9-]+$/.test(id)) throw new Error('Invalid QA worktree id');
  return join(resolve(stateDir), 'qa-worktrees', id);
}

/** Safe both in finally and after a dead worker is recovered by the supervisor. */
export function cleanupQaWorktree(opts: { projectDir: string; stateDir: string; worktreePath: string; exec?: typeof shellExec }): string[] {
  const path = resolve(opts.worktreePath);
  if (path !== qaWorktreePath(opts.stateDir, basename(path))) throw new Error('QA cleanup path is outside qa-worktrees');
  try {
    if (lstatSync(dirname(path)).isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw new Error('Refusing QA cleanup through a symlink');
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  return withFileLockSync(gitLockPath(opts.projectDir), () => {
    const errors: string[] = [];
    const run = (cmd: string): boolean => {
      const r = execute(opts.exec ?? shellExec, cmd, opts.projectDir, 120_000);
      if (r.exitCode === 0) return true;
      errors.push(`${cmd}: ${[r.stdout, r.stderr].filter(Boolean).join('\n') || `exit ${r.exitCode}`}`);
      return false;
    };
    if (!run(`git worktree remove --force ${shellQuote(path)}`)) {
      try { rmSync(path, { recursive: true, force: true }); }
      catch (err) { errors.push(String(err)); }
      run('git worktree prune');
    }
    return errors;
  });
}

export type RunQaOptions = {
  projectDir: string;
  stateDir: string;
  baseBranch: string;
  smokeTest: string;
  testCommand: string;
  setupCommand: string;
  timeoutMinutes: number;
  workerId?: string;
  exec?: typeof shellExec;
  now?: () => Date;
};

export function runQa(opts: RunQaOptions): QaResult {
  const now = opts.now ?? (() => new Date());
  const exec = opts.exec ?? shellExec;
  const projectDir = resolve(opts.projectDir);
  const state = readQaState(opts.stateDir, opts.baseBranch);
  const startedAt = now().toISOString();
  const deadline = Date.now() + opts.timeoutMinutes * 60_000;
  const worktreePath = qaWorktreePath(opts.stateDir, opts.workerId ?? `qa-${randomUUID()}`);
  const result: QaResult = { version: 1, status: 'failure', baseBranch: opts.baseBranch,
    testedSha: null, lastGreenSha: state.lastGreenSha, startedAt, completedAt: startedAt,
    commits: [], historyKind: 'unavailable', cleanupErrors: [] };
  let attemptedWorktree = false;
  let command = 'QA setup';
  const check = (cmd: string, cwd: string): string => {
    command = cmd;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.failure = { command: cmd, exitCode: 124, output: 'Error: QA worker time budget exhausted' };
      throw new Error('QA time budget exhausted');
    }
    const r = execute(exec, cmd, cwd, Math.min(remaining, cwd === projectDir ? 120_000 : remaining));
    if (r.exitCode !== 0) {
      result.failure = { command: cmd, exitCode: r.exitCode, output: [r.stdout, r.stderr].filter(Boolean).join('\n') };
      throw new Error('QA command failed');
    }
    return r.stdout;
  };
  // Persist the attempt before commands: a killed worker must not trigger an immediate retry loop.
  writeJsonAtomic(join(opts.stateDir, 'qa.json'), { ...state, lastQaAt: startedAt });
  try {
    withFileLockSync(gitLockPath(projectDir), () => {
      check(`git check-ref-format ${shellQuote(`refs/heads/${opts.baseBranch}`)}`, projectDir);
      check(`git fetch --no-tags origin ${shellQuote(`+refs/heads/${opts.baseBranch}:refs/remotes/origin/${opts.baseBranch}`)}`, projectDir);
      const sha = check(`git rev-parse --verify ${shellQuote(`refs/remotes/origin/${opts.baseBranch}^{commit}`)}`, projectDir).trim();
      if (!SHA_RE.test(sha)) throw new Error('Remote base did not resolve to a commit SHA');
      result.testedSha = sha;
      mkdirSync(dirname(worktreePath), { recursive: true });
      attemptedWorktree = true;
      check(`git worktree add --detach ${shellQuote(worktreePath)} ${shellQuote(sha)}`, projectDir);
    });
    check('pnpm install --frozen-lockfile', worktreePath);
    if (opts.setupCommand.trim()) check(opts.setupCommand.trim(), worktreePath);
    check('pnpm build', worktreePath);
    const smoke = opts.smokeTest.trim() || opts.testCommand.trim();
    if (!smoke) {
      command = 'smoke_test or test_command';
      throw new Error('No smoke_test or test_command configured');
    }
    check(smoke, worktreePath);
    result.status = 'success';
  } catch (err) {
    result.failure ??= { command, exitCode: 1, output: err instanceof Error ? err.message : String(err) };
    if (result.testedSha) {
      const baselineValid = state.lastGreenSha && execute(exec,
        `git merge-base --is-ancestor ${shellQuote(state.lastGreenSha)} ${shellQuote(result.testedSha)}`, projectDir, 120_000).exitCode === 0;
      const range = baselineValid ? `${state.lastGreenSha}..${result.testedSha}` : result.testedSha;
      const history = execute(exec, `git log --format='%H %s' --first-parent ${shellQuote(range)}${baselineValid ? '' : ' -60'}`, projectDir, 120_000);
      if (history.exitCode === 0) {
        result.commits = history.stdout.trim().split('\n').filter(Boolean);
        result.historyKind = baselineValid ? 'since-green' : 'recent';
      }
    }
  } finally {
    if (attemptedWorktree) {
      try { result.cleanupErrors = cleanupQaWorktree({ projectDir, stateDir: opts.stateDir, worktreePath, exec }); }
      catch (err) { result.cleanupErrors.push(String(err)); }
    }
  }
  result.completedAt = now().toISOString();
  writeJsonAtomic(join(opts.stateDir, 'qa.json'), { ...state, lastQaAt: startedAt,
    lastGreenSha: result.status === 'success' ? result.testedSha : state.lastGreenSha });
  return result;
}
