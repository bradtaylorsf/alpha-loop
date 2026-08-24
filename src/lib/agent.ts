/**
 * Agent Runner — spawn AI agents with real-time output streaming.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { log } from './logger.js';
import { exec } from './shell.js';
import { classifyToolErrors } from './escalation.js';
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
  /** Number of tool_use blocks emitted during the run. */
  toolCalls?: number;
  /** Number of tool_result blocks with is_error === true. */
  toolErrors?: number;
  /** Claude stream-json result subtype, when present. */
  resultSubtype?: string;
  /** Whether the Claude stream-json result reported an error. */
  resultIsError?: boolean;
  /** Sanitized classification for non-zero CLI exits. */
  failure?: AgentFailure;
};

export type AgentFailureKind = 'authentication' | 'spawn' | 'timeout' | 'execution';

/**
 * Safe-to-log agent failure metadata. The fingerprint is deterministic but
 * never contains raw CLI output, which can include account or endpoint data.
 */
export type AgentFailure = {
  kind: AgentFailureKind;
  fingerprint: string;
  diagnostic: string;
  durationMs: number;
};

export type AgentProbeResult = {
  ok: boolean;
  duration: number;
  failure?: AgentFailure;
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
/** Grace period after a Claude stream-json result before treating the run as done. */
const DEFAULT_RESULT_GRACE_MS = 60 * 1000;
/** Time to wait for SIGTERM before forcing a stuck child down. */
const FORCE_KILL_GRACE_MS = 5 * 1000;

export type AgentOptions = {
  agent: AgentType;
  model: string;
  prompt: string;
  cwd: string;
  logFile?: string;
  verbose?: boolean;
  /** Timeout in milliseconds. Defaults to 30 minutes. */
  timeout?: number;
  /**
   * Grace period after a Claude stream-json `result` event before resolving if
   * the child process never closes. Set to 0 to disable result-based recovery.
   */
  resultGraceMs?: number;
  /** Max conversation turns for the agent. Only supported by claude. */
  maxTurns?: number;
  /** Resume the most recent agent session in the CWD instead of starting fresh. */
  resume?: boolean;
  /** Cancel the active CLI process when the owning run is interrupted. */
  signal?: AbortSignal;
  /**
   * Env-var overrides merged over `process.env` when spawning the child.
   * Callers MUST compute this per stage (see `buildEndpointEnv`) so that a
   * frontier stage does not inherit a local-endpoint env from a prior stage.
   */
  env?: Record<string, string>;
  /** Restrict the invocation to a stdout-only/read-only liveness check. */
  textOnly?: boolean;
};

/** Resolve aliases to the CLI binary actually spawned. */
export function agentCliCommand(agent: AgentType): string {
  switch (agent) {
    case 'claude':
    case 'lmstudio':
      return 'claude';
    case 'codex':
    case 'ollama':
      return 'codex';
    case 'opencode':
      return 'opencode';
    default:
      throw new Error(`Unknown agent type: ${agent}`);
  }
}

/**
 * Extra sandbox config the codex CLI needs when running inside a linked git
 * worktree: the worktree's index and metadata live in the PARENT repo's .git
 * directory, outside codex's workspace-write sandbox (which only covers the
 * cwd). Without this grant, `git add`/`git commit` inside the worktree fail on
 * index.lock and the agent cannot commit its own work.
 *
 * Returns `-c sandbox_workspace_write.writable_roots=[...]` args pointing at
 * the git common dir, or [] when cwd is the primary checkout (common dir is
 * already inside the sandbox) or not a git repo at all.
 */
export function codexSandboxArgs(cwd: string): string[] {
  try {
    const result = exec('git rev-parse --git-common-dir', { cwd });
    if (result.exitCode !== 0 || !result.stdout.trim()) return [];
    const commonDir = resolve(cwd, result.stdout.trim());
    // Compare against the repo's working-tree root, not cwd: from a
    // subdirectory of the primary checkout the common dir is outside cwd but
    // still inside the checkout, and no grant is needed. Only a linked
    // worktree (common dir outside its own toplevel) needs one.
    const toplevelResult = exec('git rev-parse --show-toplevel', { cwd });
    const toplevel = toplevelResult.exitCode === 0 && toplevelResult.stdout.trim()
      ? resolve(toplevelResult.stdout.trim())
      : cwd;
    const rel = relative(toplevel, commonDir);
    const insideCheckout = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    if (insideCheckout) return [];
    return ['-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(commonDir)}]`];
  } catch {
    return [];
  }
}

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
      if (options.textOnly) {
        args.push('--allowedTools', '', '--output-format', 'text');
        return { command: agentCliCommand(options.agent), args };
      }
      args.push(
        '--dangerously-skip-permissions',
        '--verbose',
        '--output-format', 'stream-json',
      );
      if (options.maxTurns) {
        args.push('--max-turns', String(options.maxTurns));
      }
      return { command: agentCliCommand(options.agent), args };
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
      if (options.textOnly) {
        args.push('--sandbox', 'read-only');
        return { command: agentCliCommand(options.agent), args };
      }
      args.push('--full-auto');
      args.push(...codexSandboxArgs(options.cwd));
      return { command: agentCliCommand(options.agent), args };
    }
    case 'opencode': {
      const args = ['run'];
      if (options.model) args.push('--model', options.model);
      return { command: agentCliCommand(options.agent), args };
    }
    default:
      throw new Error(`Unknown agent type: ${options.agent}`);
  }
}

