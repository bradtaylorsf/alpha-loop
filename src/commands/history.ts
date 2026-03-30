import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { logError } from '../lib/logger.js';

interface SessionIssue {
  number: number;
  status: string;
  pr_url?: string;
  error?: string;
  duration?: number;
}

interface SessionData {
  name: string;
  repo?: string;
  started: string;
  duration?: number;
  model?: string;
  issues?: SessionIssue[];
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins}m ${String(secs).padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

function loadSession(yamlPath: string): SessionData | null {
  try {
    const raw = fs.readFileSync(yamlPath, 'utf-8');
    return YAML.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export function historyList(sessionsDir: string): void {
  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions found.');
    return;
  }

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const yamlPath = path.join(sessionsDir, d.name, 'session.yaml');
      if (!fs.existsSync(yamlPath)) return null;
      return { dir: d.name, session: loadSession(yamlPath) };
    })
    .filter((e): e is { dir: string; session: SessionData } => e !== null && e.session !== null);

  if (entries.length === 0) {
    console.log('No sessions found.');
    return;
  }

  // Sort by date descending
  entries.sort((a, b) => {
    const da = a.session.started ?? '';
    const db = b.session.started ?? '';
    return db.localeCompare(da);
  });

  console.log('Sessions:');
  for (const { session } of entries) {
    const name = session.name ?? 'unknown';
    const date = (session.started ?? '????-??-??').slice(0, 10);
    const issues = session.issues ?? [];
    const issueCount = issues.length;
    const successCount = issues.filter((i) => i.status === 'success').length;
    const failedCount = issues.filter((i) => i.status === 'failed').length;
    const durStr = formatDuration(session.duration);
    const issueWord = issueCount === 1 ? 'issue' : 'issues';

    let statusParts = '';
    if (successCount > 0) statusParts += `${successCount} \u2713`;
    if (failedCount > 0) statusParts += ` ${failedCount} \u2717`;

    console.log(
      `  ${name.padEnd(30)} ${date}  ${issueCount} ${issueWord.padEnd(7)} ${statusParts.padEnd(10)} ${durStr}`,
    );
  }
}

export function historyDetail(sessionsDir: string, sessionName: string): void {
  const yamlPath = path.join(sessionsDir, sessionName, 'session.yaml');
  if (!fs.existsSync(yamlPath)) {
    logError(`Session not found: ${sessionName}`);
    process.exitCode = 1;
    return;
  }

  const session = loadSession(yamlPath);
  if (!session) {
    logError(`Could not parse session: ${sessionName}`);
    process.exitCode = 1;
    return;
  }

  const dateDisplay = session.started
    ? `${session.started.slice(0, 10)} ${session.started.slice(11, 16)}`
    : '????-??-??';
  const durStr = formatDuration(session.duration);

  console.log(`Session: ${session.name ?? sessionName}`);
  console.log(`Date:    ${dateDisplay}`);
  if (session.repo) console.log(`Repo:    ${session.repo}`);
  if (session.model) console.log(`Model:   ${session.model}`);
  console.log(`Duration: ${durStr}`);
  console.log('');

  console.log('Issues:');
  for (const issue of session.issues ?? []) {
    let symbol: string;
    let statusText: string;

    switch (issue.status) {
      case 'success':
        symbol = '\u2713';
        if (issue.pr_url) {
          const prNum = issue.pr_url.match(/(\d+)$/)?.[1] ?? '';
          statusText = `PR #${prNum}`;
        } else {
          statusText = 'SUCCESS';
        }
        break;
      case 'failed':
        symbol = '\u2717';
        statusText = 'FAILED';
        break;
      default:
        symbol = '\u2298';
        statusText = 'SKIPPED';
        break;
    }

    const issueDur = formatDuration(issue.duration);
    let line = `  ${symbol} #${String(issue.number).padEnd(4)} ${statusText.padEnd(9)} (${issueDur})`;
    if (issue.error) {
      line += ` \u2014 ${issue.error}`;
    }
    console.log(line);
  }

  console.log('');
  console.log(`QA Checklist: sessions/${sessionName}/qa-checklist.md`);
  console.log(`Logs:         sessions/${sessionName}/logs/`);
}

export function historyQa(sessionsDir: string, sessionName: string): void {
  const qaPath = path.join(sessionsDir, sessionName, 'qa-checklist.md');
  if (!fs.existsSync(qaPath)) {
    logError(`QA checklist not found for session: ${sessionName}`);
    process.exitCode = 1;
    return;
  }
  console.log(fs.readFileSync(qaPath, 'utf-8'));
}

export function historyClean(sessionsDir: string): void {
  if (!fs.existsSync(sessionsDir)) {
    console.log('No sessions found.');
    return;
  }

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let removed = 0;

  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const entry of entries) {
    const yamlPath = path.join(sessionsDir, entry.name, 'session.yaml');
    if (!fs.existsSync(yamlPath)) continue;

    const session = loadSession(yamlPath);
    if (!session?.started) continue;

    const sessionDate = new Date(session.started).getTime();
    if (isNaN(sessionDate)) continue;

    if (sessionDate < cutoff) {
      fs.rmSync(path.join(sessionsDir, entry.name), { recursive: true });
      console.log(`Removed: ${session.name ?? entry.name}`);
      removed++;
    }
  }

  if (removed === 0) {
    console.log('No sessions older than 30 days found.');
  } else {
    console.log(`Removed ${removed} session(s).`);
  }
}

export function historyCommand(
  session: string | undefined,
  options: { qa?: boolean; clean?: boolean },
): void {
  const sessionsDir = path.join(process.cwd(), 'sessions');

  if (options.clean) {
    historyClean(sessionsDir);
    return;
  }

  if (session) {
    if (options.qa) {
      historyQa(sessionsDir, session);
    } else {
      historyDetail(sessionsDir, session);
    }
    return;
  }

  historyList(sessionsDir);
}
