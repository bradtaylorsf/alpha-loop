/**
 * Test Runner — execute tests in worktrees with retry support.
 */
import { appendFileSync } from 'node:fs';
import { exec } from './shell.js';
import { log } from './logger.js';
import type { Config } from './config.js';

export type TestResult = {
  passed: boolean;
  output: string;
};

/**
 * Run the configured test command in a worktree.
 * Returns structured result instead of throwing.
 */
export function runTests(worktree: string, config: Config, logFile: string): TestResult {
  if (config.skipTests) {
    log.info('Tests skipped (skipTests=true)');
    return { passed: true, output: 'Tests skipped' };
  }

  if (config.dryRun) {
    log.dry('Would run tests in worktree');
    return { passed: true, output: 'Tests skipped (dry run)' };
  }

  log.step(`Running tests: ${config.testCommand}`);

  const env: Record<string, string> = {};
  if (config.runFull) {
    env.RECORD_FIXTURES = 'true';
  }

  const result = exec(config.testCommand, {
    cwd: worktree,
    env: Object.keys(env).length > 0 ? env : undefined,
    timeout: 300_000, // 5 minute timeout
  });

  // Append test output to log file
  if (logFile) {
    try {
      appendFileSync(logFile, `\n--- Test Output ---\n${result.stdout}\n${result.stderr}\n`);
    } catch {
      // Log file write failure is non-fatal
    }
  }

  const output = result.stdout + (result.stderr ? `\n${result.stderr}` : '');

  if (result.exitCode === 0) {
    log.success('All tests passed');
    return { passed: true, output };
  }

  log.warn(`Tests failed (exit code ${result.exitCode})`);
  return { passed: false, output };
}

/**
 * Run E2E tests (Playwright or similar).
 */
export function runE2eTests(worktree: string, logFile: string): TestResult {
  log.step('Running E2E tests...');

  const result = exec('pnpm test:e2e', {
    cwd: worktree,
    timeout: 600_000, // 10 minute timeout
  });

  const output = result.stdout + (result.stderr ? `\n${result.stderr}` : '');

  if (logFile) {
    try {
      appendFileSync(logFile, `\n--- E2E Test Output ---\n${output}\n`);
    } catch {
      // Non-fatal
    }
  }

  if (result.exitCode === 0) {
    log.success('E2E tests passed');
    return { passed: true, output };
  }

  log.warn('E2E tests failed');
  return { passed: false, output };
}
