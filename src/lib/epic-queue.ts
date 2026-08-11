import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getIssueWithComments, type Issue } from './github.js';
import { hasLabel } from './labels.js';
import { parseDependencies } from './validation.js';

export type BranchAncestryMode = 'stacked' | 'independent';

export type QueueEpicLink = {
  number: number;
  title: string;
  sessionBranch?: string | null;
  sessionPrUrl?: string | null;
};

export type QueueSessionContext = {
  queueId: string;
  queueIndex: number;
  queueTotal: number;
  currentEpic: QueueEpicLink;
  previousEpic: QueueEpicLink | null;
  nextEpic: QueueEpicLink | null;
  previousSessionBranch: string | null;
  previousSessionPrUrl: string | null;
  branchAncestryMode: BranchAncestryMode;
  branchedFromBranch: string;
  dependsOnSessionBranch: string | null;
  dependsOnSessionPrUrl: string | null;
  rebaseOntoBranch: string | null;
  dependencyWarnings: string[];
  overlapWarnings: string[];
};

export type EpicQueueValidationErrorCode =
  | 'duplicate-epic'
  | 'epic-not-found'
  | 'missing-epic-label'
  | 'closed-incomplete-epic'
  | 'dependency-cycle';

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
  dependencyIds: number[];
  skipReason?: string;
  validationWarning?: string;
};

export type EpicQueueValidationResult = {
  entries: ValidatedEpicQueueEntry[];
  errors: EpicQueueValidationError[];
};

export type EpicQueueValidationOptions = {
  allowMissingEpicLabel?: boolean;
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
  queueIndex: number;
  queueTotal: number;
  dependencyIds: number[];
  waveNumber: number;
  waveIndex: number;
  previousEpic: QueueEpicLink | null;
  nextEpic: QueueEpicLink | null;
  status: EpicQueueManifestEntryStatus;
  sessionName: string | null;
  sessionBranch: string | null;
  sessionPrUrl: string | null;
  nextSessionBranch: string | null;
  nextSessionPrUrl: string | null;
  branchAncestryMode: BranchAncestryMode;
  branchedFromBranch: string | null;
  dependsOnSessionBranch: string | null;
  dependsOnSessionPrUrl: string | null;
  rebaseOntoBranch: string | null;
  dependencyWarnings: string[];
  overlapWarnings: string[];
  startedAt: string | null;
  endedAt: string | null;
  logPath: string | null;
  skipReason?: string;
  dependencyFailure?: {
    failedEpicIds: number[];
    message: string;
  };
  failures: EpicQueueManifestFailure[];
};

export type EpicQueueWaveStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';

export type EpicQueueManifestWave = {
  waveNumber: number;
  epicIds: number[];
  status: EpicQueueWaveStatus;
  startedAt: string | null;
  endedAt: string | null;
};

export type EpicQueueManifest = {
  queueId: string;
  epicIds: number[];
  branchAncestryMode: BranchAncestryMode;
  parallelLimit: number;
  waves: EpicQueueManifestWave[];
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
  return hasLabel(issue.labels, 'epic');
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
  options: EpicQueueValidationOptions = {},
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

    const missingEpicLabel = !hasEpicLabel(issue);
    if (missingEpicLabel && !options.allowMissingEpicLabel) {
      errors.push({
        code: 'missing-epic-label',
        epicNumber,
        message: `Issue #${epicNumber} is not labeled 'epic'`,
      });
      continue;
    }

    const validationWarning = missingEpicLabel
      ? `Issue #${epicNumber} is not labeled 'epic'; non-dry-run queue execution will reject it`
      : undefined;

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
        dependencyIds: [],
        skipReason: 'Epic is already closed as completed',
        validationWarning,
      });
      continue;
    }

    entries.push({
      epicNumber,
      title: issue.title,
      issue,
      status: 'pending',
      dependencyIds: [],
      validationWarning,
    });
  }

  const queuedEpicNumbers = new Set(entries.map((entry) => entry.epicNumber));
  for (const entry of entries) {
    entry.dependencyIds = parseDependencies(entry.issue.body).filter((dependencyId) => (
      queuedEpicNumbers.has(dependencyId)
    ));
  }

  if (errors.length === 0) {
    const cyclicEpicIds = findCyclicEpicIds(entries);
    for (const epicNumber of cyclicEpicIds) {
      errors.push({
        code: 'dependency-cycle',
        epicNumber,
        message: `Queued epic #${epicNumber} is part of a dependency cycle`,
      });
    }
  }

  return { entries, errors };
}

