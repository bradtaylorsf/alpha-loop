import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runCheck,
  runChecks,
  parseChecks,
} from '../../src/lib/eval-checks.js';
import type {
  CheckContext,
  CheckDefinition,
  FileExistsCheck,
  GrepCheck,
  DiffSizeCheck,
  KeywordPresentCheck,
  KeywordAbsentCheck,
} from '../../src/lib/eval-checks.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-checks-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runCheck — file_exists', () => {
  it('passes when file exists', async () => {
    writeFileSync(join(tempDir, 'hello.ts'), 'export const x = 1;');
    const check: FileExistsCheck = { type: 'file_exists', path: 'hello.ts' };
    const result = await runCheck(check, { cwd: tempDir });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails when file does not exist', async () => {
    const check: FileExistsCheck = { type: 'file_exists', path: 'missing.ts' };
    const result = await runCheck(check, { cwd: tempDir });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('runCheck — grep', () => {
  it('passes when pattern found in file', async () => {
    writeFileSync(join(tempDir, 'server.ts'), 'app.get("/health", (req, res) => res.json({ status: "ok" }));');
    const check: GrepCheck = { type: 'grep', file: 'server.ts', pattern: 'health' };
    const result = await runCheck(check, { cwd: tempDir });
    expect(result.passed).toBe(true);
  });

  it('fails when pattern not found', async () => {
    writeFileSync(join(tempDir, 'server.ts'), 'app.get("/api", handler);');
    const check: GrepCheck = { type: 'grep', file: 'server.ts', pattern: 'health' };
    const result = await runCheck(check, { cwd: tempDir });
    expect(result.passed).toBe(false);
  });

  it('fails when file does not exist', async () => {
    const check: GrepCheck = { type: 'grep', file: 'missing.ts', pattern: 'test' };
    const result = await runCheck(check, { cwd: tempDir });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('not found');
  });

  it('supports regex patterns', async () => {
    writeFileSync(join(tempDir, 'code.ts'), 'const uptime = process.uptime();');
    const check: GrepCheck = { type: 'grep', file: 'code.ts', pattern: 'uptime.*\\(\\)' };
    const result = await runCheck(check, { cwd: tempDir });
    expect(result.passed).toBe(true);
  });
});

describe('runCheck — diff_size', () => {
  it('passes when within limits', async () => {
    const check: DiffSizeCheck = { type: 'diff_size', max_files: 5, max_lines: 200 };
    const ctx: CheckContext = {
      cwd: tempDir,
      filesChanged: ['a.ts', 'b.ts'],
      diff: '+line1\n+line2\n-line3\n unchanged\n',
    };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(true);
  });

  it('fails when too many files', async () => {
    const check: DiffSizeCheck = { type: 'diff_size', max_files: 2 };
    const ctx: CheckContext = {
      cwd: tempDir,
      filesChanged: ['a.ts', 'b.ts', 'c.ts'],
      diff: '',
    };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('exceeded');
  });

  it('fails when too many lines', async () => {
    const check: DiffSizeCheck = { type: 'diff_size', max_lines: 2 };
    const lines = Array.from({ length: 10 }, (_, i) => `+line${i}`).join('\n');
    const ctx: CheckContext = { cwd: tempDir, diff: lines };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(false);
  });
});

describe('runCheck — keyword_present', () => {
  it('passes when all keywords found', async () => {
    const check: KeywordPresentCheck = { type: 'keyword_present', keywords: ['SQL injection', 'parameterized'] };
    const ctx: CheckContext = { cwd: tempDir, output: 'Found SQL injection vulnerability. Use parameterized queries.' };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails with partial credit when some missing', async () => {
    const check: KeywordPresentCheck = { type: 'keyword_present', keywords: ['SQL injection', 'parameterized', 'prepared statement'] };
    const ctx: CheckContext = { cwd: tempDir, output: 'Found SQL injection vulnerability.' };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(false);
    expect(result.score).toBeCloseTo(1 / 3);
  });
});

describe('runCheck — keyword_absent', () => {
  it('passes when no forbidden keywords found', async () => {
    const check: KeywordAbsentCheck = { type: 'keyword_absent', keywords: ['looks good', 'no issues'] };
    const ctx: CheckContext = { cwd: tempDir, output: 'Critical vulnerability found in the SQL query.' };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(true);
  });

  it('fails when forbidden keywords are present', async () => {
    const check: KeywordAbsentCheck = { type: 'keyword_absent', keywords: ['looks good', 'no issues'] };
    const ctx: CheckContext = { cwd: tempDir, output: 'Code looks good, no issues found.' };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(false);
  });
});

describe('runCheck — unknown type', () => {
  it('returns failure for unknown check type', async () => {
    const check = { type: 'unknown_type' } as any;
    const result = await runCheck(check, { cwd: tempDir });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Unknown check type');
  });
});

describe('runChecks', () => {
  it('runs multiple checks and aggregates results', async () => {
    writeFileSync(join(tempDir, 'file.ts'), 'content');
    const checks: CheckDefinition[] = [
      { type: 'file_exists', path: 'file.ts' },
      { type: 'file_exists', path: 'missing.ts' },
    ];
    const { results, allPassed, avgScore } = await runChecks(checks, { cwd: tempDir });
    expect(results).toHaveLength(2);
    expect(allPassed).toBe(false);
    expect(avgScore).toBe(0.5);
  });

  it('handles errors in individual checks', async () => {
    const checks: CheckDefinition[] = [
      { type: 'file_exists', path: 'test.ts' },
    ];
    const { results } = await runChecks(checks, { cwd: tempDir });
    expect(results).toHaveLength(1);
  });

  it('returns all passed when all checks pass', async () => {
    writeFileSync(join(tempDir, 'a.ts'), 'hello');
    writeFileSync(join(tempDir, 'b.ts'), 'world');
    const checks: CheckDefinition[] = [
      { type: 'file_exists', path: 'a.ts' },
      { type: 'file_exists', path: 'b.ts' },
    ];
    const { allPassed, avgScore } = await runChecks(checks, { cwd: tempDir });
    expect(allPassed).toBe(true);
    expect(avgScore).toBe(1);
  });
});

describe('parseChecks', () => {
  it('parses various check types from YAML-like object', () => {
    const raw = {
      type: 'e2e',
      checks: [
        { type: 'test_pass' },
        { type: 'file_exists', path: 'src/routes/health.ts' },
        { type: 'grep', file: 'src/routes/health.ts', pattern: 'uptime' },
        { type: 'http', method: 'GET', path: '/api/health', expect_status: 200, expect_body_contains: 'status' },
        { type: 'diff_size', max_files: 5, max_lines: 200 },
        { type: 'keyword_present', keywords: ['SQL injection', 'parameterized'] },
        { type: 'keyword_absent', keywords: ['looks good'] },
        { type: 'llm_judge', model: 'claude-haiku-4-5', rubric: 'Score 1-5', min_score: 4 },
      ],
    };

    const checks = parseChecks(raw);
    expect(checks).toHaveLength(8);
    expect(checks[0].type).toBe('test_pass');
    expect(checks[1].type).toBe('file_exists');
    expect((checks[1] as any).path).toBe('src/routes/health.ts');
    expect(checks[2].type).toBe('grep');
    expect((checks[2] as any).pattern).toBe('uptime');
    expect(checks[3].type).toBe('http');
    expect((checks[3] as any).expect_status).toBe(200);
    expect(checks[4].type).toBe('diff_size');
    expect((checks[4] as any).max_files).toBe(5);
    expect(checks[5].type).toBe('keyword_present');
    expect((checks[5] as any).keywords).toEqual(['SQL injection', 'parameterized']);
    expect(checks[6].type).toBe('keyword_absent');
    expect(checks[7].type).toBe('llm_judge');
    expect((checks[7] as any).min_score).toBe(4);
  });

  it('returns empty array for invalid input', () => {
    expect(parseChecks(null)).toEqual([]);
    expect(parseChecks(undefined)).toEqual([]);
    expect(parseChecks({})).toEqual([]);
    expect(parseChecks({ checks: 'not-array' })).toEqual([]);
  });
});
