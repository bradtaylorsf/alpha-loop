import * as readline from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { LoopConfig } from "../engine/loop.js";
import type { IssueWithDeps } from "./issues.js";

// --- Types ---

export type MergeStrategy = "session-branch" | "auto-merge-master" | "no-merge";

export interface SessionConfig {
  model: string;
  reviewModel: string;
  maxTurns: number;
  mergeStrategy: MergeStrategy;
  skipTests: boolean;
  skipReview: boolean;
  sessionName: string;
}

// --- Readline helpers ---

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// --- Default session name ---

export function defaultSessionName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `session/${date}-${time}`;
}

// --- Config Display ---

export function formatConfigDisplay(config: SessionConfig): string {
  const lines = [
    "",
    "Configuration:",
    `  Model:          ${config.model}`,
    `  Review Model:   ${config.reviewModel}`,
    `  Max Turns:      ${config.maxTurns}`,
    `  Merge Strategy: ${formatMergeStrategy(config.mergeStrategy)}`,
    `  Skip Tests:     ${config.skipTests ? "yes" : "no"}`,
    `  Skip Review:    ${config.skipReview ? "yes" : "no"}`,
    "",
  ];
  return lines.join("\n");
}

export function formatMergeStrategy(strategy: MergeStrategy): string {
  switch (strategy) {
    case "session-branch":
      return "session branch";
    case "auto-merge-master":
      return "auto-merge to master";
    case "no-merge":
      return "no auto-merge (PRs only)";
  }
}

// --- Merge Strategy Prompt ---

const MERGE_STRATEGY_PROMPT = `
Merge strategy:
  [1] Auto-merge to session branch (safe, review all together later)
  [2] Auto-merge to master (changes go live immediately)
  [3] Don't auto-merge (just create PRs for manual review)
`;

export function parseMergeStrategyChoice(input: string): MergeStrategy | null {
  switch (input) {
    case "1":
      return "session-branch";
    case "2":
      return "auto-merge-master";
    case "3":
      return "no-merge";
    default:
      return null;
  }
}

// --- Session Summary ---

export function formatSessionSummary(
  sessionName: string,
  repoStr: string,
  issues: IssueWithDeps[],
  config: SessionConfig,
): string {
  const issueList = issues.map((i) => `#${i.number}`).join(", ");
  const lines = [
    "",
    "\u2550".repeat(39),
    `Session: ${sessionName}`,
    `Repo:    ${repoStr}`,
    `Issues:  ${issues.length} (${issueList})`,
    `Model:   ${config.model}`,
    `Merge:   ${formatMergeStrategy(config.mergeStrategy)}`,
    "\u2550".repeat(39),
    "",
  ];
  return lines.join("\n");
}

// --- .alpha-loop.yaml persistence ---

export interface AlphaLoopYaml {
  agent?: {
    model?: string;
    reviewModel?: string;
    maxTurns?: number;
  };
  merge?: {
    strategy?: MergeStrategy;
  };
  tests?: {
    skipTests?: boolean;
    skipReview?: boolean;
  };
}

export function loadAlphaLoopYaml(cwd: string = process.cwd()): AlphaLoopYaml {
  const configPath = resolve(cwd, ".alpha-loop.yaml");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    return (parse(raw) as AlphaLoopYaml) ?? {};
  } catch {
    return {};
  }
}

export function saveAlphaLoopYaml(
  config: SessionConfig,
  cwd: string = process.cwd(),
): void {
  const configPath = resolve(cwd, ".alpha-loop.yaml");
  const data: AlphaLoopYaml = {
    agent: {
      model: config.model,
      reviewModel: config.reviewModel,
      maxTurns: config.maxTurns,
    },
    merge: {
      strategy: config.mergeStrategy,
    },
    tests: {
      skipTests: config.skipTests,
      skipReview: config.skipReview,
    },
  };
  writeFileSync(configPath, stringify(data), "utf-8");
}

// --- Setting editor ---

const EDITABLE_SETTINGS: Record<string, { prompt: string; parse: (input: string) => unknown }> = {
  model: {
    prompt: "Model (e.g. opus, sonnet, haiku): ",
    parse: (input) => input || null,
  },
  "review model": {
    prompt: "Review model (e.g. opus, sonnet, haiku): ",
    parse: (input) => input || null,
  },
  "max turns": {
    prompt: "Max turns (number): ",
    parse: (input) => {
      const n = Number(input);
      return !isNaN(n) && n > 0 ? n : null;
    },
  },
  "merge strategy": {
    prompt: MERGE_STRATEGY_PROMPT + "Choose [1/2/3]: ",
    parse: (input) => parseMergeStrategyChoice(input),
  },
  "skip tests": {
    prompt: "Skip tests? [y/N]: ",
    parse: (input) => input.toLowerCase() === "y",
  },
  "skip review": {
    prompt: "Skip review? [y/N]: ",
    parse: (input) => input.toLowerCase() === "y",
  },
};