const AUTH_FAILURES: Array<{
  pattern: RegExp;
  fingerprint: string;
  diagnostic: string;
}> = [
  {
    pattern: /oauth session expired(?:.|\n)*could not be refreshed/i,
    fingerprint: 'authentication:oauth-session-expired',
    diagnostic: 'OAuth session expired and could not be refreshed',
  },
  {
    pattern: /failed to authenticate/i,
    fingerprint: 'authentication:failed',
    diagnostic: 'Agent CLI authentication failed',
  },
  {
    pattern: /(?:not logged in|please (?:run )?(?:the )?login|authentication required|unauthorized|invalid api key|api key (?:is )?(?:invalid|missing))/i,
    fingerprint: 'authentication:credentials-required',
    diagnostic: 'Agent CLI credentials are missing or invalid',
  },
];

/**
 * Normalize a non-zero agent exit into structured metadata without copying
 * raw diagnostics (which may contain usernames, tokens, or endpoint URLs).
 */
export function classifyAgentFailure(
  exitCode: number,
  output: string,
  durationMs: number,
): AgentFailure | undefined {
  if (exitCode === 0) return undefined;

  const tail = output.slice(-4000);
  for (const authFailure of AUTH_FAILURES) {
    if (authFailure.pattern.test(tail)) {
      return {
        kind: 'authentication',
        fingerprint: authFailure.fingerprint,
        diagnostic: authFailure.diagnostic,
        durationMs,
      };
    }
  }

  if (/failed to spawn\b/i.test(tail)) {
    return {
      kind: 'spawn',
      fingerprint: 'spawn:failed',
      diagnostic: 'Agent CLI could not be started',
      durationMs,
    };
  }

  if (tail.includes('[TIMEOUT]')) {
    return {
      kind: 'timeout',
      fingerprint: 'timeout:agent',
      diagnostic: 'Agent CLI did not respond before the timeout',
      durationMs,
    };
  }

  const normalized = tail
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w.-]+/g, '<email>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  const digest = createHash('sha256').update(normalized || `exit:${exitCode}`).digest('hex').slice(0, 12);
  return {
    kind: 'execution',
    fingerprint: `execution:${digest}`,
    diagnostic: `Agent CLI exited with code ${exitCode}`,
    durationMs,
  };
}

/**
 * Build a shell command string for one-shot agent prompts (scan, vision).
 * Reads prompt from stdin. Returns the command to pipe into.
 */
export type OneShotCommandOptions = {
  /**
   * Request a stdout-only response for prompts that must not create or edit
   * files. Claude-family CLIs use an empty tool allowlist; Codex-family CLIs
   * use a read-only sandbox.
   */
  textOnly?: boolean;
};

