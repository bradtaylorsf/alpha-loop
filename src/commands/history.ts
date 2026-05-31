import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../lib/logger.js';
import {
  loadCrashMarkers,
  loadSessionManifest,
  sessionManifestPath,
  transitionSessionStatus,
  updateSessionManifest,
  type CrashMarker,
  type DurableSessionManifest,
  type SessionStatus,
} from '../lib/session.js';
import { DEFAULT_SESSION_RETENTION, loadConfig, type SessionRetentionConfig } from '../lib/config.js';
import { isWaitingFeedbackStatus } from '../lib/session-state.js';
import { readStageTelemetry } from '../lib/telemetry.js';
import type { StageTelemetry } from '../lib/telemetry.js';
import { isRecoveredResult } from '../lib/pipeline.js';
import type { PipelineResult } from '../lib/pipeline.js';
import type { EscalationEvent } from '../lib/escalation.js';
import type { EpicQueueManifest, QueueSessionContext } from '../lib/epic-queue.js';

type LearningSessionManifest = {
  name: string;
  branch: string;
  completed: string;
  results: PipelineResult[];
  queue?: QueueSessionContext;
  stages?: StageTelemetry[];
};

type QueueManifestRef = {
  dir: string;
  name: string;
  timestamp: string;
  manifest: EpicQueueManifest;
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

function uniqueCrashMarkers(results: PipelineResult[], crashes: CrashMarker[]): CrashMarker[] {
  const resultIssues = new Set(results.map((result) => result.issueNum));
  return crashes.filter((marker) => !resultIssues.has(marker.issueNum));
}

function statusLabel(status: SessionStatus | undefined, results: PipelineResult[], crashes: CrashMarker[]): string {
  if (status) return status;
  const visibleCrashes = uniqueCrashMarkers(results, crashes);
  if (visibleCrashes.length > 0) return 'failed';
  if (results.length === 0) return 'running';
  return results.some((result) => result.status === 'failure' && !isRecoveredResult(result))
    ? 'failed'
    : 'completed';
}

function sessionUpdatedAt(manifest: DurableSessionManifest | undefined, fallbackTimestamp: string): string {
  return manifest?.timestamps.updatedAt
    ?? manifest?.timestamps.startedAt
    ?? fallbackTimestamp;
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

function loadQueueManifest(filePath: string): EpicQueueManifest | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EpicQueueManifest;
    if (!manifest.queueId || !Array.isArray(manifest.epics)) return null;
    return manifest;
  } catch {
    return null;
  }
}

function queueTimestamp(queueId: string): string {
  return queueId.startsWith('queue-') ? queueId.slice('queue-'.length) : queueId;
}

/**
 * Find multi-epic queue manifests under .alpha-loop/sessions/queue-<timestamp>/queue.json.
 */
function findQueueManifests(sessionsRoot: string): QueueManifestRef[] {
  if (!fs.existsSync(sessionsRoot)) return [];

  const queues: QueueManifestRef[] = [];
  for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('queue-')) continue;
    const dir = path.join(sessionsRoot, entry.name);
    const manifest = loadQueueManifest(path.join(dir, 'queue.json'));
    if (!manifest) continue;
    const name = manifest.queueId || entry.name;
    queues.push({
      dir,
      name,
      timestamp: queueTimestamp(name),
      manifest,
    });
  }

  queues.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return queues;
}

function findQueueManifest(sessionsRoot: string, name: string): QueueManifestRef | undefined {
  const wanted = name.trim();
  if (!wanted) return undefined;
  return findQueueManifests(sessionsRoot).find((queue) => (
    queue.name === wanted ||
    queue.timestamp === wanted ||
    queue.name.endsWith(wanted)
  ));
}

/**
 * Load session manifests from the learnings directory (checked into git, shared with team).
 * These are created during session finalization.
 */
function loadManifests(projectDir?: string): Map<string, LearningSessionManifest> {
  const learningsDir = path.join(projectDir ?? process.cwd(), '.alpha-loop', 'learnings');
  const manifests = new Map<string, LearningSessionManifest>();
  if (!fs.existsSync(learningsDir)) return manifests;

  for (const file of fs.readdirSync(learningsDir)) {
    if (!file.startsWith('session-') || !file.endsWith('.json')) continue;
    try {
      const content = fs.readFileSync(path.join(learningsDir, file), 'utf-8');
      const manifest = JSON.parse(content) as LearningSessionManifest;
      if (manifest.name) {
        manifests.set(manifest.name, manifest);
      }
    } catch { /* skip invalid */ }
  }
  return manifests;
}

