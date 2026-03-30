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
  maxTurns?: number;
  logFile?: string;
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
      if (options.maxTurns) {
        args.push('--max-turns', String(options.maxTurns));
      }
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
      // Stream to terminal in real-time (tee behavior)
      process.stdout.write(data);
      // Also write to log file if provided
      if (logStream) {
        logStream.write(data);
      }
    };

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      if (logStream) {
        logStream.end();
      }
      resolve({
        exitCode: code ?? 1,
        output: chunks.join(''),
        duration,
      });
    });

    child.on('error', (err) => {
      const duration = Date.now() - startTime;
      if (logStream) {
        logStream.end();
      }
      resolve({
        exitCode: 1,
        output: `Failed to spawn ${command}: ${err.message}`,
        duration,
      });
    });
  });
}
