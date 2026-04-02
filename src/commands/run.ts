/**
 * Run Command — the main loop: poll issues, process them, finalize session.
 */
import { join } from 'node:path';
import * as readline from 'node:readline';
import { log } from '../lib/logger.js';
import { exec } from '../lib/shell.js';
import { loadConfig, assertSafeShellArg, type Config } from '../lib/config.js';
import { pollIssues, listMilestones, type Milestone } from '../lib/github.js';
import { processIssue } from '../lib/pipeline.js';
import { createSession, finalizeSession, type SessionContext } from '../lib/session.js';
import { cleanupWorktree } from '../lib/worktree.js';
import { generateSessionSummary } from '../lib/learning.js';
import { hasVision } from '../lib/vision.js';
import { contextNeedsRefresh } from '../lib/context.js';
import { runPreflight } from '../lib/preflight.js';
import { syncAgentAssets, resolveHarnesses } from './sync.js';

export type RunOptions = {
  dryRun?: boolean;
  model?: string;
  milestone?: string;
  skipTests?: boolean;
  skipReview?: boolean;
  skipLearn?: boolean;
  autoMerge?: boolean;
  mergeTo?: string;
  verbose?: boolean;
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

/**
 * Show open milestones and let the user pick one, or choose "all in order".
 * Returns the milestone title to filter by, or empty string for all issues.
 */
async function pickMilestone(repo: string): Promise<string> {
  const milestones = listMilestones(repo);

  if (milestones.length === 0) {
    log.info('No open milestones found — processing all ready issues');
    return '';
  }

  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const NC = '\x1b[0m';

  console.error('');
  console.error(`${BOLD}  Open Milestones${NC}`);
  console.error('');
  console.error(`  ${BOLD}0${NC}  All issues (no milestone filter)`);
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    const progress = m.openIssues + m.closedIssues > 0
      ? `${m.closedIssues}/${m.openIssues + m.closedIssues} done`
      : 'empty';
    const due = m.dueOn ? ` · due ${m.dueOn.split('T')[0]}` : '';
    console.error(`  ${BOLD}${i + 1}${NC}  ${m.title} ${DIM}(${m.openIssues} open, ${progress}${due})${NC}`);
  }
  console.error('');

  const choice = await askChoice(`  Select milestone [0-${milestones.length}]: `, milestones.length);

  if (choice <= 0) {
    log.info('Processing all ready issues (no milestone filter)');
    return '';
  }

  const selected = milestones[choice - 1];
  log.success(`Milestone selected: ${selected.title} (${selected.openIssues} open issues)`);
  return selected.title;
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
  if (options.verbose) overrides.verbose = true;

  const config = loadConfig(overrides);

  if (!config.repo) {
    log.error('No repository configured. Run "alpha-loop init" or set repo in .alpha-loop.yaml');
    process.exit(1);
  }

  // Create session
  const session = createSession(config);

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

    // Clean up active worktree if any
    if (activeIssueNum !== null) {
      log.info(`Cleaning up worktree for issue #${activeIssueNum}...`);
      try {
        await cleanupWorktree({
          issueNum: activeIssueNum,
          projectDir: process.cwd(),
          autoCleanup: true,
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

  // Milestone selection (interactive or from config/CLI flag)
  let activeMilestone = config.milestone;
  if (!activeMilestone && !config.dryRun && process.stdin.isTTY) {
    activeMilestone = await pickMilestone(config.repo);
  }
  if (activeMilestone) {
    log.info(`Filtering issues by milestone: ${activeMilestone}`);
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

  // Fetch all matching issues
  const milestoneMsg = activeMilestone ? ` in milestone '${activeMilestone}'` : '';
  log.info(`Fetching issues${milestoneMsg}...`);

  const issues = pollIssues(config.repo, config.labelReady, 100, {
    project: config.project,
    repoOwner: config.repoOwner,
    milestone: activeMilestone || undefined,
  });

  if (issues.length === 0) {
    log.info('No issues found. Nothing to do.');
  } else {
    const issueLimit = config.maxIssues > 0 ? Math.min(issues.length, config.maxIssues) : issues.length;
    const issuesToProcess = issues.slice(0, issueLimit);

    if (config.maxIssues > 0 && issues.length > config.maxIssues) {
      log.info(`Found ${issues.length} issue(s), processing first ${issueLimit} (max_issues=${config.maxIssues})`);
    } else {
      log.info(`Found ${issuesToProcess.length} issue(s) to process`);
    }

    const sessionStartTime = Date.now();

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

  // Finalize session
  await finalizeSession(session, config);

  const successCount = session.results.filter((r) => r.status === 'success').length;
  log.info(`Session complete: ${successCount}/${session.results.length} issues succeeded`);
}