export function historyList(sessionsDir: string, projectDir?: string): void {
  const localSessions = findSessionDirs(sessionsDir);
  const manifests = loadManifests(projectDir);
  const queues = findQueueManifests(sessionsDir);

  // Build a unified list: local sessions + manifests not covered by local data
  const seenNames = new Set(localSessions.map((s) => s.name));

  type SessionEntry = {
    name: string;
    timestamp: string;
    results: PipelineResult[];
    crashes: CrashMarker[];
    manifest?: DurableSessionManifest;
    source: 'local' | 'manifest';
  };
  const entries: SessionEntry[] = [];

  // Add local sessions
  for (const session of localSessions) {
    const durableManifest = loadSessionManifest(session.dir) ?? undefined;
    entries.push({
      name: session.name,
      timestamp: session.timestamp,
      results: loadResults(session.dir),
      crashes: loadCrashMarkers(session.dir),
      manifest: durableManifest,
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
      crashes: [],
      manifest: undefined,
      source: 'manifest',
    });
  }

  // Sort newest first
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  if (entries.length === 0 && queues.length === 0) {
    console.log('No sessions found.');
    return;
  }

  if (entries.length > 0) {
    console.log('Sessions:');
    console.log('');

    for (const entry of entries) {
      const crashCount = uniqueCrashMarkers(entry.results, entry.crashes).length;
      const issueCount = Math.max(entry.manifest?.issueNumbers.length ?? 0, entry.results.length + crashCount);
      const recoveredCount = entry.results.filter(isRecoveredResult).length;
      const successCount = entry.results.filter((r) => r.status === 'success' && !isRecoveredResult(r)).length;
      const failedCount = entry.results.filter((r) => r.status === 'failure' && !isRecoveredResult(r)).length;
      const totalDuration = entry.results
        .filter((r) => !isRecoveredResult(r))
        .reduce((sum, r) => sum + r.duration, 0);
      const durStr = formatDuration(totalDuration);

      // Parse date from timestamp (YYYYMMDD-HHMMSS)
      const ts = entry.timestamp;
      const date = ts.length >= 8
        ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`
        : ts;

      const issueWord = issueCount === 1 ? 'issue' : 'issues';
      const status = statusLabel(entry.manifest?.status, entry.results, entry.crashes);
      let statusParts = '';
      if (successCount > 0) statusParts += `${successCount} \u2713`;
      if (failedCount > 0) statusParts += ` ${failedCount} \u2717`;
      if (recoveredCount > 0) statusParts += ` ${recoveredCount} recovered`;
      if (crashCount > 0) statusParts += ` ${crashCount} crashed`;
      if (issueCount === 0) statusParts = '(empty)';
      statusParts = `${status} ${statusParts}`.trim();

      console.log(
        `  ${entry.name.padEnd(30)} ${date}  ${String(issueCount).padStart(2)} ${issueWord.padEnd(7)} ${statusParts.padEnd(10)} ${durStr}`,
      );
    }
  }

  if (queues.length > 0) {
    if (entries.length > 0) console.log('');
    console.log('Queues:');
    console.log('');

    for (const queue of queues) {
      const manifest = queue.manifest;
      const epicCount = manifest.epics.length;
      const successCount = manifest.epics.filter((entry) => entry.status === 'success').length;
      const failedCount = manifest.epics.filter((entry) => entry.status === 'failure').length;
      const pendingCount = manifest.epics.filter((entry) => entry.status === 'pending' || entry.status === 'running').length;
      const startedAt = manifest.startedAt ?? '';
      const date = startedAt.length >= 10 ? startedAt.slice(0, 10) : queue.timestamp;
      const epicWord = epicCount === 1 ? 'epic' : 'epics';
      const status = `${manifest.status}${manifest.stopReason ? `: ${manifest.stopReason}` : ''}`;

      console.log(
        `  ${queue.name.padEnd(30)} ${date}  ${String(epicCount).padStart(2)} ${epicWord.padEnd(6)} ${successCount} ok, ${failedCount} failed, ${pendingCount} pending  ${status}`,
      );
    }
  }
}

function formatQueueEpicStatus(status: string): string {
  if (status === 'success') return 'success';
  if (status === 'failure') return 'failed';
  if (status === 'skipped') return 'skipped';
  if (status === 'running') return 'running';
  return 'pending';
}

function printQueueManifestDetail(queue: QueueManifestRef, projectDir?: string): void {
  const root = projectDir ?? process.cwd();
  const manifest = queue.manifest;
  const manifestPath = path.relative(root, path.join(queue.dir, 'queue.json'));

  console.log(`Queue:       ${manifest.queueId}`);
  console.log(`Status:      ${manifest.status}`);
  console.log(`Branch mode: ${manifest.branchAncestryMode}`);
  console.log(`Started:     ${manifest.startedAt}`);
  if (manifest.endedAt) console.log(`Ended:       ${manifest.endedAt}`);
  if (manifest.stopReason) console.log(`Stop reason: ${manifest.stopReason}`);
  console.log(`Manifest:    ${manifestPath}`);
  console.log('');

  console.log('Epics:');
  for (const entry of manifest.epics) {
    console.log(`  ${entry.queueIndex}/${entry.queueTotal} #${entry.epicNumber} ${entry.title} - ${formatQueueEpicStatus(entry.status)}`);
    if (entry.sessionName) console.log(`           Session: ${entry.sessionName}`);
    if (entry.sessionBranch) console.log(`           Branch:  ${entry.sessionBranch}`);
    if (entry.sessionPrUrl) console.log(`           PR:      ${entry.sessionPrUrl}`);
    if (entry.branchedFromBranch) console.log(`           From:    ${entry.branchedFromBranch}`);
    if (entry.dependsOnSessionBranch) {
      const pr = entry.dependsOnSessionPrUrl ? ` (${entry.dependsOnSessionPrUrl})` : '';
      console.log(`           Depends: ${entry.dependsOnSessionBranch}${pr}`);
    }
    if (entry.rebaseOntoBranch) {
      console.log(`           Rebase:  ${entry.sessionBranch ?? 'this branch'} onto ${entry.rebaseOntoBranch} after the dependency PR lands`);
    }
    for (const warning of entry.dependencyWarnings ?? []) console.log(`           Dependency: ${warning}`);
    for (const warning of entry.overlapWarnings ?? []) console.log(`           File overlap: ${warning}`);
    for (const failure of entry.failures ?? []) console.log(`           Failure: ${failure.code} - ${failure.message}`);
  }
}

function printSessionQueueSummary(queue: QueueSessionContext): void {
  console.log('');
  console.log('Queue:');
  console.log(`  ID:        ${queue.queueId}`);
  console.log(`  Position:  ${queue.queueIndex} of ${queue.queueTotal}`);
  console.log(`  Epic:      #${queue.currentEpic.number} ${queue.currentEpic.title}`);
  console.log(`  Mode:      ${queue.branchAncestryMode}`);
  console.log(`  From:      ${queue.branchedFromBranch}`);
  if (queue.dependsOnSessionBranch) {
    const pr = queue.dependsOnSessionPrUrl ? ` (${queue.dependsOnSessionPrUrl})` : '';
    console.log(`  Depends:   ${queue.dependsOnSessionBranch}${pr}`);
  }
  if (queue.rebaseOntoBranch) {
    console.log(`  Rebase:    onto ${queue.rebaseOntoBranch} after the dependency PR lands`);
  }
}

function printDurableFeedbackSummary(manifest: DurableSessionManifest): void {
  const feedback = manifest.feedback;
  if (!feedback) return;
  const latest = feedback.latestFeedback;
  const classification = latest?.classification ?? feedback.classification;
  if (!latest && !classification && feedback.currentStatus !== 'resume_requested') return;

  const source = latest?.source ? ` from ${latest.source}` : '';
  console.log(`Feedback: ${classification ?? 'unclassified'}${source}`);
  if (latest?.author) console.log(`          Author: ${latest.author}`);
  if (latest?.externalThreadId) console.log(`          Thread: ${latest.externalThreadId}`);
  if (latest?.externalMessageId) console.log(`          Message: ${latest.externalMessageId}`);
  if (latest?.resumeCommand) {
    console.log(`          Resume: ${latest.resumeCommand}`);
  } else if (feedback.currentStatus === 'resume_requested') {
    const issueNum = manifest.currentIssue?.issueNum ?? manifest.issueNumber;
    if (issueNum) console.log(`          Resume: alpha-loop resume --issue ${issueNum}`);
  }
}

export function historyDetail(sessionsDir: string, sessionName: string, projectDir?: string): void {
  const queue = findQueueManifest(sessionsDir, sessionName);
  if (queue) {
    printQueueManifestDetail(queue, projectDir);
    return;
  }

  let results: PipelineResult[] = [];
  let crashMarkers: CrashMarker[] = [];
  let sessionDir: string | undefined;
  let manifest: LearningSessionManifest | undefined;
  let durableManifest: DurableSessionManifest | undefined;
  const root = projectDir ?? process.cwd();
  const manifests = loadManifests(root);

  // Try local session directories first
  const localDir = path.join(sessionsDir, sessionName);
  if (fs.existsSync(localDir)) {
    sessionDir = localDir;
    durableManifest = loadSessionManifest(localDir) ?? undefined;
    results = loadResults(localDir);
    crashMarkers = loadCrashMarkers(localDir);
  } else {
    const all = findSessionDirs(sessionsDir);
    const match = all.find((s) => s.name === sessionName || s.timestamp === sessionName);
    if (match) {
      sessionDir = match.dir;
      durableManifest = loadSessionManifest(match.dir) ?? undefined;
      results = loadResults(match.dir);
      crashMarkers = loadCrashMarkers(match.dir);
    }
  }

  // Fall back to manifest from learnings (checked-in data from teammates)
  if (results.length === 0 && crashMarkers.length === 0) {
    manifest = manifests.get(sessionName)
      ?? [...manifests.values()].find((m) => m.name.endsWith(sessionName));
    if (manifest) {
      results = manifest.results;
      sessionName = manifest.name;
    }
  }

  manifest ??= manifests.get(sessionName)
    ?? [...manifests.values()].find((m) => m.name === sessionName || m.name.endsWith(sessionName));

  const visibleCrashes = uniqueCrashMarkers(results, crashMarkers);

  if (!durableManifest && results.length === 0 && visibleCrashes.length === 0) {
    log.error(`Session not found: ${sessionName}`);
    process.exitCode = 1;
    return;
  }

  const naturalResults = results.filter((r) => !isRecoveredResult(r));
  const totalDuration = naturalResults.reduce((sum, r) => sum + r.duration, 0);
  const successCount = naturalResults.filter((r) => r.status === 'success').length;
  const failureCount = naturalResults.filter((r) => r.status === 'failure').length;
  const recoveredCount = results.length - naturalResults.length;
  const issueCount = Math.max(durableManifest?.issueNumbers.length ?? 0, results.length + visibleCrashes.length);
  const status = statusLabel(durableManifest?.status, results, crashMarkers);

  console.log(`Session:  ${sessionName}`);
  console.log(`Status:   ${status}${durableManifest ? ` (${durableManifest.stage})` : ''}`);
  console.log(`Issues:   ${issueCount} (${successCount} succeeded, ${failureCount} failed, ${recoveredCount} recovered, ${visibleCrashes.length} crashed)`);
  console.log(`Duration: ${formatDuration(totalDuration)}`);
  if (durableManifest) {
    console.log(`Branch:   ${durableManifest.branch}`);
    if (durableManifest.sessionPrUrl) console.log(`PR:       ${durableManifest.sessionPrUrl}`);
    if (durableManifest.parentEpicNumber) console.log(`Epic:     #${durableManifest.parentEpicNumber}`);
    console.log(`Manifest: ${path.relative(root, durableManifest ? sessionManifestPath(sessionDir ?? '') : '')}`);
    if (durableManifest.worktree?.path) {
      const worktreeExists = fs.existsSync(durableManifest.worktree.path);
      console.log(`Worktree: ${durableManifest.worktree.path}${worktreeExists ? '' : ' (missing)'}`);
      if (!worktreeExists) {
        const recoveryBranch = durableManifest.worktree.lastKnownBranch ?? durableManifest.lastKnownBranch ?? durableManifest.branch;
        console.log(`Recover:  recreate worktree from branch ${recoveryBranch}`);
      }
    } else if (durableManifest.lastKnownBranch) {
      console.log(`Recover:  branch ${durableManifest.lastKnownBranch}`);
    }
    if (durableManifest.webApp) {
      if (durableManifest.webApp.previewUrl) console.log(`Preview:  ${durableManifest.webApp.previewUrl}`);
      if (durableManifest.webApp.artifactPath) console.log(`Browser:  ${durableManifest.webApp.artifactPath}`);
      if (durableManifest.webApp.screenshots.length > 0) {
        console.log(`Shots:    ${durableManifest.webApp.screenshots.length} screenshot(s)`);
      }
    }
    printDurableFeedbackSummary(durableManifest);
  }
  console.log('');

  if (manifest?.queue) {
    printSessionQueueSummary(manifest.queue);
    console.log('');
  }

  // Stage-revert banner: if any issue in this session has an active revert event, flag it.
  const activeReverts = new Set<string>();
  for (const r of results) {
    for (const ev of r.escalationEvents ?? []) {
      if (ev.type === 'stage_revert' || ev.type === 'stage_revert_active') {
        activeReverts.add(`${ev.stage}: ${ev.from_model} -> ${ev.to_model}`);
      }
    }
  }
  if (activeReverts.size > 0) {
    console.log('Stage reverts active (pinned to fallback):');
    for (const line of activeReverts) console.log(`  ! ${line}`);
    console.log('');
  }

  console.log('Issues:');
  if (results.length === 0 && durableManifest?.issues.length) {
    for (const issue of durableManifest.issues) {
      const branch = issue.branch ? ` branch ${issue.branch}` : '';
      const pr = issue.prUrl ? ` PR ${issue.prUrl.match(/(\d+)$/)?.[1] ?? issue.prUrl}` : '';
      console.log(`  - #${String(issue.issueNum).padEnd(4)} ${issue.title ?? '(title unavailable)'}`);
      console.log(`           ${(issue.status ?? durableManifest.status).toUpperCase()} ${issue.stage ?? durableManifest.stage}${branch}${pr}`);
      if (issue.worktreePath && !fs.existsSync(issue.worktreePath)) {
        console.log(`           missing worktree; recover from ${issue.branch ?? durableManifest.lastKnownBranch ?? durableManifest.branch}`);
      }
    }
  }

  for (const result of results) {
    const recovered = isRecoveredResult(result);
    const symbol = recovered ? '~' : result.status === 'success' ? '\u2713' : result.status === 'waiting' ? '?' : '\u2717';
    let statusText: string;

    if (recovered) {
      statusText = `RECOVERED:${result.recoveryMode.toUpperCase()}`;
    } else if (result.status === 'success' && result.prUrl) {
      const prNum = result.prUrl.match(/(\d+)$/)?.[1] ?? '';
      statusText = `PR #${prNum}`;
    } else if (result.status === 'success') {
      statusText = 'SUCCESS';
    } else if (result.status === 'waiting') {
      statusText = result.waitingStatus?.toUpperCase() ?? 'WAITING';
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

    // Escalation events, grouped by stage, printed inline under the stage row.
    const events = result.escalationEvents ?? [];
    if (events.length > 0) {
      const byStage = new Map<string, EscalationEvent[]>();
      for (const ev of events) {
        const list = byStage.get(ev.stage) ?? [];
        list.push(ev);
        byStage.set(ev.stage, list);
      }
      for (const [stage, stageEvents] of byStage) {
        for (const ev of stageEvents) {
          const symbol = ev.type === 'escalation' ? '\u21b3' : '!';
          console.log(
            `           ${symbol} ${ev.type}: ${stage} [${ev.from_model} \u2192 ${ev.to_model}] reason=${ev.reason} (turn ${ev.turn_index})`
          );
        }
      }
    }
  }

  for (const marker of visibleCrashes) {
    console.log(
      `  ! #${String(marker.issueNum).padEnd(4)} CRASHED during ${marker.step}`
    );
    console.log(
      `           branch ${marker.branch}  recoverable ${marker.recoverable ? 'yes' : 'no'}  ${marker.timestamp}`
    );
    if (marker.error) {
      console.log(`           error: ${marker.error}`);
    }
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
  const learningsDir = path.join(root, '.alpha-loop', 'learnings');
  const summaryName = `session-summary-${sessionName.replace(/\//g, '-')}.md`;
  const summaryPath = path.join(learningsDir, summaryName);
  if (fs.existsSync(summaryPath)) {
    console.log(`Summary:      ${path.relative(root, summaryPath)}`);
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

/**
 * Load per-stage telemetry for a session. Looks first in the traces dir
 * (stages.jsonl written during the run), then falls back to the session
 * manifest's embedded `stages` field for sessions pushed by teammates.
 */
function loadStageTelemetry(sessionName: string, projectDir?: string): StageTelemetry[] {
  const root = projectDir ?? process.cwd();
  // Trace dirs mirror traces.ts: session/<ts> -> session-<ts>.
  const traceName = sessionName.replace(/\//g, '-');
  const traceDir = path.join(root, '.alpha-loop', 'traces', traceName);
  if (fs.existsSync(path.join(traceDir, 'stages.jsonl'))) {
    return readStageTelemetry(traceDir);
  }
  const manifests = loadManifests(projectDir);
  const manifest = manifests.get(sessionName);
  return manifest?.stages ?? [];
}

function fmtNumber(n: number, digits = 0): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function historyTelemetry(sessionName: string, projectDir?: string): void {
  const entries = loadStageTelemetry(sessionName, projectDir);
  if (entries.length === 0) {
    console.log(`No per-stage telemetry recorded for this session.`);
    return;
  }

  console.log(`Stage telemetry for ${sessionName}:`);
  console.log('');

  const header = ['stage', 'model', 'endpoint', 'tok_in', 'tok_out', 'cost_usd', 'wall_s', 'tool_err', 'ok'];
  console.log(header.join('\t'));

  let totalCost = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalWall = 0;
  let totalErrs = 0;

  for (const e of entries) {
    totalCost += e.cost_usd;
    totalTokensIn += e.tokens_in;
    totalTokensOut += e.tokens_out;
    totalWall += e.wall_time_s;
    totalErrs += e.tool_errors;
    console.log([
      e.stage,
      e.model,
      e.endpoint,
      fmtNumber(e.tokens_in),
      fmtNumber(e.tokens_out),
      `$${e.cost_usd.toFixed(4)}`,
      e.wall_time_s.toFixed(2),
      String(e.tool_errors),
      e.stage_success ? 'ok' : 'fail',
    ].join('\t'));
  }

  console.log('');
  console.log(`Totals: ${entries.length} stage(s), ${fmtNumber(totalTokensIn)} in / ${fmtNumber(totalTokensOut)} out, $${totalCost.toFixed(4)}, ${totalWall.toFixed(1)}s wall, ${totalErrs} tool error(s)`);
}

function manifestAgeMs(manifest: DurableSessionManifest, fallbackTimestamp: string): number {
  const timestamp = sessionUpdatedAt(manifest, fallbackTimestamp);
  const time = Date.parse(timestamp);
  if (!Number.isNaN(time)) return Date.now() - time;

  if (fallbackTimestamp.length >= 8) {
    const dateStr = `${fallbackTimestamp.slice(0, 4)}-${fallbackTimestamp.slice(4, 6)}-${fallbackTimestamp.slice(6, 8)}`;
    const fallbackTime = new Date(dateStr).getTime();
    if (!Number.isNaN(fallbackTime)) return Date.now() - fallbackTime;
  }
  return 0;
}

function retentionDaysForStatus(status: SessionStatus, retention: SessionRetentionConfig): number | null {
  if (isWaitingFeedbackStatus(status)) {
    return retention.pausedWorktreeDays > 0 ? retention.pausedWorktreeDays : null;
  }
  if (status === 'completed' || status === 'failed' || status === 'cleaned-up') {
    return retention.completedWorktreeDays > 0 ? retention.completedWorktreeDays : null;
  }
  return null;
}

function projectDirForSessionsDir(sessionsDir: string): string {
  const resolved = path.resolve(sessionsDir);
  if (path.basename(resolved) === 'sessions' && path.basename(path.dirname(resolved)) === '.alpha-loop') {
    return path.dirname(path.dirname(resolved));
  }
  return path.dirname(resolved);
}

function resolveRetainedWorktreePath(worktreePath: string, sessionsDir: string): { path: string; safe: boolean } {
  const projectDir = projectDirForSessionsDir(sessionsDir);
  const worktreesRoot = path.resolve(projectDir, '.worktrees');
  const candidate = path.isAbsolute(worktreePath)
    ? path.resolve(worktreePath)
    : path.resolve(projectDir, worktreePath);
  const rel = path.relative(worktreesRoot, candidate);
  return {
    path: candidate,
    safe: rel === '' || (rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)),
  };
}

function cleanManifestWorktree(
  session: { dir: string; name: string; timestamp: string },
  manifest: DurableSessionManifest,
  retention: SessionRetentionConfig,
  sessionsDir: string,
): boolean {
  const days = retentionDaysForStatus(manifest.status, retention);
  if (days === null) return false;
  if (manifestAgeMs(manifest, session.timestamp) < days * 24 * 60 * 60 * 1000) return false;

  const worktreePath = manifest.worktree?.path;
  const resolvedWorktree = worktreePath ? resolveRetainedWorktreePath(worktreePath, sessionsDir) : null;
  const removedWorktree = Boolean(resolvedWorktree?.safe && fs.existsSync(resolvedWorktree.path));
  if (resolvedWorktree?.safe && fs.existsSync(resolvedWorktree.path)) {
    fs.rmSync(resolvedWorktree.path, { recursive: true, force: true });
  }

  transitionSessionStatus(session.dir, 'cleaned-up', 'cleanup');
  updateSessionManifest(session.dir, (current) => ({
    ...current,
    cleanup: {
      status: worktreePath
        ? (resolvedWorktree?.safe ? (removedWorktree ? 'removed' : 'missing') : 'preserved')
        : 'missing',
      worktreePath,
      reason: worktreePath && !resolvedWorktree?.safe
        ? `retention:${manifest.status}:${days}d:unsafe-worktree-path-skipped`
        : `retention:${manifest.status}:${days}d`,
      at: new Date().toISOString(),
    },
    worktree: current.worktree
      ? {
          ...current.worktree,
          missing: resolvedWorktree?.safe ? true : current.worktree.missing,
          updatedAt: new Date().toISOString(),
        }
      : current.worktree,
  }));
  console.log(`Cleaned: ${session.name}${worktreePath ? ` (${worktreePath})` : ''}`);
  return true;
}

export function historyClean(
  sessionsDir: string,
  retention: SessionRetentionConfig = { pausedWorktreeDays: 0, completedWorktreeDays: 30 },
): void {
  const sessions = findSessionDirs(sessionsDir);

  if (sessions.length === 0) {
    console.log('No sessions found.');
    return;
  }

  let removed = 0;

  for (const session of sessions) {
    const durableManifest = loadSessionManifest(session.dir);
    if (durableManifest) {
      if (cleanManifestWorktree(session, durableManifest, retention, sessionsDir)) {
        removed++;
      }
      continue;
    }

    // Parse date from timestamp YYYYMMDD-HHMMSS
    const ts = session.timestamp;
    if (ts.length < 8) continue;
    const dateStr = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    const sessionDate = new Date(dateStr).getTime();
    if (isNaN(sessionDate)) continue;
    if (retention.completedWorktreeDays <= 0) continue;

    const cutoff = Date.now() - retention.completedWorktreeDays * 24 * 60 * 60 * 1000;
    if (sessionDate < cutoff) {
      fs.rmSync(session.dir, { recursive: true });
      console.log(`Removed: ${session.name}`);
      removed++;
    }
  }

  if (removed === 0) {
    if (retention.completedWorktreeDays === 30 && retention.pausedWorktreeDays === 0) {
      console.log('No sessions older than 30 days found.');
    } else {
      console.log('No sessions matched retention cleanup.');
    }
  } else {
    console.log(`Cleaned ${removed} session(s).`);
  }
}

export function historyCommand(
  session: string | undefined,
  options: { qa?: boolean; clean?: boolean; telemetry?: boolean },
): void {
  const sessionsDir = path.join(process.cwd(), '.alpha-loop', 'sessions');

  if (options.clean) {
    historyClean(sessionsDir, loadConfig().sessionRetention ?? DEFAULT_SESSION_RETENTION);
    return;
  }

  if (session) {
    if (options.telemetry) {
      historyTelemetry(session);
    } else if (options.qa) {
      historyQa(sessionsDir, session);
    } else {
      historyDetail(sessionsDir, session);
    }
    return;
  }

  historyList(sessionsDir);
}
