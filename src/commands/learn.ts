/**
 * Learn command — backfill learnings from existing session traces.
 * Finds issues with trace metadata but no corresponding learning file,
 * then runs learning extraction for each one.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { extractLearnings } from '../lib/learning.js';
import { log } from '../lib/logger.js';
import {
  listTraceSessions,
  listTraceIssues,
  readTraceMetadata,
  readTrace,
} from '../lib/traces.js';

export type LearnOptions = {
  session?: string;
  dryRun?: boolean;
};

/**
 * Check if a learning file already exists for an issue within a given session.
 * Learning files follow the pattern: issue-{num}-{timestamp}.md
 * We match on the issue number prefix, not the timestamp, since
 * multiple runs of the same issue could exist.
 */
function hasLearningForIssue(learningsDir: string, issueNum: number, sessionName: string): boolean {
  if (!existsSync(learningsDir)) return false;
  const prefix = `issue-${issueNum}-`;
  return readdirSync(learningsDir)
    .some((f) => f.startsWith(prefix) && f.endsWith('.md'));
}

export async function learnCommand(options: LearnOptions): Promise<void> {
  const projectDir = process.cwd();
  const config = loadConfig({ dryRun: options.dryRun });
  const learningsDir = join(projectDir, '.alpha-loop', 'learnings');

  // Discover sessions with traces
  const allSessions = listTraceSessions(projectDir);
  if (allSessions.length === 0) {
    log.warn('No session traces found in .alpha-loop/traces/. Run the loop first.');
    return;
  }

  // Filter to requested session or use all
  let sessions: string[];
  if (options.session) {
    // Allow partial match (e.g. "20260414" matches "session/20260414-143022")
    sessions = allSessions.filter((s) => s.includes(options.session!));
    if (sessions.length === 0) {
      log.error(`No sessions matching "${options.session}". Available sessions:`);
      for (const s of allSessions.slice(0, 10)) {
        console.log(`  ${s}`);
      }
      return;
    }
  } else {
    sessions = allSessions;
  }

  log.info(`Found ${sessions.length} session(s) to check for missing learnings`);

  // Collect issues that need learning extraction
  type PendingIssue = {
    session: string;
    issueNum: number;
    title: string;
    body: string;
    status: string;
    retries: number;
    duration: number;
    diff: string;
    testOutput: string;
    reviewOutput: string;
    verifyOutput: string;
  };

  const pending: PendingIssue[] = [];
  let skipped = 0;

  for (const sessionName of sessions) {
    const issueNums = listTraceIssues(sessionName, projectDir);

    for (const issueNum of issueNums) {
      // Skip if learning already exists for this issue
      if (hasLearningForIssue(learningsDir, issueNum, sessionName)) {
        skipped++;
        continue;
      }

      const metadata = readTraceMetadata(sessionName, issueNum, projectDir);
      if (!metadata) continue;

      // Read available trace data
      const diff = readTrace(sessionName, issueNum, 'diff.patch', projectDir) ?? '';
      const testOutput = readTrace(sessionName, issueNum, 'test-output.txt', projectDir) ?? '';
      const reviewOutput = readTrace(sessionName, issueNum, 'review-output.json', projectDir) ?? '';
      const verifyOutput = readTrace(sessionName, issueNum, 'verify-output.json', projectDir) ?? '';

      pending.push({
        session: sessionName,
        issueNum,
        title: metadata.title,
        body: '', // Issue body isn't stored in traces; agent will work from diff + test output
        status: metadata.status,
        retries: metadata.retries,
        duration: metadata.duration,
        diff,
        testOutput,
        reviewOutput,
        verifyOutput,
      });
    }
  }

  if (pending.length === 0) {
    log.success(`All issues already have learnings (${skipped} skipped).`);
    return;
  }

  log.info(`${pending.length} issue(s) need learning extraction, ${skipped} already have learnings`);
  console.log('');
  for (const p of pending) {
    console.log(`  #${p.issueNum} — ${p.title} (${p.session})`);
  }
  console.log('');

  if (options.dryRun) {
    log.dry(`Would extract learnings for ${pending.length} issue(s).`);
    return;
  }

  // Extract learnings for each pending issue
  let extracted = 0;
  let failed = 0;

  for (const p of pending) {
    log.step(`[${extracted + failed + 1}/${pending.length}] Extracting learnings for #${p.issueNum}: ${p.title}`);

    try {
      await extractLearnings({
        issueNum: p.issueNum,
        title: p.title,
        status: p.status,
        retries: p.retries,
        duration: p.duration,
        diff: p.diff,
        testOutput: p.testOutput,
        reviewOutput: p.reviewOutput,
        verifyOutput: p.verifyOutput,
        body: p.body,
        config,
        sessionLogsDir: join(projectDir, '.alpha-loop', 'traces', p.session),
        sessionName: p.session,
      });
      extracted++;
    } catch (err) {
      log.warn(`Failed to extract learnings for #${p.issueNum}: ${err}`);
      failed++;
    }
  }

  console.log('');
  log.success(`Learning extraction complete: ${extracted} extracted, ${failed} failed, ${skipped} already existed`);
}
