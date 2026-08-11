/**
 * Test Runner — execute tests in worktrees with retry support.
 */
import { appendFileSync } from 'node:fs';
import { exec, shellQuote } from './shell.js';
import { log } from './logger.js';
import type { Config } from './config.js';

/** Test runner timeout (5 minutes). */
const TEST_TIMEOUT_MS = 300_000;

export type TestResult = {
  passed: boolean;
  output: string;
};

export type TestRunOptions = {
  /** Issue-relative paths changed since this issue branch forked. */
  changedFiles?: string[];
  /** Always use testCommand, for the end-of-session quality gate. */
  forceFull?: boolean;
};

export type ResolvedTestCommand = {
  command: string;
  scope: 'full' | 'changed';
  fallbackReason?: string;
};

/** True when changed scope has a usable file-list template. */
export function isChangedTestScopeEnabled(config: Config): boolean {
  return config.testScope === 'changed'
    && (config.changedTestCommand?.trim().length ?? 0) > 0
    && Boolean(config.changedTestCommand?.includes('{files}'));
}

/** Resolve the command for a specific test invocation. */
export function resolveTestCommand(
  config: Config,
  options: TestRunOptions = {},
): ResolvedTestCommand {
  if (options.forceFull || config.testScope !== 'changed') {
    return { command: config.testCommand, scope: 'full' };
  }

  const template = config.changedTestCommand?.trim() ?? '';
  if (!template) {
    return {
      command: config.testCommand,
      scope: 'full',
      fallbackReason: 'test_scope is changed but changed_test_command is not configured; falling back to the full test_command',
    };
  }
  if (!template.includes('{files}')) {
    return {
      command: config.testCommand,
      scope: 'full',
      fallbackReason: 'changed_test_command must contain a {files} placeholder; falling back to the full test_command',
    };
  }

  const changedFiles = Array.from(new Set(
    (options.changedFiles ?? []).map((file) => file.trim()).filter(Boolean),
  ));
  if (changedFiles.length === 0) {
    return {
      command: config.testCommand,
      scope: 'full',
      fallbackReason: 'no changed files were available for changed_test_command; falling back to the full test_command',
    };
  }

  const files = changedFiles.map(shellQuote).join(' ');
  return {
    command: template.split('{files}').join(files),
    scope: 'changed',
  };
}

/**
 * Run the configured test command in a worktree.
 * Returns structured result instead of throwing.
 */
export function runTests(
  worktree: string,
  config: Config,
  logFile: string,
  options: TestRunOptions = {},
): TestResult {
  if (config.skipTests) {
    log.info('Tests skipped (skipTests=true)');
    return { passed: true, output: 'Tests skipped' };
  }

  if (config.dryRun) {
    log.dry('Would run tests in worktree');
    return { passed: true, output: 'Tests skipped (dry run)' };
  }

  const resolved = resolveTestCommand(config, options);
  if (resolved.fallbackReason) {
    log.warn(resolved.fallbackReason);
  }
  log.step(`Running tests: ${resolved.command}`);

  const env: Record<string, string> = {};
  if (config.runFull) {
    env.RECORD_FIXTURES = 'true';
  }

  const result = exec(resolved.command, {
    cwd: worktree,
    env: Object.keys(env).length > 0 ? env : undefined,
    timeout: TEST_TIMEOUT_MS,
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

// Note: Live verification (playwright-cli) is in src/lib/verify.ts
// This module only handles unit/integration test execution.
