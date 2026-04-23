/**
 * Agent Runner — spawn AI agents with real-time output streaming.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { log } from './logger.js';
import type { RoutingEndpoint } from './config.js';

/**
 * Supported agent CLI shapes. `lmstudio` piggy-backs on the `claude` CLI (since
 * LM Studio exposes an Anthropic-compatible endpoint); `ollama` piggy-backs on
 * the `codex` CLI (OpenAI-compatible).
 */
export type AgentType = 'claude' | 'codex' | 'opencode' | 'lmstudio' | 'ollama';

export type AgentResult = {
  exitCode: number;
  output: string;
  duration: number;
  /** Total cost in USD (parsed from agent output, if available). */
  costUsd?: number;
  /** Input tokens consumed (parsed from agent output, if available). */
  inputTokens?: number;
  /** Output tokens generated (parsed from agent output, if available). */
  outputTokens?: number;
  /** Model used for the invocation. */
  model?: string;
};

/**
 * Parse a Claude stream-json line into a human-readable log line.
 * Returns null for lines that shouldn't be logged.
 */
function formatStreamJsonLine(line: string): string | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const type = obj.type as string;

    if (type === 'assistant') {
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
      const parts: string[] = [];

      for (const block of content) {
        if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown> | undefined;
          const name = block.name as string;
          // Show the most useful input field for common tools
          if (name === 'Read' && input?.file_path) {
            parts.push(`[${name}] ${input.file_path}`);
          } else if (name === 'Write' && input?.file_path) {
            parts.push(`[${name}] ${input.file_path}`);
          } else if (name === 'Edit' && input?.file_path) {
            parts.push(`[${name}] ${input.file_path}`);
          } else if (name === 'Bash' && input?.command) {
            parts.push(`[${name}] ${String(input.command).slice(0, 200)}`);
          } else if (name === 'Glob' && input?.pattern) {
            parts.push(`[${name}] ${input.pattern}`);
          } else if (name === 'Grep' && input?.pattern) {
            parts.push(`[${name}] ${input.pattern}`);
          } else {
            parts.push(`[${name}]`);
          }
        } else if (block.type === 'text') {
          const text = String(block.text ?? '').trim();
          if (text) parts.push(text);
        }
      }

      if (parts.length > 0) return parts.join('\n');
    }

    if (type === 'result') {
      const result = String(obj.result ?? '').trim();
      const cost = obj.total_cost_usd as number | undefined;
      const costStr = cost ? ` ($${cost.toFixed(4)})` : '';
      if (result) return `\n--- RESULT${costStr} ---\n${result}`;
    }

    return null;
  } catch {
    return null;
  }
}

/** Default agent timeout: 30 minutes */
const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

export type AgentOptions = {
  agent: AgentType;
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
  /**
   * Env-var overrides merged over `process.env` when spawning the child.
   * Callers MUST compute this per stage (see `buildEndpointEnv`) so that a
   * frontier stage does not inherit a local-endpoint env from a prior stage.
   */
  env?: Record<string, string>;
};

/**
 * Build CLI command and args for a given agent type.
 *
 * `lmstudio` delegates to the claude CLI shape (Anthropic-compatible); `ollama`
 * delegates to the codex CLI shape (OpenAI-compatible). Endpoint selection is
 * wired via env vars (see `buildEndpointEnv`), not CLI flags.
 */
