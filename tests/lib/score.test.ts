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
  buildParetoFrontier,
  formatScoreEntry,
  formatParetoTable,
  compareRuns,
  deriveConfigLabel,
} from '../../src/lib/score.js';
import type { CaseResult, ScoreEntry, ParetoEntry } from '../../src/lib/score.js';

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

  it('computes Pareto frontier correctly with efficiency', () => {
    const entry = (score: number, cost: number): ScoreEntry => ({
      timestamp: new Date().toISOString(),
      configHash: 'test',
      config: { model: 'claude-sonnet-4-6' },
      cases: [],
      composite: score,
      totalCost: cost,
    });

    appendScore(tempDir, entry(90, 10));  // Pareto: best score
    appendScore(tempDir, entry(80, 5));   // Pareto: lower cost
    appendScore(tempDir, entry(70, 8));   // Dominated by (80, 5)
    appendScore(tempDir, entry(60, 3));   // Pareto: cheapest

    const frontier = paretoFrontier(tempDir);
    expect(frontier).toHaveLength(3);
    expect(frontier.map((e) => e.composite)).toEqual([90, 80, 60]);

    // Verify efficiency is computed
    expect(frontier[0].efficiency).toBe(9);   // 90/10
    expect(frontier[1].efficiency).toBe(16);  // 80/5
    expect(frontier[2].efficiency).toBe(20);  // 60/3

    // Verify config labels
    expect(frontier[0].configLabel).toBe('sonnet');
  });

  it('handles zero cost with Infinity efficiency', () => {
    const entry: ScoreEntry = {
      timestamp: new Date().toISOString(),
      configHash: 'test',
      config: {},
      cases: [],
      composite: 80,
      totalCost: 0,
    };

    appendScore(tempDir, entry);
    const frontier = paretoFrontier(tempDir);
    expect(frontier[0].efficiency).toBe(Infinity);
  });
});

describe('buildParetoFrontier', () => {
  it('builds frontier from in-memory entries', () => {
    const entries: ScoreEntry[] = [
      { timestamp: 't1', configHash: 'a', config: { model: 'claude-opus-4-6' }, cases: [], composite: 90, totalCost: 10 },
      { timestamp: 't2', configHash: 'b', config: { model: 'claude-haiku-4-5' }, cases: [], composite: 75, totalCost: 2 },
      { timestamp: 't3', configHash: 'c', config: { model: 'claude-sonnet-4-6' }, cases: [], composite: 85, totalCost: 12 }, // dominated
    ];

    const frontier = buildParetoFrontier(entries);
    expect(frontier).toHaveLength(2);
    expect(frontier.map((e) => e.configHash)).toEqual(['a', 'b']);
  });
});

describe('deriveConfigLabel', () => {
  it('derives label from model name', () => {
    expect(deriveConfigLabel({ model: 'claude-opus-4-6' })).toBe('opus');
    expect(deriveConfigLabel({ model: 'claude-sonnet-4-6' })).toBe('sonnet');
    expect(deriveConfigLabel({ model: 'claude-haiku-4-5' })).toBe('haiku');
  });

  it('combines unique models from pipeline', () => {
    const label = deriveConfigLabel({
      model: 'claude-sonnet-4-6',
      pipeline: {
        plan: { model: 'claude-haiku-4-5' },
        review: { model: 'claude-haiku-4-5' },
      },
    });
    expect(label).toBe('sonnet+haiku');
  });

  it('includes reviewModel', () => {
    const label = deriveConfigLabel({
      model: 'claude-sonnet-4-6',
      reviewModel: 'claude-haiku-4-5',
    });
    expect(label).toBe('sonnet+haiku');
  });

  it('returns default for empty config', () => {
    expect(deriveConfigLabel({})).toBe('default');
  });

  it('handles gpt models', () => {
    expect(deriveConfigLabel({ model: 'gpt-4o' })).toBe('gpt4o');
    expect(deriveConfigLabel({ model: 'gpt-4o-mini' })).toBe('gpt4o-mini');
  });
});

describe('formatParetoTable', () => {
  it('formats frontier as ASCII table', () => {
    const frontier: ParetoEntry[] = [
      {
        timestamp: 't1', configHash: 'aaa', config: { model: 'claude-opus-4-6' },
        cases: [], composite: 90, totalCost: 10, efficiency: 9, configLabel: 'opus',
      },
      {
        timestamp: 't2', configHash: 'bbb', config: { model: 'claude-haiku-4-5' },
        cases: [], composite: 75, totalCost: 2, efficiency: 37.5, configLabel: 'haiku',
      },
    ];

    const table = formatParetoTable(frontier, 'aaa');
    expect(table).toContain('Pareto Frontier');
    expect(table).toContain('opus');
    expect(table).toContain('haiku');
    expect(table).toContain('Score');
    expect(table).toContain('Cost');
    expect(table).toContain('Efficiency');
  });

  it('returns message for empty frontier', () => {
    const table = formatParetoTable([]);
    expect(table).toContain('No data');
  });
});