function matchSetting(input: string): string | null {
  const lower = input.toLowerCase();
  for (const key of Object.keys(EDITABLE_SETTINGS)) {
    if (key.startsWith(lower) || key.replace(/\s+/g, "").startsWith(lower)) {
      return key;
    }
  }
  return null;
}

async function editSetting(
  rl: readline.Interface,
  config: SessionConfig,
  settingName: string,
): Promise<void> {
  const setting = EDITABLE_SETTINGS[settingName];
  if (!setting) return;

  const input = await ask(rl, setting.prompt);
  const value = setting.parse(input);

  if (value === null) {
    console.log("Invalid value, keeping current setting.");
    return;
  }

  switch (settingName) {
    case "model":
      config.model = value as string;
      break;
    case "review model":
      config.reviewModel = value as string;
      break;
    case "max turns":
      config.maxTurns = value as number;
      break;
    case "merge strategy":
      config.mergeStrategy = value as MergeStrategy;
      break;
    case "skip tests":
      config.skipTests = value as boolean;
      break;
    case "skip review":
      config.skipReview = value as boolean;
      break;
  }
}

// --- Interactive config flow ---

export function buildSessionConfig(loopConfig: LoopConfig): SessionConfig {
  const alphaLoop = loadAlphaLoopYaml();
  return {
    model: alphaLoop.agent?.model ?? loopConfig.model,
    reviewModel: alphaLoop.agent?.reviewModel ?? loopConfig.reviewModel ?? loopConfig.model,
    maxTurns: alphaLoop.agent?.maxTurns ?? loopConfig.maxTurns,
    mergeStrategy: alphaLoop.merge?.strategy ?? "session-branch",
    skipTests: alphaLoop.tests?.skipTests ?? loopConfig.skipTests,
    skipReview: alphaLoop.tests?.skipReview ?? loopConfig.skipReview,
    sessionName: defaultSessionName(),
  };
}

export async function interactiveConfig(
  loopConfig: LoopConfig,
  repoStr: string,
  issues: IssueWithDeps[],
): Promise<SessionConfig | null> {
  const config = buildSessionConfig(loopConfig);
  const rl = createInterface();

  try {
    // Step 1: Show config and allow edits
    while (true) {
      console.log(formatConfigDisplay(config));
      const input = await ask(rl, "Change? (type setting name, or Enter to continue): ");

      if (input === "") break;

      const matched = matchSetting(input);
      if (matched) {
        await editSetting(rl, config, matched);
      } else {
        console.log(
          `Unknown setting: "${input}". Options: model, review model, max turns, merge strategy, skip tests, skip review`,
        );
      }
    }

    // Step 2: Session naming
    const sessionDefault = defaultSessionName();
    const sessionInput = await ask(
      rl,
      `Session name (default: ${sessionDefault}): `,
    );
    config.sessionName = sessionInput || sessionDefault;

    // Step 3: Final summary and confirmation
    console.log(formatSessionSummary(config.sessionName, repoStr, issues, config));
    const startAnswer = await ask(rl, "Start? [Y/n] ");
    if (startAnswer.toLowerCase() === "n") {
      console.log("Cancelled.");
      return null;
    }

    // Step 4: Save defaults prompt
    const saveAnswer = await ask(
      rl,
      "Save these settings as defaults for this repo? [y/N] ",
    );
    if (saveAnswer.toLowerCase() === "y") {
      saveAlphaLoopYaml(config);
      console.log("Saved to .alpha-loop.yaml");
    }

    return config;
  } finally {
    rl.close();
  }
}

// --- Non-interactive mode ---

export interface ConfigFlags {
  model?: string;
  "review-model"?: string;
  "max-turns"?: string;
  "merge-strategy"?: string;
  "session-name"?: string;
  "skip-tests"?: boolean;
  "skip-review"?: boolean;
}

export function hasAllConfigFlags(flags: ConfigFlags): boolean {
  return !!(
    flags.model &&
    flags["session-name"] &&
    flags["merge-strategy"]
  );
}

export function buildSessionConfigFromFlags(
  loopConfig: LoopConfig,
  flags: ConfigFlags,
): SessionConfig {
  const base = buildSessionConfig(loopConfig);

  if (flags.model) base.model = flags.model;
  if (flags["review-model"]) base.reviewModel = flags["review-model"];
  if (flags["max-turns"]) {
    const n = Number(flags["max-turns"]);
    if (!isNaN(n) && n > 0) base.maxTurns = n;
  }
  if (flags["merge-strategy"]) {
    const strategy = flags["merge-strategy"] as MergeStrategy;
    if (["session-branch", "auto-merge-master", "no-merge"].includes(strategy)) {
      base.mergeStrategy = strategy;
    }
  }
  if (flags["session-name"]) base.sessionName = flags["session-name"];
  if (flags["skip-tests"] !== undefined) base.skipTests = !!flags["skip-tests"];
  if (flags["skip-review"] !== undefined) base.skipReview = !!flags["skip-review"];

  return base;
}
