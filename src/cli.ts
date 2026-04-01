#!/usr/bin/env node
import { program } from 'commander';
import { initCommand } from './commands/init.js';
import { historyCommand } from './commands/history.js';
import { scanCommand } from './commands/scan.js';
import { visionCommand } from './commands/vision.js';
import { authCommand } from './commands/auth.js';
import { syncCommand, migrateToTemplates, syncAgentAssets } from './commands/sync.js';
import { loadConfig } from './lib/config.js';
import { log } from './lib/logger.js';

program
  .name('alpha-loop')
  .description('Agent-agnostic automated development loop')
  .version('1.0.0');

program
  .command('init')
  .description('Create .alpha-loop.yaml config template')
  .action(initCommand);

program
  .command('run')
  .description('Run the loop — fetches matching issues and processes them all, then exits')
  .option('--dry-run', 'Preview without changes')
  .option('--model <model>', 'AI model to use')
  .option('--skip-tests', 'Skip test execution')
  .option('--skip-review', 'Skip code review')
  .option('--skip-learn', 'Skip learning extraction')
  .option('--milestone <name>', 'Only process issues in this milestone')
  .option('--auto-merge', 'Auto-merge PRs to session branch')
  .option('--merge-to <branch>', 'Use existing branch instead of creating session branch')
  .option('--verbose', 'Stream live agent output to terminal')
  .action(async (options) => {
    const { runCommand } = await import('./commands/run.js');
    await runCommand(options);
  });

program
  .command('history [session]')
  .description('View session history')
  .option('--qa', 'Show QA checklist for session')
  .option('--clean', 'Remove old session data')
  .action(historyCommand);

program
  .command('scan')
  .description('Generate/refresh project context')
  .action(scanCommand);

program
  .command('vision')
  .description('Interactive project vision setup')
  .action(visionCommand);

program
  .command('auth')
  .description('Save authenticated browser state')
  .action(authCommand);

program
  .command('sync')
  .description('Sync .alpha-loop/templates/ to all configured harnesses')
  .option('--check', 'Check for drift without syncing (exits non-zero if drift found)')
  .action(syncCommand);

program
  .command('migrate')
  .description('Migrate legacy skills/, AGENTS.md, .claude/agents/ into .alpha-loop/templates/')
  .action(() => {
    migrateToTemplates();
    const config = loadConfig();
    if (config.harnesses.length > 0) {
      const result = syncAgentAssets(config.harnesses);
      if (result.synced) {
        log.success('Synced templates to configured harnesses');
      }
    }
  });

program
  .command('resume')
  .description('Resume stranded work — push branches, run review, open PRs')
  .option('--issue <num>', 'Only resume a specific issue number')
  .option('--session <name>', 'Resume from a specific session directory')
  .action(async (options) => {
    const { resumeCommand } = await import('./commands/resume.js');
    await resumeCommand(options);
  });

program
  .command('review')
  .description('Analyze accumulated learnings and propose self-improvements to agents, skills, and config')
  .option('--apply', 'Apply proposed changes and open a draft PR')
  .option('--session <name>', 'Only analyze learnings from a specific session')
  .action(async (options) => {
    const { reviewCommand } = await import('./commands/review.js');
    await reviewCommand(options);
  });

program.parse();
