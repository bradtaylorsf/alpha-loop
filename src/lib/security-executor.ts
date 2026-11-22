/**
 * Session-end security profile executor.
 * Runs saved check commands once, classifies each row, and writes a proof
 * bound to the session git SHA. Does not spawn the fix agent. Does not treat
 * an older proof as PASS for the current SHA.
 */
import { exec as nodeExec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decisionAllowed,
  evaluateCommandPolicy,
  evaluateSecurityDenyPolicy,
} from './automation-policy.js';
import type { Config } from './config.js';
import type { SecurityPlan, SecurityPlanCheck, SecurityProfileName } from './security-types.js';

export type SecurityCheckStatus = 'PASS' | 'FAIL' | 'NOT_RUN';

export type SecurityCheckResult = {
  techniqueId: string;
  surface: string;
  source: string;
  target: SecurityPlanCheck['target'];
  status: SecurityCheckStatus;
  reason: string;
  command: string;
  exitCode: number | null;
  catalogRevision: string;
  logFile: string;
  timedOut: boolean;
  blocked: boolean;
};

export type SecurityProof = {
  version: 1;
  gitSha: string;
  catalogRevisions: Record<string, string>;
  productSuitePassed: boolean;
  createdAt: string;
  results: SecurityCheckResult[];
};

export type RunSecurityExecutorInput = {
  plan: SecurityPlan;
  worktree: string;
  gitSha: string;
  logsDir: string;
  config: Config;
  /** When false, every selected row is NOT_RUN and no command runs. */
  productSuitePassed: boolean;
  /**
   * When set, every selected row is NOT_RUN with this reason and no command
   * runs (used by --skip-sec). Takes precedence over productSuitePassed.
   */
  skipReason?: string;
};

export type RunSecurityExecutorResult = {
  proof: SecurityProof;
  proofPath: string;
  results: SecurityCheckResult[];
  /** True when every selected result is PASS. Empty selected set is true. */
  passed: boolean;
};

const PROOF_FILENAME = 'security-proof.json';
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

export function securityProofPath(logsDir: string): string {
  return join(logsDir, PROOF_FILENAME);
}

/**
 * A prior proof is valid for PASS reuse checks only when its git SHA matches
 * the session SHA. An older proof is never treated as PASS for a new SHA.
 */
export function isProofValidForSha(proof: SecurityProof, gitSha: string): boolean {
  return proof.gitSha === gitSha && proof.gitSha.trim() !== '';
}

