import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEpicQueueWaves,
  createEpicQueueManifest,
  createEpicQueueValidationFailureManifest,
  findDuplicateEpicIds,
  parseEpicQueue,
  validateEpicQueue,
  writeQueueManifest,
} from '../../src/lib/epic-queue';
import type { Issue } from '../../src/lib/github';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: 'Epic',
    body: '- [ ] #2',
    labels: ['epic'],
    state: 'OPEN',
    ...overrides,
  };
}

describe('epic queue helpers', () => {
  test('parseEpicQueue preserves comma-separated order', () => {
    expect(parseEpicQueue('205,166,214')).toEqual([205, 166, 214]);
    expect(parseEpicQueue(' 205, 166 ,214 ')).toEqual([205, 166, 214]);
  });

  test('parseEpicQueue rejects empty and invalid tokens', () => {
    expect(() => parseEpicQueue('')).toThrow('--epics requires');
    expect(() => parseEpicQueue('205,,214')).toThrow('position 2');
    expect(() => parseEpicQueue('205,abc')).toThrow('position 2');
    expect(() => parseEpicQueue('0,214')).toThrow('position 1');
  });

  test('findDuplicateEpicIds reports each duplicate once in repeat order', () => {
    expect(findDuplicateEpicIds([205, 166, 205, 214, 166, 166])).toEqual([205, 166]);
  });

  test('validateEpicQueue returns ordered valid entries and skips completed epics', () => {
    const issues = new Map<number, Issue>([
      [205, issue({ number: 205, title: 'First' })],
      [166, issue({ number: 166, title: 'Done', state: 'CLOSED', stateReason: 'COMPLETED' })],
      [214, issue({ number: 214, title: 'Third' })],
    ]);

    const result = validateEpicQueue('owner/repo', [205, 166, 214], (_repo, issueNum) => issues.get(issueNum) ?? null);

    expect(result.errors).toEqual([]);
    expect(result.entries.map((entry) => [entry.epicNumber, entry.status])).toEqual([
      [205, 'pending'],
      [166, 'already-complete'],
      [214, 'pending'],
    ]);
    expect(result.entries.map((entry) => entry.dependencyIds)).toEqual([[], [], []]);
  });

  test('buildEpicQueueWaves creates deterministic dependency waves in requested order', () => {
    const issues = new Map<number, Issue>([
      [30, issue({ number: 30, title: 'Third', body: 'Depends on #10 and depends on #20.' })],
      [10, issue({ number: 10, title: 'First', body: 'No dependencies.' })],
      [20, issue({ number: 20, title: 'Second', body: 'No dependencies.' })],
      [40, issue({ number: 40, title: 'Fourth', body: 'Requires #30.' })],
    ]);
    const result = validateEpicQueue('owner/repo', [30, 10, 20, 40], (_repo, issueNum) => issues.get(issueNum) ?? null);

    expect(result.errors).toEqual([]);
    expect(result.entries.map((entry) => [entry.epicNumber, entry.dependencyIds])).toEqual([
      [30, [10, 20]],
      [10, []],
      [20, []],
      [40, [30]],
    ]);
    expect(buildEpicQueueWaves(result.entries).map((wave) => wave.map((entry) => entry.epicNumber))).toEqual([
      [10, 20],
      [30],
      [40],
    ]);
  });

  test('validateEpicQueue rejects dependency cycles among queued epics', () => {
    const issues = new Map<number, Issue>([
      [10, issue({ number: 10, body: 'Depends on #20.' })],
      [20, issue({ number: 20, body: 'Blocked by #10.' })],
      [30, issue({ number: 30, body: 'Depends on #10.' })],
    ]);

    const result = validateEpicQueue('owner/repo', [10, 20, 30], (_repo, issueNum) => issues.get(issueNum) ?? null);

    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'dependency-cycle', epicNumber: 10 }),
      expect.objectContaining({ code: 'dependency-cycle', epicNumber: 20 }),
    ]);
  });

  test('validateEpicQueue rejects duplicates, missing issues, non-epics, and closed incomplete epics', () => {
    const issues = new Map<number, Issue>([
      [166, issue({ number: 166, labels: ['ready'] })],
      [214, issue({ number: 214, state: 'CLOSED', stateReason: 'NOT_PLANNED' })],
    ]);

    const result = validateEpicQueue('owner/repo', [205, 205, 166, 214, 999], (_repo, issueNum) => issues.get(issueNum) ?? null);

    expect(result.entries).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual([
      'duplicate-epic',
      'missing-epic-label',
      'closed-incomplete-epic',
      'epic-not-found',
    ]);
  });

  test('validateEpicQueue can keep non-epic issues for dry-run preview warnings', () => {
    const issues = new Map<number, Issue>([
      [214, issue({ number: 214, title: 'Missing label', labels: ['ready'] })],
    ]);

    const result = validateEpicQueue(
      'owner/repo',
      [214],
      (_repo, issueNum) => issues.get(issueNum) ?? null,
      { allowMissingEpicLabel: true },
    );

    expect(result.errors).toEqual([]);
    expect(result.entries).toEqual([
      expect.objectContaining({
        epicNumber: 214,
        status: 'pending',
        validationWarning: expect.stringContaining('not labeled'),
      }),
    ]);
  });

  test('writeQueueManifest writes queue.json under the queue session directory', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'alpha-loop-queue-'));
    try {
      const manifest = createEpicQueueManifest([
        {
          epicNumber: 205,
          title: 'First',
          issue: issue({ number: 205, title: 'First' }),
          status: 'pending',
          dependencyIds: [],
        },
      ], new Date('2026-05-21T10:11:12.000Z'));

      const manifestPath = writeQueueManifest(projectDir, manifest);

      expect(manifestPath).toBe(join(projectDir, '.alpha-loop', 'sessions', 'queue-20260521T101112Z', 'queue.json'));
      expect(JSON.parse(readFileSync(manifestPath, 'utf-8'))).toEqual(manifest);
      expect(manifest.parallelLimit).toBe(1);
      expect(manifest.waves).toEqual([
        expect.objectContaining({ waveNumber: 1, epicIds: [205], status: 'pending' }),
      ]);
      expect(manifest.epics[0]).toEqual(expect.objectContaining({
        dependencyIds: [],
        waveNumber: 1,
        waveIndex: 1,
        logPath: null,
      }));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('createEpicQueueValidationFailureManifest preserves requested IDs for failed attempts', () => {
    const manifest = createEpicQueueValidationFailureManifest(
      [205, 205, 166, 214],
      [
        { code: 'duplicate-epic', epicNumber: 205, message: 'Epic #205 appears more than once' },
        { code: 'missing-epic-label', epicNumber: 166, message: 'Issue #166 is not labeled epic' },
      ],
      new Date('2026-05-21T10:11:12.000Z'),
    );

    expect(manifest).toEqual(expect.objectContaining({
      queueId: 'queue-20260521T101112Z',
      epicIds: [205, 205, 166, 214],
      status: 'stopped',
      stopReason: 'queue-validation-failed',
    }));
    expect(manifest.epics.map((entry) => [entry.epicNumber, entry.status])).toEqual([
      [205, 'failure'],
      [205, 'failure'],
      [166, 'failure'],
      [214, 'pending'],
    ]);
  });
});
