/**
 * Session-end security gate: run the executor once, record FAIL on the
 * session failures list, append a proof table for the session PR, and
 * comment one line per security-check issue.
 */
import { existsSync } from 'node:fs';
import { commentIssue, listOpenIssues } from './github.js';
import { hasLabel } from './labels.js';
import { log } from './logger.js';
import { exec } from './shell.js';
import {
  runSecurityExecutor,
  type SecurityCheckResult,
  type SecurityProof,
  type RunSecurityExecutorResult,
} from './security-executor.js';
import { loadSecurityPlan, securityPlanPath } from './security-plan.js';
import type { Config } from './config.js';
import type { SessionContext } from './session.js';
import type { Milestone } from './github.js';

export const SECURITY_CHECK_LABEL = 'security-check';

export type SecurityGateFailure = {
  code: 'security-gate-failed';
  message: string;
  issueNum?: number;
};

export type RunSessionSecurityGateInput = {
  config: Config;
  session: SessionContext;
  worktreePath: string;
  /** Raw product-suite result. --skip-tests forces false via productSuitePassedForSecurity. */
  productSuitePassed: boolean;
  /** When true, write NOT_RUN for every selected row and do not execute commands. */
  skipSec?: boolean;
  /** Optional override for tests. */
  gitSha?: string;
  /** Optional issue comment sink for tests. */
  commentIssueFn?: typeof commentIssue;
  /** Optional open-issue listing for tests. */
  listOpenIssuesFn?: typeof listOpenIssues;
};

export type RunSessionSecurityGateResult = {
  ran: boolean;
  skipped: boolean;
  proof: SecurityProof | null;
  proofPath: string | null;
  proofMarkdown: string | null;
  failures: SecurityGateFailure[];
  results: SecurityCheckResult[];
};

/**
 * A milestone is hidden from pickTarget when it has at least one open issue
 * and every open issue carries the security-check label.
 */
export function isSecurityCheckOnlyMilestone(
  milestoneTitle: string,
  openIssues: ReadonlyArray<{ milestone?: string | null; labels: string[] }>,
): boolean {
  const issues = openIssues.filter((issue) => issue.milestone === milestoneTitle);
  if (issues.length === 0) return false;
  return issues.every((issue) => hasLabel(issue.labels, SECURITY_CHECK_LABEL));
}

/** Drop milestones whose open issues are all security-check. */
export function filterSecurityOnlyMilestones(
  milestones: readonly Milestone[],
  openIssues: ReadonlyArray<{ milestone?: string | null; labels: string[] }>,
): Milestone[] {
  return milestones.filter((milestone) => !isSecurityCheckOnlyMilestone(milestone.title, openIssues));
}

