/**
 * Run Command — the main loop: poll issues, process them, finalize session.
 */
import { join } from 'node:path';
import * as readline from 'node:readline';
import { log } from '../lib/logger.js';
import { exec } from '../lib/shell.js';
import { loadConfig, assertSafeShellArg, type Config } from '../lib/config.js';
import {
  pollIssues, listMilestones, listEpics, getEpicSubIssues, getIssueWithComments,
  getMergedPRForIssue, updateEpicChecklist, commentIssue, closeIssue, labelIssue,
  type Milestone, type Issue,
} from '../lib/github.js';
import { buildEpicSummary } from '../lib/epics.js';
import { verifyEpic } from '../lib/verify-epic.js';
import { processIssue, processBatch } from '../lib/pipeline.js';
import { createSession, finalizeSession, type SessionContext } from '../lib/session.js';
import { cleanupWorktree } from '../lib/worktree.js';
import { generateSessionSummary } from '../lib/learning.js';
import { hasVision } from '../lib/vision.js';
import { contextNeedsRefresh } from '../lib/context.js';
import { runPreflight } from '../lib/preflight.js';
import { syncAgentAssets, resolveHarnesses } from './sync.js';
import { saveCapturedCase, detectFailureStep } from '../lib/eval.js';
import { readGateResult, formatGateFindings } from '../lib/pipeline.js';
import { spawnAgent } from '../lib/agent.js';
import { buildSessionReviewPrompt } from '../lib/prompts.js';
import { writeTraceToSubdir } from '../lib/traces.js';
import { readFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { validateIssueQueue, printValidationReport, commentOnIncompleteIssues, type ValidationReport } from '../lib/validation.js';

export type RunOptions = {
  dryRun?: boolean;
  model?: string;
  milestone?: string;
  skipTests?: boolean;
  skipReview?: boolean;
  skipLearn?: boolean;
  autoMerge?: boolean;
  mergeTo?: string;
  batch?: boolean;
  batchSize?: number;
  verbose?: boolean;
  validate?: boolean;
  fix?: boolean;
  /** Force a specific epic by number, skip picker. */
  epic?: number;
  /** Skip the epic picker entirely, use flat/milestone flow. */
  noEpic?: boolean;
  /** Run only the verification pass on an existing epic. */
  verifyOnly?: number;
};

/**
 * Check that required CLI tools are installed.
 * Also warns about optional tools (playwright-cli) that improve the pipeline.
 */
function checkPrerequisites(config: Config): void {
  const AGENT_INSTALL_URLS: Record<string, string> = {
    claude: 'https://claude.ai/code',
    codex: 'https://developers.openai.com/codex/cli/reference',
    opencode: 'https://github.com/sst/opencode',
  };

  const agentUrl = AGENT_INSTALL_URLS[config.agent] ?? '';
  const agentMsg = `${config.agent} CLI not found.${agentUrl ? ` Install: ${agentUrl}` : ''}`;

  const safeAgent = assertSafeShellArg(config.agent, 'agent');

  const tools = [
    { name: 'gh', message: 'GitHub CLI not found. Install: https://cli.github.com/' },
    { name: 'git', message: 'git not found.' },
    { name: safeAgent, message: agentMsg },
  ];

  for (const tool of tools) {
    const result = exec(`command -v "${tool.name}"`);
    if (result.exitCode !== 0) {
      log.error(tool.message);
      process.exit(1);
    }
  }

  // Warn about optional playwright-cli for live verification
  if (!config.skipVerify) {
    const pwResult = exec('command -v "playwright-cli"');
    if (pwResult.exitCode !== 0) {
      log.warn('playwright-cli not installed — live verification will be skipped');
      log.warn('  Install: npm install -g @anthropic-ai/claude-code');
      log.warn('  Then run: playwright-cli install --skills');
    }
  }
}

/**
 * Print the startup banner showing all configuration.
 */
function printBanner(config: Config, session: SessionContext): void {
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[0;36m';
  const NC = '\x1b[0m';

  console.error('');
  console.error(`${BOLD}${CYAN}=====================================${NC}`);
  console.error(`${BOLD}${CYAN}  Alpha Loop${NC}`);
  console.error(`${BOLD}${CYAN}=====================================${NC}`);
  console.error('');
  console.error(`  Repo:           ${BOLD}${config.repo}${NC}`);
  console.error(`  Project:        ${BOLD}#${config.project} (${config.repoOwner})${NC}`);
  console.error(`  Model:          ${BOLD}${config.model}${NC}`);
  console.error(`  Review Model:   ${BOLD}${config.reviewModel}${NC}`);
  console.error(`  Base Branch:    ${BOLD}${config.baseBranch}${NC}`);
  console.error(`  Label:          ${BOLD}${config.labelReady}${NC}`);
  console.error(`  Dry Run:        ${BOLD}${config.dryRun}${NC}`);
  console.error(`  Skip Tests:     ${BOLD}${config.skipTests}${NC}`);
  console.error(`  Skip Review:    ${BOLD}${config.skipReview}${NC}`);
  console.error(`  Skip Learn:     ${BOLD}${config.skipLearn}${NC}`);
  console.error(`  Skip Verify:    ${BOLD}${config.skipVerify}${NC}`);
  console.error(`  Verbose:        ${BOLD}${config.verbose}${NC}`);
  console.error(`  Test Retries:   ${BOLD}${config.maxTestRetries}${NC}`);
  console.error(`  Max Issues:     ${BOLD}${config.maxIssues || 'unlimited'}${NC}`);
  console.error(`  Max Duration:   ${BOLD}${config.maxSessionDuration ? config.maxSessionDuration + 's' : 'unlimited'}${NC}`);
  console.error(`  Auto Merge:     ${BOLD}${config.autoMerge}${NC}`);
  console.error(`  Batch Mode:     ${BOLD}${config.batch}${NC}`);
  if (config.batch) {
    console.error(`  Batch Size:     ${BOLD}${config.batchSize}${NC}`);
  }
  console.error(`  Session:        ${BOLD}${session.branch}${NC}`);
  console.error('');
}

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() !== 'n');
    });
  });
}

