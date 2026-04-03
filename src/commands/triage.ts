/**
 * Triage command — analyze open GitHub issues for staleness, clarity, size,
 * and duplicates using an AI agent, then apply user-selected fixes.
 */

import { checkbox, confirm } from '@inquirer/prompts';
import { loadConfig, assertSafeShellArg } from '../lib/config.js';
import { buildOneShotCommand } from '../lib/agent.js';
import { buildTriagePrompt } from '../lib/prompts.js';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import {
  extractJsonFromResponse,
  formatTriageFindings,
  buildPlanningContext,
  type TriageFinding,
  type TriageAction,
} from '../lib/planning.js';
import {
  listOpenIssues,
  closeIssue,
  updateIssue,
  createIssue,
  commentIssue,
} from '../lib/github.js';

export type TriageOptions = {
  dryRun?: boolean;
  yes?: boolean;
};

/** Truncate issue bodies to stay within agent context limits. */
const MAX_BODY_CHARS = 500;

export async function triageCommand(options: TriageOptions): Promise<void> {
  const config = loadConfig({ dryRun: options.dryRun });

  // ── Fetch open issues ──────────────────────────────────────────────────────
  log.step('Fetching open issues...');
  const issues = listOpenIssues(config.repo);

  if (issues.length === 0) {
    log.info('No open issues found. Nothing to triage.');
    return;
  }

  log.info(`Found ${issues.length} open issue(s)`);

  // Truncate issue bodies
  const truncatedIssues = issues.map((issue) => ({
    ...issue,
    body: issue.body.length > MAX_BODY_CHARS
      ? issue.body.slice(0, MAX_BODY_CHARS) + '...'
      : issue.body,
  }));

  // ── Build context ──────────────────────────────────────────────────────────
  const ctx = buildPlanningContext(config);

  // ── AI analysis ────────────────────────────────────────────────────────────
  log.step('Analyzing issues via AI agent...');
  const triagePrompt = buildTriagePrompt({
    issues: truncatedIssues,
    projectContext: ctx.projectContext,
    visionContext: ctx.visionContext,
  });

  const safeModel = assertSafeShellArg(config.model, 'model');
  const agentCmd = buildOneShotCommand(config.agent, safeModel);
  const result = exec(
    `echo ${JSON.stringify(triagePrompt)} | ${agentCmd} 2>/dev/null`,
    { cwd: process.cwd(), timeout: 10 * 60 * 1000 },
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    log.error('Agent failed to analyze issues. Check agent configuration and try again.');
    if (result.stderr) log.error(result.stderr.slice(0, 500));
    return;
  }

  let findings: TriageFinding[];
  try {
    findings = extractJsonFromResponse<TriageFinding[]>(result.stdout);
  } catch (err) {
    log.error(`Failed to parse triage JSON: ${(err as Error).message}`);
    log.error(`Agent response (first 500 chars): ${result.stdout.slice(0, 500)}`);
    return;
  }

  if (!Array.isArray(findings) || findings.length === 0) {
    log.success('All issues look good — no triage actions needed.');
    return;
  }

  // ── Display findings ───────────────────────────────────────────────────────
  console.log('');
  console.log(formatTriageFindings(findings));
  console.log('');
  log.info(`Found ${findings.length} issue(s) needing attention`);

  // ── Dry run exit ───────────────────────────────────────────────────────────
  if (options.dryRun) {
    log.dry('Dry run — no changes will be made.');
    return;
  }

  // ── Interactive review ─────────────────────────────────────────────────────
  let selectedNums: number[];

  if (options.yes) {
    selectedNums = findings.filter((f) => f.selected).map((f) => f.issueNum);
    log.info(`--yes: applying all ${selectedNums.length} triage action(s)`);
  } else {
    const actionLabels: Record<TriageAction, string> = {
      close: 'Close as stale',
      rewrite: 'Rewrite body',
      split: 'Split into sub-issues',
      merge: 'Close as duplicate',
    };

    const choices = findings.map((f) => ({
      name: `[${actionLabels[f.action]}] #${f.issueNum} ${f.title} — ${f.reason.slice(0, 60)}`,
      value: f.issueNum,
      checked: f.selected,
    }));

    selectedNums = await checkbox({
      message: 'Select actions to apply:',
      choices,
    });

    if (selectedNums.length === 0) {
      log.info('No actions selected.');
      return;
    }

    const proceed = await confirm({
      message: `Apply ${selectedNums.length} change(s)?`,
    });

    if (!proceed) {
      log.info('Cancelled.');
      return;
    }
  }

  // ── Execute actions ────────────────────────────────────────────────────────
  const failures: string[] = [];
  let applied = 0;

  for (const finding of findings) {
    if (!selectedNums.includes(finding.issueNum)) continue;

    try {
      switch (finding.category) {
        case 'stale': {
          commentIssue(config.repo, finding.issueNum,
            `Closing as stale: ${finding.reason}\n\n_Triaged by alpha-loop._`);
          closeIssue(config.repo, finding.issueNum, 'not_planned');
          log.success(`Closed stale issue #${finding.issueNum}`);
          applied++;
          break;
        }

        case 'unclear': {
          if (finding.rewrittenBody) {
            updateIssue(config.repo, finding.issueNum, { body: finding.rewrittenBody });
            log.success(`Rewrote body for #${finding.issueNum}`);
          } else {
            log.warn(`No rewritten body for #${finding.issueNum}, skipping`);
          }
          applied++;
          break;
        }

        case 'too_large': {
          if (finding.splitInto && finding.splitInto.length > 0) {
            const createdNums: number[] = [];
            for (const subTitle of finding.splitInto) {
              const num = createIssue(config.repo, subTitle, `Split from #${finding.issueNum}`, ['enhancement']);
              if (num > 0) {
                createdNums.push(num);
                log.success(`Created sub-issue #${num}: ${subTitle}`);
              } else {
                failures.push(`Sub-issue "${subTitle}": creation returned 0`);
              }
            }
            if (createdNums.length > 0) {
              const links = createdNums.map((n) => `- #${n}`).join('\n');
              commentIssue(config.repo, finding.issueNum,
                `Split into smaller issues:\n${links}\n\n_Triaged by alpha-loop._`);
              closeIssue(config.repo, finding.issueNum, 'completed');
              log.success(`Closed #${finding.issueNum} after splitting`);
            }
          } else {
            log.warn(`No split suggestions for #${finding.issueNum}, skipping`);
          }
          applied++;
          break;
        }

        case 'duplicate': {
          if (finding.duplicateOf != null) {
            commentIssue(config.repo, finding.issueNum,
              `Closing as duplicate of #${finding.duplicateOf}.\n\n_Triaged by alpha-loop._`);
            closeIssue(config.repo, finding.issueNum, 'not_planned');
            log.success(`Closed duplicate #${finding.issueNum} (duplicate of #${finding.duplicateOf})`);
          } else {
            log.warn(`No duplicate reference for #${finding.issueNum}, skipping`);
          }
          applied++;
          break;
        }
      }
    } catch (err) {
      failures.push(`#${finding.issueNum}: ${(err as Error).message}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  log.success(`Applied ${applied} triage action(s)`);

  if (failures.length > 0) {
    console.log('');
    log.warn(`${failures.length} operation(s) failed:`);
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }
}
