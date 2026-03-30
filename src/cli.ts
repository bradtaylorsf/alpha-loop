#!/usr/bin/env node

import { Command } from 'commander';
import { historyCommand } from './commands/history.js';
import { scanCommand } from './commands/scan.js';
import { visionCommand } from './commands/vision.js';
import { authCommand } from './commands/auth.js';

const program = new Command();

program
  .name('alpha-loop')
  .description('Agent-agnostic automated development loop: Plan -> Build -> Test -> Review -> Ship')
  .version('0.2.0');

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
