#!/usr/bin/env node

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { defaultConfig, startLoop } from "../engine/loop.js";
import type { LoopConfig } from "../engine/loop.js";
import { createGitHubClient } from "../engine/github.js";
import { createRunnerFromConfig } from "../engine/runners/index.js";
import { createServer } from "../server/index.js";

// --- Help text ---

const USAGE = `
alpha-loop — Agent-agnostic automated development loop

Usage:
  alpha-loop                     Run the loop continuously
  alpha-loop dashboard           Start Express server + React dashboard only
  alpha-loop --once              Process one batch of issues and exit
  alpha-loop --dry-run           Preview mode (no changes)
  alpha-loop --help              Show this help

Options:
  --model <model>                AI model to use (default: from config or "sonnet")
  --repo <owner/repo>            GitHub repository (default: from config or REPO env)
  --project <num>                GitHub project number
  --once                         Process one batch and exit
  --dry-run                      Preview mode, no changes
  --auto-merge                   Auto-merge PRs when checks pass
  --merge-to <branch>            Base branch for PRs (default: "master")
  --skip-tests                   Skip test stage
  --skip-review                  Skip review stage
  --skip-e2e                     Skip e2e tests
  --api-port <port>              Port for Express API server (default: 4000)
  --help                         Show this help
`.trim();

// --- Config loading ---

interface YamlConfig {
  loop?: {
    repo?: string;
    baseBranch?: string;
    pollInterval?: number;
    maxTestRetries?: number;
    labels?: { ready?: string };
  };
  agent?: {
    name?: string;
    model?: string;
    reviewModel?: string;
    maxTurns?: number;
  };
  tests?: {
    skipTests?: boolean;
    skipReview?: boolean;
  };
}

function loadYamlConfig(): YamlConfig {
  const configPath = resolve(process.cwd(), "config.yaml");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf-8");
    return (parse(raw) as YamlConfig) ?? {};
  } catch {
    return {};
  }
}

function parseRepo(repoStr: string): { owner: string; repo: string } {
  const parts = repoStr.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${repoStr}". Expected "owner/repo".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

// --- CLI arg parsing ---

export function parseCliArgs(argv: string[]): {
  command: "loop" | "dashboard" | "help";
  options: Record<string, string | boolean | undefined>;
} {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "auto-merge": { type: "boolean", default: false },
      "skip-tests": { type: "boolean", default: false },
      "skip-review": { type: "boolean", default: false },
      "skip-e2e": { type: "boolean", default: false },
      model: { type: "string" },
      repo: { type: "string" },
      project: { type: "string" },
      "merge-to": { type: "string" },
      "api-port": { type: "string" },
    },
  });

  if (values.help) {
    return { command: "help", options: values };
  }

  if (positionals.includes("dashboard")) {
    return { command: "dashboard", options: values };
  }

  return { command: "loop", options: values };
}

// --- Build config from all sources ---

export function buildConfig(options: Record<string, string | boolean | undefined>): LoopConfig {
  const yaml = loadYamlConfig();

  // Env vars (backwards compat with loop.sh)
  const envRepo = process.env.REPO;
  const envModel = process.env.MODEL;
  const envMaxTurns = process.env.MAX_TURNS ? Number(process.env.MAX_TURNS) : undefined;
  const envPollInterval = process.env.POLL_INTERVAL ? Number(process.env.POLL_INTERVAL) : undefined;
  const envBaseBranch = process.env.BASE_BRANCH;
  const envSkipTests = process.env.SKIP_TESTS === "true";
  const envSkipReview = process.env.SKIP_REVIEW === "true";
  const envDryRun = process.env.DRY_RUN === "true";

  // Config priority: CLI flags > env vars > config.yaml > defaults
  const repoStr = (options.repo as string) ?? envRepo ?? yaml.loop?.repo;
  const { owner, repo } = repoStr ? parseRepo(repoStr) : { owner: "owner", repo: "repo" };

  return defaultConfig({
    owner,
    repo,
    baseBranch: (options["merge-to"] as string) ?? envBaseBranch ?? yaml.loop?.baseBranch,
    model: (options.model as string) ?? envModel ?? yaml.agent?.model,
    reviewModel: yaml.agent?.reviewModel,
    maxTurns: envMaxTurns ?? yaml.agent?.maxTurns,
    maxTestRetries: yaml.loop?.maxTestRetries,
    pollInterval: envPollInterval ?? yaml.loop?.pollInterval,
    label: yaml.loop?.labels?.ready,
    skipTests: (options["skip-tests"] as boolean) || envSkipTests || yaml.tests?.skipTests || false,
    skipReview: (options["skip-review"] as boolean) || envSkipReview || yaml.tests?.skipReview || false,
    dryRun: (options["dry-run"] as boolean) || envDryRun,
    autoCleanup: true,
  });
}

// --- Main ---

async function main(): Promise<void> {
  const { command, options } = parseCliArgs(process.argv.slice(2));

  if (command === "help") {
    console.log(USAGE);
    return;
  }

  if (command === "dashboard") {
    const port = options["api-port"] ? Number(options["api-port"]) : undefined;
    createServer({ port });
    console.log("Dashboard mode — loop is NOT running. Visit http://localhost:" + (port ?? 4000));
    return;
  }

  // Loop mode
  const config = buildConfig(options);
  const agentName = loadYamlConfig().agent?.name ?? "claude";
  const runner = createRunnerFromConfig(agentName);
  const github = createGitHubClient(config.owner, config.repo);
  const port = options["api-port"] ? Number(options["api-port"]) : undefined;

  // Start Express server in background for monitoring
  const { db } = createServer({ port });

  console.log(`Starting loop: ${config.owner}/${config.repo} (model: ${config.model})`);
  if (options.once) console.log("Mode: --once (single batch)");
  if (config.dryRun) console.log("Mode: --dry-run (preview only)");

  await startLoop(config, runner, github, undefined, {
    db,
    once: options.once as boolean,
  });
}

// Only run main() when executed directly (not imported in tests)
const isDirectRun =
  process.argv[1]?.endsWith("/dist/cli/index.js") ||
  process.argv[1]?.endsWith("/src/cli/index.ts");

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
