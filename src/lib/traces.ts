/**
 * Trace Storage — full execution traces per issue (Meta-Harness style).
 *
 * Stores raw agent output, diffs, test output, review output, verify output,
 * and pipeline metadata as separate files under:
 *   .alpha-loop/traces/{session}/{issue-num}/
 *
 * Key insight from Meta-Harness (Lee et al., 2026): full trace access
 * outperforms summaries by 15+ points. We store everything raw.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';

/** Known trace file names within an issue trace directory. */
export type TraceFile =
  | 'agent-output.txt'
  | 'diff.patch'
  | 'test-output.txt'
  | 'review-output.json'
  | 'verify-output.json'
  | 'plan.json'
  | 'metadata.json';

/** Pipeline metadata stored alongside traces. */
export type TraceMetadata = {
  issueNum: number;
  title: string;
  status: 'success' | 'failure';
  failureReason?: 'transient' | 'permanent';
  duration: number;
  retries: number;
  testsPassing: boolean;
  verifyPassing: boolean;
  verifySkipped: boolean;
  filesChanged: number;
  prUrl?: string;
  timestamp: string;
  agent: string;
  model: string;
};

/** A complete trace for one issue run. */
export type Trace = {
  session: string;
  issueNum: number;
  dir: string;
  metadata: TraceMetadata;
};

const TRACES_ROOT = '.alpha-loop/traces';

/** Get the base traces directory. */
export function tracesDir(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), TRACES_ROOT);
}

/** Get the directory for a specific issue trace within a session. */
export function traceDir(session: string, issueNum: number, projectDir?: string): string {
  return join(tracesDir(projectDir), session.replace(/\//g, '-'), String(issueNum));
}

/**
 * Write a trace file for an issue.
 * Creates the directory structure if it doesn't exist.
 */
export function writeTrace(
  session: string,
  issueNum: number,
  file: TraceFile,
  content: string,
  projectDir?: string,
): void {
  const dir = traceDir(session, issueNum, projectDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, file);
  writeFileSync(filePath, content);
  log.info(`Trace written: ${filePath}`);
}

/**
 * Write trace metadata for an issue.
 */
export function writeTraceMetadata(
  session: string,
  issueNum: number,
  metadata: TraceMetadata,
  projectDir?: string,
): void {
  writeTrace(session, issueNum, 'metadata.json', JSON.stringify(metadata, null, 2) + '\n', projectDir);
}

/**
 * Read a trace file. Returns null if it doesn't exist.
 */
export function readTrace(
  session: string,
  issueNum: number,
  file: TraceFile,
  projectDir?: string,
): string | null {
  const filePath = join(traceDir(session, issueNum, projectDir), file);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

/**
 * Read trace metadata for an issue. Returns null if it doesn't exist.
 */
export function readTraceMetadata(
  session: string,
  issueNum: number,
  projectDir?: string,
): TraceMetadata | null {
  const raw = readTrace(session, issueNum, 'metadata.json', projectDir);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TraceMetadata;
  } catch {
    return null;
  }
}

/**
 * List all sessions that have traces.
 */
export function listTraceSessions(projectDir?: string): string[] {
  const root = tracesDir(projectDir);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * List all issue numbers with traces in a session.
 */
export function listTraceIssues(session: string, projectDir?: string): number[] {
  const sessionDir = join(tracesDir(projectDir), session.replace(/\//g, '-'));
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => parseInt(d.name, 10))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
}

/**
 * List all traces across all sessions.
 * Returns them newest-first by session name (which is timestamp-based).
 */
export function listTraces(projectDir?: string): Trace[] {
  const traces: Trace[] = [];
  const sessions = listTraceSessions(projectDir);

  for (const session of sessions.reverse()) {
    const issues = listTraceIssues(session, projectDir);
    for (const issueNum of issues) {
      const metadata = readTraceMetadata(session, issueNum, projectDir);
      if (metadata) {
        traces.push({
          session,
          issueNum,
          dir: traceDir(session, issueNum, projectDir),
          metadata,
        });
      }
    }
  }

  return traces;
}

/**
 * Get the full filesystem path context for a trace.
 * Returns all trace files and their sizes for Meta-Harness-style filesystem access.
 */
export function getTraceFiles(session: string, issueNum: number, projectDir?: string): Array<{ file: string; size: number }> {
  const dir = traceDir(session, issueNum, projectDir);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .map((file) => {
      const filePath = join(dir, file);
      const content = readFileSync(filePath, 'utf-8');
      return { file, size: content.length };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}
