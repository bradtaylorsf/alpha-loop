/**
 * CLI Runner Module
 * =================
 *
 * Wraps the `claude` CLI for OAuth token support.
 * Emits structured events that can be stored and replayed.
 *
 * Architecture:
 * - CLI outputs JSONL (stream-json format)
 * - This module parses each line and emits structured events
 * - Events are self-contained with all metadata for storage
 * - No text accumulation needed - each event is complete
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { createLogger } from './logger.js';
import type { SessionEventType } from './types/database.js';

const logger = createLogger('cli-runner');

// ============================================================================
// Types
// ============================================================================

export interface CLIRunnerOptions {
  prompt: string;
  model?: string;
  cwd: string;
  allowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  oauthToken?: string;
  apiKey?: string;
  settingsFile?: string;
  mcpServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
  abortController?: AbortController;

  // Session ID Management (Phase 0 - UUID-first architecture)
  /**
   * Session UUID to use for this session. If provided, CLI will use this UUID instead of generating one.
   * This enables UUID-first session creation where we know the identifier BEFORE starting the CLI.
   */
  sessionId?: string;
  /** Session ID to resume from (enables conversation continuation) */
  resumeSessionId?: string;
  /**
   * Fork from a previous session, creating a new session that branches from the original.
   * Used with --fork-session flag to preserve the original session while exploring alternatives.
   */
  forkFromSession?: string;
  /** Whether to persist the session for future resumption (default: true when resuming) */
  persistSession?: boolean;

  // Model Configuration
  /**
   * Fallback model to use if primary model is overloaded or unavailable.
   * Example: Set model='opus' and fallbackModel='sonnet' for auto-fallback.
   */
  fallbackModel?: string;

  // Task Workflow environment variables (Phase 2)
  /** Harness session ID (numeric) for metrics and worktree tracking */
  harnessSessionId?: number;
  /** Task ID this session is working on */
  taskId?: number;
  /** URL-safe slug for the task (used for branch naming) */
  taskSlug?: string;
  /** Project name for worktree directory naming */
  projectName?: string;
  /** Harness API URL for hooks to call back */
  apiUrl?: string;
  /** Project's development URL for testing */
  devUrl?: string;
  /** Task branch name (if already created) */
  taskBranch?: string;

  /**
   * Custom agents to make available in this session.
   * JSON object mapping agent names to their definitions.
   * Example: { "database-developer": { description: "...", prompt: "..." } }
   */
  agents?: Record<string, { description: string; prompt: string }>;
}

/**
 * Structured event emitted by CLI Runner
 * Each event is self-contained and can be stored/replayed
 */
export interface CLIEvent {
  /** Event type */
  type: SessionEventType;

  /** CLI session ID (UUID) */
  sessionId: string;

  /** Sequence number within session (1, 2, 3...) */
  sequenceNum: number;

  /** Timestamp when event was received */
  timestamp: string;

  /** Text content (for text, error events) */
  content?: string;

  /** Tool name (for tool_use, tool_result events) */
  toolName?: string;

  /** Tool input parameters as JSON string */
  toolInput?: string;

  /** Tool result content */
  toolResult?: string;

  /** Whether this is an error */
  isError?: boolean;

  /** Model used */
  model?: string;

  /** Token usage (if available) */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };

  /** Cost in USD (if available) */
  costUsd?: number;

  /** Duration in ms (for result events) */
  durationMs?: number;
}

export interface CLIRunnerResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  sessionId?: string;
  events: CLIEvent[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  costUsd?: number;
  durationMs?: number;
}

// ============================================================================
// OAuth Token Helpers
// ============================================================================

/**
 * Module-level OAuth token storage.
 * This allows the token to be set dynamically at runtime (e.g., from Electron
 * after the user completes setup) without restarting the server process.
 */
let runtimeOAuthToken: string | undefined = undefined;

/**
 * Set the OAuth token at runtime.
 * Called from the /api/auth/claude-token endpoint when Electron saves a new token.
 */
export function setOAuthToken(token: string | undefined): void {
  runtimeOAuthToken = token;
  logger.info('OAuth token updated at runtime', {
    hasToken: !!token,
    tokenPrefix: token ? token.substring(0, 15) + '...' : 'none'
  });
}

