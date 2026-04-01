import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../lib/logger.js';
import type { PipelineResult } from '../lib/pipeline.js';

type SessionManifest = {
  name: string;
  branch: string;
  completed: string;
  results: PipelineResult[];
};

function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins > 0) {
    return `${mins}m ${String(secs).padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

/**
 * Load all result-*.json files from a session directory.
 */
function loadResults(sessionDir: string): PipelineResult[] {
  const results: PipelineResult[] = [];
  try {
    const files = fs.readdirSync(sessionDir)
      .filter((f) => f.startsWith('result-') && f.endsWith('.json'))
      .sort();
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(sessionDir, file), 'utf-8');
        results.push(JSON.parse(content) as PipelineResult);
      } catch { /* skip invalid */ }
    }
  } catch { /* directory not readable */ }
  return results;
}

/**
 * Find all session directories under .alpha-loop/sessions/.
 * Handles nested structure: sessions/session/<timestamp>/
 */
function findSessionDirs(sessionsRoot: string): Array<{ dir: string; name: string; timestamp: string }> {
  if (!fs.existsSync(sessionsRoot)) return [];

  const sessions: Array<{ dir: string; name: string; timestamp: string }> = [];

  for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(sessionsRoot, group.name);

    for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      sessions.push({
        dir: path.join(groupDir, entry.name),
        name: `${group.name}/${entry.name}`,
        timestamp: entry.name,
      });
    }
  }

  // Sort newest first
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

/**
 * Load session manifests from the learnings directory (checked into git, shared with team).
 * These are created during session finalization.
 */
function loadManifests(): Map<string, SessionManifest> {
  const learningsDir = path.join(process.cwd(), '.alpha-loop', 'learnings');
  const manifests = new Map<string, SessionManifest>();
  if (!fs.existsSync(learningsDir)) return manifests;

  for (const file of fs.readdirSync(learningsDir)) {
    if (!file.startsWith('session-') || !file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(learningsDir, file), 'utf-8');
      const manifest = JSON.parse(content) as SessionManifest;
      if (manifest.name) {
        manifests.set(manifest.name, manifest);
      }
    } catch { /* skip invalid */ }
  }
  return manifests;
}

export function historyList(sessionsDir: string): void {
  const localSessions = findSessionDirs(sessionsDir);
  const manifests = loadManifests();

  // Build a unified list: local sessions + manifests not covered by local data
  const seenNames = new Set(localSessions.map((s) => s.name));

  type SessionEntry = { name: string; timestamp: string; results: PipelineResult[]; source: 'local' | 'manifest' };
  const entries: SessionEntry[] = [];

  // Add local sessions
  for (const session of localSessions) {
    entries.push({
      name: session.name,
      timestamp: session.timestamp,
      results: loadResults(session.dir),
      source: 'local',
    });
  }

  // Add manifests that don't have local session directories
  for (const [name, manifest] of manifests) {
    if (seenNames.has(name)) continue;
    // Extract timestamp from name (e.g., "session/20260401-004637" -> "20260401-004637")
    const ts = name.split('/').pop() ?? name;
    entries.push({
      name,
      timestamp: ts,
      results: manifest.results,
      source: 'manifest',
    });
  }

  // Sort newest first
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (entries.length === 0) {
    console.log('No sessions found.');
    return;
  }

  console.log('Sessions:');
  console.log('');

  for (const entry of entries) {
    const issueCount = entry.results.length;
    const successCount = entry.results.filter((r) => r.status === 'success').length;
    const failedCount = issueCount - successCount;
    const totalDuration = entry.results.reduce((sum, r) => sum + r.duration, 0);
    const durStr = formatDuration(totalDuration);

    // Parse date from timestamp (YYYYMMDD-HHMMSS)
    const ts = entry.timestamp;
    const date = ts.length >= 8
      ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`
      : ts;

    const issueWord = issueCount === 1 ? 'issue' : 'issues';
    let statusParts = '';
    if (successCount > 0) statusParts += `${successCount} \u2713`;
    if (failedCount > 0) statusParts += ` ${failedCount} \u2717`;
    if (issueCount === 0) statusParts = '(empty)';

    console.log(
      `  ${entry.name.padEnd(30)} ${date}  ${String(issueCount).padStart(2)} ${issueWord.padEnd(7)} ${statusParts.padEnd(10)} ${durStr}`,
    );
  }
}