function askChoice(prompt: string, max: number): Promise<number> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      if (isNaN(num) || num < 0 || num > max) {
        resolve(-1); // invalid
      } else {
        resolve(num);
      }
    });
  });
}

export type PickTargetResult =
  | { type: 'epic'; epicNum: number; epicTitle: string }
  | { type: 'milestone'; title: string }
  | { type: 'all' };

/**
 * Show open epics + milestones and let the user pick one, or choose "all in order".
 * Epics are listed first (they're typically what the user actually wants).
 *
 * When `preferEpics` is true and there's exactly one open epic, the picker
 * auto-selects it without prompting.
 *
 * When `hideEpics` is true, epics are not shown or auto-selected (the `--no-epic`
 * flag path).
 */
async function pickTarget(
  repo: string,
  opts: { preferEpics: boolean; hideEpics: boolean },
): Promise<PickTargetResult> {
  const epics = opts.hideEpics ? [] : listEpics(repo);
  const milestones = listMilestones(repo);

  if (epics.length === 0 && milestones.length === 0) {
    log.info('No open epics or milestones found — processing all ready issues');
    return { type: 'all' };
  }

  // preferEpics: when there's exactly one open epic and the user has opted in,
  // skip the picker and use it. This is the common case for a single-initiative repo.
  if (opts.preferEpics && epics.length === 1) {
    const only = epics[0];
    log.info(`preferEpics: auto-selecting sole open epic #${only.number}`);
    return { type: 'epic', epicNum: only.number, epicTitle: only.title };
  }

  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const NC = '\x1b[0m';

  console.error('');
  if (epics.length > 0) {
    console.error(`${BOLD}  Open Epics${NC}`);
    console.error('');
    for (let i = 0; i < epics.length; i++) {
      const e = epics[i];
      const summary = buildEpicSummary(e);
      const progress = summary.totalCount > 0
        ? `${summary.doneCount}/${summary.totalCount} done`
        : 'no sub-issues';
      console.error(`  ${BOLD}${i + 1}${NC}  ${e.title} #${e.number} ${DIM}(${progress})${NC}`);
    }
    console.error('');
  }

  if (milestones.length > 0) {
    console.error(`${BOLD}  Open Milestones${NC}`);
    console.error('');
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      const progress = m.openIssues + m.closedIssues > 0
        ? `${m.closedIssues}/${m.openIssues + m.closedIssues} done`
        : 'empty';
      const due = m.dueOn ? ` · due ${m.dueOn.split('T')[0]}` : '';
      console.error(`  ${BOLD}${epics.length + i + 1}${NC}  ${m.title} ${DIM}(${m.openIssues} open, ${progress}${due})${NC}`);
    }
    console.error('');
  }

  const total = epics.length + milestones.length;
  console.error(`  ${BOLD}0${NC}  All ready issues (no filter)`);
  console.error('');

  const choice = await askChoice(`  Select [0-${total}]: `, total);

  if (choice <= 0) {
    log.info('Processing all ready issues (no filter)');
    return { type: 'all' };
  }

  if (choice <= epics.length) {
    const selected = epics[choice - 1];
    log.success(`Epic selected: ${selected.title} (#${selected.number})`);
    return { type: 'epic', epicNum: selected.number, epicTitle: selected.title };
  }

  const milestoneIdx = choice - epics.length - 1;
  const selected = milestones[milestoneIdx];
  log.success(`Milestone selected: ${selected.title} (${selected.openIssues} open issues)`);
  return { type: 'milestone', title: selected.title };
}

