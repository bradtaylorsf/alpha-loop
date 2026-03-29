import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { stringify } from "yaml";
import type { PipelineResult } from "../engine/loop.js";
import type { LoopResults } from "../engine/loop.js";
import type { GitHubIssue } from "../engine/github.js";
import type { MergeStrategy } from "./config.js";
import type { ArtifactInfo } from "../engine/artifacts.js";
import { formatArtifactCounts, formatArtifactLinks } from "../engine/artifacts.js";

// --- Types ---

export type IssueStatus = "success" | "failed" | "skipped";

export interface IssueResultEntry {
  number: number;
  title: string;
  status: IssueStatus;
  prNumber?: number;
  prUrl?: string;
  error?: string;
  duration: number; // ms
  artifacts?: ArtifactInfo;
}

export interface SessionSummaryData {
  sessionName: string;
  repo: string;
  started: string; // ISO
  completed: string; // ISO
  duration: number; // seconds
  model: string;
  mergeStrategy: MergeStrategy;
  issues: IssueResultEntry[];
}

// --- Helpers ---

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

const SEPARATOR = "\u2550".repeat(39);

// --- Build issue results from loop output ---

export function buildIssueResults(
  loopResults: LoopResults,
  owner: string,
  repo: string,
): IssueResultEntry[] {
  const entries: IssueResultEntry[] = [];

  // Add processed issues from pipeline results
  for (const result of loopResults.results) {
    const issue = loopResults.issues.get(result.issueNumber);
    const title = issue?.title ?? `Issue #${result.issueNumber}`;
    const isSkipped = result.error === "Skipped by user";

    const entry: IssueResultEntry = {
      number: result.issueNumber,
      title,
      status: isSkipped ? "skipped" : result.success ? "success" : "failed",
      duration: result.duration,
    };

    if (result.prNumber) {
      entry.prNumber = result.prNumber;
      entry.prUrl = `https://github.com/${owner}/${repo}/pull/${result.prNumber}`;
    }
    if (result.error && !isSkipped) {
      entry.error = result.error;
    }
    if (result.artifacts) {
      entry.artifacts = result.artifacts;
    }

    entries.push(entry);
  }

  // Add skipped issues that were never processed (skipped at between-issues prompt)
  for (const issueNumber of loopResults.skippedIssues) {
    // Don't duplicate if already in results (e.g., skipped via 's' key during processing)
    if (entries.some((e) => e.number === issueNumber)) continue;
    const issue = loopResults.issues.get(issueNumber);
    entries.push({
      number: issueNumber,
      title: issue?.title ?? `Issue #${issueNumber}`,
      status: "skipped",
      duration: 0,
    });
  }

  return entries;
}

// --- Format session summary for display ---

export function formatPostRunSummary(data: SessionSummaryData): string {
  const lines: string[] = [];

  lines.push("");
  lines.push(SEPARATOR);
  lines.push(`Session Complete: ${data.sessionName}`);
  lines.push(`Duration: ${formatDurationSeconds(data.duration)}`);
  lines.push(SEPARATOR);
  lines.push("");

  for (const issue of data.issues) {
    const symbol =
      issue.status === "success" ? "\u2713" :
      issue.status === "failed" ? "\u2717" :
      "\u2298"; // ⊘

    const statusText =
      issue.status === "success" ? `PR #${issue.prNumber ?? "?"}` :
      issue.status === "failed" ? "FAILED" :
      "SKIPPED";

    const duration = formatDuration(issue.duration);
    let line = `${symbol} #${issue.number}  ${issue.title.padEnd(24)} ${statusText.padEnd(9)} (${duration})`;

    if (issue.error) {
      line += ` \u2014 ${issue.error}`;
    }
    if (issue.status === "skipped") {
      line += " \u2014 user skipped";
    }
    if (issue.artifacts) {
      const counts = formatArtifactCounts(issue.artifacts);
      if (counts) line += `  ${counts}`;
    }

    lines.push(line);
  }

  lines.push("");
  return lines.join("\n");
}

// --- QA Checklist ---

export interface QAChecklistEntry {
  prNumber: number;
  issueTitle: string;
  changedFiles: string;
  checklistItems: string[];
  artifacts?: ArtifactInfo;
}

