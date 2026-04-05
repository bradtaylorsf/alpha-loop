/**
 * Roadmap command — analyze open GitHub issues and organize them into
 * milestones using an AI agent, then create milestones and assign issues.
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkbox, confirm } from '@inquirer/prompts';
import { loadConfig, assertSafeShellArg } from '../lib/config.js';
import { buildOneShotCommand } from '../lib/agent.js';
import { buildRoadmapPrompt } from '../lib/prompts.js';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import {
  extractJsonFromResponse,
  formatRoadmapTable,
  buildPlanningContext,
  type PlannedMilestone,
  type RoadmapAssignment,
} from '../lib/planning.js';
import {
  listOpenIssues,
  listMilestones,
  createMilestone,
  setIssueMilestone,
  addIssueToProject,
} from '../lib/github.js';

export type RoadmapOptions = {
  dryRun?: boolean;
  yes?: boolean;
};

/** Truncate issue bodies to stay within agent context limits. */
const MAX_BODY_CHARS = 500;

export async function roadmapCommand(options: RoadmapOptions): Promise<void> {
  const config = loadConfig({ dryRun: options.dryRun });

  // ── Fetch open issues ──────────────────────────────────────────────────────
  log.step('Fetching open issues...');
  const issues = listOpenIssues(config.repo);

  if (issues.length === 0) {
    log.info('No open issues found. Nothing to organize.');
    return;
  }

  log.info(`Found ${issues.length} open issue(s)`);

  // ── Fetch existing milestones ─────────────────────────────────────────────
  log.step('Fetching existing milestones...');
  const existingMilestones = listMilestones(config.repo);
  log.info(`Found ${existingMilestones.length} existing milestone(s)`);

  // Build a map of issue number → current milestone title
  // Note: listOpenIssues doesn't return milestone info, so we rely on the agent
  // to include currentMilestone from its analysis. We pass milestone names for context.

  // Truncate issue bodies
  const truncatedIssues = issues.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body.length > MAX_BODY_CHARS
      ? issue.body.slice(0, MAX_BODY_CHARS) + '...'
      : issue.body,
    milestone: null as string | null,
  }));

  // ── Build context ──────────────────────────────────────────────────────────
  const ctx = buildPlanningContext(config);

  // ── AI analysis ────────────────────────────────────────────────────────────
  log.step('Analyzing issues via AI agent...');
  const roadmapPrompt = buildRoadmapPrompt({
    issues: truncatedIssues,
    milestones: existingMilestones.map((m) => ({
      title: m.title,
      description: m.description,
      dueOn: m.dueOn,
    })),
    projectContext: ctx.projectContext,
    visionContext: ctx.visionContext,
  });

  const safeModel = assertSafeShellArg(config.model, 'model');
  const agentCmd = buildOneShotCommand(config.agent, safeModel);
  const promptFile = join(tmpdir(), `alpha-loop-prompt-${Date.now()}`);
  writeFileSync(promptFile, roadmapPrompt, 'utf-8');
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

  let parsed: { milestones: PlannedMilestone[]; assignments: RoadmapAssignment[] };
  try {
    parsed = extractJsonFromResponse<{ milestones: PlannedMilestone[]; assignments: RoadmapAssignment[] }>(result.stdout);
  } catch (err) {
    log.error(`Failed to parse roadmap JSON: ${(err as Error).message}`);
    log.error(`Agent response (first 500 chars): ${result.stdout.slice(0, 500)}`);
    return;
  }

  if (!parsed.milestones || !parsed.assignments || parsed.assignments.length === 0) {
    log.info('Agent returned no roadmap assignments.');
    return;
  }

  // ── Display roadmap ────────────────────────────────────────────────────────
  const existingTitles = existingMilestones.map((m) => m.title);
  console.log('');
  console.log(formatRoadmapTable(parsed.milestones, parsed.assignments, existingTitles));
  console.log('');

  const newMilestones = parsed.milestones.filter((m) => !existingTitles.includes(m.title));
  log.info(`${newMilestones.length} new milestone(s), ${parsed.assignments.length} assignment(s)`);

  // ── Dry run exit ───────────────────────────────────────────────────────────
  if (options.dryRun) {
    log.dry('Dry run — no changes will be made.');
    return;
  }

  // ── Interactive review ─────────────────────────────────────────────────────
  let selectedNums: number[];

  if (options.yes) {
    selectedNums = parsed.assignments.filter((a) => a.selected).map((a) => a.issueNum);
    log.info(`--yes: applying all ${selectedNums.length} milestone assignment(s)`);
  } else {
    const choices = parsed.assignments.map((a) => {
      const current = a.currentMilestone || 'unassigned';
      return {
        name: `#${a.issueNum} ${a.title} → ${a.milestone} [currently: ${current}]`,
        value: a.issueNum,
        checked: a.selected,
      };
    });

    selectedNums = await checkbox({
      message: 'Select assignments to apply:',
      choices,
    });

    if (selectedNums.length === 0) {
      log.info('No assignments selected.');
      return;
    }

    const proceed = await confirm({
      message: `Create ${newMilestones.length} milestone(s) and assign ${selectedNums.length} issue(s)?`,
    });

    if (!proceed) {
      log.info('Cancelled.');
      return;
    }
  }

  // ── Execute ────────────────────────────────────────────────────────────────
  const failures: string[] = [];

  // Create new milestones and build title → number map
  const milestoneNumMap = new Map<string, number>();

  // Seed map with existing milestones
  for (const m of existingMilestones) {
    milestoneNumMap.set(m.title, m.number);
  }

  // Create new milestones
  let milestonesCreated = 0;
  for (const ms of newMilestones) {
    try {
      const num = createMilestone(config.repo, ms.title, ms.description, ms.dueOn ?? undefined);
      if (num > 0) {
        milestoneNumMap.set(ms.title, num);
        milestonesCreated++;
        log.success(`Created milestone: ${ms.title}`);
      } else {
        failures.push(`Milestone "${ms.title}": creation returned 0`);
      }
    } catch (err) {
      failures.push(`Milestone "${ms.title}": ${(err as Error).message}`);
    }
  }

  // Assign issues to milestones
  let assigned = 0;
  for (const assignment of parsed.assignments) {
    if (!selectedNums.includes(assignment.issueNum)) continue;

    if (!milestoneNumMap.has(assignment.milestone)) {
      failures.push(`#${assignment.issueNum}: milestone "${assignment.milestone}" not found`);
      continue;
    }

    try {
      setIssueMilestone(config.repo, assignment.issueNum, assignment.milestone);
      assigned++;
    } catch (err) {
      failures.push(`#${assignment.issueNum}: ${(err as Error).message}`);
    }
  }

  // Add untracked issues to project board if configured
  if (config.project > 0) {
    for (const assignment of parsed.assignments) {
      if (!selectedNums.includes(assignment.issueNum)) continue;
      try {
        addIssueToProject(config.repoOwner, config.project, config.repo, assignment.issueNum);
      } catch {
        // Project board add is best-effort
      }
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  log.success(`Created ${milestonesCreated} milestone(s), assigned ${assigned} issue(s)`);

  if (failures.length > 0) {
    console.log('');
    log.warn(`${failures.length} operation(s) failed:`);
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }
}
