import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeCompositeScore,
  hashConfig,
  appendScore,
  readScores,
  latestScore,
  scoresByConfig,
  paretoFrontier,
  formatScoreEntry,
} from '../../src/lib/score.js';
import type { CaseResult, ScoreEntry } from '../../src/lib/score.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-score-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('computeCompositeScore', () => {
  it('returns 0 for empty cases', () => {
    expect(computeCompositeScore([])).toBe(0);
  });

  it('returns 100 for all passing with no retries and zero duration', () => {
    const cases: CaseResult[] = [
      { caseId: 'a', passed: true, partialCredit: 1, retries: 0, duration: 0 },
      { caseId: 'b', passed: true, partialCredit: 1, retries: 0, duration: 0 },
    ];
    expect(computeCompositeScore(cases)).toBe(100);
  });

  it('penalizes retries and duration', () => {
    const cases: CaseResult[] = [
      { caseId: 'a', passed: true, partialCredit: 1, retries: 2, duration: 100 },
    ];
    // score = 100 - 0.1*2 - 0.01*100 = 100 - 0.2 - 1 = 98.8
    expect(computeCompositeScore(cases)).toBe(98.8);
  });

  it('penalizes failures', () => {
    const cases: CaseResult[] = [
      { caseId: 'a', passed: true, partialCredit: 1, retries: 0, duration: 0 },
      { caseId: 'b', passed: false, partialCredit: 0, retries: 0, duration: 0 },
    ];
    // score = (1/2)*100 - 0 - 0 = 50
    expect(computeCompositeScore(cases)).toBe(50);
  });
});

describe('hashConfig', () => {
  it('produces consistent hashes', () => {
    const config = { agent: 'claude', model: 'opus' };
    const hash1 = hashConfig(config);
    const hash2 = hashConfig(config);
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different configs', () => {
    const hash1 = hashConfig({ agent: 'claude' });
    const hash2 = hashConfig({ agent: 'codex' });
    expect(hash1).not.toBe(hash2);
  });

  it('produces 12-character hex strings', () => {
    const hash = hashConfig({ test: 'value' });
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
  });
});

describe('appendScore / readScores', () => {
  it('appends and reads score entries', () => {
    const entry: ScoreEntry = {
      timestamp: '2026-04-01T12:00:00.000Z',
      configHash: 'abc123def456',
      config: { agent: 'claude' },
      cases: [{ caseId: 'a', passed: true, partialCredit: 1, retries: 0, duration: 60 }],
      composite: 99.4,
      totalCost: 0.50,
    };

    appendScore(tempDir, entry);
    const scores = readScores(tempDir);
    expect(scores).toHaveLength(1);
    expect(scores[0].composite).toBe(99.4);
  });

  it('appends multiple entries', () => {
    const makeEntry = (score: number): ScoreEntry => ({
      timestamp: new Date().toISOString(),
      configHash: 'test',
      config: {},
      cases: [],
      composite: score,
      totalCost: 0,
    });

    appendScore(tempDir, makeEntry(80));
    appendScore(tempDir, makeEntry(90));
    appendScore(tempDir, makeEntry(85));

    const scores = readScores(tempDir);
    expect(scores).toHaveLength(3);
    expect(scores.map((s) => s.composite)).toEqual([80, 90, 85]);
  });

  it('returns empty array when no scores file exists', () => {
    expect(readScores(tempDir)).toEqual([]);
  });
});

describe('latestScore', () => {
  it('returns null when no scores exist', () => {
    expect(latestScore(tempDir)).toBeNull();
  });

  it('returns the most recent entry', () => {
    const makeEntry = (score: number): ScoreEntry => ({
      timestamp: new Date().toISOString(),
      configHash: 'test',
      config: {},
      cases: [],
      composite: score,
      totalCost: 0,
    });

    appendScore(tempDir, makeEntry(80));
    appendScore(tempDir, makeEntry(95));

    expect(latestScore(tempDir)?.composite).toBe(95);
  });
});

describe('scoresByConfig', () => {
  it('groups scores by config hash and sorts by best score', () => {
    const entry = (hash: string, score: number): ScoreEntry => ({
      timestamp: new Date().toISOString(),
      configHash: hash,
      config: { hash },
      cases: [],
      composite: score,
      totalCost: 0,
    });

    appendScore(tempDir, entry('aaa', 70));
    appendScore(tempDir, entry('bbb', 90));
    appendScore(tempDir, entry('aaa', 80));
    appendScore(tempDir, entry('bbb', 85));

    const grouped = scoresByConfig(tempDir);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].configHash).toBe('bbb'); // best=90
    expect(grouped[1].configHash).toBe('aaa'); // best=80
    expect(grouped[0].scores).toHaveLength(2);
  });
});

describe('paretoFrontier', () => {
  it('returns empty array when no scores exist', () => {
    expect(paretoFrontier(tempDir)).toEqual([]);
  });

  it('computes Pareto frontier correctly', () => {
    const entry = (score: number, cost: number): ScoreEntry => ({
      timestamp: new Date().toISOString(),
      configHash: 'test',
      config: {},
      cases: [],
      composite: score,
      totalCost: cost,
    });

    // Pareto-optimal: highest score at lowest cost
    appendScore(tempDir, entry(90, 10));  // Pareto: best score
    appendScore(tempDir, entry(80, 5));   // Pareto: lower cost
    appendScore(tempDir, entry(70, 8));   // Dominated by (80, 5)
    appendScore(tempDir, entry(60, 3));   // Pareto: cheapest

    const frontier = paretoFrontier(tempDir);
    // Should include: (90,10), (80,5), (60,3) — not (70,8)
    expect(frontier).toHaveLength(3);
    expect(frontier.map((e) => e.composite)).toEqual([90, 80, 60]);
  });
});

describe('formatScoreEntry', () => {
  it('formats entry for display', () => {
    const entry: ScoreEntry = {
      timestamp: '2026-04-01T12:00:00.000Z',
      configHash: 'abc123def456',
      config: {},
      cases: [
        { caseId: 'a', passed: true, partialCredit: 1, retries: 0, duration: 60 },
        { caseId: 'b', passed: false, partialCredit: 0, retries: 2, duration: 120 },
      ],
      composite: 49.5,
      totalCost: 1.25,
    };

    const formatted = formatScoreEntry(entry);
    expect(formatted).toContain('2026-04-01');
    expect(formatted).toContain('score=49.5');
    expect(formatted).toContain('pass=1/2');
    expect(formatted).toContain('cost=$1.25');
    expect(formatted).toContain('config=abc123def456');
  });
});