export function historyDetail(sessionsDir: string, sessionName: string): void {
  let results: PipelineResult[] = [];
  let sessionDir: string | undefined;

  // Try local session directories first
  const localDir = path.join(sessionsDir, sessionName);
  if (fs.existsSync(localDir)) {
    sessionDir = localDir;
    results = loadResults(localDir);
  } else {
    const all = findSessionDirs(sessionsDir);
    const match = all.find((s) => s.name === sessionName || s.timestamp === sessionName);
    if (match) {
      sessionDir = match.dir;
      results = loadResults(match.dir);
    }
  }

  // Fall back to manifest from learnings (checked-in data from teammates)
  if (results.length === 0) {
    const manifests = loadManifests();
    const manifest = manifests.get(sessionName)
      ?? [...manifests.values()].find((m) => m.name.endsWith(sessionName));
    if (manifest) {
      results = manifest.results;
      sessionName = manifest.name;
    }
  }

  if (results.length === 0) {
    log.error(`Session not found: ${sessionName}`);
    process.exitCode = 1;
    return;
  }

  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const successCount = results.filter((r) => r.status === 'success').length;

  console.log(`Session:  ${sessionName}`);
  console.log(`Issues:   ${results.length} (${successCount} succeeded, ${results.length - successCount} failed)`);
  console.log(`Duration: ${formatDuration(totalDuration)}`);
  console.log('');

  console.log('Issues:');
  for (const result of results) {
    const symbol = result.status === 'success' ? '\u2713' : '\u2717';
    let statusText: string;

    if (result.status === 'success' && result.prUrl) {
      const prNum = result.prUrl.match(/(\d+)$/)?.[1] ?? '';
      statusText = `PR #${prNum}`;
    } else if (result.status === 'success') {
      statusText = 'SUCCESS';
    } else {
      statusText = 'FAILED';
    }

    const durStr = formatDuration(result.duration);
    const tests = result.testsPassing ? 'tests \u2713' : 'tests \u2717';
    const verify = result.verifyPassing ? 'verify \u2713' : 'verify \u2717';

    console.log(
      `  ${symbol} #${String(result.issueNum).padEnd(4)} ${result.title}`
    );
    console.log(
      `           ${statusText.padEnd(12)} ${durStr.padEnd(10)} ${tests}  ${verify}`
    );
  }

  console.log('');

  // Show paths to useful files (only available for local sessions)
  if (sessionDir) {
    const logsDir = path.join(sessionDir, 'logs');
    if (fs.existsSync(logsDir)) {
      console.log(`Logs:         ${path.relative(process.cwd(), logsDir)}/`);
    }
    const screenshotsDir = path.join(sessionDir, 'screenshots');
    if (fs.existsSync(screenshotsDir)) {
      console.log(`Screenshots:  ${path.relative(process.cwd(), screenshotsDir)}/`);
    }
    const qaPath = path.join(sessionDir, 'qa-checklist.md');
    if (fs.existsSync(qaPath)) {
      console.log(`QA Checklist: ${path.relative(process.cwd(), qaPath)}`);
    }
  }

  // Check for session summary in learnings
  const learningsDir = path.join(process.cwd(), '.alpha-loop', 'learnings');
  const summaryName = `session-summary-${sessionName.replace(/\//g, '-')}.md`;
  const summaryPath = path.join(learningsDir, summaryName);
  if (fs.existsSync(summaryPath)) {
    console.log(`Summary:      ${path.relative(process.cwd(), summaryPath)}`);
  }
}

export function historyQa(sessionsDir: string, sessionName: string): void {
  // Try exact path, then search
  let qaPath = path.join(sessionsDir, sessionName, 'qa-checklist.md');
  if (!fs.existsSync(qaPath)) {
    const all = findSessionDirs(sessionsDir);
    const match = all.find((s) => s.name === sessionName || s.timestamp === sessionName);
    if (match) {
      qaPath = path.join(match.dir, 'qa-checklist.md');
    }
  }

  if (!fs.existsSync(qaPath)) {
    log.error(`QA checklist not found for session: ${sessionName}`);
    process.exitCode = 1;
    return;
  }
  console.log(fs.readFileSync(qaPath, 'utf-8'));
}

export function historyClean(sessionsDir: string): void {
  const sessions = findSessionDirs(sessionsDir);

  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  const RETENTION_DAYS = 30;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;

  for (const session of sessions) {
    // Parse date from timestamp YYYYMMDD-HHMMSS
    const ts = session.timestamp;
    if (ts.length < 8) continue;
    const dateStr = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    const sessionDate = new Date(dateStr).getTime();
    if (isNaN(sessionDate)) continue;

    if (sessionDate < cutoff) {
      fs.rmSync(session.dir, { recursive: true });
      console.log(`Removed: ${session.name}`);
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
  const sessionsDir = path.join(process.cwd(), '.alpha-loop', 'sessions');

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