export function buildAgentArgs(options: AgentOptions): { command: string; args: string[] } {
  switch (options.agent) {
    case 'claude':
    case 'lmstudio': {
      const args: string[] = [];
      if (options.resume) args.push('--continue');
      args.push('-p');
      if (options.model) args.push('--model', options.model);
      args.push(
        '--dangerously-skip-permissions',
        '--verbose',
        '--output-format', 'stream-json',
      );
      if (options.maxTurns) {
        args.push('--max-turns', String(options.maxTurns));
      }
      return { command: 'claude', args };
    }
    case 'codex':
    case 'ollama': {
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
export function buildOneShotCommand(agent: AgentType, model: string): string {
  switch (agent) {
    case 'claude':
    case 'lmstudio': {
      const parts = ['claude', '-p'];
      if (model) parts.push('--model', model);
      parts.push('--dangerously-skip-permissions', '--output-format', 'text');
      return parts.join(' ');
    }
    case 'codex':
    case 'ollama': {
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
 * Build the env-var overrides needed to point a child CLI at a specific
 * routing endpoint. Anthropic-shaped endpoints set ANTHROPIC_BASE_URL /
 * ANTHROPIC_MODEL; OpenAI-compatible endpoints set OPENAI_BASE_URL /
 * OPENAI_MODEL.
 *
 * Callers MUST compute this per stage and not share envs across stages, so
 * that a frontier stage does not inherit a local endpoint from a prior stage.
 */
export function buildEndpointEnv(endpoint: RoutingEndpoint, model: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!endpoint || !endpoint.base_url) return env;
  switch (endpoint.type) {
    case 'anthropic':
    case 'anthropic_compat':
      env.ANTHROPIC_BASE_URL = endpoint.base_url;
      if (model) env.ANTHROPIC_MODEL = model;
      break;
    case 'openai_compat':
      env.OPENAI_BASE_URL = endpoint.base_url;
      if (model) env.OPENAI_MODEL = model;
      break;
  }
  return env;
}

/**
 * Spawn an AI agent with a prompt.
 * Streams output to terminal in real-time while capturing it.
 *
 * For Claude, uses stream-json format and parses it into readable log lines.
 * For other agents, captures raw stdout/stderr directly.
 */
export async function spawnAgent(options: AgentOptions): Promise<AgentResult> {
  const { command, args } = buildAgentArgs(options);
  const useStreamJson = options.agent === 'claude';

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
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    let resolved = false;
    // For stream-json: accumulate partial lines, extract final result text
    let lineBuffer = '';
    let finalResultText = '';
    // Cost/token tracking (parsed from stream-json result blocks)
    let parsedCostUsd: number | undefined;
    let parsedInputTokens: number | undefined;
    let parsedOutputTokens: number | undefined;

    // Pipe prompt via stdin (like: echo "$prompt" | claude -p)
    child.stdin.write(options.prompt);
    child.stdin.end();

    /**
     * Write a string to the log file, handling backpressure.
     */
    const writeToLog = (stream: typeof child.stdout, text: string) => {
      if (!logStream) return;
      const ok = logStream.write(text);
      if (!ok) {
        stream.pause();
        logStream!.once('drain', () => stream.resume());
      }
    };

    /**
     * Handle raw data for non-Claude agents (pass-through).
     */
    const handleRawData = (stream: typeof child.stdout) => (data: Buffer) => {
      chunks.push(data);
      if (options.verbose) process.stderr.write(data);
      writeToLog(stream, data.toString());
    };

    /**
     * Handle stream-json data for Claude — parse JSON lines into readable output.
     */
    const handleStreamJson = (stream: typeof child.stdout) => (data: Buffer) => {
      chunks.push(data);
      lineBuffer += data.toString();

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);

        if (!line) continue;

        // Extract the final result text and cost/token data for the return value
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type === 'result') {
            finalResultText = typeof obj.result === 'string' ? obj.result : '';
            // Capture error info so transient error detection works
            if (obj.is_error || obj.subtype === 'error') {
              finalResultText = finalResultText || JSON.stringify(obj);
            }
            // Parse cost from result block
            if (typeof obj.total_cost_usd === 'number') {
              parsedCostUsd = obj.total_cost_usd;
            }
            // Parse token usage from result block
            const usage = obj.usage as Record<string, unknown> | undefined;
            if (usage) {
              if (typeof usage.input_tokens === 'number') parsedInputTokens = usage.input_tokens;
              if (typeof usage.output_tokens === 'number') parsedOutputTokens = usage.output_tokens;
            }
          }
        } catch { /* not valid JSON, ignore */ }

        const formatted = formatStreamJsonLine(line);
        if (formatted) {
          const logLine = formatted + '\n';
          if (options.verbose) process.stderr.write(logLine);
          writeToLog(stream, logLine);
        }
      }
    };

    if (useStreamJson) {
      child.stdout.on('data', handleStreamJson(child.stdout));
      // stderr from Claude in stream-json mode is typically empty, but capture it
      child.stderr.on('data', handleRawData(child.stderr));
    } else {
      child.stdout.on('data', handleRawData(child.stdout));
      child.stderr.on('data', handleRawData(child.stderr));
    }

    // Prevent unhandled stream errors from crashing the process
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    const getOutput = () => {
      if (useStreamJson) {
        // Return the parsed result text, not raw JSON
        return finalResultText || Buffer.concat(chunks).toString();
      }
      return Buffer.concat(chunks).toString();
    };

    const finish = (exitCode: number, output: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      const result: AgentResult = {
        exitCode,
        output,
        duration,
        model: options.model || undefined,
        costUsd: parsedCostUsd,
        inputTokens: parsedInputTokens,
        outputTokens: parsedOutputTokens,
      };
      if (logStream) {
        logStream.end(() => {
          resolve(result);
        });
      } else {
        resolve(result);
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
