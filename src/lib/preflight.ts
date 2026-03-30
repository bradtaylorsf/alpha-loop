import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, type ExecResult } from './shell.js';

export interface PreflightConfig {
  testCommand: string;
  skipPreflight?: boolean;
  skipTests?: boolean;
  dryRun?: boolean;
}

export interface PreflightResult {
  passed: boolean;
  preExistingFailures: string[];
  ignoreFile?: string;
}

const SKIP_RESULT: PreflightResult = { passed: true, preExistingFailures: [] };

/**
 * Run preflight test validation.
 * If tests fail, records pre-existing failures so they can be ignored during issue processing.
 * Returns list of pre-existing failures to ignore.
 */
export async function runPreflight(
  config: PreflightConfig,
  executor: (cmd: string) => Promise<ExecResult> = exec,
): Promise<PreflightResult> {
  if (config.skipPreflight || config.skipTests) {
    return SKIP_RESULT;
  }

  if (config.dryRun) {
    return SKIP_RESULT;
  }

  const result = await executor(config.testCommand);

  // Tests passed
  if (result.exitCode === 0) {
    return { passed: true, preExistingFailures: [] };
  }

  // Tests failed — parse output for failing test names
  const output = result.stdout + '\n' + result.stderr;
  const failures = parseFailingTests(output);

  // Save ignore file
  const ignoreFile = saveIgnoreFile(failures, output);

  return {
    passed: false,
    preExistingFailures: failures,
    ignoreFile,
  };
}

/**
 * Parse test output for failing test names.
 * Supports Jest (● suite › test) and Vitest (❌) formats.
 */
export function parseFailingTests(output: string): string[] {
  const lines = output.split('\n');
  const failures: string[] = [];

  // Jest format: lines starting with ● (with optional leading whitespace)
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('●')) {
      failures.push(trimmed);
    }
  }

  // Vitest format: lines starting with ❌
  if (failures.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('❌')) {
        failures.push(trimmed);
      }
    }
  }

  // Fallback: FAIL lines for file-level info
  if (failures.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('FAIL ')) {
        failures.push(trimmed);
      }
    }
  }

  return failures;
}

function saveIgnoreFile(failures: string[], rawOutput: string): string {
  const filePath = join(tmpdir(), `preflight-ignore-${Date.now()}`);
  const content: string[] = [...failures];

  // Also extract FAIL file paths as fallback
  const failLines = rawOutput.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('FAIL '))
    .map((l) => l.replace(/^FAIL\s+/, ''));

  for (const f of failLines) {
    if (!content.includes(f)) {
      content.push(f);
    }
  }

  writeFileSync(filePath, content.join('\n') + '\n', 'utf-8');
  return filePath;
}
