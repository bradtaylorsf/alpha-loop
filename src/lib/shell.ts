/**
 * Shell execution helpers.
 */
import { execSync, spawn } from 'node:child_process';
import * as readline from 'node:readline';

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

/** Run a command with streaming output. Returns exit code. */
export function run(
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    onStdout?: (line: string) => void;
    onStderr?: (line: string) => void;
  },
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options?.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => options?.onStdout?.(line));
    }

    if (child.stderr) {
      const rl = readline.createInterface({ input: child.stderr });
      rl.on('line', (line) => options?.onStderr?.(line));
    }

    child.on('close', (code) => resolve(code ?? 1));
  });
}
