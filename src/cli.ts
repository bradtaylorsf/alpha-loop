#!/usr/bin/env node
import { program } from 'commander';
import { initCommand } from './commands/init.js';

program
  .name('alpha-loop')
  .description('Agent-agnostic automated development loop')
  .version('0.3.0');

program
  .command('init')
  .description('Create .alpha-loop.yaml config template')
  .action(initCommand);

program
  .command('run')
  .description('Run the loop')
  .option('--once', 'Process one issue and exit')
  .option('--dry-run', 'Preview without changes')
  .option('--model <model>', 'AI model to use', 'opus')
  .option('--skip-tests', 'Skip test execution')
  .option('--skip-review', 'Skip code review')
  .option('--skip-learn', 'Skip learning extraction')
  .option('--auto-merge', 'Auto-merge PRs to session branch')
  .option('--merge-to <branch>', 'Use existing branch instead of creating session branch')
  .action(() => {
    // Placeholder — implemented in issue #76
    console.log('Run command not yet implemented');
  });

// Future subcommands (implemented in subsequent issues):
// scan   — scan for ready issues
// history — show loop history
// auth   — authenticate with GitHub
// vision — run vision analysis

program.parse();
