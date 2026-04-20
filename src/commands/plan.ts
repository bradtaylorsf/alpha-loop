/**
 * Plan command — generate a full project scope (milestones + issues) from seed inputs
 * using an AI agent, then create them on GitHub.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { input, checkbox, confirm, editor } from '@inquirer/prompts';
import { loadConfig, assertSafeShellArg } from '../lib/config.js';
import { buildOneShotCommand } from '../lib/agent.js';
import { buildPlanPrompt } from '../lib/prompts.js';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import { getRateLimitStatus } from '../lib/rate-limit.js';
import {
  extractJsonFromResponse,
  formatIssueTable,
  normalizePlanMilestones,
  readSeedFiles,
  savePlanDraft,
  loadPlanDraft,
  buildPlanningContext,
  type PlanDraft,
  type PlannedIssue,
} from '../lib/planning.js';
import {
  createMilestone,
  createIssue,
  addIssueToProject,
  listOpenIssues,
  listMilestones,
  listLabels,
  createLabel,
} from '../lib/github.js';

export type PlanOptions = {
  seed?: string;
  vision?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  resume?: boolean;
};

export async function planCommand(options: PlanOptions): Promise<void> {
  // ── TTY check ──────────────────────────────────────────────────────────────
  if (!process.stdin.isTTY && !options.yes && !options.resume) {
    log.info('The plan command requires an interactive terminal. Use --seed with --yes for non-interactive mode.');
    return;
  }

  const projectDir = process.cwd();
  const config = loadConfig({ dryRun: options.dryRun });

  let draft: PlanDraft;
  let selectedIssues: PlannedIssue[];

  if (options.resume) {
    // ── Resume from saved draft ───────────────────────────────────────────────
    const saved = loadPlanDraft(projectDir);
    if (!saved) {
      log.error('No saved plan found at .alpha-loop/plan.json — nothing to resume.');
      return;
    }
    draft = saved;
    log.success(`Resumed plan: ${draft.milestones.length} milestone(s), ${draft.issues.length} issue(s)`);
    console.log('');
    console.log(formatIssueTable(draft.issues, draft.milestones));
    console.log('');

    if (options.dryRun) {
      log.dry('Dry run — no GitHub resources will be created.');
      return;
    }

    if (options.yes) {
      selectedIssues = draft.issues.filter((i) => i.selected);
      log.info(`--yes: selecting ${selectedIssues.length} issue(s)`);
    } else {
      const issueChoices = draft.issues.map((issue) => ({
        name: `[${issue.priority}/${issue.complexity}] ${issue.title}`,
        value: issue.id,
        checked: issue.selected,
      }));

      const selectedIds = await checkbox({
        message: 'Select issues to create:',
        choices: issueChoices,
      });

      for (const issue of draft.issues) {
        issue.selected = selectedIds.includes(issue.id);
      }
      selectedIssues = draft.issues.filter((i) => i.selected);

      if (selectedIssues.length === 0) {
        log.info('No issues selected.');
        return;
      }

      const proceedConfirm = await confirm({
        message: `Create ${selectedIssues.length} issue(s) on GitHub?`,
      });

      if (!proceedConfirm) {
        log.info('Cancelled.');
        return;
      }
    }
  } else {
    // ── Normal flow: generate plan from seed ──────────────────────────────────

    // ── Seed description ─────────────────────────────────────────────────────
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
    } else if (options.yes) {
      log.error('--yes requires --seed <file> to provide a project description.');
      return;
    } else {
      seedDescription = await input({
        message: 'Describe what you want to build:',
      });
      if (!seedDescription.trim()) {
        log.error('A description is required.');
        return;
      }
    }

    // ── Seed source selection ────────────────────────────────────────────────
    const seedSources = options.yes
      ? (() => {
          log.info('--yes: selecting all seed sources (codebase, specs, issues)');
          return ['codebase', 'specs', 'issues'];
        })()
      : await checkbox({
          message: 'Select seed sources to include:',
          choices: [
            { name: 'Codebase scan (project context)', value: 'codebase' },
            { name: 'Spec files (glob pattern)', value: 'specs' },
            { name: 'Existing issues (avoid duplicates)', value: 'issues' },
          ],
        });

    // ── Gather seed data ─────────────────────────────────────────────────────
    let seedFiles: Array<{ path: string; content: string }> = [];
    let existingIssues: Array<{ number: number; title: string }> = [];

    if (seedSources.includes('specs')) {
      const globPattern = options.yes
        ? 'docs/**/*.md'
        : await input({
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

    // ── Vision ───────────────────────────────────────────────────────────────
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

    if (!fs.existsSync(visionFile) && (options.vision !== false || options.yes)) {
      if (options.yes) log.info('--yes: auto-generating vision document');
      log.step('Generating project vision...');
      const visionPrompt = `Based on this project description, generate a concise project vision document (under 500 words) in markdown.\n\nDescription: ${seedDescription}\n${projectContext ? `\nTechnical context:\n${projectContext}` : ''}`;
      const safeModel = assertSafeShellArg(config.model, 'model');
      const agentCmd = buildOneShotCommand(config.agent, safeModel);
      const visionPromptFile = path.join(os.tmpdir(), `alpha-loop-prompt-${Date.now()}`);
      fs.writeFileSync(visionPromptFile, visionPrompt, 'utf-8');
      let visionResult;
      try {
        visionResult = exec(
          `${agentCmd} < "${visionPromptFile}" 2>/dev/null`,
          { cwd: projectDir, timeout: 5 * 60 * 1000 },
        );
      } finally {
        try { fs.unlinkSync(visionPromptFile); } catch { /* cleanup best-effort */ }
      }
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

    // ── Fetch existing milestones ───────────────────────────────────────────
    log.step('Fetching existing milestones...');
    const existingMilestonesList = listMilestones(config.repo);
    log.info(`Found ${existingMilestonesList.length} existing milestone(s)`);
    const existingMilestonesForPrompt = existingMilestonesList.map((m) => ({
      title: m.title,
      description: m.description,
      openIssues: m.openIssues,
    }));

    // ── AI plan generation ───────────────────────────────────────────────────
    log.step('Generating project plan via AI agent...');
    const planPrompt = buildPlanPrompt({
      seedDescription,
      seedFiles: seedFiles.length > 0 ? seedFiles : undefined,
      visionContext,
      projectContext,
      existingIssues: existingIssues.length > 0 ? existingIssues : undefined,
      existingMilestones: existingMilestonesForPrompt.length > 0 ? existingMilestonesForPrompt : undefined,
    });

    const safeModel = assertSafeShellArg(config.model, 'model');
    const agentCmd = buildOneShotCommand(config.agent, safeModel);
    const planPromptFile = path.join(os.tmpdir(), `alpha-loop-prompt-${Date.now()}`);
    fs.writeFileSync(planPromptFile, planPrompt, 'utf-8');
    let planResult;
    try {
      planResult = exec(
        `${agentCmd} < "${planPromptFile}" 2>/dev/null`,
        { cwd: projectDir, timeout: 10 * 60 * 1000 },
      );
    } finally {
      try { fs.unlinkSync(planPromptFile); } catch { /* cleanup best-effort */ }
    }

    if (planResult.exitCode !== 0 || !planResult.stdout.trim()) {
      log.error('Agent failed to generate a plan. Check agent configuration and try again.');
      if (planResult.stderr) log.error(planResult.stderr.slice(0, 500));
      return;
    }

    try {
      draft = extractJsonFromResponse<PlanDraft>(planResult.stdout);
    } catch (err) {
      log.error(`Failed to parse plan JSON: ${(err as Error).message}`);
      log.error(`Agent response (first 500 chars): ${planResult.stdout.slice(0, 500)}`);
      return;
    }

    // Normalize milestone titles to use 3-digit zero-padded prefixes
    draft = normalizePlanMilestones(draft);

    // ── Display plan ─────────────────────────────────────────────────────────
    console.log('');
    console.log(formatIssueTable(draft.issues, draft.milestones));
    console.log('');
    log.info(`Plan: ${draft.milestones.length} milestone(s), ${draft.issues.length} issue(s)`);

    // ── Dry run exit ─────────────────────────────────────────────────────────
    if (options.dryRun) {
      log.dry('Dry run — no GitHub resources will be created.');
      return;
    }

    // ── Review UX ────────────────────────────────────────────────────────────
    if (options.yes) {
      selectedIssues = draft.issues;
      log.info(`--yes: selecting all ${selectedIssues.length} issue(s)`);
      log.info('--yes: skipping body editing');
      log.info(`--yes: creating ${draft.milestones.length} milestone(s) and ${selectedIssues.length} issue(s)`);
    } else {
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

      selectedIssues = draft.issues.filter((i) => i.selected);

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
    }

    // ── Save draft for recovery ──────────────────────────────────────────────
    savePlanDraft(draft, projectDir);
    log.info('Plan saved to .alpha-loop/plan.json');
  }

  // ── GitHub execution (shared by normal + resume paths) ────────────────────
  const failures: string[] = [];

  // Fetch existing milestones for reuse
  const existingMilestonesList = options.resume ? listMilestones(config.repo) : (
    // In the normal flow we already fetched these above, but the variable
    // is scoped inside the else block. Re-fetch here (cheap API call).
    listMilestones(config.repo)
  );
  const existingMilestoneMap = new Map(
    existingMilestonesList.map((m) => [m.title.toLowerCase(), m]),
  );

  // ── Ensure labels exist ─────────────────────────────────────────────────
  const allLabels = new Set<string>();
  for (const issue of selectedIssues) {
    for (const label of issue.labels) {
      allLabels.add(label);
    }
  }
  if (config.labelReady) {
    allLabels.add(config.labelReady);
  }

  if (allLabels.size > 0) {
    log.step('Checking labels...');
    const existingLabels = new Set(listLabels(config.repo).map((l) => l.toLowerCase()));
    const missingLabels = [...allLabels].filter((l) => !existingLabels.has(l.toLowerCase()));
    if (missingLabels.length > 0) {
      log.info(`Creating ${missingLabels.length} missing label(s): ${missingLabels.join(', ')}`);
      for (const label of missingLabels) {
        if (!createLabel(config.repo, label)) {
          failures.push(`Label "${label}": creation failed`);
        }
      }
    }
  }

  // Pre-flight budget check (only count new milestones)
  const callsPerIssue = config.project > 0 ? 2 : 1; // createIssue + optional addToProject
  const newMilestoneCount = draft.milestones.filter(
    (ms) => !existingMilestoneMap.has(ms.title.toLowerCase()),
  ).length;
  const estimatedCost = newMilestoneCount + (selectedIssues.length * callsPerIssue);
  const budget = getRateLimitStatus();
  if (estimatedCost > budget.remaining) {
    const resetDate = new Date(budget.resetAt * 1000);
    log.rate(`Budget warning: need ~${estimatedCost} calls but only ${budget.remaining}/${budget.limit} remaining. Resets at ${resetDate.toLocaleTimeString()}`);
    log.rate('Proceeding with adaptive throttling — mutations may be delayed');
  } else {
    log.rate(`Budget OK: ~${estimatedCost} calls needed, ${budget.remaining}/${budget.limit} remaining`);
  }

  // Create milestones (reuse existing ones by title match)
  const availableMilestones = new Set<string>();
  for (let i = 0; i < draft.milestones.length; i++) {
    const ms = draft.milestones[i];
    const existing = existingMilestoneMap.get(ms.title.toLowerCase());
    if (existing) {
      availableMilestones.add(ms.title);
      log.success(`Reusing existing milestone ${i + 1}/${draft.milestones.length}: ${ms.title} (#${existing.number})`);
      continue;
    }
    try {
      const msNum = createMilestone(
        config.repo,
        ms.title,
        ms.description,
        ms.dueOn ?? undefined,
      );
      if (msNum > 0) {
        availableMilestones.add(ms.title);
        log.success(`Created milestone ${i + 1}/${draft.milestones.length}: ${ms.title}`);
      } else {
        failures.push(`Milestone "${ms.title}": creation returned 0`);
      }
    } catch (err) {
      failures.push(`Milestone "${ms.title}": ${(err as Error).message}`);
    }
  }

  // Create issues
  const createdIssues: Array<{ num: number; title: string }> = [];
  for (let i = 0; i < selectedIssues.length; i++) {
    const issue = selectedIssues[i];
    try {
      const milestoneTitle = availableMilestones.has(issue.milestone) ? issue.milestone : undefined;
      const labels = [...issue.labels];
      if (config.labelReady && !labels.includes(config.labelReady)) {
        labels.push(config.labelReady);
      }
      const issueNum = createIssue(
        config.repo,
        issue.title,
        issue.body,
        labels,
        milestoneTitle,
      );
      if (issueNum > 0) {
        createdIssues.push({ num: issueNum, title: issue.title });
        const rateSt = getRateLimitStatus();
        log.success(`Created issue ${i + 1}/${selectedIssues.length} #${issueNum}: ${issue.title} [rate: ${rateSt.remaining}/${rateSt.limit}]`);

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
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('');
  log.success(`Created ${availableMilestones.size} milestone(s) and ${createdIssues.length} issue(s)`);
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
