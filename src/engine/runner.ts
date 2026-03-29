import { spawn } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface AgentRunnerConfig {
  name: string;
  command: string;
  buildArgs: (options: RunOptions) => string[];
  run: (options: RunOptions) => Promise<RunResult>;
}

export interface RunOptions {
  prompt: string;
  model?: string;
  maxTurns?: number;
  permissionMode?: string;
  cwd?: string;
  logFile?: string;
  env?: Record<string, string>;
}

export interface RunResult {
  success: boolean;
  output: string;
  exitCode: number;
  duration: number;
}

export function createClaudeRunner(): AgentRunnerConfig {
  const name = 'claude';
  const command = 'claude';

  function buildArgs(options: RunOptions): string[] {
    const args = ['-p', '--output-format', 'text'];

    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.maxTurns !== undefined) {
      args.push('--max-turns', String(options.maxTurns));
    }
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }

    return args;
  }

  async function run(options: RunOptions): Promise<RunResult> {
    const args = buildArgs(options);
    const start = Date.now();

    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let logStream: ReturnType<typeof createWriteStream> | null = null;
      if (options.logFile) {
        mkdirSync(dirname(options.logFile), { recursive: true });
        logStream = createWriteStream(options.logFile, { flags: 'a' });
      }

      const chunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout.on('data', (data: Buffer) => {
        chunks.push(data);
        logStream?.write(data);
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderrChunks.push(data);
        logStream?.write(data);
      });

      proc.stdin.write(options.prompt);
      proc.stdin.end();

      proc.on('close', (code) => {
        logStream?.end();
        const exitCode = code ?? 1;
        const output = Buffer.concat(chunks).toString('utf-8');
        const duration = Date.now() - start;

        resolve({
          success: exitCode === 0,
          output,
          exitCode,
          duration,
        });
      });

      proc.on('error', (err) => {
        logStream?.end();
        const duration = Date.now() - start;

        resolve({
          success: false,
          output: err.message,
          exitCode: 1,
          duration,
        });
      });
    });
  }

  return { name, command, buildArgs, run };
}

export function createAgentRunner(config: {
  name: string;
  command: string;
  buildArgs: (options: RunOptions) => string[];
}): AgentRunnerConfig {
  async function run(options: RunOptions): Promise<RunResult> {
    const args = config.buildArgs(options);
    const start = Date.now();

    return new Promise((resolve) => {
      const proc = spawn(config.command, args, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let logStream: ReturnType<typeof createWriteStream> | null = null;
      if (options.logFile) {
        mkdirSync(dirname(options.logFile), { recursive: true });
        logStream = createWriteStream(options.logFile, { flags: 'a' });
      }

      const chunks: Buffer[] = [];

      proc.stdout.on('data', (data: Buffer) => {
        chunks.push(data);
        logStream?.write(data);
      });

      proc.stderr.on('data', (data: Buffer) => {
        logStream?.write(data);
      });

      proc.stdin.write(options.prompt);
      proc.stdin.end();

      proc.on('close', (code) => {
        logStream?.end();
        const exitCode = code ?? 1;
        const output = Buffer.concat(chunks).toString('utf-8');
        const duration = Date.now() - start;

        resolve({
          success: exitCode === 0,
          output,
          exitCode,
          duration,
        });
      });

      proc.on('error', (err) => {
        logStream?.end();
        const duration = Date.now() - start;

        resolve({
          success: false,
          output: err.message,
          exitCode: 1,
          duration,
        });
      });
    });
  }

  return { ...config, run };
}
