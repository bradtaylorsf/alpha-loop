import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execAsync, type ExecResult } from './shell.js';
import { exec } from './shell.js';
import { log } from './logger.js';

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
  executor: (cmd: string) => Promise<ExecResult> = execAsync,
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

/**
 * Check if configured ports are already in use on the host.
 * Warns about conflicts so the user can fix them before the agent wastes retries.
 */
export function checkPortConflicts(port: number): string[] {
  const conflicts: string[] = [];

  const result = exec(`lsof -i :${port} -P -n -sTCP:LISTEN`, { cwd: process.cwd() });
  if (result.exitCode === 0 && result.stdout.trim()) {
    const lines = result.stdout.trim().split('\n').slice(1); // skip header
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const processName = parts[0] ?? 'unknown';
      const pid = parts[1] ?? '?';
      conflicts.push(`Port ${port} in use by ${processName} (PID ${pid})`);
    }
  }

  return conflicts;
}

/**
 * Run port conflict checks for the dev server port.
 * Returns list of conflicts found. Empty = no conflicts.
 */
export function runPortCheck(port: number): string[] {
  if (!port) return [];

  const conflicts = checkPortConflicts(port);
  if (conflicts.length > 0) {
    log.warn('Port conflicts detected:');
    for (const c of conflicts) {
      log.warn(`  ${c}`);
    }
    log.warn('The verification step may fail if these ports are not freed.');
  } else {
    log.success(`Port ${port} is available`);
  }

  return conflicts;
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