export function formatSecurityProofTable(proof: SecurityProof): string {
  const lines: string[] = [
    '### Security Profile Gate',
    '',
    `**Git SHA:** \`${proof.gitSha}\``,
    `**Product suite:** ${proof.productSuitePassed ? 'passed' : 'not passed'}`,
    '',
    '| Technique | Surface | Status | Reason |',
    '| --- | --- | --- | --- |',
  ];
  for (const row of proof.results) {
    const reason = row.reason.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${row.techniqueId} | ${row.surface} | ${row.status} | ${reason} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function resolveProductSuitePassedForSecurity(input: {
  skipTests: boolean;
  /** Result from the session product-test gate when it ran. */
  gateTestsPassing: boolean | null;
}): boolean {
  if (input.skipTests) return false;
  if (input.gateTestsPassing === null) return true;
  return input.gateTestsPassing;
}

export function securityPlanFileExists(projectDir: string): boolean {
  return existsSync(securityPlanPath(projectDir));
}

/**
 * Run the session security gate once when security_checks is on and a plan
 * has selected rows. Stores proof markdown on the session for the PR body.
 */
export async function runSessionSecurityGate(
  input: RunSessionSecurityGateInput,
): Promise<RunSessionSecurityGateResult> {
  const empty: RunSessionSecurityGateResult = {
    ran: false,
    skipped: false,
    proof: null,
    proofPath: null,
    proofMarkdown: null,
    failures: [],
    results: [],
  };

  if (!input.config.securityChecks) {
    return empty;
  }

  const projectDir = process.cwd();
  const plan = loadSecurityPlan(projectDir);
  const selected = plan.checks.filter((check) => check.selected);
  if (selected.length === 0) {
    log.info('Security gate: no selected checks in security-plan.json — skipping');
    return empty;
  }

  const resolvedSha = input.gitSha
    ?? exec('git rev-parse HEAD', { cwd: input.worktreePath }).stdout.trim();
  const gitSha = resolvedSha || 'unknown';

  log.step('Security profile gate: running selected checks');

  let executorResult: RunSecurityExecutorResult;
  if (input.skipSec) {
    executorResult = await runSecurityExecutor({
      plan,
      worktree: input.worktreePath,
      gitSha,
      logsDir: input.session.logsDir,
      config: input.config,
      productSuitePassed: true,
      skipReason: 'Skipped via --skip-sec; security checks not run.',
    });
  } else {
    executorResult = await runSecurityExecutor({
      plan,
      worktree: input.worktreePath,
      gitSha,
      logsDir: input.session.logsDir,
      config: input.config,
      productSuitePassed: input.productSuitePassed,
    });
  }

  const proofMarkdown = formatSecurityProofTable(executorResult.proof);
  input.session.securityProofMarkdown = proofMarkdown;

  const failures: SecurityGateFailure[] = [];
  for (const row of executorResult.results) {
    if (row.status !== 'FAIL') continue;
    failures.push({
      code: 'security-gate-failed',
      message: `Security check ${row.techniqueId} [${row.surface}] FAIL: ${row.reason}`,
    });
  }

  const commentFn = input.commentIssueFn ?? commentIssue;
  const listFn = input.listOpenIssuesFn ?? listOpenIssues;
  try {
    await commentSecurityIssues({
      repo: input.config.repo,
      results: executorResult.results,
      planMilestones: selected.map((check) => ({
        techniqueId: check.techniqueId,
        surface: check.surface,
        milestone: check.milestone,
      })),
      commentFn,
      listFn,
    });
  } catch (err) {
    log.warn(`Security gate: could not comment on security issues: ${err instanceof Error ? err.message : err}`);
  }

  if (failures.length > 0) {
    log.error(`Security gate: ${failures.length} check(s) FAILED`);
  } else if (input.skipSec) {
    log.info('Security gate: skipped (--skip-sec); recorded NOT_RUN');
  } else if (executorResult.passed) {
    log.success('Security gate: all selected checks PASS');
  } else {
    log.info('Security gate: completed with non-PASS results (see proof)');
  }

  return {
    ran: true,
    skipped: Boolean(input.skipSec),
    proof: executorResult.proof,
    proofPath: executorResult.proofPath,
    proofMarkdown,
    failures,
    results: executorResult.results,
  };
}

async function commentSecurityIssues(input: {
  repo: string;
  results: readonly SecurityCheckResult[];
  planMilestones: ReadonlyArray<{ techniqueId: string; surface: string; milestone?: string }>;
  commentFn: typeof commentIssue;
  listFn: typeof listOpenIssues;
}): Promise<void> {
  const openIssues = input.listFn(input.repo, 200).filter((issue) => hasLabel(issue.labels, SECURITY_CHECK_LABEL));
  if (openIssues.length === 0) return;

  for (const row of input.results) {
    const planRow = input.planMilestones.find(
      (check) => check.techniqueId === row.techniqueId && check.surface === row.surface,
    );
    const issue = openIssues.find((candidate) => {
      if (planRow?.milestone && candidate.milestone === planRow.milestone) return true;
      const expectedTitle = `${row.techniqueId}: ${row.surface}`;
      return candidate.title === expectedTitle;
    });
    if (!issue) continue;
    const line = `Security gate: ${row.techniqueId} [${row.surface}] → ${row.status}${row.reason ? ` (${row.reason})` : ''}`;
    input.commentFn(input.repo, issue.number, line);
  }
}