export function generateQAChecklist(
  issues: IssueResultEntry[],
  issueMap: Map<number, GitHubIssue>,
): QAChecklistEntry[] {
  const entries: QAChecklistEntry[] = [];

  for (const issue of issues) {
    if (issue.status !== "success" || !issue.prNumber) continue;

    const ghIssue = issueMap.get(issue.number);
    const body = ghIssue?.body ?? "";

    // Extract acceptance criteria from issue body
    const checklistItems = extractChecklistItems(body, issue.title);

    entries.push({
      prNumber: issue.prNumber,
      issueTitle: issue.title,
      changedFiles: "", // Will be populated if diff info available
      checklistItems,
      artifacts: issue.artifacts,
    });
  }

  return entries;
}

function extractChecklistItems(issueBody: string, issueTitle: string): string[] {
  const items: string[] = [];

  // Extract from acceptance criteria section
  const acMatch = issueBody.match(
    /##\s*Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/i,
  );
  if (acMatch) {
    const criteria = acMatch[1].trim();
    // Extract checklist items (lines starting with - [ ] or - [x])
    const checklistLines = criteria.match(/^[-*]\s*\[[ x]\]\s*.+$/gm);
    if (checklistLines) {
      for (const line of checklistLines) {
        const text = line.replace(/^[-*]\s*\[[ x]\]\s*/, "").trim();
        if (text) items.push(text);
      }
    }
  }

  // If no items found, generate basic ones from the title
  if (items.length === 0) {
    items.push(`Verify "${issueTitle}" works as expected`);
    items.push("Check for regressions in related functionality");
  }

  return items;
}

