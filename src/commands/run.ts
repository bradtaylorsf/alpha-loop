/**
 * Run Command — the main loop: poll issues, process them, finalize session.
 * Port of loop.sh's main() function.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../lib/logger.js';
import { exec } from '../lib/shell.js';
import { loadConfig, type Config } from '../lib/config.js';
import { pollIssues } from '../lib/github.js';
import { processIssue } from '../lib/pipeline.js';
import { createSession, finalizeSession, type SessionContext } from '../lib/session.js';
import { cleanupWorktree } from '../lib/worktree.js';

export type RunOptions = {
  once?: boolean;
  dryRun?: boolean;
  model?: string;
  skipTests?: boolean;
  skipReview?: boolean;
  skipLearn?: boolean;
  autoMerge?: boolean;
  mergeTo?: string;
};

/**
 * Check that required CLI tools are installed.
 */
function checkPrerequisites(): void {
  const tools = [
    { name: 'gh', message: 'GitHub CLI not found. Install: https://cli.github.com/' },
    { name: 'git', message: 'git not found.' },
    { name: 'claude', message: 'Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code' },
  ];

  for (const tool of tools) {
    const result = exec(`which ${tool.name}`);
    if (result.exitCode !== 0) {
      log.error(tool.message);
      process.exit(1);
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
  console.error(`  Max Turns:      ${BOLD}${config.maxTurns}${NC}`);
  console.error(`  Base Branch:    ${BOLD}${config.baseBranch}${NC}`);
  console.error(`  Label:          ${BOLD}${config.labelReady}${NC}`);
  console.error(`  Poll Interval:  ${BOLD}${config.pollInterval}s${NC}`);
  console.error(`  Dry Run:        ${BOLD}${config.dryRun}${NC}`);
  console.error(`  Skip Tests:     ${BOLD}${config.skipTests}${NC}`);
  console.error(`  Skip Review:    ${BOLD}${config.skipReview}${NC}`);
  console.error(`  Skip Learn:     ${BOLD}${config.skipLearn}${NC}`);
  console.error(`  Test Retries:   ${BOLD}${config.maxTestRetries}${NC}`);
  console.error(`  Auto Merge:     ${BOLD}${config.autoMerge}${NC}`);
  console.error(`  Session:        ${BOLD}${session.branch}${NC}`);
  console.error('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  if (options.autoMerge) overrides.autoMerge = true;
  if (options.mergeTo) overrides.mergeTo = options.mergeTo;

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
  checkPrerequisites();

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
    } catch {
      // Best effort finalization
    }

    const issueCount = session.results.length;
    const successCount = session.results.filter((r) => r.status === 'success').length;
    log.info(`Session complete: ${successCount}/${issueCount} issues succeeded`);
    process.exit(0);
  };

  process.on('SIGINT', () => { cleanup(); });
  process.on('SIGTERM', () => { cleanup(); });

  // Generate/refresh project context if stale
  const contextFile = join(process.cwd(), '.alpha-loop', 'context.md');
  if (!existsSync(contextFile)) {
    log.info('No project context found. Run "alpha-loop scan" to generate one.');
  }

  // Main polling loop
  let issuesProcessed = 0;

  while (true) {
    log.info(`Polling for issues labeled '${config.labelReady}'...`);

    const issues = pollIssues(config.repo, config.labelReady);

    if (issues.length === 0) {
      if (options.once) {
        log.info('No issues found. Exiting (--once mode).');
        break;
      }
      log.info(`No issues found. Sleeping ${config.pollInterval}s...`);
      await sleep(config.pollInterval * 1000);
      continue;
    }

    log.info(`Found ${issues.length} issue(s) to process`);

    for (const issue of issues) {
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
      } catch (err) {
        log.error(`Failed to process issue #${issue.number}: ${err}`);
      }

      activeIssueNum = null;
      issuesProcessed++;
    }

    if (options.once) {
      log.info(`Processed ${issuesProcessed} issue(s). Exiting (--once mode).`);
      break;
    }

    log.info(`Cycle complete. Processed ${issuesProcessed} issue(s) total. Sleeping ${config.pollInterval}s...`);
    await sleep(config.pollInterval * 1000);
  }

  // Finalize session
  await finalizeSession(session, config);

  const successCount = session.results.filter((r) => r.status === 'success').length;
  log.info(`Session complete: ${successCount}/${session.results.length} issues succeeded`);
}
