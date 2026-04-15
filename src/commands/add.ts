/**
 * Add command — create a single GitHub issue from a free-form description
 * using AI to generate title, body, labels, and milestone assignment.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { input, select, editor } from '@inquirer/prompts';
import { loadConfig, assertSafeShellArg } from '../lib/config.js';
import { buildOneShotCommand } from '../lib/agent.js';
import { buildAddPrompt } from '../lib/prompts.js';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import { extractJsonFromResponse, buildPlanningContext } from '../lib/planning.js';
import {
  listMilestones,
  listLabels,
  createIssue,
  createMilestone,
  addIssueToProject,
} from '../lib/github.js';

export type AddOptions = {
  seed?: string;
  milestone?: string;
  dryRun?: boolean;
  yes?: boolean;
};

type AddIssueProposal = {
  title: string;
  body: string;
  labels: string[];
  milestone: {
    title: string;
    description?: string;
    isNew: boolean;
  };
};

export async function addCommand(options: AddOptions): Promise<void> {
  const config = loadConfig({ dryRun: options.dryRun });

  // ── Input ──────────────────────────────────────────────────────────────────
  let description: string;

  if (options.seed) {
    try {
      description = readFileSync(options.seed, 'utf-8').trim();
    } catch (err) {
      log.error(`Could not read seed file: ${(err as Error).message}`);
      return;
    }
  } else if (!process.stdin.isTTY && !options.yes) {
    log.info('The add command requires an interactive terminal. Use --seed with --yes for non-interactive mode.');
    return;
  } else {
    description = await input({
      message: 'Describe the issue (bug, feature, task, etc.):',
    });
  }

  if (!description.trim()) {
    log.error('Please provide a description.');
    return;
  }

  // ── Context gathering ──────────────────────────────────────────────────────
  log.step('Gathering project context...');
  const milestones = listMilestones(config.repo);
  const existingLabels = listLabels(config.repo);
  const ctx = buildPlanningContext(config);

  // ── AI generation ──────────────────────────────────────────────────────────
  log.step('Generating issue via AI agent...');
  const prompt = buildAddPrompt({
    description,
    milestones: milestones.map((m) => ({
      title: m.title,
      description: m.description,
      openIssues: m.openIssues,
    })),
    projectContext: ctx.projectContext,
    existingLabels,
  });

  const safeModel = assertSafeShellArg(config.model, 'model');
  const agentCmd = buildOneShotCommand(config.agent, safeModel);
  const promptFile = join(tmpdir(), `alpha-loop-prompt-${Date.now()}`);
  writeFileSync(promptFile, prompt, 'utf-8');

  let result;
  try {
    result = exec(
      `${agentCmd} < "${promptFile}" 2>/dev/null`,
      { cwd: process.cwd(), timeout: 5 * 60 * 1000 },
    );
  } finally {
    try { unlinkSync(promptFile); } catch { /* cleanup best-effort */ }
  }

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    log.error('Agent failed to generate issue. Check agent configuration and try again.');
    if (result.stderr) log.error(result.stderr.slice(0, 500));
    return;
  }

  let proposal: AddIssueProposal;
  try {
    proposal = extractJsonFromResponse<AddIssueProposal>(result.stdout);
  } catch (err) {
    log.error(`Failed to parse AI response: ${(err as Error).message}`);
    log.error(`Agent response (first 500 chars): ${result.stdout.slice(0, 500)}`);
    return;
  }

  if (!proposal.title || !proposal.body || !proposal.milestone?.title) {
    log.error('AI response missing required fields (title, body, milestone). Try again.');
    return;
  }

  // ── Apply --milestone override ─────────────────────────────────────────────
  if (options.milestone) {
    const existing = milestones.find(
      (m) => m.title.toLowerCase() === options.milestone!.toLowerCase(),
    );
    proposal.milestone = {
      title: options.milestone,
      description: existing?.description ?? '',
      isNew: !existing,
    };
  }

  // ── Display proposal ──────────────────────────────────────────────────────
  const milestoneTag = proposal.milestone.isNew ? '(NEW)' : '(existing)';
  console.log('');
  log.step('Proposed Issue:');
  console.log(`  Title:      ${proposal.title}`);
  console.log(`  Labels:     ${proposal.labels.join(', ')}`);
  console.log(`  Milestone:  ${proposal.milestone.title} ${milestoneTag}`);
  console.log('');
  console.log('  Body:');
  for (const line of proposal.body.split('\n').slice(0, 20)) {
    console.log(`    ${line}`);
  }
  if (proposal.body.split('\n').length > 20) {
    console.log('    ...(truncated)');
  }
  console.log('');

  // ── Dry run exit ──────────────────────────────────────────────────────────
  if (options.dryRun) {
    log.dry('Dry run — no changes will be made.');
    return;
  }

  // ── Interactive review ─────────────────────────────────────────────────────
  if (!options.yes) {
    // Milestone confirmation
    if (!options.milestone) {
      const milestoneChoice = await select({
        message: `Milestone: "${proposal.milestone.title}" ${milestoneTag}. Accept?`,
        choices: [
          { name: 'Yes, use this milestone', value: 'accept' },
          { name: 'Pick a different milestone', value: 'pick' },
          { name: 'Create a new milestone', value: 'new' },
        ],
      });

      if (milestoneChoice === 'pick') {
        if (milestones.length === 0) {
          log.warn('No existing milestones to pick from. Keeping AI suggestion.');
        } else {
          const picked = await select({
            message: 'Select a milestone:',
            choices: milestones.map((m) => ({
              name: `${m.title} (${m.openIssues} open)`,
              value: m.title,
            })),
          });
          proposal.milestone = { title: picked, isNew: false };
        }
      } else if (milestoneChoice === 'new') {
        const newTitle = await input({ message: 'New milestone title:' });
        const newDesc = await input({ message: 'Milestone description (optional):' });
        proposal.milestone = { title: newTitle, description: newDesc || undefined, isNew: true };
      }
    }

    // Offer to edit the body
    const editChoice = await select({
      message: 'Issue body:',
      choices: [
        { name: 'Looks good, create it', value: 'create' },
        { name: 'Edit body in editor', value: 'edit' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });

    if (editChoice === 'cancel') {
      log.info('Cancelled.');
      return;
    }

    if (editChoice === 'edit') {
      proposal.body = await editor({
        message: 'Edit issue body:',
        default: proposal.body,
      });
    }
  }

  // ── Create resources ──────────────────────────────────────────────────────
  log.step('Creating issue on GitHub...');

  // Create milestone if new
  if (proposal.milestone.isNew) {
    const msNum = createMilestone(
      config.repo,
      proposal.milestone.title,
      proposal.milestone.description ?? '',
    );
    if (msNum > 0) {
      log.success(`Created milestone: ${proposal.milestone.title}`);
    } else {
      log.warn(`Failed to create milestone "${proposal.milestone.title}". Issue will be created without milestone.`);
      proposal.milestone.isNew = false;
      proposal.milestone.title = '';
    }
  }

  // Create the issue
  const milestoneArg = proposal.milestone.title || undefined;
  const issueNum = createIssue(config.repo, proposal.title, proposal.body, proposal.labels, milestoneArg);

  if (issueNum === 0) {
    log.error('Failed to create issue. Check GitHub permissions and try again.');
    return;
  }

  log.success(`Created issue #${issueNum}: ${proposal.title}`);
  console.log(`  https://github.com/${config.repo}/issues/${issueNum}`);

  // Add to project board if configured
  if (config.project && config.project > 0) {
    addIssueToProject(config.repoOwner, config.project, config.repo, issueNum);
    log.info('Added to project board');
  }
}
