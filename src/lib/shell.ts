import { execSync as nodeExecSync, exec as nodeExec } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a shell command asynchronously. Does not throw on non-zero exit.
 */
export async function exec(cmd: string, cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    nodeExec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        exitCode: error ? (error as any).code ?? 1 : 0,
      });
    });
  });
}

/**
 * Run a shell command synchronously. Returns stdout. Throws on non-zero exit.
 */
export function execSync(cmd: string, cwd?: string): string {
  return nodeExecSync(cmd, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

/**
 * Check whether a command exists on the system PATH.
 */
export function commandExists(cmd: string): boolean {
  try {
    nodeExecSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