export function hasOAuthToken(): boolean {
  return !!(
    runtimeOAuthToken ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_OAUTH_API_KEY
  );
}

export function getOAuthToken(): string | undefined {
  // Check runtime token first (set by Electron after user completes setup)
  // Then fall back to environment variables
  return (
    runtimeOAuthToken ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_OAUTH_API_KEY
  );
}

export function getAuthMethod(): 'oauth' | 'api_key' | 'none' {
  if (hasOAuthToken()) return 'oauth';
  if (process.env.ANTHROPIC_API_KEY) return 'api_key';
  return 'none';
}

// ============================================================================
// CLI Runner Class
// ============================================================================

/**
 * CLI Runner that wraps the `claude` CLI
 *
 * Events emitted:
 * - 'spawned': { pid: number } - CLI process spawned (useful for process tracking)
 * - 'event': CLIEvent - structured event (text, tool_use, tool_result, error)
 * - 'done': void - CLI process completed
 */
export class CLIRunner extends EventEmitter {
  private process?: ChildProcess;
  private abortController?: AbortController;
  private lineBuffer = '';
  private isRunning = false;
  private _pid?: number;

  // Session state
  private sessionId = '';
  private sequenceNum = 0;
  private events: CLIEvent[] = [];
  private textBuffer = '';
  private model?: string;

  // Final result data
  private usage?: { inputTokens: number; outputTokens: number };
  private costUsd?: number;
  private durationMs?: number;

  /**
   * Get the PID of the running CLI process
   */
  get pid(): number | undefined {
    return this._pid;
  }

  /**
   * Run a Claude CLI session
   */
  async run(options: CLIRunnerOptions): Promise<CLIRunnerResult> {
    if (this.isRunning) {
      throw new Error('CLI runner is already running');
    }

    // Reset state
    this.isRunning = true;
    this.lineBuffer = '';
    this.sessionId = '';
    this.sequenceNum = 0;
    this.events = [];
    this.textBuffer = '';
    this.model = options.model;
    this.usage = undefined;
    this.costUsd = undefined;
    this.durationMs = undefined;
    this.abortController = options.abortController || new AbortController();

    const args = this.buildArgs(options);
    const env = this.buildEnv(options);

    logger.info('Starting Claude CLI', {
      cwd: options.cwd,
      model: options.model,
      hasOAuth: !!options.oauthToken || hasOAuthToken(),
    });

    return new Promise((resolve, reject) => {
      this.process = spawn('claude', args, {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Store and emit PID for process tracking
      this._pid = this.process.pid;
      if (this._pid) {
        logger.info('Claude CLI spawned', { pid: this._pid, cwd: options.cwd });
        this.emit('spawned', { pid: this._pid });
      }

      // Write prompt to stdin
      if (this.process.stdin) {
        this.process.stdin.write(options.prompt);
        this.process.stdin.end();
      }

      let errorOutput = '';

      // Handle stdout (JSONL stream)
      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleStreamData(data.toString());
      });

      // Handle stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      // Handle process exit
      this.process.on('close', (code) => {
        // Flush any remaining text
        this.flushTextBuffer();

        // Process remaining line buffer
        if (this.lineBuffer.trim()) {
          try {
            const json = JSON.parse(this.lineBuffer.trim());
            this.processStreamMessage(json);
          } catch {
            // Ignore parse errors
          }
          this.lineBuffer = '';
        }

        this.isRunning = false;
        this.emit('done');

        resolve({
          success: code === 0,
          output: this.textBuffer,
          error: code !== 0 ? errorOutput : undefined,
          exitCode: code || 0,
          sessionId: this.sessionId,
          events: this.events,
          usage: this.usage,
          costUsd: this.costUsd,
          durationMs: this.durationMs,
        });
      });

      this.process.on('error', (error) => {
        this.isRunning = false;
        reject(error);
      });

      if (this.abortController) {
        this.abortController.signal.addEventListener('abort', () => {
          this.stop();
        });
      }
    });
  }