describe('compareRuns', () => {
  it('returns null when no scores exist', () => {
    expect(compareRuns(tempDir, '1', '2')).toBeNull();
  });

  it('compares two runs by 1-based index', () => {
    const entry1: ScoreEntry = {
      timestamp: '2026-04-01T10:00:00Z',
      configHash: 'aaa',
      config: {},
      cases: [
        { caseId: 'case-a', passed: true, partialCredit: 1, retries: 0, duration: 60 },
        { caseId: 'case-b', passed: false, partialCredit: 0, retries: 1, duration: 120 },
      ],
      composite: 49.5,
      totalCost: 2.0,
    };
    const entry2: ScoreEntry = {
      timestamp: '2026-04-02T10:00:00Z',
      configHash: 'bbb',
      config: {},
      cases: [
        { caseId: 'case-a', passed: true, partialCredit: 1, retries: 0, duration: 50 },
        { caseId: 'case-b', passed: true, partialCredit: 1, retries: 0, duration: 80 },
      ],
      composite: 99.35,
      totalCost: 3.0,
    };

    appendScore(tempDir, entry1);
    appendScore(tempDir, entry2);

    const result = compareRuns(tempDir, '1', '2');
    expect(result).not.toBeNull();
    expect(result!.scoreDelta).toBeCloseTo(49.85);
    expect(result!.costDelta).toBe(1.0);
    expect(result!.cases).toHaveLength(2);

    const caseA = result!.cases.find((c) => c.caseId === 'case-a')!;
    expect(caseA.run1Passed).toBe(true);
    expect(caseA.run2Passed).toBe(true);
    expect(caseA.delta).toBe(0);

    const caseB = result!.cases.find((c) => c.caseId === 'case-b')!;
    expect(caseB.run1Passed).toBe(false);
    expect(caseB.run2Passed).toBe(true);
    expect(caseB.delta).toBe(1);
  });

  it('compares by timestamp prefix', () => {
    const entry1: ScoreEntry = {
      timestamp: '2026-04-01T10:00:00Z',
      configHash: 'aaa',
      config: {},
      cases: [{ caseId: 'x', passed: true, partialCredit: 1, retries: 0, duration: 30 }],
      composite: 99.7,
      totalCost: 1.0,
    };
    const entry2: ScoreEntry = {
      timestamp: '2026-04-02T10:00:00Z',
      configHash: 'bbb',
      config: {},
      cases: [{ caseId: 'x', passed: false, partialCredit: 0, retries: 2, duration: 90 }],
      composite: -0.2,
      totalCost: 0.5,
    };

    appendScore(tempDir, entry1);
    appendScore(tempDir, entry2);

    const result = compareRuns(tempDir, '2026-04-01', '2026-04-02');
    expect(result).not.toBeNull();
    expect(result!.run1.timestamp).toContain('2026-04-01');
    expect(result!.run2.timestamp).toContain('2026-04-02');
  });

  it('returns null for invalid references', () => {
    appendScore(tempDir, {
      timestamp: '2026-04-01T10:00:00Z',
      configHash: 'aaa',
      config: {},
      cases: [],
      composite: 50,
      totalCost: 1,
    });

    expect(compareRuns(tempDir, '1', '99')).toBeNull();
    expect(compareRuns(tempDir, 'nonexistent', '1')).toBeNull();
  });

  it('handles cases present in only one run', () => {
    const entry1: ScoreEntry = {
      timestamp: '2026-04-01T10:00:00Z',
      configHash: 'aaa',
      config: {},
      cases: [{ caseId: 'only-in-1', passed: true, partialCredit: 1, retries: 0, duration: 30 }],
      composite: 100,
      totalCost: 1,
    };
    const entry2: ScoreEntry = {
      timestamp: '2026-04-02T10:00:00Z',
      configHash: 'bbb',
      config: {},
      cases: [{ caseId: 'only-in-2', passed: true, partialCredit: 1, retries: 0, duration: 30 }],
      composite: 100,
      totalCost: 1,
    };

    appendScore(tempDir, entry1);
    appendScore(tempDir, entry2);

    const result = compareRuns(tempDir, '1', '2')!;
    expect(result.cases).toHaveLength(2);
    const c1 = result.cases.find((c) => c.caseId === 'only-in-1')!;
    expect(c1.run1Passed).toBe(true);
    expect(c1.run2Passed).toBeNull();
    const c2 = result.cases.find((c) => c.caseId === 'only-in-2')!;
    expect(c2.run1Passed).toBeNull();
    expect(c2.run2Passed).toBe(true);
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