function findCyclicEpicIds(entries: ValidatedEpicQueueEntry[]): number[] {
  const dependencies = new Map(entries.map((entry) => [entry.epicNumber, entry.dependencyIds]));
  const state = new Map<number, 'visiting' | 'visited'>();
  const stack: number[] = [];
  const cyclic = new Set<number>();

  const visit = (epicNumber: number): void => {
    if (state.get(epicNumber) === 'visited') return;
    if (state.get(epicNumber) === 'visiting') {
      const cycleStart = stack.lastIndexOf(epicNumber);
      for (const member of stack.slice(cycleStart)) cyclic.add(member);
      return;
    }
    state.set(epicNumber, 'visiting');
    stack.push(epicNumber);
    for (const dependencyId of dependencies.get(epicNumber) ?? []) visit(dependencyId);
    stack.pop();
    state.set(epicNumber, 'visited');
  };

  for (const entry of entries) visit(entry.epicNumber);
  return entries.filter((entry) => cyclic.has(entry.epicNumber)).map((entry) => entry.epicNumber);
}

/** Build maximal topological waves while preserving requested queue order within each wave. */
export function buildEpicQueueWaves(entries: ValidatedEpicQueueEntry[]): ValidatedEpicQueueEntry[][] {
  const remaining = new Set(entries.map((entry) => entry.epicNumber));
  const completed = new Set<number>();
  const waves: ValidatedEpicQueueEntry[][] = [];

  while (remaining.size > 0) {
    const wave = entries.filter((entry) => (
      remaining.has(entry.epicNumber)
      && entry.dependencyIds.every((dependencyId) => completed.has(dependencyId))
    ));
    if (wave.length === 0) {
      const cyclic = entries.filter((entry) => remaining.has(entry.epicNumber)).map((entry) => `#${entry.epicNumber}`);
      throw new Error(`Epic queue dependency cycle detected: ${cyclic.join(', ')}`);
    }
    waves.push(wave);
    for (const entry of wave) {
      remaining.delete(entry.epicNumber);
      completed.add(entry.epicNumber);
    }
  }

  return waves;
}

