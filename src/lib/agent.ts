/**
 * Agent Runner — spawn AI agents with real-time output streaming.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import * as logger from './logger.js';

export type AgentResult = {
  exitCode: number;
  output: string;
  duration: number;
};

export type AgentOptions = {
  agent: 'claude' | 'codex' | 'opencode';
  model: string;
  prompt: string;
  cwd: string;
  logFile?: string;
  verbose?: boolean;
};

/**
 * Build CLI command and args for a given agent type.
 */
export function buildAgentArgs(options: AgentOptions): { command: string; args: string[] } {
  switch (options.agent) {
    case 'claude': {
      const args = [
        '-p',
        '--model', options.model,
        '--dangerously-skip-permissions',
        '--verbose',
        '--output-format', 'text',
      ];
      // Note: --max-turns intentionally omitted. Let the agent finish naturally.
      // The harness controls retry limits via maxTestRetries, not agent turn limits.
      return { command: 'claude', args };
    }
    case 'codex': {
      const args = [
        '-q',
        '--model', options.model,
        '--auto-edit',
      ];
      return { command: 'codex', args };
    }
    case 'opencode': {
      const args = [
        'run',
        '--model', options.model,
      ];
      return { command: 'opencode', args };
    }
    default:
      throw new Error(`Unknown agent type: ${options.agent}`);
  }
}

/**
 * Spawn an AI agent with a prompt.
 * Streams output to terminal in real-time while capturing it.
 */
export async function spawnAgent(options: AgentOptions): Promise<AgentResult> {
  const { command, args } = buildAgentArgs(options);

  logger.info(`Agent: ${options.agent} | Model: ${options.model} | CWD: ${options.cwd}`);

  const startTime = Date.now();
  const chunks: string[] = [];
  let logStream: WriteStream | undefined;

  if (options.logFile) {
    logStream = createWriteStream(options.logFile, { flags: 'w' });
  }

  return new Promise<AgentResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Pipe prompt via stdin (like: echo "$prompt" | claude -p)
    child.stdin.write(options.prompt);
    child.stdin.end();

    const handleData = (data: Buffer) => {
      const text = data.toString();
      chunks.push(text);
      // Stream to terminal only when verbose is enabled
      if (options.verbose) {
        process.stderr.write(data);
      }
      // Always write to log file if provided
      if (logStream) {
        logStream.write(data);
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    const finish = (exitCode: number, output: string) => {
      const duration = Date.now() - startTime;
      if (logStream) {
        logStream.end(() => {
          resolve({ exitCode, output, duration });
        });
      } else {
        resolve({ exitCode, output, duration });
      }
    };

    child.on('close', (code) => {
      finish(code ?? 1, chunks.join(''));
    });

    child.on('error', (err) => {
      finish(1, `Failed to spawn ${command}: ${err.message}`);
    });
  });
}
