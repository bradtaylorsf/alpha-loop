/**
 * Triage command — analyze open GitHub issues for staleness, clarity, size,
 * and duplicates using an AI agent, then apply user-selected fixes.
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkbox, confirm } from '@inquirer/prompts';
import { loadConfig, assertSafeShellArg } from '../lib/config.js';
import { buildOneShotCommand } from '../lib/agent.js';
import { buildTriagePrompt } from '../lib/prompts.js';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import { buildEpicIssueBody, mergeEpicChecklist } from '../lib/epics.js';
import {
  formatTriageFindings,
  formatEpicGroupProposals,
  parseTriageAnalysisResponse,
  buildPlanningContext,
  type TriageFinding,
  type TriageAction,
  type TriageAnalysis,
  type ProposedEpicGroup,
} from '../lib/planning.js';
import {
  listOpenIssuesWithComments,
  closeIssue,
  updateIssue,
  createIssue,
  commentIssue,
  getIssueBody,
  updateEpicIssueBody,
  commentChildEpicBacklink,
} from '../lib/github.js';

export type TriageOptions = {
  dryRun?: boolean;
  yes?: boolean;
};

/** Truncate issue bodies to stay within agent context limits. */
const MAX_BODY_CHARS = 500;

function hasLabel(issue: { labels?: string[] }, label: string): boolean {
  return (issue.labels ?? []).some((item) => item.toLowerCase() === label.toLowerCase());
}

