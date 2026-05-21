import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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

  test('writeQueueManifest writes queue.json under the queue session directory', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'alpha-loop-queue-'));
    try {
      const manifest = createEpicQueueManifest([
        {
          epicNumber: 205,
          title: 'First',
          issue: issue({ number: 205, title: 'First' }),
          status: 'pending',
        },
      ], new Date('2026-05-21T10:11:12.000Z'));

      const manifestPath = writeQueueManifest(projectDir, manifest);

      expect(manifestPath).toBe(join(projectDir, '.alpha-loop', 'sessions', 'queue-20260521T101112Z', 'queue.json'));
      expect(JSON.parse(readFileSync(manifestPath, 'utf-8'))).toEqual(manifest);
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