/**
 * Run the verification pass on an epic: fetch sub-issues + merged PRs, evaluate
 * AC via the review model, post a summary comment, and close the epic on pass
 * (or add `needs-human-input` on partial/fail).
 *
 * Shared between the post-loop trigger and the `--verify-only` entry point.
 */
async function runEpicVerificationFlow(
  epicNum: number,
  config: Config,
  session: SessionContext | null,
): Promise<void> {
  const epic = getIssueWithComments(config.repo, epicNum);
  if (!epic) {
    log.error(`Could not fetch epic #${epicNum}`);
    return;
  }
  const refs = getEpicSubIssues(config.repo, epicNum);
  if (refs.length === 0) {
    log.warn(`Epic #${epicNum} has no sub-issues in its checklist — nothing to verify`);
    return;
  }

  const subIssues: Issue[] = [];
  const mergedPRUrls: Array<string | null> = [];
  for (const ref of refs) {
    const sub = getIssueWithComments(config.repo, ref.number);
    if (!sub) continue;
    subIssues.push(sub);
    mergedPRUrls.push(getMergedPRForIssue(config.repo, ref.number));
  }

  const logsDir = session?.logsDir
    ?? join(process.cwd(), '.alpha-loop', 'sessions', `verify-${epicNum}-${Date.now()}`, 'logs');

  if (!session) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(logsDir, { recursive: true });
  }

  const result = await verifyEpic({ epic, subIssues, mergedPRUrls }, config, logsDir);

  if (config.dryRun) {
    log.dry(`[verify-only] Would post comment on #${epicNum} (verdict=${result.verdict})`);
    console.error(result.comment);
    return;
  }

  commentIssue(config.repo, epicNum, result.comment);
  if (result.verdict === 'pass') {
    closeIssue(config.repo, epicNum, 'completed');
    log.success(`Epic #${epicNum} verified and closed`);
  } else {
    labelIssue(config.repo, epicNum, 'needs-human-input');
    log.warn(`Epic #${epicNum} needs human review: verdict=${result.verdict}`);
  }
}

/**
 * Run the main loop: poll for issues, process them, finalize session.
 */
