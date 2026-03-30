/**
 * Shell execution helpers.
 * Stub for issue #74 — provides exec() used by worktree.ts and github.ts.
 */
import { execSync } from 'node:child_process';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Execute a shell command synchronously and return structured result.
 * Does not throw on non-zero exit — returns exitCode instead.
 */
export function exec(
  command: string,
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
): ExecResult {
  try {
    const stdout = execSync(command, {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      timeout: options?.timeout,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (e.stdout ?? '').toString().trim(),
      stderr: (e.stderr ?? '').toString().trim(),
      exitCode: e.status ?? 1,
    };
  }
}
