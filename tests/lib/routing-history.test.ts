import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendRoutingHistory,
  readRoutingHistory,
  latestMatrixRunTime,
  isMatrixFresh,
  MATRIX_FRESHNESS_WINDOW_MS,
  ROUTING_HISTORY_PATH,
} from '../../src/lib/routing-history.js';

describe('routing-history', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-routing-history-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('append + read roundtrip', () => {
    it('creates the file with a header on first append and reads back entries', () => {
      appendRoutingHistory(
        {
          timestamp: '20260423-010000',
          action: 'promote',
          stage: 'build',
          from: { model: 'claude-sonnet-4-6', endpoint: 'anthropic-prod' },
          to: { model: 'qwen3-coder-30b', endpoint: 'lmstudio' },
          reason: 'cost savings 50%',
          metrics: { runs: 50, tool_error_rate: 0.01 },
          prUrl: 'https://github.com/foo/bar/pull/1',
        },
        tempDir,
      );

      appendRoutingHistory(
        {
          timestamp: '20260423-020000',
          action: 'demote',
          stage: 'build',
          from: { model: 'qwen3-coder-30b', endpoint: 'lmstudio' },
          to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic-prod' },
          reason: 'tool_error_rate > 0.08',
        },
        tempDir,
      );

      const entries = readRoutingHistory(tempDir);
      expect(entries).toHaveLength(2);
      expect(entries[0].action).toBe('promote');
      expect(entries[0].stage).toBe('build');
      expect(entries[0].from.model).toBe('claude-sonnet-4-6');
      expect(entries[0].to.model).toBe('qwen3-coder-30b');
      expect(entries[0].prUrl).toContain('pull/1');
      expect(entries[1].action).toBe('demote');
      expect(entries[1].reason).toContain('tool_error_rate');
    });

    it('returns empty when history file does not exist', () => {
      expect(readRoutingHistory(tempDir)).toEqual([]);
    });

    it('writes to .alpha-loop/learnings/routing-history.md', () => {
      appendRoutingHistory(
        {
          timestamp: 'ts',
          action: 'promote',
          stage: 'build',
          from: { model: 'a' },
          to: { model: 'b' },
          reason: 'x',
        },
        tempDir,
      );
      expect(ROUTING_HISTORY_PATH).toBe('.alpha-loop/learnings/routing-history.md');
    });
  });

  describe('latestMatrixRunTime / isMatrixFresh', () => {
    it('returns null when no reports exist', () => {
      expect(latestMatrixRunTime(tempDir)).toBeNull();
    });

    it('returns the mtime of the newest routing report', () => {
      const reportsDir = join(tempDir, 'eval', 'reports');
      mkdirSync(reportsDir, { recursive: true });

      const older = join(reportsDir, 'routing-2026-04-01.md');
      const newer = join(reportsDir, 'routing-2026-04-20.md');
      writeFileSync(older, 'x');
      writeFileSync(newer, 'y');

      // Force distinct mtimes.
      const olderMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
      const newerMs = Date.now() - 1 * 24 * 60 * 60 * 1000;
      utimesSync(older, olderMs / 1000, olderMs / 1000);
      utimesSync(newer, newerMs / 1000, newerMs / 1000);

      const result = latestMatrixRunTime(tempDir);
      expect(result).not.toBeNull();
      expect(result).toBeGreaterThan(olderMs - 1000);
      // Should pick the newer one.
      expect(Math.abs((result ?? 0) - newerMs)).toBeLessThan(2000);
    });

    it('isMatrixFresh respects 7-day window', () => {
      const reportsDir = join(tempDir, 'eval', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const report = join(reportsDir, 'routing-2026-04-15.md');
      writeFileSync(report, 'x');

      const nowMs = Date.now();
      const eightDaysAgo = nowMs - 8 * 24 * 60 * 60 * 1000;
      utimesSync(report, eightDaysAgo / 1000, eightDaysAgo / 1000);
      expect(isMatrixFresh(tempDir, nowMs)).toBe(false);

      const threeDaysAgo = nowMs - 3 * 24 * 60 * 60 * 1000;
      utimesSync(report, threeDaysAgo / 1000, threeDaysAgo / 1000);
      expect(isMatrixFresh(tempDir, nowMs)).toBe(true);
    });

    it('returns false when the window is zero and latest is any age', () => {
      const reportsDir = join(tempDir, 'eval', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const report = join(reportsDir, 'routing-2026-04-15.md');
      writeFileSync(report, 'x');
      expect(isMatrixFresh(tempDir, Date.now() + 1000, 0)).toBe(false);
    });

    it('MATRIX_FRESHNESS_WINDOW_MS equals 7 days', () => {
      expect(MATRIX_FRESHNESS_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
  });
});