export function formatQAChecklist(entries: QAChecklistEntry[]): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];

  lines.push(SEPARATOR);
  lines.push("QA Checklist");
  lines.push(SEPARATOR);
  lines.push("");

  for (const entry of entries) {
    lines.push(`PR #${entry.prNumber} \u2014 ${entry.issueTitle}:`);
    if (entry.changedFiles) {
      lines.push(`  Changed: ${entry.changedFiles}`);
    }
    for (const item of entry.checklistItems) {
      lines.push(`  \u25A1 ${item}`);
    }
    if (entry.artifacts) {
      const artifactLines = formatArtifactLinks(entry.artifacts);
      lines.push(...artifactLines);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// --- Save session files ---

export function buildSessionYaml(data: SessionSummaryData): Record<string, unknown> {
  return {
    name: data.sessionName,
    repo: data.repo,
    started: data.started,
    completed: data.completed,
    duration: data.duration,
    model: data.model,
    merge_strategy: data.mergeStrategy,
    issues: data.issues.map((issue) => {
      const entry: Record<string, unknown> = {
        number: issue.number,
        status: issue.status,
      };
      if (issue.prUrl) entry.pr_url = issue.prUrl;
      if (issue.error) entry.error = issue.error;
      entry.duration = Math.round(issue.duration / 1000);
      if (issue.artifacts) {
        entry.artifacts = {
          screenshots: issue.artifacts.screenshots.length,
          videos: issue.artifacts.videos.length,
          dir: issue.artifacts.artifactsDir,
        };
      }
      return entry;
    }),
  };
}

export function saveSessionFiles(
  data: SessionSummaryData,
  qaChecklist: string,
  baseDir: string = process.cwd(),
): { sessionDir: string; sessionYamlPath: string; qaChecklistPath: string } {
  const sessionDir = join(baseDir, "sessions", data.sessionName);
  mkdirSync(sessionDir, { recursive: true });

  const sessionYamlPath = join(sessionDir, "session.yaml");
  writeFileSync(sessionYamlPath, stringify(buildSessionYaml(data)), "utf-8");

  const qaChecklistPath = join(sessionDir, "qa-checklist.md");
  const qaContent = `# QA Checklist \u2014 ${data.sessionName}\n\nGenerated: ${data.completed}\n\n${qaChecklist}`;
  writeFileSync(qaChecklistPath, qaContent, "utf-8");

  return { sessionDir, sessionYamlPath, qaChecklistPath };
}

// --- Post-run interactive options ---

export interface PostRunAction {
  type: "open_prs" | "retry_failed" | "view_log" | "done";
  failedIssues?: number[];
}

export function formatPostRunOptions(
  issues: IssueResultEntry[],
): string {
  const hasPRs = issues.some((i) => i.prUrl);
  const failedIssues = issues.filter((i) => i.status === "failed");
  const hasFailed = failedIssues.length > 0;

  const lines: string[] = [];
  lines.push("What's next?");

  if (hasPRs) {
    lines.push("  [1] Open PRs in browser");
  }
  if (hasFailed) {
    const nums = failedIssues.map((i) => `#${i.number}`).join(", ");
    lines.push(`  [2] Retry failed issues (${nums})`);
  }
  lines.push("  [3] View full session log");
  lines.push("  [4] Done");
  lines.push("");

  return lines.join("\n");
}

export async function promptPostRunAction(
  issues: IssueResultEntry[],
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<PostRunAction> {
  const hasPRs = issues.some((i) => i.prUrl);
  const failedIssues = issues.filter((i) => i.status === "failed");

  output.write(formatPostRunOptions(issues));

  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    rl.question("Choose [1-4]: ", (answer) => {
      rl.close();
      const choice = answer.trim();
      switch (choice) {
        case "1":
          if (hasPRs) {
            resolve({ type: "open_prs" });
            return;
          }
          break;
        case "2":
          if (failedIssues.length > 0) {
            resolve({ type: "retry_failed", failedIssues: failedIssues.map((i) => i.number) });
            return;
          }
          break;
        case "3":
          resolve({ type: "view_log" });
          return;
        case "4":
          resolve({ type: "done" });
          return;
      }
      // Default to done for invalid input
      resolve({ type: "done" });
    });
  });
}

// --- Execute post-run actions ---

export function openPRsInBrowser(issues: IssueResultEntry[]): void {
  const prUrls = issues
    .filter((i) => i.prUrl)
    .map((i) => i.prUrl!);

  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  for (const url of prUrls) {
    try {
      execSync(`${openCmd} ${url}`, { stdio: "ignore", timeout: 5000 });
    } catch {
      // Best effort — user may not have a browser
    }
  }
}

export function viewSessionLog(sessionDir: string): void {
  const logFiles = ["session.log", "combined.log"];
  for (const file of logFiles) {
    const logPath = join(sessionDir, file);
    if (existsSync(logPath)) {
      try {
        execSync(`less ${logPath}`, { stdio: "inherit" });
      } catch {
        // User quit less, that's fine
      }
      return;
    }
  }
  // Fallback: show session.yaml
  const yamlPath = join(sessionDir, "session.yaml");
  if (existsSync(yamlPath)) {
    const content = readFileSync(yamlPath, "utf-8");
    process.stdout.write(content + "\n");
  } else {
    process.stdout.write("No session log found.\n");
  }
}

// --- Main post-run flow ---

export async function showPostRunSummary(
  loopResults: LoopResults,
  sessionName: string,
  owner: string,
  repo: string,
  model: string,
  mergeStrategy: MergeStrategy,
  startedAt: Date,
): Promise<PostRunAction> {
  const completedAt = new Date();
  const durationSeconds = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);

  const issueResults = buildIssueResults(loopResults, owner, repo);

  const summaryData: SessionSummaryData = {
    sessionName,
    repo: `${owner}/${repo}`,
    started: startedAt.toISOString(),
    completed: completedAt.toISOString(),
    duration: durationSeconds,
    model,
    mergeStrategy,
    issues: issueResults,
  };

  // Display summary
  process.stdout.write(formatPostRunSummary(summaryData));

  // Generate and display QA checklist
  const qaEntries = generateQAChecklist(issueResults, loopResults.issues);
  const qaText = formatQAChecklist(qaEntries);
  if (qaText) {
    process.stdout.write(qaText);
  }

  // Save session files
  const { sessionDir } = saveSessionFiles(summaryData, qaText);
  process.stdout.write(`Session saved to ${sessionDir}/\n\n`);

  // Show post-run options
  if (!process.stdin.isTTY) {
    return { type: "done" };
  }

  const action = await promptPostRunAction(issueResults);

  // Execute the action
  switch (action.type) {
    case "open_prs":
      openPRsInBrowser(issueResults);
      break;
    case "view_log":
      viewSessionLog(sessionDir);
      break;
    case "retry_failed":
    case "done":
      break;
  }

  return action;
}