function filterValidEpicGroups(
  groups: ProposedEpicGroup[],
  issues: Array<{ number: number; labels?: string[] }>,
): ProposedEpicGroup[] {
  if (groups.length === 0) return [];

  const issueByNumber = new Map(issues.map((issue) => [issue.number, issue]));
  return groups.filter((group) => {
    const unknown = group.orderedChildIssueNumbers.filter((num) => !issueByNumber.has(num));
    const nested = group.orderedChildIssueNumbers.filter((num) => {
      const issue = issueByNumber.get(num);
      return issue ? hasLabel(issue, 'epic') : false;
    });
    const existingEpic = group.existingEpicIssueNum
      ? issueByNumber.get(group.existingEpicIssueNum)
      : undefined;

    if (unknown.length > 0) {
      log.warn(`Skipping epic proposal "${group.title}": child issue(s) not found among open issues: ${unknown.map((n) => `#${n}`).join(', ')}`);
      return false;
    }

    if (nested.length > 0) {
      log.warn(`Skipping epic proposal "${group.title}": nested epic child issue(s) are not supported: ${nested.map((n) => `#${n}`).join(', ')}`);
      return false;
    }

    if (group.existingEpicIssueNum && !existingEpic) {
      log.warn(`Skipping epic proposal "${group.title}": existing epic #${group.existingEpicIssueNum} is not an open issue`);
      return false;
    }

    if (existingEpic && !hasLabel(existingEpic, 'epic')) {
      log.warn(`Skipping epic proposal "${group.title}": existing candidate #${group.existingEpicIssueNum} is not labeled epic`);
      return false;
    }

    return true;
  });
}

function formatEpicChoice(group: ProposedEpicGroup, index: number): string {
  const target = group.existingEpicIssueNum
    ? `update #${group.existingEpicIssueNum}`
    : 'create new epic';
  const children = group.orderedChildIssueNumbers.map((n) => `#${n}`).join(' -> ');
  return `[${target}] ${index + 1}. ${group.title} — ${children}`;
}

function applyEpicProposal(repo: string, group: ProposedEpicGroup, failures: string[]): number | null {
  let epicNum = group.existingEpicIssueNum;

  if (epicNum) {
    const existingBody = getIssueBody(repo, epicNum);
    if (existingBody == null) {
      failures.push(`Epic #${epicNum}: could not fetch existing body`);
      return null;
    }

    const nextBody = mergeEpicChecklist(existingBody, group.orderedChildIssueNumbers);
    if (nextBody !== existingBody && !updateEpicIssueBody(repo, epicNum, nextBody)) {
      failures.push(`Epic #${epicNum}: checklist update failed`);
      return null;
    }
    log.success(`Updated epic #${epicNum}: ${group.title}`);
  } else {
    const body = buildEpicIssueBody({
      goal: group.goal,
      rationale: group.rationale,
      orderedChildIssueNumbers: group.orderedChildIssueNumbers,
      acceptanceCriteria: group.acceptanceCriteria,
    });
    epicNum = createIssue(repo, group.title, body, ['epic']);
    if (epicNum <= 0) {
      failures.push(`Epic "${group.title}": creation returned 0`);
      return null;
    }
    log.success(`Created epic #${epicNum}: ${group.title}`);
  }

  for (const childIssueNum of group.orderedChildIssueNumbers) {
    if (!commentChildEpicBacklink(repo, childIssueNum, epicNum)) {
      failures.push(`Child #${childIssueNum}: backlink to epic #${epicNum} failed`);
    }
  }

  return epicNum;
}

export async function triageCommand(options: TriageOptions): Promise<void> {
  const config = loadConfig({ dryRun: options.dryRun });

  // ── Fetch open issues with comments (single API call) ──────────────────────
  log.step('Fetching open issues with comments...');
  const issues = listOpenIssuesWithComments(config.repo);

  if (issues.length === 0) {
    log.info('No open issues found. Nothing to triage.');
    return;
  }

  log.info(`Found ${issues.length} open issue(s)`);

  // Truncate issue bodies for context
  const truncatedIssues = issues.map((issue) => ({
    ...issue,
    body: issue.body.length > MAX_BODY_CHARS
      ? issue.body.slice(0, MAX_BODY_CHARS) + '...'
      : issue.body,
    comments: (issue.comments ?? []).slice(0, 5),
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
  const promptFile = join(tmpdir(), `alpha-loop-prompt-${Date.now()}`);
  writeFileSync(promptFile, triagePrompt, 'utf-8');
  let result;
  try {
    result = exec(
      `${agentCmd} < "${promptFile}" 2>/dev/null`,
      { cwd: process.cwd(), timeout: 10 * 60 * 1000 },
    );
  } finally {
    try { unlinkSync(promptFile); } catch { /* cleanup best-effort */ }
  }

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    log.error('Agent failed to analyze issues. Check agent configuration and try again.');
    if (result.stderr) log.error(result.stderr.slice(0, 500));
    return;
  }

  let analysis: TriageAnalysis;
  try {
    analysis = parseTriageAnalysisResponse(result.stdout);
  } catch (err) {
    log.error(`Failed to parse triage JSON: ${(err as Error).message}`);
    log.error(`Agent response (first 500 chars): ${result.stdout.slice(0, 500)}`);
    return;
  }

  const findings = analysis.findings;
  const epicGroups = filterValidEpicGroups(analysis.epicGroups, issues);

  if (findings.length === 0 && epicGroups.length === 0) {
    if (analysis.epicGroups.length > 0) {
      log.info('No valid epic proposals after filtering invalid or nested groups.');
      return;
    }
    log.success('All issues look good — no triage actions needed.');
    return;
  }

  // ── Display findings and proposed epic groups ─────────────────────────────
  if (findings.length > 0) {
    console.log('');
    console.log(formatTriageFindings(findings));
    console.log('');
    log.info(`Found ${findings.length} issue(s) needing attention`);
  }

  if (epicGroups.length > 0) {
    console.log('');
    console.log(formatEpicGroupProposals(epicGroups));
    console.log('');
    log.info(`Found ${epicGroups.length} proposed epic group(s)`);
  }

  // ── Dry run exit ───────────────────────────────────────────────────────────
  if (options.dryRun) {
    log.dry('Dry run — no changes will be made.');
    return;
  }

  // ── Interactive review ─────────────────────────────────────────────────────
  let selectedNums: number[];
  let selectedEpicIndexes: number[];

  if (options.yes) {
    selectedNums = findings.filter((f) => f.selected).map((f) => f.issueNum);
    selectedEpicIndexes = epicGroups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => group.selected)
      .map(({ index }) => index);
    log.info(`--yes: applying all ${selectedNums.length} selected triage action(s) and ${selectedEpicIndexes.length} selected epic proposal(s)`);
  } else {
    const actionLabels: Record<TriageAction, string> = {
      close: 'Close as stale',
      rewrite: 'Rewrite body',
      split: 'Split into sub-issues',
      merge: 'Close as duplicate',
      enrich: 'Enrich with details',
    };

    if (findings.length > 0) {
      const choices = findings.map((f) => ({
        name: `[${actionLabels[f.action]}] #${f.issueNum} ${f.title} — ${f.reason.slice(0, 60)}`,
        value: f.issueNum,
        checked: f.selected,
      }));

      selectedNums = await checkbox({
        message: 'Select cleanup actions to apply:',
        choices,
      });
    } else {
      selectedNums = [];
      log.info('No per-issue cleanup actions to apply.');
    }

    if (epicGroups.length > 0) {
      selectedEpicIndexes = await checkbox({
        message: 'Select epic proposals to apply:',
        choices: epicGroups.map((group, index) => ({
          name: formatEpicChoice(group, index),
          value: index,
          checked: group.selected,
        })),
      });
    } else {
      selectedEpicIndexes = [];
    }

    const totalSelections = selectedNums.length + selectedEpicIndexes.length;
    if (totalSelections === 0) {
      log.info('No changes selected.');
      return;
    }

    const proceed = await confirm({
      message: `Apply ${selectedNums.length} cleanup action(s) and ${selectedEpicIndexes.length} epic proposal(s)?`,
    });

    if (!proceed) {
      log.info('Cancelled.');
      return;
    }
  }

  if (selectedNums.length === 0 && selectedEpicIndexes.length === 0) {
    log.info('No selected triage actions or epic proposals to apply.');
    return;
  }

  // ── Execute actions ────────────────────────────────────────────────────────
  const failures: string[] = [];
  let applied = 0;
  let appliedEpics = 0;
  const appliedEpicNums: number[] = [];

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
            // Preserve original body in a collapsed block
            const original = issues.find((i) => i.number === finding.issueNum)?.body;
            const preserved = original
              ? `<details><summary>Original description</summary>\n\n${original}\n\n</details>\n\n`
              : '';
            updateIssue(config.repo, finding.issueNum, { body: preserved + finding.rewrittenBody });
            commentIssue(config.repo, finding.issueNum, '_Issue rewritten by alpha-loop triage. Original description preserved above._');
            log.success(`Rewrote body for #${finding.issueNum}`);
            applied++;
          } else {
            log.warn(`No rewritten body for #${finding.issueNum}, skipping`);
          }
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
              applied++;
            }
          } else {
            log.warn(`No split suggestions for #${finding.issueNum}, skipping`);
          }
          break;
        }

        case 'duplicate': {
          if (finding.duplicateOf != null) {
            commentIssue(config.repo, finding.issueNum,
              `Closing as duplicate of #${finding.duplicateOf}.\n\n_Triaged by alpha-loop._`);
            closeIssue(config.repo, finding.issueNum, 'not_planned');
            log.success(`Closed duplicate #${finding.issueNum} (duplicate of #${finding.duplicateOf})`);
            applied++;
          } else {
            log.warn(`No duplicate reference for #${finding.issueNum}, skipping`);
          }
          break;
        }

        case 'enrich': {
          if (finding.enrichedBody) {
            updateIssue(config.repo, finding.issueNum, { body: finding.enrichedBody });
            commentIssue(config.repo, finding.issueNum, '_Issue enriched by alpha-loop triage. Original description preserved in collapsed block above._');
            log.success(`Enriched #${finding.issueNum}`);
            applied++;
          } else {
            log.warn(`No enriched body for #${finding.issueNum}, skipping`);
          }
          break;
        }
      }
    } catch (err) {
      failures.push(`#${finding.issueNum}: ${(err as Error).message}`);
    }
  }

  for (const index of selectedEpicIndexes) {
    const group = epicGroups[index];
    if (!group) continue;
    try {
      const epicNum = applyEpicProposal(config.repo, group, failures);
      if (epicNum != null) {
        appliedEpics++;
        appliedEpicNums.push(epicNum);
      }
    } catch (err) {
      failures.push(`Epic "${group.title}": ${(err as Error).message}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  log.success(`Applied ${applied} triage action(s)`);
  if (appliedEpics > 0) {
    log.success(`Applied ${appliedEpics} epic proposal(s): ${appliedEpicNums.map((n) => `#${n}`).join(', ')}`);
  } else if (selectedEpicIndexes.length > 0) {
    log.warn('Applied 0 epic proposal(s)');
  }

  if (failures.length > 0) {
    console.log('');
    log.warn(`${failures.length} operation(s) failed:`);
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }
}
