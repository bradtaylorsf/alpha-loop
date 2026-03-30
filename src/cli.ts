#!/usr/bin/env node
import { program } from 'commander';
import { initCommand } from './commands/init.js';
import { historyCommand } from './commands/history.js';
import { scanCommand } from './commands/scan.js';
import { visionCommand } from './commands/vision.js';
import { authCommand } from './commands/auth.js';

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
  .description('Run the loop')
  .option('--once', 'Process one issue and exit')
  .option('--dry-run', 'Preview without changes')
  .option('--model <model>', 'AI model to use')
  .option('--skip-tests', 'Skip test execution')
  .option('--skip-review', 'Skip code review')
  .option('--skip-learn', 'Skip learning extraction')
  .option('--auto-merge', 'Auto-merge PRs to session branch')
  .option('--merge-to <branch>', 'Use existing branch instead of creating session branch')
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

program.parse();