export async function runCommand(options: RunOptions): Promise<void> {
  // Build config from YAML + env + CLI flags
  const overrides: Partial<Config> = {};
  if (options.dryRun) overrides.dryRun = true;
  if (options.model) overrides.model = options.model;
  if (options.skipTests) overrides.skipTests = true;
  if (options.skipReview) overrides.skipReview = true;
  if (options.skipLearn) overrides.skipLearn = true;
  if (options.milestone) overrides.milestone = options.milestone;
  if (options.autoMerge) overrides.autoMerge = true;
  if (options.mergeTo) overrides.mergeTo = options.mergeTo;
  if (options.batch) overrides.batch = true;
  if (options.batchSize) overrides.batchSize = options.batchSize;
  if (options.verbose) overrides.verbose = true;

  const config = loadConfig(overrides);

  if (!config.repo) {
    log.error('No repository configured. Run "alpha-loop init" or set repo in .alpha-loop.yaml');
    process.exit(1);
  }

  // --- Verify-only path: bypass the normal loop entirely ---
  if (options.verifyOnly !== undefined) {
    log.step(`Running verify-only pass for epic #${options.verifyOnly}`);
    await runEpicVerificationFlow(options.verifyOnly, config, null);
    return;
  }

  // --- Target selection (epic or milestone) — must happen before session creation ---
  let activeEpic: number | undefined;
  let activeEpicTitle: string | undefined;
  let activeMilestone = config.milestone;

  // --epic <N> overrides everything except --verify-only
  if (options.epic !== undefined) {
    const epic = getIssueWithComments(config.repo, options.epic);
    if (!epic) {
      log.error(`Could not fetch epic #${options.epic}`);
      process.exit(1);
    }
    activeEpic = epic.number;
    activeEpicTitle = epic.title;
    activeMilestone = '';
  }

  // Interactive picker when TTY and nothing preset
  if (activeEpic === undefined && !activeMilestone && !config.dryRun && process.stdin.isTTY) {
    const target = await pickTarget(config.repo, {
      preferEpics: config.preferEpics,
      hideEpics: options.noEpic === true,
    });
    if (target.type === 'epic') {
      activeEpic = target.epicNum;
      activeEpicTitle = target.epicTitle;
    } else if (target.type === 'milestone') {
      activeMilestone = target.title;
    }
  }

  if (activeEpic !== undefined) {
    log.info(`Processing epic #${activeEpic}${activeEpicTitle ? ': ' + activeEpicTitle : ''}`);
  } else if (activeMilestone) {
    log.info(`Filtering issues by milestone: ${activeMilestone}`);
  }

  // Create session (named after epic or milestone if selected)
  const session = createSession(config, {
    milestone: activeMilestone || undefined,
    epicNum: activeEpic,
    epicTitle: activeEpicTitle,
  });

  // Print startup banner
  printBanner(config, session);

  // Check prerequisites
  checkPrerequisites(config);

  // Track active worktree for cleanup on signal
  let activeIssueNum: number | null = null;

  // Handle Ctrl+C gracefully
  const cleanup = async () => {
    log.info('');
    log.info('Shutting down...');

    // Clean up active worktree if any — preserve if it has commits so work isn't lost
    if (activeIssueNum !== null) {
      log.info(`Cleaning up worktree for issue #${activeIssueNum}...`);
      try {
        await cleanupWorktree({
          issueNum: activeIssueNum,
          projectDir: process.cwd(),
          autoCleanup: true,
          preserveIfCommits: true,
        });
      } catch {
        // Best effort cleanup
      }
    }

    // Finalize session
    try {
      await finalizeSession(session, config);
    } catch (err) {
      log.error(`Session finalization failed: ${err instanceof Error ? err.message : err}`);
    }

    const issueCount = session.results.length;
    const successCount = session.results.filter((r) => r.status === 'success').length;
    log.info(`Session complete: ${successCount}/${issueCount} issues succeeded`);
    process.exit(0);
  };

  process.on('SIGINT', () => { void cleanup(); });
  process.on('SIGTERM', () => { void cleanup(); });

  // Sync agent assets to all configured harnesses before starting the loop
  const syncResult = syncAgentAssets(resolveHarnesses(config.harnesses, config.agent));
  if (syncResult.synced) {
    log.success('Agent assets synced before run');
  }

  // Pre-flight test validation
  log.step('Running pre-flight test validation...');
  const preflightResult = await runPreflight({
    testCommand: config.testCommand,
    skipPreflight: config.skipPreflight,
    skipTests: config.skipTests,
    dryRun: config.dryRun,
  });
  if (preflightResult.passed) {
    if (!config.skipPreflight && !config.skipTests && !config.dryRun) {
      log.success('Pre-flight tests passed');
    }
  } else {
    log.warn(`Pre-flight: ${preflightResult.preExistingFailures.length} pre-existing failure(s) will be ignored`);
    for (const f of preflightResult.preExistingFailures) {
      log.warn(`  ${f}`);
    }
  }

  // Prompt for project vision if it doesn't exist (interactive only)
  if (!hasVision() && process.stdin.isTTY) {
    log.warn('No project vision found. The agent will make better decisions with one.');
    const answer = await askYesNo('Set up project vision now? [Y/n]: ');
    if (answer) {
      const { visionCommand } = await import('./vision.js');
      await visionCommand();
    }
  }

  // Generate or refresh project context if needed
  if (contextNeedsRefresh()) {
    log.info('Project context is stale or missing. Generating...');
    const { scanCommand } = await import('./scan.js');
    scanCommand();
  } else {
    log.info('Project context is fresh');
  }

  // If vision or context were created/updated, commit them so worktrees get them
  if (!config.dryRun) {
    const statusResult = exec('git status --porcelain .alpha-loop/ AGENTS.md CLAUDE.md');
    if (statusResult.stdout.trim()) {
      log.info('New files generated — committing so worktrees include them...');
      exec('git add .alpha-loop/ AGENTS.md CLAUDE.md 2>/dev/null || true');
      const diffCheck = exec('git diff --cached --quiet');
      if (diffCheck.exitCode !== 0) {
        exec('git commit -m "chore: add project vision and context for alpha-loop"');
        exec(`git push origin "${config.baseBranch}"`);
        log.success('Vision and context committed to ' + config.baseBranch);
      }
    }
  }

  // --- Fetch issue queue ---
  // When an epic is selected, the queue is its sub-issues in checklist order.
  // Otherwise, fetch via the usual project/label/milestone path and exclude
  // epic-labeled issues (AC #2: epics never picked up by the normal `ready` flow).
  let issues: Issue[];
  if (activeEpic !== undefined) {
    log.info(`Fetching sub-issues of epic #${activeEpic} in checklist order...`);
    const refs = getEpicSubIssues(config.repo, activeEpic);
    issues = [];
    for (const ref of refs) {
      if (ref.checked) continue; // already done
      const sub = getIssueWithComments(config.repo, ref.number);
      if (!sub) {
        log.warn(`Sub-issue #${ref.number} skipped: could not fetch`);
        continue;
      }
      if (sub.labels.includes('epic')) {
        log.warn(`Sub-issue #${sub.number} skipped: is itself an epic (nested epics unsupported in v1)`);
        continue;
      }
      if (!sub.labels.includes(config.labelReady)) {
        log.warn(`Sub-issue #${sub.number} skipped: not labeled '${config.labelReady}'`);
        continue;
      }
      issues.push(sub);
    }
  } else {
    const milestoneMsg = activeMilestone ? ` in milestone '${activeMilestone}'` : '';
    log.info(`Fetching issues${milestoneMsg}...`);
    issues = pollIssues(config.repo, config.labelReady, 100, {
      project: config.project,
      repoOwner: config.repoOwner,
      milestone: activeMilestone || undefined,
    }).filter((iss) => !iss.labels.includes('epic'));
  }

  // When set mid-loop, skip post-loop epic verification (e.g. checklist body inconsistency).
  let epicAbort = false;

  if (issues.length === 0) {
    log.info('No issues found. Nothing to do.');
  } else {
    const issueLimit = config.maxIssues > 0 ? Math.min(issues.length, config.maxIssues) : issues.length;
    let issuesToProcess = issues.slice(0, issueLimit);

    // Pre-session validation
    if (options.validate) {
      log.step('Running pre-session validation...');
      const report: ValidationReport = validateIssueQueue(
        issuesToProcess.map((i) => ({ number: i.number, title: i.title, body: i.body })),
      );
      printValidationReport(report);

      if (options.fix) {
        // Reorder based on dependency analysis
        if (report.dependencyWarnings.length > 0) {
          const reorderedNums = report.reorderedQueue.map((i) => i.number);
          issuesToProcess = reorderedNums
            .map((num) => issuesToProcess.find((i) => i.number === num))
            .filter((i): i is typeof issuesToProcess[number] => i !== undefined);
          log.info(`Reordered queue: ${issuesToProcess.map((i) => `#${i.number}`).join(', ')}`);
        }

        // Comment on incomplete issues and skip them
        if (report.completenessWarnings.length > 0 && !config.dryRun) {
          commentOnIncompleteIssues(config.repo, report);
        }
      }

      // Skip incomplete issues only when --fix is active
      if (options.fix && report.skippedIssues.length > 0) {
        const skippedSet = new Set(report.skippedIssues);
        issuesToProcess = issuesToProcess.filter((i) => !skippedSet.has(i.number));
        log.info(`Skipped ${report.skippedIssues.length} incomplete issue(s)`);
      }

      if (issuesToProcess.length === 0) {
        log.info('No issues remaining after validation. Nothing to do.');
      }
    }

    if (config.maxIssues > 0 && issues.length > config.maxIssues) {
      log.info(`Found ${issues.length} issue(s), processing first ${issueLimit} (max_issues=${config.maxIssues})`);
    } else {
      log.info(`Found ${issuesToProcess.length} issue(s) to process`);
    }

    const sessionStartTime = Date.now();

    if (config.batch) {
      // --- Batch mode: chunk issues and process each chunk as one agent session ---
      const batchSize = config.batchSize;
      const totalBatches = Math.ceil(issuesToProcess.length / batchSize);
      log.info(`Batch mode: ${issuesToProcess.length} issues in ${totalBatches} batch(es) of up to ${batchSize}`);

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        // Check duration limit before each batch
        if (config.maxSessionDuration > 0) {
          const elapsed = Math.round((Date.now() - sessionStartTime) / 1000);
          if (elapsed >= config.maxSessionDuration) {
            log.info(`Stopping: max_session_duration reached (${elapsed}s / ${config.maxSessionDuration}s)`);
            break;
          }
        }

        const batchStart = batchIdx * batchSize;
        const batchIssues = issuesToProcess.slice(batchStart, batchStart + batchSize);
        const batchNums = batchIssues.map((i) => `#${i.number}`).join(', ');

        log.info('==========================================');
        log.info(`Batch ${batchIdx + 1}/${totalBatches}: ${batchNums} (${batchIssues.length} issues)`);
        log.info('==========================================');

        activeIssueNum = batchIssues[0].number;

        try {
          const results = await processBatch(batchIssues, config, session);
          session.results.push(...results);

          // Flip epic checklist for each successful sub-issue
          if (activeEpic !== undefined) {
            let checklistError = false;
            for (const r of results) {
              if (r.status !== 'success') continue;
              try {
                updateEpicChecklist(config.repo, activeEpic, r.issueNum, true);
              } catch (err) {
                log.error(`Epic #${activeEpic} checklist update failed for sub-issue #${r.issueNum}: ${err instanceof Error ? err.message : err}`);
                // One-agent-per-epic contract — halt further processing on body inconsistency
                epicAbort = true;
                checklistError = true;
                break;
              }
            }
            if (checklistError) {
              activeIssueNum = null;
              break;
            }
          }

          // Stop if any issue hit a transient error
          if (results.some((r) => r.failureReason === 'transient')) {
            log.warn('Agent hit a rate/usage limit — stopping session to avoid wasting cycles');
            break;
          }
        } catch (err) {
          log.error(`Failed to process batch ${batchIdx + 1}: ${err}`);
        }

        activeIssueNum = null;
      }
    } else {
      // --- Sequential mode (original behavior) ---
      for (const issue of issuesToProcess) {
        // Check duration limit before each issue
        if (config.maxSessionDuration > 0) {
          const elapsed = Math.round((Date.now() - sessionStartTime) / 1000);
          if (elapsed >= config.maxSessionDuration) {
            log.info(`Stopping: max_session_duration reached (${elapsed}s / ${config.maxSessionDuration}s)`);
            break;
          }
        }

        log.info('==========================================');
        log.info(`Processing issue #${issue.number}: ${issue.title}`);
        log.info('==========================================');

        activeIssueNum = issue.number;

        try {
          const result = await processIssue(
            issue.number,
            issue.title,
            issue.body,
            config,
            session,
          );
          session.results.push(result);

          // Flip the epic checklist box when this sub-issue succeeded
          if (activeEpic !== undefined && result.status === 'success') {
            try {
              updateEpicChecklist(config.repo, activeEpic, issue.number, true);
            } catch (err) {
              log.error(`Epic #${activeEpic} checklist update failed for sub-issue #${issue.number}: ${err instanceof Error ? err.message : err}`);
              // One-agent-per-epic contract — halt further processing on body inconsistency
              epicAbort = true;
              activeIssueNum = null;
              break;
            }
          }

          // Stop processing if agent hit a transient error (usage/rate limit)
          if (result.failureReason === 'transient') {
            log.warn('Agent hit a rate/usage limit — stopping session to avoid wasting cycles');
            break;
          }
        } catch (err) {
          log.error(`Failed to process issue #${issue.number}: ${err}`);
        }

        activeIssueNum = null;
      }
    }
  }

  // --- Epic completion check: verify and close if all sub-issues are now done ---
  if (activeEpic !== undefined && !epicAbort && !config.dryRun) {
    try {
      const remaining = getEpicSubIssues(config.repo, activeEpic).filter((r) => !r.checked);
      if (remaining.length === 0) {
        log.step(`All sub-issues of epic #${activeEpic} are complete — running verification pass`);
        await runEpicVerificationFlow(activeEpic, config, session);
      } else {
        log.info(`Epic #${activeEpic}: ${remaining.length} sub-issue(s) still open — verification deferred`);
      }
    } catch (err) {
      log.warn(`Epic completion check failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Auto-capture failures as eval case skeletons
  if (config.autoCapture && session.results.length > 0) {
    const failures = session.results.filter((r) => r.status === 'failure');
    if (failures.length > 0) {
      log.step(`Auto-capturing ${failures.length} failure(s) as eval cases...`);
      for (const failure of failures) {
        try {
          const step = detectFailureStep(failure);
          saveCapturedCase({
            issueNum: failure.issueNum,
            title: failure.title,
            step,
            session: session.name,
          });
        } catch (err) {
          log.warn(`Failed to auto-capture issue #${failure.issueNum}: ${err instanceof Error ? err.message : err}`);
        }
      }
      log.info('Run "alpha-loop eval capture" to add failure descriptions to these cases.');
    }
  }

  // Generate session summary (aggregates learnings across all issues)
  if (session.results.length > 0) {
    const learningsDir = join(process.cwd(), '.alpha-loop', 'learnings');
    await generateSessionSummary({
      sessionName: session.name,
      results: session.results,
      learningsDir,
      config,
    });
  }

  // Post-session holistic code review
  if (session.results.length > 0 && !config.skipPostSessionReview && !config.dryRun) {
    log.step('Running post-session code review...');

    const projectDir = process.cwd();

    // Ensure we're on the session branch
    exec(`git checkout "${session.branch}"`, { cwd: projectDir });

    // Get full session diff
    const diffResult = exec(`git diff "origin/${config.baseBranch}...HEAD"`, { cwd: projectDir });
    const sessionDiff = diffResult.stdout;

    if (sessionDiff.trim()) {
      // Load vision context if available
      const visionPath = join(projectDir, '.alpha-loop', 'vision.md');
      const visionContext = existsSync(visionPath) ? readFileSync(visionPath, 'utf-8') : undefined;

      const reviewFile = join(projectDir, 'review-session.json');
      const reviewFileSession = join(session.logsDir, 'review-session.json');

      for (let attempt = 1; attempt <= config.maxTestRetries; attempt++) {
        log.info(`Session review attempt ${attempt} of ${config.maxTestRetries}`);

        try {
          const reviewPrompt = buildSessionReviewPrompt({
            sessionName: session.name,
            baseBranch: config.baseBranch,
            issuesSummary: session.results.map((r) => ({
              issueNum: r.issueNum,
              title: r.title,
              status: r.status,
              testsPassing: r.testsPassing,
            })),
            includeSecurityScan: !config.skipPostSessionSecurity,
            visionContext,
          });

          // Trace review prompt
          writeTraceToSubdir(session.name, 'prompts', `session-review${attempt > 1 ? `-${attempt}` : ''}.md`, reviewPrompt);

          const reviewResult = await spawnAgent({
            agent: config.agent,
            model: config.reviewModel,
            prompt: reviewPrompt,
            cwd: projectDir,
            logFile: join(session.logsDir, `session-review${attempt > 1 ? `-${attempt}` : ''}.log`),
            verbose: config.verbose,
          });

          // Trace review output
          writeTraceToSubdir(session.name, 'outputs', `session-review${attempt > 1 ? `-${attempt}` : ''}.log`, reviewResult.output);
        } catch {
          log.warn('Session review failed, continuing without review');
          break;
        }

        // Read gate result
        const gate = readGateResult(reviewFile);

        // Move gate file to session logs
        if (existsSync(reviewFile)) {
          try { renameSync(reviewFile, reviewFileSession); } catch { /* cross-device */ }
        }

        if (gate.passed) {
          log.success(`Session review passed: ${gate.summary || 'no issues found'}`);
          session.sessionReviewFindings = gate;
          break;
        }

        // Review found unfixed issues — send to implementer
        const unfixedCount = gate.findings.filter((f) => !f.fixed).length;
        log.warn(`Session review found ${unfixedCount} unfixed issue(s)`);

        if (attempt < config.maxTestRetries) {
          const findings = formatGateFindings(gate, 'Session Review');
          const fixPrompt = `The post-session code review found problems that need to be fixed.\n\n${findings}\n\nInstructions:\n1. Address each finding listed above\n2. Run tests to make sure nothing is broken\n3. Commit your fixes with: git commit -m "fix: address session review findings"`;

          // Trace fix prompt
          writeTraceToSubdir(session.name, 'prompts', `session-review-fix-${attempt}.md`, fixPrompt);

          try {
            const fixResult = await spawnAgent({
              agent: config.agent,
              model: config.model,
              prompt: fixPrompt,
              cwd: projectDir,
              logFile: join(session.logsDir, `session-review-fix-${attempt}.log`),
              verbose: config.verbose,
            });

            // Trace fix output
            writeTraceToSubdir(session.name, 'outputs', `session-review-fix-${attempt}.log`, fixResult.output);

            // Auto-commit if agent left changes
            const fixStatus = exec('git status --porcelain', { cwd: projectDir });
            if (fixStatus.stdout.trim()) {
              exec('git add -A', { cwd: projectDir });
              exec('git commit -m "fix: address session review findings"', { cwd: projectDir });
            }
          } catch {
            log.warn('Session review fix failed, continuing');
          }
        } else {
          log.warn('Session review: max attempts reached, continuing with unfixed findings');
          session.sessionReviewFindings = gate;
        }
      }

      // Clean up gate file if it wasn't moved
      if (existsSync(reviewFile)) {
        try { unlinkSync(reviewFile); } catch { /* ignore */ }
      }
    } else {
      log.info('No changes in session diff, skipping session review');
    }
  } else if (config.skipPostSessionReview) {
    log.info('Post-session review skipped');
  }

  // Finalize session
  await finalizeSession(session, config);

  const successCount = session.results.filter((r) => r.status === 'success').length;
  log.info(`Session complete: ${successCount}/${session.results.length} issues succeeded`);
}
