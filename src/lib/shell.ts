import { execSync, spawn } from 'node:child_process';
import * as readline from 'node:readline';

/** Run a command and return stdout. Throws on non-zero exit. */
export function exec(cmd: string, options?: { cwd?: string }): string {
  return execSync(cmd, {
    cwd: options?.cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
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