  /**
   * Stop the running CLI process
   */
  stop(): void {
    if (this.process && this.isRunning) {
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.isRunning && this.process) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  /**
   * Build CLI arguments
   */
  private buildArgs(options: CLIRunnerOptions): string[] {
    const args: string[] = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--input-format', 'text',
    ];

    // CRITICAL: Set session ID upfront to unify identifiers (Phase 0)
    // This enables UUID-first session creation where we know the identifier BEFORE CLI starts
    if (options.sessionId) {
      args.push('--session-id', options.sessionId);
      logger.info('CLI will use pre-generated session ID', { sessionId: options.sessionId });
    }

    if (options.model) {
      args.push('--model', options.model);
    }

    // Fallback model for auto-switching on model overload (Phase 0)
    if (options.fallbackModel) {
      args.push('--fallback-model', options.fallbackModel);
      logger.info('CLI fallback model configured', { fallback: options.fallbackModel });
    }

    if (options.allowedTools?.length) {
      args.push('--allowedTools', options.allowedTools.join(','));
    }
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns));
    }
    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt);
    } else if (options.appendSystemPrompt) {
      args.push('--append-system-prompt', options.appendSystemPrompt);
    }
    if (options.settingsFile) {
      args.push('--settings', options.settingsFile);
    }
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: options.mcpServers }));
    }

    // Pass custom agents if provided
    if (options.agents && Object.keys(options.agents).length > 0) {
      args.push('--agents', JSON.stringify(options.agents));
    }

    args.push('--permission-mode', 'acceptEdits');

    // Handle session persistence, resumption, and forking
    // Priority: forkFromSession > resumeSessionId > normal start
    if (options.forkFromSession) {
      // Fork creates a new session branching from the original (Phase 0)
      args.push('--resume', options.forkFromSession);
      args.push('--fork-session');
      logger.info('CLI will fork from session', { sourceSession: options.forkFromSession });
    } else if (options.resumeSessionId) {
      // Resume continues the existing session
      args.push('--resume', options.resumeSessionId);
      logger.info('CLI will resume session', { sessionId: options.resumeSessionId });
    } else if (options.persistSession === false) {
      // Only disable persistence when explicitly requested AND not resuming/forking
      args.push('--no-session-persistence');
    }
    // Default: session persistence is enabled (no flag needed)

    return args;
  }

  /**
   * Build environment variables
   */
  private buildEnv(options: CLIRunnerOptions): NodeJS.ProcessEnv {
    const env = { ...process.env };

    const oauthToken = options.oauthToken || getOAuthToken();
    if (oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      delete env.ANTHROPIC_API_KEY;
    } else if (options.apiKey || process.env.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = options.apiKey || process.env.ANTHROPIC_API_KEY!;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    // Task Workflow environment variables (Phase 2)
    // These are read by hooks for session/task context
    if (options.harnessSessionId !== undefined) {
      env.ALPHAAGENT_SESSION_ID = String(options.harnessSessionId);
    }
    if (options.taskId !== undefined) {
      env.ALPHAAGENT_TASK_ID = String(options.taskId);
    }
    if (options.taskSlug) {
      env.ALPHAAGENT_TASK_SLUG = options.taskSlug;
    }
    if (options.projectName) {
      env.ALPHAAGENT_PROJECT_NAME = options.projectName;
    }
    if (options.apiUrl) {
      env.ALPHAAGENT_API_URL = options.apiUrl;
    }
    if (options.devUrl) {
      env.ALPHAAGENT_DEV_URL = options.devUrl;
    }
    if (options.taskBranch) {
      env.ALPHAAGENT_TASK_BRANCH = options.taskBranch;
    }

    return env;
  }

  /**
   * Handle streaming JSONL data
   */
  private handleStreamData(text: string): void {
    const fullText = this.lineBuffer + text;
    const lines = fullText.split('\n');
    const endsWithNewline = text.endsWith('\n');

    const linesToProcess = endsWithNewline ? lines : lines.slice(0, -1);
    this.lineBuffer = endsWithNewline ? '' : (lines[lines.length - 1] || '');

    for (const line of linesToProcess) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      try {
        const json = JSON.parse(trimmedLine);
        this.processStreamMessage(json);
      } catch {
        // Ignore parse errors
      }
    }
  }

  /**
   * Create and emit a structured event
   */
  private emitEvent(event: Omit<CLIEvent, 'sessionId' | 'sequenceNum' | 'timestamp'>): void {
    const fullEvent: CLIEvent = {
      ...event,
      sessionId: this.sessionId,
      sequenceNum: ++this.sequenceNum,
      timestamp: new Date().toISOString(),
      model: this.model,
    };

    this.events.push(fullEvent);
    this.emit('event', fullEvent);
  }

  /**
   * Flush accumulated text as a single event
   */
  private flushTextBuffer(): void {
    if (this.textBuffer.trim()) {
      this.emitEvent({
        type: 'text',
        content: this.textBuffer,
      });
      // Don't clear - keep for final output
    }
  }

  /**
   * Process a parsed stream message
   */
  private processStreamMessage(msg: Record<string, unknown>): void {
    const msgType = msg.type as string;

    switch (msgType) {
      case 'system':
        // Extract session ID
        this.sessionId = (msg.session_id as string) || `session-${Date.now()}`;
        this.emitEvent({
          type: 'system',
          content: JSON.stringify(msg),
        });
        break;

      case 'stream_event': {
        const event = msg.event as Record<string, unknown>;
        if (!event) break;

        const eventType = event.type as string;

        if (eventType === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown>;
          if (delta?.type === 'text_delta' && delta.text) {
            // Accumulate text (will be flushed before tool_use or at end)
            this.textBuffer += delta.text as string;
          }
        }
        break;
      }

      case 'assistant':
        // Full assistant message - flush text and emit tool uses
        this.flushTextBuffer();
        this.textBuffer = '';

        if (msg.message && typeof msg.message === 'object') {
          const message = msg.message as Record<string, unknown>;
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'tool_use') {
                // Special handling for Task tool - indicates sub-agent delegation
                const isSubAgent = block.name === 'Task';
                const input = block.input as Record<string, unknown> | undefined;
                const subagentType = isSubAgent ? (input?.subagent_type as string) : undefined;
                const subagentDesc = isSubAgent ? (input?.description as string) : undefined;

                this.emitEvent({
                  type: 'tool_use',
                  toolName: block.name,
                  toolInput: JSON.stringify(block.input),
                  content: isSubAgent
                    ? `🤖 Delegating to ${subagentType || 'sub-agent'}: ${subagentDesc || 'task'}`
                    : `Tool: ${block.name}`,
                });

                // Log sub-agent invocations for visibility
                if (isSubAgent) {
                  logger.info(`[CLI] Sub-agent invoked: ${subagentType}`, {
                    description: subagentDesc,
                    subagentType,
                  });
                }
              }
            }
          }
        }
        break;

      case 'user':
        // Tool results
        if (msg.message && typeof msg.message === 'object') {
          const message = msg.message as Record<string, unknown>;
          if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'tool_result') {
                const content = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);

                this.emitEvent({
                  type: 'tool_result',
                  toolResult: content,
                  isError: !!block.is_error,
                  content: block.is_error ? `Error: ${content.slice(0, 200)}` : `Result: ${content.slice(0, 200)}...`,
                });
              }
            }
          }
        }
        break;

      case 'result':
        // Session complete - extract final statistics
        this.flushTextBuffer();

        if (typeof msg.duration_ms === 'number') {
          this.durationMs = msg.duration_ms;
        }
        if (typeof msg.total_cost_usd === 'number') {
          this.costUsd = msg.total_cost_usd;
        }
        if (msg.usage && typeof msg.usage === 'object') {
          const usage = msg.usage as Record<string, unknown>;
          this.usage = {
            inputTokens: (usage.input_tokens as number) || 0,
            outputTokens: (usage.output_tokens as number) || 0,
          };
        }

        this.emitEvent({
          type: 'result',
          content: msg.is_error ? 'Session failed' : 'Session completed',
          isError: !!msg.is_error,
          durationMs: this.durationMs,
          costUsd: this.costUsd,
          usage: this.usage,
        });
        break;

      case 'error':
        this.emitEvent({
          type: 'error',
          content: String(msg.error || msg.message || 'Unknown error'),
          isError: true,
        });
        break;

      default:
        // Log unknown message types to help debug missing sub-agent events
        logger.debug(`[CLI] Unknown message type: ${msgType}`, {
          type: msgType,
          keys: Object.keys(msg),
          // Include partial content for debugging
          preview: JSON.stringify(msg).slice(0, 500),
        });
        break;
    }
  }
}

/**
 * Run a single CLI query (convenience function)
 */
export async function runCLIQuery(options: CLIRunnerOptions): Promise<CLIRunnerResult> {
  const runner = new CLIRunner();
  return runner.run(options);
}
