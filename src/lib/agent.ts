/**
 * Agent Runner — spawn AI agents with real-time output streaming.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { log } from './logger.js';

export type AgentResult = {
  exitCode: number;
  output: string;
  duration: number;
};

/** Default agent timeout: 30 minutes */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

export type AgentOptions = {
  agent: 'claude' | 'codex' | 'opencode';
  model: string;
  prompt: string;
  cwd: string;
  logFile?: string;
  verbose?: boolean;
  /** Timeout in milliseconds. Defaults to 30 minutes. */
  timeout?: number;
  /** Max conversation turns for the agent. Only supported by claude. */
  maxTurns?: number;
  /** Resume the most recent agent session in the CWD instead of starting fresh. */
  resume?: boolean;
};

/**
 * Build CLI command and args for a given agent type.
 */
export function buildAgentArgs(options: AgentOptions): { command: string; args: string[] } {
  switch (options.agent) {
    case 'claude': {
      const args: string[] = [];
      if (options.resume) args.push('--continue');
      args.push('-p');
      if (options.model) args.push('--model', options.model);
      args.push(
        '--dangerously-skip-permissions',
        '--verbose',
        '--output-format', 'text',
      );
      if (options.maxTurns) {
        args.push('--max-turns', String(options.maxTurns));
      }
      return { command: 'claude', args };
    }
    case 'codex': {
      const args: string[] = [];
      if (options.resume) {
        args.push('exec', 'resume', '--last');
      } else {
        args.push('exec');
      }
      if (options.model) args.push('--model', options.model);
      args.push('--full-auto');
      return { command: 'codex', args };
    }
    case 'opencode': {
      const args = ['run'];
      if (options.model) args.push('--model', options.model);
      return { command: 'opencode', args };
    }
    default:
      throw new Error(`Unknown agent type: ${options.agent}`);
  }
}

/**
 * Build a shell command string for one-shot agent prompts (scan, vision).
 * Reads prompt from stdin. Returns the command to pipe into.
 */
export function buildOneShotCommand(agent: 'claude' | 'codex' | 'opencode', model: string): string {
  switch (agent) {
    case 'claude': {
      const parts = ['claude', '-p'];
      if (model) parts.push('--model', model);
      parts.push('--dangerously-skip-permissions', '--output-format', 'text');
      return parts.join(' ');
    }
    case 'codex': {
      const parts = ['codex', 'exec'];
      if (model) parts.push('--model', model);
      parts.push('--full-auto');
      return parts.join(' ');
    }
    case 'opencode': {
      const parts = ['opencode', 'run'];
      if (model) parts.push('--model', model);
      return parts.join(' ');
    }
    default:
      throw new Error(`Unknown agent type: ${agent}`);
  }
}

/**
 * Spawn an AI agent with a prompt.
 * Streams output to terminal in real-time while capturing it.
 */
export async function spawnAgent(options: AgentOptions): Promise<AgentResult> {
  const { command, args } = buildAgentArgs(options);

  log.info(`Agent: ${options.agent} | Model: ${options.model} | CWD: ${options.cwd}`);

  const startTime = Date.now();
  const chunks: Buffer[] = [];
  let logStream: WriteStream | undefined;

  if (options.logFile) {
    logStream = createWriteStream(options.logFile, { flags: 'w' });
  }

  const timeoutMs = options.timeout ?? DEFAULT_AGENT_TIMEOUT_MS;

  return new Promise<AgentResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolved = false;

    // Pipe prompt via stdin (like: echo "$prompt" | claude -p)
    child.stdin.write(options.prompt);
    child.stdin.end();

    const handleData = (stream: typeof child.stdout) => (data: Buffer) => {
      chunks.push(data);
      if (options.verbose) {
        process.stderr.write(data);
      }
      if (logStream) {
        const ok = logStream.write(data);
        // Handle backpressure: pause the source stream until the log drains
        if (!ok) {
          stream.pause();
          logStream!.once('drain', () => stream.resume());
        }
      }
    };

    child.stdout.on('data', handleData(child.stdout));
    child.stderr.on('data', handleData(child.stderr));

    // Prevent unhandled stream errors from crashing the process
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    const getOutput = () => Buffer.concat(chunks).toString();

    const finish = (exitCode: number, output: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      if (logStream) {
        logStream.end(() => {
          resolve({ exitCode, output, duration });
        });
      } else {
        resolve({ exitCode, output, duration });
      }
    };

    // Kill the agent if it exceeds the timeout
    const timer = setTimeout(() => {
      if (!resolved) {
        log.warn(`Agent timed out after ${Math.round(timeoutMs / 1000)}s, killing process...`);
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 5000);
        finish(1, getOutput() + '\n[TIMEOUT] Agent killed after exceeding time limit.');
      }
    }, timeoutMs);

    child.on('close', (code) => {
      finish(code ?? 1, getOutput());
    });

    child.on('error', (err) => {
      finish(1, `Failed to spawn ${command}: ${err.message}`);
    });
  });
}
