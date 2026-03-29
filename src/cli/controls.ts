import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { PipelineStage, PipelineResult } from "../engine/loop.js";
import type { GitHubIssue } from "../engine/github.js";

// --- Types ---

export type StageIndicator = "completed" | "in_progress" | "failed" | "pending";

export interface StageInfo {
  name: PipelineStage;
  indicator: StageIndicator;
  duration?: number; // seconds
  attempt?: string; // e.g. "attempt 1/3"
}

export interface ControlAction {
  type: "skip" | "context" | "view_log" | "quit";
}

export interface LoopControls {
  /** Start tracking a new issue */
  startIssue(issue: GitHubIssue): void;
  /** Update stage progress */
  onStage(stage: PipelineStage, message?: string): void;
  /** Get the abort controller for the current issue (skip kills this) */
  getAbortController(): AbortController;
  /** Prompt user between issues. Returns action. */
  betweenIssues(result: PipelineResult, nextIssue?: GitHubIssue): Promise<"continue" | "skip" | "quit">;
  /** Get and clear any user-provided context */
  consumeContext(): string | undefined;
  /** Whether quit was requested */
  shouldQuit(): boolean;
  /** Whether current issue was skipped */
  wasSkipped(): boolean;
  /** Cleanup resources */
  destroy(): void;
}

// --- Stage indicator symbols ---

const STAGE_SYMBOLS: Record<StageIndicator, string> = {
  completed: "\u2713",  // ✓
  in_progress: "\u25CF", // ●
  failed: "\u2717",      // ✗
  pending: "\u25CB",     // ○
};

// --- Display pipeline stages (excluding meta-stages) ---

const DISPLAY_STAGES: PipelineStage[] = [
  "setup",
  "implement",
  "test",
  "fix",
  "review",
  "pr",
  "cleanup",
];

// --- Helpers ---

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatDuration(ms: number): string {
  return formatElapsed(Math.round(ms / 1000));
}

// --- Non-interactive controls (no-op for CI / no TTY) ---

export function createNonInteractiveControls(): LoopControls {
  let abortController = new AbortController();

  return {
    startIssue(_issue: GitHubIssue): void {
      abortController = new AbortController();
    },
    onStage(_stage: PipelineStage, _message?: string): void {
      // No display in non-interactive mode
    },
    getAbortController(): AbortController {
      return abortController;
    },
    async betweenIssues(_result: PipelineResult, _nextIssue?: GitHubIssue): Promise<"continue" | "skip" | "quit"> {
      return "continue";
    },
    consumeContext(): string | undefined {
      return undefined;
    },
    shouldQuit(): boolean {
      return false;
    },
    wasSkipped(): boolean {
      return false;
    },
    destroy(): void {
      // Nothing to clean up
    },
  };
}

// --- Interactive controls ---

