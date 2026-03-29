import { readdirSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// --- Types ---

export interface SessionRecord {
  name: string;
  date: string; // ISO or human-readable
  issueCount: number;
  successCount: number;
  failedCount: number;
  duration: number; // seconds
  dirPath: string;
}

export interface SessionDetail {
  name: string;
  date: string;
  repo: string;
  model: string;
  duration: number; // seconds
  mergeStrategy: string;
  issues: SessionIssueRecord[];
  qaChecklistPath: string;
  logsDir: string;
}

export interface SessionIssueRecord {
  number: number;
  title?: string;
  status: "success" | "failed" | "skipped";
  prNumber?: number;
  prUrl?: string;
  error?: string;
  duration: number; // seconds
}

// --- Helpers ---

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function formatDateShort(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return isoDate;
  }
}

function formatDateFull(isoDate: string): string {
  try {
    const d = new Date(isoDate);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return isoDate;
  }
}

// --- Parse session.yaml ---

interface SessionYamlData {
  name?: string;
  repo?: string;
  started?: string;
  completed?: string;
  duration?: number;
  model?: string;
  merge_strategy?: string;
  issues?: Array<{
    number?: number;
    title?: string;
    status?: string;
    pr_number?: number;
    pr_url?: string;
    error?: string;
    duration?: number;
  }>;
}

function parseSessionYaml(filePath: string): SessionYamlData | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return parse(content) as SessionYamlData;
  } catch {
    return null;
  }
}

// --- List all sessions ---

export function listSessions(baseDir: string): SessionRecord[] {
  const sessionsDir = join(baseDir, "sessions");
  if (!existsSync(sessionsDir)) return [];

  const records: SessionRecord[] = [];

  // Scan for session directories (may be nested like session/20260330-091500)
  const scanDir = (dir: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const sessionYamlPath = join(fullPath, "session.yaml");
      const name = prefix ? `${prefix}/${entry}` : entry;

      if (existsSync(sessionYamlPath)) {
        const data = parseSessionYaml(sessionYamlPath);
        if (data) {
          const issues = data.issues ?? [];
          const successCount = issues.filter((i) => i.status === "success").length;
          const failedCount = issues.filter((i) => i.status === "failed").length;

          records.push({
            name: data.name ?? name,
            date: data.started ?? "",
            issueCount: issues.length,
            successCount,
            failedCount,
            duration: data.duration ?? 0,
            dirPath: fullPath,
          });
        }
      } else {
        // Recurse into subdirectory (handles session/20260330-091500 nesting)
        scanDir(fullPath, name);
      }
    }
  };

  scanDir(sessionsDir, "");

  // Sort by date descending
  records.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return records;
}

// --- Get session detail ---

export function getSessionDetail(baseDir: string, sessionName: string): SessionDetail | null {
  const sessionsDir = join(baseDir, "sessions");

  // Try direct path first
  let sessionDir = join(sessionsDir, sessionName);
  let sessionYamlPath = join(sessionDir, "session.yaml");

  if (!existsSync(sessionYamlPath)) {
    // Try to find by name in all sessions
    const allSessions = listSessions(baseDir);
    const match = allSessions.find((s) => s.name === sessionName);
    if (match) {
      sessionDir = match.dirPath;
      sessionYamlPath = join(sessionDir, "session.yaml");
    } else {
      return null;
    }
  }

  const data = parseSessionYaml(sessionYamlPath);
  if (!data) return null;

  const issues: SessionIssueRecord[] = (data.issues ?? []).map((i) => ({
    number: i.number ?? 0,
    title: i.title,
    status: (i.status as SessionIssueRecord["status"]) ?? "failed",
    prNumber: i.pr_number,
    prUrl: i.pr_url,
    error: i.error,
    duration: i.duration ?? 0,
  }));

  return {
    name: data.name ?? sessionName,
    date: data.started ?? "",
    repo: data.repo ?? "",
    model: data.model ?? "",
    duration: data.duration ?? 0,
    mergeStrategy: data.merge_strategy ?? "",
    issues,
    qaChecklistPath: join(sessionDir, "qa-checklist.md"),
    logsDir: join(sessionDir, "logs"),
  };
}

