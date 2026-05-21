import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getIssueWithComments, type Issue } from './github.js';

export type EpicQueueValidationErrorCode =
  | 'duplicate-epic'
  | 'epic-not-found'
  | 'missing-epic-label'
  | 'closed-incomplete-epic';

export type EpicQueueValidationError = {
  code: EpicQueueValidationErrorCode;
  epicNumber: number;
  message: string;
};

export type EpicQueueEntryStatus = 'pending' | 'already-complete';

export type ValidatedEpicQueueEntry = {
  epicNumber: number;
  title: string;
  issue: Issue;
  status: EpicQueueEntryStatus;
  skipReason?: string;
};

export type EpicQueueValidationResult = {
  entries: ValidatedEpicQueueEntry[];
  errors: EpicQueueValidationError[];
};

export type EpicQueueManifestStatus = 'running' | 'success' | 'stopped';
export type EpicQueueManifestEntryStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';

export type EpicQueueManifestFailure = {
  code: string;
  message: string;
  issueNum?: number;
  exitCode?: number;
};

export type EpicQueueManifestEntry = {
  epicNumber: number;
  title: string;
  status: EpicQueueManifestEntryStatus;
  sessionName: string | null;
  sessionBranch: string | null;
  sessionPrUrl: string | null;
  startedAt: string | null;
  endedAt: string | null;
  skipReason?: string;
  failures: EpicQueueManifestFailure[];
};

export type EpicQueueManifest = {
  queueId: string;
  epicIds: number[];
  status: EpicQueueManifestStatus;
  startedAt: string;
  endedAt: string | null;
  stopReason: string | null;
  epics: EpicQueueManifestEntry[];
};

export type FetchIssue = (repo: string, issueNum: number) => Issue | null;

function formatQueueTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function normalizeIssueState(value: string | undefined): string {
  return (value ?? 'OPEN').toLowerCase();
}

function normalizeIssueStateReason(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/_/g, '-');
}

function hasEpicLabel(issue: Issue): boolean {
  return issue.labels.some((label) => label.toLowerCase() === 'epic');
}

function isClosed(issue: Issue): boolean {
  return normalizeIssueState(issue.state) === 'closed';
}

function isCompleted(issue: Issue): boolean {
  return isClosed(issue) && normalizeIssueStateReason(issue.stateReason) === 'completed';
}

export function parseEpicQueue(raw: string): number[] {
  if (raw.trim() === '') {
    throw new Error('--epics requires a comma-separated list of epic issue numbers');
  }

  return raw.split(',').map((part, index) => {
    const token = part.trim();
    if (!/^[1-9]\d*$/.test(token)) {
      throw new Error(`Invalid epic issue number at position ${index + 1}: ${token || '(empty)'}`);
    }
    const epicNumber = Number(token);
    if (!Number.isSafeInteger(epicNumber)) {
      throw new Error(`Epic issue number at position ${index + 1} is too large: ${token}`);
    }
    return epicNumber;
  });
}

export function findDuplicateEpicIds(epicNumbers: number[]): number[] {
  const seen = new Set<number>();
  const duplicates: number[] = [];
  const duplicateSet = new Set<number>();

  for (const epicNumber of epicNumbers) {
    if (seen.has(epicNumber) && !duplicateSet.has(epicNumber)) {
      duplicates.push(epicNumber);
      duplicateSet.add(epicNumber);
    }
    seen.add(epicNumber);
  }

  return duplicates;
}

export function validateEpicQueue(
  repo: string,
  epicNumbers: number[],
  fetchIssue: FetchIssue = getIssueWithComments,
): EpicQueueValidationResult {
  const entries: ValidatedEpicQueueEntry[] = [];
  const errors: EpicQueueValidationError[] = [];
  const duplicateIds = findDuplicateEpicIds(epicNumbers);
  const duplicateSet = new Set(duplicateIds);

  for (const epicNumber of duplicateIds) {
    errors.push({
      code: 'duplicate-epic',
      epicNumber,
      message: `Epic #${epicNumber} appears more than once in the queue`,
    });
  }

  for (const epicNumber of epicNumbers) {
    if (duplicateSet.has(epicNumber)) continue;

    const issue = fetchIssue(repo, epicNumber);
    if (!issue) {
      errors.push({
        code: 'epic-not-found',
        epicNumber,
        message: `Could not fetch queued epic #${epicNumber}`,
      });
      continue;
    }

    if (!hasEpicLabel(issue)) {
      errors.push({
        code: 'missing-epic-label',
        epicNumber,
        message: `Issue #${epicNumber} is not labeled 'epic'`,
      });
      continue;
    }

    if (isClosed(issue) && !isCompleted(issue)) {
      errors.push({
        code: 'closed-incomplete-epic',
        epicNumber,
        message: `Issue #${epicNumber} is closed but not marked completed`,
      });
      continue;
    }

    if (isCompleted(issue)) {
      entries.push({
        epicNumber,
        title: issue.title,
        issue,
        status: 'already-complete',
        skipReason: 'Epic is already closed as completed',
      });
      continue;
    }

    entries.push({
      epicNumber,
      title: issue.title,
      issue,
      status: 'pending',
    });
  }

  return { entries, errors };
}

export function createEpicQueueManifest(
  entries: ValidatedEpicQueueEntry[],
  now: Date = new Date(),
): EpicQueueManifest {
  const startedAt = now.toISOString();

  return {
    queueId: `queue-${formatQueueTimestamp(now)}`,
    epicIds: entries.map((entry) => entry.epicNumber),
    status: 'running',
    startedAt,
    endedAt: null,
    stopReason: null,
    epics: entries.map((entry) => ({
      epicNumber: entry.epicNumber,
      title: entry.title,
      status: entry.status === 'already-complete' ? 'skipped' : 'pending',
      sessionName: null,
      sessionBranch: null,
      sessionPrUrl: null,
      startedAt: null,
      endedAt: entry.status === 'already-complete' ? startedAt : null,
      skipReason: entry.skipReason,
      failures: [],
    })),
  };
}

export function createEpicQueueValidationFailureManifest(
  epicNumbers: number[],
  errors: EpicQueueValidationError[],
  now: Date = new Date(),
): EpicQueueManifest {
  const startedAt = now.toISOString();

  return {
    queueId: `queue-${formatQueueTimestamp(now)}`,
    epicIds: epicNumbers,
    status: 'stopped',
    startedAt,
    endedAt: startedAt,
    stopReason: 'queue-validation-failed',
    epics: epicNumbers.map((epicNumber) => {
      const failures = errors
        .filter((error) => error.epicNumber === epicNumber)
        .map((error) => ({ code: error.code, message: error.message }));
      return {
        epicNumber,
        title: '',
        status: failures.length > 0 ? 'failure' : 'pending',
        sessionName: null,
        sessionBranch: null,
        sessionPrUrl: null,
        startedAt: null,
        endedAt: failures.length > 0 ? startedAt : null,
        failures,
      };
    }),
  };
}

export function writeQueueManifest(projectDir: string, manifest: EpicQueueManifest): string {
  const queueDir = join(projectDir, '.alpha-loop', 'sessions', manifest.queueId);
  mkdirSync(queueDir, { recursive: true });
  const manifestPath = join(queueDir, 'queue.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifestPath;
}