export function buildOneShotCommand(agent: AgentType, model: string, options: OneShotCommandOptions = {}): string {
  switch (agent) {
    case 'claude':
    case 'lmstudio': {
      const parts = ['claude', '-p'];
      if (model) parts.push('--model', model);
      if (options.textOnly) {
        parts.push('--allowedTools', '""');
      } else {
        parts.push('--dangerously-skip-permissions');
      }
      parts.push('--output-format', 'text');
      return parts.join(' ');
    }
    case 'codex':
    case 'ollama': {
      const parts = ['codex', 'exec'];
      if (model) parts.push('--model', model);
      if (options.textOnly) {
        parts.push('--sandbox', 'read-only');
      } else {
        parts.push('--full-auto');
      }
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
 * Default local-server base URLs for single-agent `lmstudio` / `ollama` mode.
 * Exported so tests and callers can reference the same constants.
 */
export const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234';
export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

/**
 * Auto-injected env vars for single-agent `lmstudio` / `ollama` mode.
 *
 * Without this, `agent: lmstudio` would spawn the claude CLI with no base URL
 * override and silently hit the real Anthropic API. We only inject defaults
 * when the corresponding env var isn't already set in the parent process, so
 * users who export `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` to point at a
 * non-default port keep full control.
 */
function defaultLocalEnv(agent: AgentType, model: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (agent === 'lmstudio') {
    if (!process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = DEFAULT_LMSTUDIO_BASE_URL;
    if (model && !process.env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = model;
  } else if (agent === 'ollama') {
    if (!process.env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = DEFAULT_OLLAMA_BASE_URL;
    if (model && !process.env.OPENAI_MODEL) env.OPENAI_MODEL = model;
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
  const useStreamJson = command === 'claude' && args.includes('stream-json');

  log.info(`Agent: ${options.agent} | Model: ${options.model} | CWD: ${options.cwd}`);

  const startTime = Date.now();
  const chunks: Buffer[] = [];
  let logStream: WriteStream | undefined;

  if (options.logFile) {
    logStream = createWriteStream(options.logFile, { flags: 'w' });
  }

  const timeoutMs = options.timeout ?? DEFAULT_AGENT_TIMEOUT_MS;

  // Compose env: caller overrides win > agent-default local base URLs > process.env
  const localDefaults = defaultLocalEnv(options.agent, options.model);
  const hasOverrides = options.env && Object.keys(options.env).length > 0;
  const hasLocalDefaults = Object.keys(localDefaults).length > 0;
  const spawnEnv = hasOverrides || hasLocalDefaults
    ? { ...process.env, ...localDefaults, ...(options.env ?? {}) }
    : process.env;

  return new Promise<AgentResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    });

    let resolved = false;
    // For stream-json: accumulate partial lines, extract final result text
    let lineBuffer = '';
    let finalResultText = '';
    // Cost/token tracking (parsed from stream-json result blocks)
    let parsedCostUsd: number | undefined;
    let parsedInputTokens: number | undefined;
    let parsedOutputTokens: number | undefined;
    let parsedResultSubtype: string | undefined;
    let parsedResultIsError = false;
    let sawStreamResult = false;
    let agentTimeoutTimer: NodeJS.Timeout | undefined;
    let resultGraceTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let pendingTerminationExitCode: number | undefined;
    let pendingTerminationOutput: string | undefined;
    // Tool-use telemetry (per-stage metrics aggregation).
    let toolUseCount = 0;
    let toolErrorCount = 0;

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

    function terminateChild(
      reason: string,
      exitCode: number,
      output: string,
      signal: NodeJS.Signals = 'SIGTERM',
    ) {
      if (resolved) return;
      pendingTerminationExitCode = exitCode;
      pendingTerminationOutput = output;
      log.warn(reason);
      try { child.kill(signal); } catch { /* ignore */ }
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        finish(exitCode, output);
      }, FORCE_KILL_GRACE_MS);
    }

    const handleAbort = () => {
      terminateChild(
        'Agent cancelled by the owning session; terminating process...',
        130,
        getOutput() + '\n[ABORTED] Agent cancelled by the owning session.',
      );
    };
    options.signal?.addEventListener('abort', handleAbort, { once: true });
    if (options.signal?.aborted) handleAbort();

    function resultExitCode() {
      return parsedResultIsError ? 1 : 0;
    }

    function startResultGraceTimer() {
      const resultGraceMs = options.resultGraceMs ?? DEFAULT_RESULT_GRACE_MS;
      if (resultGraceMs <= 0 || resolved) return;
      if (resultGraceTimer) clearTimeout(resultGraceTimer);
      resultGraceTimer = setTimeout(() => {
        terminateChild(
          `Agent emitted a stream-json result but did not close after ${Math.round(resultGraceMs / 1000)}s; terminating stuck process...`,
          resultExitCode(),
          getOutput(),
        );
      }, resultGraceMs);
    }

    function processStreamJsonLine(stream: typeof child.stdout, line: string) {
      if (!line) return;

      // Extract the final result text and cost/token data for the return value
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === 'result') {
          sawStreamResult = true;
          finalResultText = typeof obj.result === 'string' ? obj.result : '';
          parsedResultSubtype = typeof obj.subtype === 'string' ? obj.subtype : undefined;
          parsedResultIsError = obj.is_error === true || parsedResultSubtype?.startsWith('error') === true;
          // Capture structured error info so transient/permanent classification
          // still has something useful when Claude reports an empty error result.
          if (parsedResultIsError) {
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
          startResultGraceTimer();
        } else if (obj.type === 'assistant') {
          const msg = obj.message as Record<string, unknown> | undefined;
          const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
          for (const block of content) {
            if (block.type === 'tool_use') toolUseCount++;
          }
        } else if (obj.type === 'user') {
          const msg = obj.message as Record<string, unknown> | undefined;
          const content = (msg?.content ?? []) as Array<Record<string, unknown>>;
          for (const block of content) {
            if (block.type === 'tool_result' && block.is_error === true) toolErrorCount++;
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
        processStreamJsonLine(stream, line);
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

    function getOutput() {
      if (useStreamJson) {
        // Return the parsed result text, not raw JSON
        return finalResultText || Buffer.concat(chunks).toString();
      }
      return Buffer.concat(chunks).toString();
    }

    function finish(exitCode: number, output?: string) {
      if (resolved) return;
      resolved = true;
      if (agentTimeoutTimer) clearTimeout(agentTimeoutTimer);
      if (resultGraceTimer) clearTimeout(resultGraceTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', handleAbort);
      if (useStreamJson && !sawStreamResult && lineBuffer.trim()) {
        processStreamJsonLine(child.stdout, lineBuffer.trim());
        lineBuffer = '';
      }
      const finalOutput = output ?? getOutput();
      const duration = Date.now() - startTime;
      // Fall back to output-string classification when we didn't see structured
      // tool_result error blocks (e.g. non-stream-json agents like codex).
      const toolErrorsFinal = toolErrorCount > 0
        ? toolErrorCount
        : classifyToolErrors(finalOutput).length;
      const result: AgentResult = {
        exitCode,
        output: finalOutput,
        duration,
        model: options.model || undefined,
        costUsd: parsedCostUsd,
        inputTokens: parsedInputTokens,
        outputTokens: parsedOutputTokens,
        toolCalls: toolUseCount,
        toolErrors: toolErrorsFinal,
      };
      const failure = classifyAgentFailure(exitCode, finalOutput, duration);
      if (failure) result.failure = failure;
      if (parsedResultSubtype !== undefined) result.resultSubtype = parsedResultSubtype;
      if (parsedResultIsError) result.resultIsError = true;
      if (logStream) {
        logStream.end(() => {
          resolve(result);
        });
      } else {
        resolve(result);
      }
    }

    // Kill the agent if it exceeds the timeout
    agentTimeoutTimer = setTimeout(() => {
      if (!resolved) {
        terminateChild(
          `Agent timed out after ${Math.round(timeoutMs / 1000)}s, killing process...`,
          1,
          getOutput() + '\n[TIMEOUT] Agent killed after exceeding time limit.',
        );
      }
    }, timeoutMs);

    child.on('close', (code) => {
      finish(
        pendingTerminationExitCode ?? code ?? (sawStreamResult ? resultExitCode() : 1),
        pendingTerminationOutput,
      );
    });

    child.on('error', (err) => {
      finish(1, `Failed to spawn ${command}: ${err.message}`);
    });
  });
}

/**
 * Run a short, text-only prompt before session creation to prove the selected
 * CLI can authenticate and answer without gaining write-capable tools.
 */
export async function probeAgentLiveness(
  options: Pick<AgentOptions, 'agent' | 'model' | 'cwd' | 'env'> & { timeout?: number },
): Promise<AgentProbeResult> {
  const result = await spawnAgent({
    ...options,
    prompt: 'Reply with exactly: ping. Do not use tools.',
    textOnly: true,
    timeout: options.timeout ?? 10_000,
  });

  if (result.exitCode === 0) {
    return { ok: true, duration: result.duration };
  }

  return {
    ok: false,
    duration: result.duration,
    failure: result.failure ?? classifyAgentFailure(result.exitCode, result.output, result.duration),
  };
}