// --- Format session list ---

export function formatSessionList(sessions: SessionRecord[]): string {
  if (sessions.length === 0) {
    return "No sessions found.\n";
  }

  const lines: string[] = [];
  lines.push("Sessions:");

  for (const s of sessions) {
    const date = formatDateShort(s.date);
    const issueWord = s.issueCount === 1 ? "issue" : "issues";
    const duration = formatDurationSeconds(s.duration);

    let statusParts: string[] = [];
    if (s.successCount > 0) statusParts.push(`${s.successCount} \u2713`);
    if (s.failedCount > 0) statusParts.push(`${s.failedCount} \u2717`);
    const skipped = s.issueCount - s.successCount - s.failedCount;
    if (skipped > 0) statusParts.push(`${skipped} \u2298`);
    const statusStr = statusParts.join(" ");

    lines.push(
      `  ${s.name.padEnd(30)} ${date}  ${s.issueCount} ${issueWord.padEnd(7)} ${statusStr.padEnd(10)} ${duration}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

// --- Format session detail ---

export function formatSessionDetail(detail: SessionDetail): string {
  const lines: string[] = [];

  lines.push(`Session: ${detail.name}`);
  lines.push(`Date:    ${formatDateFull(detail.date)}`);
  if (detail.repo) lines.push(`Repo:    ${detail.repo}`);
  if (detail.model) lines.push(`Model:   ${detail.model}`);
  lines.push(`Duration: ${formatDurationSeconds(detail.duration)}`);
  lines.push("");

  lines.push("Issues:");
  for (const issue of detail.issues) {
    const symbol =
      issue.status === "success" ? "\u2713" :
      issue.status === "failed" ? "\u2717" :
      "\u2298";

    const titleStr = issue.title ?? `Issue #${issue.number}`;
    const duration = formatDurationSeconds(issue.duration);

    let statusText: string;
    if (issue.status === "success") {
      // Extract PR number from prUrl if prNumber not stored directly
      const prNum = issue.prNumber ?? extractPrNumber(issue.prUrl);
      statusText = prNum ? `PR #${prNum}` : "SUCCESS";
    } else if (issue.status === "failed") {
      statusText = "FAILED";
    } else {
      statusText = "SKIPPED";
    }

    let line = `  ${symbol} #${issue.number}  ${titleStr.padEnd(24)} ${statusText.padEnd(9)} (${duration})`;
    if (issue.error) {
      line += ` \u2014 ${issue.error}`;
    }
    lines.push(line);
  }

  lines.push("");
  lines.push(`QA Checklist: ${detail.qaChecklistPath}`);
  lines.push(`Logs:         ${detail.logsDir}`);
  lines.push("");

  return lines.join("\n");
}

function extractPrNumber(prUrl?: string): number | undefined {
  if (!prUrl) return undefined;
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

// --- Read QA checklist ---

export function readQAChecklist(baseDir: string, sessionName: string): string | null {
  const detail = getSessionDetail(baseDir, sessionName);
  if (!detail) return null;

  if (!existsSync(detail.qaChecklistPath)) return null;

  try {
    return readFileSync(detail.qaChecklistPath, "utf-8");
  } catch {
    return null;
  }
}

// --- Clean old sessions ---

export function cleanOldSessions(baseDir: string, maxAgeDays: number = 30): string[] {
  const sessions = listSessions(baseDir);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const session of sessions) {
    if (!session.date) continue;
    const sessionDate = new Date(session.date).getTime();
    if (isNaN(sessionDate)) continue;

    if (sessionDate < cutoff) {
      try {
        rmSync(session.dirPath, { recursive: true, force: true });
        removed.push(session.name);
      } catch {
        // Best effort removal
      }
    }
  }

  return removed;
}

// --- Format clean results ---

export function formatCleanResults(removed: string[]): string {
  if (removed.length === 0) {
    return "No sessions older than 30 days found.\n";
  }

  const lines: string[] = [];
  lines.push(`Removed ${removed.length} session(s):`);
  for (const name of removed) {
    lines.push(`  - ${name}`);
  }
  lines.push("");
  return lines.join("\n");
}