export function createEpicQueueManifest(
  entries: ValidatedEpicQueueEntry[],
  now: Date = new Date(),
  branchAncestryMode: BranchAncestryMode = 'stacked',
  parallelLimit = 1,
  scheduledWaves: ValidatedEpicQueueEntry[][] = entries.map((entry) => [entry]),
): EpicQueueManifest {
  const startedAt = now.toISOString();
  const queueTotal = entries.length;
  const wavePosition = new Map<number, { waveNumber: number; waveIndex: number }>();
  scheduledWaves.forEach((wave, waveIndex) => {
    wave.forEach((entry, entryIndex) => {
      wavePosition.set(entry.epicNumber, { waveNumber: waveIndex + 1, waveIndex: entryIndex + 1 });
    });
  });

  return {
    queueId: `queue-${formatQueueTimestamp(now)}`,
    epicIds: entries.map((entry) => entry.epicNumber),
    branchAncestryMode,
    parallelLimit,
    waves: scheduledWaves.map((wave, index) => ({
      waveNumber: index + 1,
      epicIds: wave.map((entry) => entry.epicNumber),
      status: 'pending',
      startedAt: null,
      endedAt: null,
    })),
    status: 'running',
    startedAt,
    endedAt: null,
    stopReason: null,
    epics: entries.map((entry, index) => ({
      epicNumber: entry.epicNumber,
      title: entry.title,
      queueIndex: index + 1,
      queueTotal,
      dependencyIds: entry.dependencyIds,
      waveNumber: wavePosition.get(entry.epicNumber)?.waveNumber ?? index + 1,
      waveIndex: wavePosition.get(entry.epicNumber)?.waveIndex ?? 1,
      previousEpic: index > 0
        ? { number: entries[index - 1].epicNumber, title: entries[index - 1].title }
        : null,
      nextEpic: index < entries.length - 1
        ? { number: entries[index + 1].epicNumber, title: entries[index + 1].title }
        : null,
      status: entry.status === 'already-complete' ? 'skipped' : 'pending',
      sessionName: null,
      sessionBranch: null,
      sessionPrUrl: null,
      nextSessionBranch: null,
      nextSessionPrUrl: null,
      branchAncestryMode,
      branchedFromBranch: null,
      dependsOnSessionBranch: null,
      dependsOnSessionPrUrl: null,
      rebaseOntoBranch: null,
      dependencyWarnings: [],
      overlapWarnings: [],
      startedAt: null,
      endedAt: entry.status === 'already-complete' ? startedAt : null,
      logPath: null,
      skipReason: entry.skipReason,
      failures: [],
    })),
  };
}

export function createEpicQueueValidationFailureManifest(
  epicNumbers: number[],
  errors: EpicQueueValidationError[],
  now: Date = new Date(),
  branchAncestryMode: BranchAncestryMode = 'stacked',
  parallelLimit = 1,
): EpicQueueManifest {
  const startedAt = now.toISOString();
  const queueTotal = epicNumbers.length;

  return {
    queueId: `queue-${formatQueueTimestamp(now)}`,
    epicIds: epicNumbers,
    branchAncestryMode,
    parallelLimit,
    waves: epicNumbers.map((epicNumber, index) => ({
      waveNumber: index + 1,
      epicIds: [epicNumber],
      status: 'pending',
      startedAt: null,
      endedAt: null,
    })),
    status: 'stopped',
    startedAt,
    endedAt: startedAt,
    stopReason: 'queue-validation-failed',
    epics: epicNumbers.map((epicNumber, index) => {
      const failures = errors
        .filter((error) => error.epicNumber === epicNumber)
        .map((error) => ({ code: error.code, message: error.message }));
      return {
        epicNumber,
        title: '',
        queueIndex: index + 1,
        queueTotal,
        dependencyIds: [],
        waveNumber: index + 1,
        waveIndex: 1,
        previousEpic: index > 0 ? { number: epicNumbers[index - 1], title: '' } : null,
        nextEpic: index < epicNumbers.length - 1 ? { number: epicNumbers[index + 1], title: '' } : null,
        status: failures.length > 0 ? 'failure' : 'pending',
        sessionName: null,
        sessionBranch: null,
        sessionPrUrl: null,
        nextSessionBranch: null,
        nextSessionPrUrl: null,
        branchAncestryMode,
        branchedFromBranch: null,
        dependsOnSessionBranch: null,
        dependsOnSessionPrUrl: null,
        rebaseOntoBranch: null,
        dependencyWarnings: [],
        overlapWarnings: [],
        startedAt: null,
        endedAt: failures.length > 0 ? startedAt : null,
        logPath: null,
        failures,
      };
    }),
  };
}

export function writeQueueManifest(projectDir: string, manifest: EpicQueueManifest): string {
  const queueDir = join(projectDir, '.alpha-loop', 'sessions', manifest.queueId);
  mkdirSync(queueDir, { recursive: true });
  const manifestPath = join(queueDir, 'queue.json');
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  renameSync(temporaryPath, manifestPath);
  return manifestPath;
}