export function createInteractiveControls(logDir?: string): LoopControls {
  let currentIssue: GitHubIssue | undefined;
  let abortController = new AbortController();
  let quitRequested = false;
  let skipRequested = false;
  let userContext: string | undefined;
  let currentStage: PipelineStage = "setup";
  let stageStartTime = Date.now();
  let stageTimerInterval: ReturnType<typeof setInterval> | undefined;
  const stageHistory: Map<PipelineStage, StageInfo> = new Map();
  let stageMessage: string | undefined;

  // Track raw mode state
  let rawModeActive = false;
  let keypressHandler: ((chunk: Buffer) => void) | undefined;

  function startRawMode(): void {
    if (rawModeActive || !process.stdin.isTTY) return;
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      rawModeActive = true;

      keypressHandler = (chunk: Buffer) => {
        const key = chunk.toString();
        handleKeypress(key);
      };
      process.stdin.on("data", keypressHandler);
    } catch {
      // stdin may not support raw mode in some environments
    }
  }

  function stopRawMode(): void {
    if (!rawModeActive) return;
    try {
      if (keypressHandler) {
        process.stdin.removeListener("data", keypressHandler);
        keypressHandler = undefined;
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
      rawModeActive = false;
    } catch {
      // Best effort
    }
  }

  function handleKeypress(key: string): void {
    switch (key.toLowerCase()) {
      case "s":
        handleSkip();
        break;
      case "c":
        handleContext();
        break;
      case "v":
        handleViewLog();
        break;
      case "q":
        handleQuit();
        break;
      case "\u0003": // Ctrl+C
        process.emit("SIGINT", "SIGINT");
        break;
    }
  }

  function handleSkip(): void {
    if (!currentIssue) return;
    skipRequested = true;
    abortController.abort();
    writeStatus(`\nSkipping issue #${currentIssue.number}...`);
  }

  function handleContext(): void {
    stopRawMode();
    clearInterval(stageTimerInterval);
    stageTimerInterval = undefined;

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    process.stdout.write("\n\nAdditional context for the agent:\n> ");

    rl.on("line", (line: string) => {
      userContext = line.trim();
      rl.close();
      process.stdout.write("\nContext saved. Will be included in next agent prompt.\n\n");
      startRawMode();
      renderProgress();
      startTimer();
    });
  }

  function handleViewLog(): void {
    if (!currentIssue || !logDir) {
      writeStatus("\nNo log file available.\n");
      return;
    }

    const logFile = join(logDir, `issue-${currentIssue.number}.log`);
    if (!existsSync(logFile)) {
      writeStatus("\nLog file not yet created.\n");
      return;
    }

    stopRawMode();
    clearInterval(stageTimerInterval);
    stageTimerInterval = undefined;

    process.stdout.write("\n--- Live Log (press q or Esc to return) ---\n\n");

    try {
      // Show last 30 lines
      const content = readFileSync(logFile, "utf-8");
      const lines = content.split("\n");
      const tail = lines.slice(-30).join("\n");
      process.stdout.write(tail + "\n");
    } catch {
      process.stdout.write("(could not read log file)\n");
    }

    process.stdout.write("\n--- Press q or Esc to return ---\n");

    // Wait for q or Esc
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const exitLogView = (chunk: Buffer): void => {
      const k = chunk.toString();
      if (k === "q" || k === "\u001b") {
        process.stdin.removeListener("data", exitLogView);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        startRawMode();
        renderProgress();
        startTimer();
      }
    };
    process.stdin.on("data", exitLogView);
  }

  function handleQuit(): void {
    quitRequested = true;
    writeStatus("\nWill quit after current issue finishes.\n");
  }

  function writeStatus(msg: string): void {
    process.stdout.write(msg);
  }

  function renderProgress(): void {
    if (!currentIssue) return;

    // Build the progress display
    const lines: string[] = [];
    lines.push("");
    lines.push(`\u2501\u2501\u2501 Issue #${currentIssue.number}: ${currentIssue.title} \u2501\u2501\u2501`);

    for (const stageName of DISPLAY_STAGES) {
      const info = stageHistory.get(stageName);
      if (!info) continue;

      const symbol = STAGE_SYMBOLS[info.indicator];
      let line = `${symbol} ${stageName.padEnd(12)}`;

      if (info.indicator === "completed" && info.duration !== undefined) {
        line += `(${formatElapsed(info.duration)})`;
      } else if (info.indicator === "in_progress") {
        const elapsed = Math.round((Date.now() - stageStartTime) / 1000);
        line += stageMessage ? `${stageMessage}` : `(${formatElapsed(elapsed)})`;
      }

      lines.push(line);
    }

    lines.push("");
    if (quitRequested) {
      lines.push("[s] skip  [c] context  [v] view log  (quitting after this issue)");
    } else {
      lines.push("[s] skip  [c] context  [v] view log  [q] quit after current");
    }

    // Clear screen and redraw
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(lines.join("\n") + "\n");
  }

  function startTimer(): void {
    if (stageTimerInterval) return;
    stageTimerInterval = setInterval(() => {
      renderProgress();
    }, 1000);
  }

  function stopTimer(): void {
    if (stageTimerInterval) {
      clearInterval(stageTimerInterval);
      stageTimerInterval = undefined;
    }
  }

  return {
    startIssue(issue: GitHubIssue): void {
      currentIssue = issue;
      abortController = new AbortController();
      skipRequested = false;
      stageHistory.clear();
      currentStage = "setup";
      stageStartTime = Date.now();
      stageMessage = undefined;
      startRawMode();
      renderProgress();
      startTimer();
    },

    onStage(stage: PipelineStage, message?: string): void {
      // Mark previous stage as completed
      if (currentStage !== stage) {
        const prevInfo = stageHistory.get(currentStage);
        if (prevInfo && prevInfo.indicator === "in_progress") {
          prevInfo.indicator = "completed";
          prevInfo.duration = Math.round((Date.now() - stageStartTime) / 1000);
        }
      }

      // Handle terminal states
      if (stage === "done" || stage === "failed") {
        // Mark last display stage as completed/failed
        const lastInfo = stageHistory.get(currentStage);
        if (lastInfo && lastInfo.indicator === "in_progress") {
          lastInfo.indicator = stage === "done" ? "completed" : "failed";
          lastInfo.duration = Math.round((Date.now() - stageStartTime) / 1000);
        }
        stopTimer();
        stopRawMode();
        renderProgress();
        return;
      }

      // Only track display stages
      if (!DISPLAY_STAGES.includes(stage)) return;

      currentStage = stage;
      stageStartTime = Date.now();
      stageMessage = message;

      stageHistory.set(stage, {
        name: stage,
        indicator: "in_progress",
        attempt: message,
      });

      // Mark stages not yet reached as pending (for display ordering)
      let reached = false;
      for (const s of DISPLAY_STAGES) {
        if (s === stage) {
          reached = true;
          continue;
        }
        if (reached && !stageHistory.has(s)) {
          // Don't add future stages — they'll appear when reached
        }
      }

      renderProgress();
    },

    getAbortController(): AbortController {
      return abortController;
    },

    async betweenIssues(result: PipelineResult, nextIssue?: GitHubIssue): Promise<"continue" | "skip" | "quit"> {
      stopTimer();
      stopRawMode();

      // Show result
      const symbol = result.success ? "\u2713" : "\u2717";
      const duration = formatDuration(result.duration);
      let resultLine = `${symbol} #${result.issueNumber} ${result.success ? "completed" : "failed"} (${duration})`;
      if (result.prNumber) {
        resultLine += ` \u2014 PR #${result.prNumber} created`;
      }
      if (result.error) {
        resultLine += ` \u2014 ${result.error}`;
      }

      process.stdout.write(`\n${resultLine}\n`);

      if (quitRequested || !nextIssue) {
        return "quit";
      }

      process.stdout.write(`\nNext: #${nextIssue.number} ${nextIssue.title}\n`);
      process.stdout.write("Press Enter to continue, [s] to skip, [q] to quit: ");

      return new Promise((resolve) => {
        process.stdin.setRawMode(true);
        process.stdin.resume();

        const handler = (chunk: Buffer): void => {
          const key = chunk.toString();
          process.stdin.removeListener("data", handler);
          try {
            process.stdin.setRawMode(false);
            process.stdin.pause();
          } catch {
            // Best effort
          }

          if (key === "\r" || key === "\n") {
            process.stdout.write("\n");
            resolve("continue");
          } else if (key.toLowerCase() === "s") {
            process.stdout.write("skip\n");
            resolve("skip");
          } else if (key.toLowerCase() === "q" || key === "\u0003") {
            process.stdout.write("quit\n");
            resolve("quit");
          } else {
            // Default: continue
            process.stdout.write("\n");
            resolve("continue");
          }
        };

        process.stdin.on("data", handler);
      });
    },

    consumeContext(): string | undefined {
      const ctx = userContext;
      userContext = undefined;
      return ctx;
    },

    shouldQuit(): boolean {
      return quitRequested;
    },

    wasSkipped(): boolean {
      return skipRequested;
    },

    destroy(): void {
      stopTimer();
      stopRawMode();
    },
  };
}

// --- Context injection helper ---

export function injectContext(prompt: string, context: string): string {
  return `${prompt}\n\n## Additional Context from User\n\n${context}`;
}

// --- Factory ---

export function createControls(options?: { logDir?: string }): LoopControls {
  if (!process.stdin.isTTY) {
    return createNonInteractiveControls();
  }
  return createInteractiveControls(options?.logDir);
}
