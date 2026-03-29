import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// --- Types ---

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

export interface AgentRunner {
  name: string;
  command: string;
  buildArgs(options: RunOptions): string[];
  run(options: RunOptions): Promise<RunResult>;
}

// --- Helpers ---

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (dir && dir !== ".") {
    mkdirSync(dir, { recursive: true });
  }
}

export function spawnAgent(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const cwd = options.cwd ?? process.cwd();
    const env = { ...process.env, ...options.env };

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let logStream: ReturnType<typeof createWriteStream> | undefined;

    if (options.logFile) {
      ensureDir(options.logFile);
      logStream = createWriteStream(options.logFile, { flags: "a" });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      logStream?.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      logStream?.write(text);
    });

    child.on("close", (code) => {
      logStream?.end();
      const exitCode = code ?? 1;
      resolve({
        success: exitCode === 0,
        output: stdout || stderr,
        exitCode,
        duration: Date.now() - start,
      });
    });

    child.on("error", (err) => {
      logStream?.end();
      resolve({
        success: false,
        output: err.message,
        exitCode: 1,
        duration: Date.now() - start,
      });
    });

    // Pipe prompt to stdin then close
    child.stdin.write(options.prompt);
    child.stdin.end();
  });
}

// --- Re-export extracted runner ---

export { createClaudeRunner } from "./runners/claude.js";

// --- Generic Runner Factory ---

export function createRunner(config: {
  name: string;
  command: string;
  buildArgs: (options: RunOptions) => string[];
}): AgentRunner {
  return {
    name: config.name,
    command: config.command,
    buildArgs: config.buildArgs,
    run(options: RunOptions): Promise<RunResult> {
      const args = this.buildArgs(options);
      return spawnAgent(this.command, args, options);
    },
  };
}