export function loadSecurityProof(logsDir: string): SecurityProof | null {
  const path = securityProofPath(logsDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SecurityProof;
    if (!parsed || parsed.version !== 1 || typeof parsed.gitSha !== 'string') return null;
    if (!Array.isArray(parsed.results)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Run selected security checks once against the session worktree.
 * Writes one log per technique and one proof file under `logsDir`.
 */
export async function runSecurityExecutor(
  input: RunSecurityExecutorInput,
): Promise<RunSecurityExecutorResult> {
  const { plan, worktree, gitSha, logsDir, config, productSuitePassed, skipReason } = input;
  mkdirSync(logsDir, { recursive: true });

  const selected = plan.checks.filter((check) => check.selected);
  const catalogRevisions = collectCatalogRevisions(plan, selected);
  const results: SecurityCheckResult[] = [];

  if (skipReason) {
    for (const check of selected) {
      results.push(writeNotRunResult(check, logsDir, skipReason));
    }
    return finalize(results, gitSha, catalogRevisions, productSuitePassed, logsDir);
  }

  if (!productSuitePassed) {
    for (const check of selected) {
      results.push(writeNotRunResult(check, logsDir, 'Product suite failed; security checks not run.'));
    }
    return finalize(results, gitSha, catalogRevisions, productSuitePassed, logsDir);
  }

  for (const check of selected) {
    results.push(await runOneCheck(check, plan, worktree, logsDir, config));
  }

  return finalize(results, gitSha, catalogRevisions, productSuitePassed, logsDir);
}

async function runOneCheck(
  check: SecurityPlanCheck,
  plan: SecurityPlan,
  worktree: string,
  logsDir: string,
  config: Config,
): Promise<SecurityCheckResult> {
  const logFile = techniqueLogPath(logsDir, check);
  const base = {
    techniqueId: check.techniqueId,
    surface: check.surface,
    source: check.source,
    target: check.target,
    command: check.command,
    catalogRevision: check.catalogRevision,
    logFile,
  };

  const revisionError = catalogRevisionMismatch(check, plan);
  if (revisionError) {
    return writeResult({
      ...base,
      status: 'FAIL',
      reason: revisionError,
      exitCode: null,
      timedOut: false,
      blocked: true,
    }, 'Catalog revision mismatch; command not run.\n');
  }

  const commandDecision = evaluateCommandPolicy(config, check.command, { stage: 'security' });
  if (!decisionAllowed(commandDecision)) {
    return writeResult({
      ...base,
      status: 'FAIL',
      reason: commandDecision.reason,
      exitCode: null,
      timedOut: false,
      blocked: true,
    }, `Blocked by command policy.\n${commandDecision.reasons.join('\n')}\n`);
  }

  const denyBefore = evaluateSecurityDenyPolicy(check.command);
  if (!decisionAllowed(denyBefore)) {
    return writeResult({
      ...base,
      status: 'FAIL',
      reason: denyBefore.reason,
      exitCode: null,
      timedOut: false,
      blocked: true,
    }, `Blocked by security deny policy.\n${denyBefore.reasons.join('\n')}\n`);
  }

  const timeoutMs = Math.max(0, Math.floor(check.timeoutSec * 1000));
  const run = await execCheck(check.command, worktree, timeoutMs);
  const captured = `${run.stdout}${run.stderr ? `\n${run.stderr}` : ''}`;

  const denyAfter = evaluateSecurityDenyPolicy(check.command, { capturedOutput: captured });
  if (!decisionAllowed(denyAfter)) {
    return writeResult({
      ...base,
      status: 'FAIL',
      reason: denyAfter.reason,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      blocked: true,
    }, `Command output rejected by security deny policy.\n${denyAfter.reasons.join('\n')}\n--- output ---\n${captured}\n`);
  }

  if (run.timedOut) {
    return writeResult({
      ...base,
      status: 'FAIL',
      reason: `Timed out after ${check.timeoutSec}s.`,
      exitCode: run.exitCode,
      timedOut: true,
      blocked: false,
    }, `Timed out after ${check.timeoutSec}s.\n--- output ---\n${captured}\n`);
  }

  if (run.exitCode !== check.passExit) {
    return writeResult({
      ...base,
      status: 'FAIL',
      reason: `Exit code ${run.exitCode} did not match passExit ${check.passExit}.`,
      exitCode: run.exitCode,
      timedOut: false,
      blocked: false,
    }, `Exit code ${run.exitCode} (expected ${check.passExit}).\n--- output ---\n${captured}\n`);
  }

  return writeResult({
    ...base,
    status: 'PASS',
    reason: `Exit code ${run.exitCode} matched passExit ${check.passExit}.`,
    exitCode: run.exitCode,
    timedOut: false,
    blocked: false,
  }, `PASS: exit code ${run.exitCode}.\n--- output ---\n${captured}\n`);
}

function writeNotRunResult(
  check: SecurityPlanCheck,
  logsDir: string,
  reason: string,
): SecurityCheckResult {
  return writeResult({
    techniqueId: check.techniqueId,
    surface: check.surface,
    source: check.source,
    target: check.target,
    status: 'NOT_RUN',
    reason,
    command: check.command,
    exitCode: null,
    catalogRevision: check.catalogRevision,
    logFile: techniqueLogPath(logsDir, check),
    timedOut: false,
    blocked: false,
  }, `${reason}\n`);
}

function writeResult(result: SecurityCheckResult, logBody: string): SecurityCheckResult {
  writeFileSync(result.logFile, logBody);
  return result;
}

function finalize(
  results: SecurityCheckResult[],
  gitSha: string,
  catalogRevisions: Record<string, string>,
  productSuitePassed: boolean,
  logsDir: string,
): RunSecurityExecutorResult {
  const proof: SecurityProof = {
    version: 1,
    gitSha,
    catalogRevisions,
    productSuitePassed,
    createdAt: new Date().toISOString(),
    results,
  };
  const proofPath = securityProofPath(logsDir);
  writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  const passed = results.every((row) => row.status === 'PASS');
  return { proof, proofPath, results, passed };
}

function collectCatalogRevisions(
  plan: SecurityPlan,
  selected: readonly SecurityPlanCheck[],
): Record<string, string> {
  const revisions: Record<string, string> = {};
  for (const [name, pin] of Object.entries(plan.profiles)) {
    if (pin?.acceptedSha) revisions[name] = pin.acceptedSha;
  }
  for (const check of selected) {
    if (!revisions[check.source]) revisions[check.source] = check.catalogRevision;
  }
  return revisions;
}

function catalogRevisionMismatch(check: SecurityPlanCheck, plan: SecurityPlan): string | null {
  const profile = check.source as SecurityProfileName;
  const pin = plan.profiles[profile];
  if (!pin) {
    return `No accepted catalog revision for profile "${check.source}".`;
  }
  if (check.catalogRevision !== pin.acceptedSha) {
    return (
      `catalogRevision ${check.catalogRevision} does not match accepted SHA `
      + `${pin.acceptedSha} for profile "${check.source}".`
    );
  }
  return null;
}

function techniqueLogPath(logsDir: string, check: SecurityPlanCheck): string {
  const safeId = sanitizeFilename(check.techniqueId);
  const safeSurface = sanitizeFilename(check.surface);
  return join(logsDir, `security-check-${safeId}-${safeSurface}.log.txt`);
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}

type CheckExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

function execCheck(command: string, cwd: string, timeoutMs: number): Promise<CheckExecResult> {
  return new Promise((resolve) => {
    nodeExec(
      command,
      {
        cwd,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
        maxBuffer: EXEC_MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const err = typeof stderr === 'string' ? stderr : '';
        if (!error) {
          resolve({ stdout: out, stderr: err, exitCode: 0, timedOut: false });
          return;
        }
        const execErr = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
          signal?: string;
        };
        const timedOut = execErr.killed === true
          || execErr.code === 'ETIMEDOUT'
          || execErr.signal === 'SIGTERM';
        const exitCode = typeof execErr.code === 'number' ? execErr.code : (timedOut ? null : 1);
        resolve({ stdout: out, stderr: err, exitCode, timedOut });
      },
    );
  });
}
