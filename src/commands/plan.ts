/**
 * Plan command — generate a full project scope (milestones + issues) from seed inputs
 * using an AI agent, then create them on GitHub.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { input, checkbox, confirm, editor } from '@inquirer/prompts';
import { loadConfig, assertSafeShellArg } from '../lib/config.js';
import { buildOneShotCommand } from '../lib/agent.js';
import { buildPlanPrompt } from '../lib/prompts.js';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import {
  extractJsonFromResponse,
  formatIssueTable,
  readSeedFiles,
  savePlanDraft,
  buildPlanningContext,
  type PlanDraft,
  type PlannedIssue,
} from '../lib/planning.js';
import {
  createMilestone,
  createIssue,
  addIssueToProject,
  listOpenIssues,
} from '../lib/github.js';

export type PlanOptions = {
  seed?: string;
  noVision?: boolean;
  dryRun?: boolean;
};

export async function planCommand(options: PlanOptions): Promise<void> {
  // ── TTY check ──────────────────────────────────────────────────────────────
  if (!process.stdin.isTTY) {
    log.info('The plan command requires an interactive terminal. Pipe a seed file with --seed instead.');
    return;
  }

  const projectDir = process.cwd();
  const config = loadConfig({ dryRun: options.dryRun });

  // ── Seed description ───────────────────────────────────────────────────────
  let seedDescription: string;
  if (options.seed) {
    const seedPath = path.resolve(projectDir, options.seed);
    try {
      seedDescription = fs.readFileSync(seedPath, 'utf-8').trim();
      log.info(`Read seed from ${options.seed}`);
    } catch {
      log.error(`Could not read seed file: ${options.seed}`);
      return;
    }
  } else {
    seedDescription = await input({
      message: 'Describe what you want to build:',
    });
    if (!seedDescription.trim()) {
      log.error('A description is required.');
      return;
    }
  }

  // ── Seed source selection ──────────────────────────────────────────────────
  const seedSources = await checkbox({
    message: 'Select seed sources to include:',
    choices: [
      { name: 'Codebase scan (project context)', value: 'codebase' },
      { name: 'Spec files (glob pattern)', value: 'specs' },
      { name: 'Existing issues (avoid duplicates)', value: 'issues' },
    ],
  });

  // ── Gather seed data ──────────────────────────────────────────────────────
  let seedFiles: Array<{ path: string; content: string }> = [];
  let existingIssues: Array<{ number: number; title: string }> = [];

  if (seedSources.includes('specs')) {
    const globPattern = await input({
      message: 'Glob pattern for spec files (e.g. docs/**/*.md):',
    });
    if (globPattern.trim()) {
      seedFiles = readSeedFiles([globPattern.trim()], projectDir);
      log.info(`Found ${seedFiles.length} spec file(s)`);
    }
  }

  if (seedSources.includes('issues')) {
    const issues = listOpenIssues(config.repo);
    existingIssues = issues.map((i) => ({ number: i.number, title: i.title }));
    log.info(`Loaded ${existingIssues.length} existing issue(s)`);
  }

  // ── Vision ─────────────────────────────────────────────────────────────────
  const contextDir = path.join(projectDir, '.alpha-loop');
  const visionFile = path.join(contextDir, 'vision.md');
  let visionContext: string | null = null;
  let projectContext: string | null = null;

  if (seedSources.includes('codebase')) {
    const ctx = buildPlanningContext(config);
    visionContext = ctx.visionContext;
    projectContext = ctx.projectContext;
    // Merge any existing issues from context if not already loaded
    if (!seedSources.includes('issues') && ctx.existingIssues.length > 0) {
      existingIssues = ctx.existingIssues.map((i) => ({ number: i.number, title: i.title }));
    }
  }

  if (!fs.existsSync(visionFile) && !options.noVision) {
    log.step('Generating project vision...');
    const visionPrompt = `Based on this project description, generate a concise project vision document (under 500 words) in markdown.\n\nDescription: ${seedDescription}\n${projectContext ? `\nTechnical context:\n${projectContext}` : ''}`;
    const safeModel = assertSafeShellArg(config.model, 'model');
    const agentCmd = buildOneShotCommand(config.agent, safeModel);
    const visionResult = exec(
      `echo ${JSON.stringify(visionPrompt)} | ${agentCmd} 2>/dev/null`,
      { cwd: projectDir, timeout: 5 * 60 * 1000 },
    );
    if (visionResult.exitCode === 0 && visionResult.stdout) {
      fs.mkdirSync(contextDir, { recursive: true });
      fs.writeFileSync(visionFile, visionResult.stdout + '\n');
      visionContext = visionResult.stdout;
      log.success('Vision saved to .alpha-loop/vision.md');
    } else {
      log.warn('Vision generation failed — continuing without vision');
    }
  } else if (fs.existsSync(visionFile) && !visionContext) {
    visionContext = fs.readFileSync(visionFile, 'utf-8');
  }

  // ── AI plan generation ─────────────────────────────────────────────────────
  log.step('Generating project plan via AI agent...');
  const planPrompt = buildPlanPrompt({
    seedDescription,
    seedFiles: seedFiles.length > 0 ? seedFiles : undefined,
    visionContext,
    projectContext,
    existingIssues: existingIssues.length > 0 ? existingIssues : undefined,
  });

  const safeModel = assertSafeShellArg(config.model, 'model');
  const agentCmd = buildOneShotCommand(config.agent, safeModel);
  const planResult = exec(
    `echo ${JSON.stringify(planPrompt)} | ${agentCmd} 2>/dev/null`,
    { cwd: projectDir, timeout: 10 * 60 * 1000 },
  );

  if (planResult.exitCode !== 0 || !planResult.stdout.trim()) {
    log.warn('Agent failed to generate a plan. Check agent configuration and try again.');
    if (planResult.stderr) log.error(planResult.stderr.slice(0, 500));
    return;
  }

  let draft: PlanDraft;
  try {
    draft = extractJsonFromResponse<PlanDraft>(planResult.stdout);
  } catch (err) {
    log.error(`Failed to parse plan JSON: ${(err as Error).message}`);
    log.error(`Agent response (first 500 chars): ${planResult.stdout.slice(0, 500)}`);
    return;
  }

  // ── Display plan ───────────────────────────────────────────────────────────
  console.log('');
  console.log(formatIssueTable(draft.issues, draft.milestones));
  console.log('');
  log.info(`Plan: ${draft.milestones.length} milestone(s), ${draft.issues.length} issue(s)`);

  // ── Dry run exit ───────────────────────────────────────────────────────────
  if (options.dryRun) {
    log.dry('Dry run — no GitHub resources will be created.');
    return;
  }

  // ── Review UX ──────────────────────────────────────────────────────────────
  const issueChoices = draft.issues.map((issue) => ({
    name: `[${issue.priority}/${issue.complexity}] ${issue.title}`,
    value: issue.id,
    checked: issue.selected,
  }));

  const selectedIds = await checkbox({
    message: 'Select issues to create:',
    choices: issueChoices,
  });

  // Update selected flags
  for (const issue of draft.issues) {
    issue.selected = selectedIds.includes(issue.id);
  }

  const selectedIssues = draft.issues.filter((i) => i.selected);

  // Offer to edit individual issue bodies
  const wantsEdit = await confirm({
    message: 'Edit any issue bodies before creating?',
    default: false,
  });

  if (wantsEdit) {
    for (const issue of selectedIssues) {
      const edited = await editor({
        message: `Edit body for: ${issue.title}`,
        default: issue.body,
      });
      issue.body = edited;
    }
  }

  const proceedConfirm = await confirm({
    message: `Create ${draft.milestones.length} milestone(s) and ${selectedIssues.length} issue(s) on GitHub?`,
  });

  if (!proceedConfirm) {
    log.info('Cancelled.');
    return;
  }

  // ── Save draft for recovery ────────────────────────────────────────────────
  savePlanDraft(draft, projectDir);
  log.info('Plan saved to .alpha-loop/plan.json');

  // ── GitHub execution ───────────────────────────────────────────────────────
  const failures: string[] = [];
  const totalOps = draft.milestones.length + selectedIssues.length;
  const needsDelay = totalOps > 10;

  // Create milestones
  const milestoneMap = new Map<string, number>();
  for (const ms of draft.milestones) {
    try {
      const msNum = createMilestone(
        config.repo,
        ms.title,
        ms.description,
        ms.dueOn ?? undefined,
      );
      if (msNum > 0) {
        milestoneMap.set(ms.title, msNum);
        log.success(`Created milestone: ${ms.title}`);
      } else {
        failures.push(`Milestone "${ms.title}": creation returned 0`);
      }
    } catch (err) {
      failures.push(`Milestone "${ms.title}": ${(err as Error).message}`);
    }
    if (needsDelay) await delay(100);
  }

  // Create issues
  const createdIssues: Array<{ num: number; title: string }> = [];
  for (const issue of selectedIssues) {
    try {
      const milestoneNum = milestoneMap.get(issue.milestone);
      const labels = [...issue.labels];
      if (config.labelReady && !labels.includes(config.labelReady)) {
        labels.push(config.labelReady);
      }
      const issueNum = createIssue(
        config.repo,
        issue.title,
        issue.body,
        labels,
        milestoneNum,
      );
      if (issueNum > 0) {
        createdIssues.push({ num: issueNum, title: issue.title });
        log.success(`Created issue #${issueNum}: ${issue.title}`);

        // Add to project board if configured
        if (config.project > 0) {
          try {
            addIssueToProject(config.repoOwner, config.project, config.repo, issueNum);
          } catch (err) {
            failures.push(`Add #${issueNum} to project: ${(err as Error).message}`);
          }
        }
      } else {
        failures.push(`Issue "${issue.title}": creation returned 0`);
      }
    } catch (err) {
      failures.push(`Issue "${issue.title}": ${(err as Error).message}`);
    }
    if (needsDelay) await delay(100);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  log.success(`Created ${milestoneMap.size} milestone(s) and ${createdIssues.length} issue(s)`);
  for (const ci of createdIssues) {
    console.log(`  https://github.com/${config.repo}/issues/${ci.num}  ${ci.title}`);
  }

  if (failures.length > 0) {
    console.log('');
    log.warn(`${failures.length} operation(s) failed:`);
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
