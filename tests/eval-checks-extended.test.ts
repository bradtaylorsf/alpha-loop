import { runCheck, runChecks, parseChecks } from '../src/lib/eval-checks.js';
import type { CheckContext, ContainsAnyCheck, NotContainsCheck } from '../src/lib/eval-checks.js';

describe('contains_any check', () => {
  const ctx: CheckContext = { cwd: process.cwd() };

  it('passes when any value is found in output', async () => {
    const check: ContainsAnyCheck = {
      type: 'contains_any',
      values: ['SQL injection', 'parameterized', 'prepared statement'],
    };
    const result = await runCheck(check, { ...ctx, output: 'This has a parameterized query issue' });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.detail).toContain('parameterized');
  });

  it('fails when no values are found', async () => {
    const check: ContainsAnyCheck = {
      type: 'contains_any',
      values: ['SQL injection', 'parameterized'],
    };
    const result = await runCheck(check, { ...ctx, output: 'Everything looks good' });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
  });

  it('handles empty output', async () => {
    const check: ContainsAnyCheck = {
      type: 'contains_any',
      values: ['test'],
    };
    const result = await runCheck(check, { ...ctx, output: '' });
    expect(result.passed).toBe(false);
  });

  it('handles missing output (undefined)', async () => {
    const check: ContainsAnyCheck = {
      type: 'contains_any',
      values: ['test'],
    };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(false);
  });
});

describe('not_contains check', () => {
  const ctx: CheckContext = { cwd: process.cwd() };

  it('passes when no forbidden values are found', async () => {
    const check: NotContainsCheck = {
      type: 'not_contains',
      values: ['LGTM', 'looks good'],
    };
    const result = await runCheck(check, { ...ctx, output: 'Found security vulnerability in line 42' });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('fails when a forbidden value is found', async () => {
    const check: NotContainsCheck = {
      type: 'not_contains',
      values: ['LGTM', 'looks good'],
    };
    const result = await runCheck(check, { ...ctx, output: 'LGTM, this code looks fine' });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.detail).toContain('LGTM');
  });

  it('passes with empty output', async () => {
    const check: NotContainsCheck = {
      type: 'not_contains',
      values: ['bad'],
    };
    const result = await runCheck(check, { ...ctx, output: '' });
    expect(result.passed).toBe(true);
  });

  it('handles missing output (undefined)', async () => {
    const check: NotContainsCheck = {
      type: 'not_contains',
      values: ['test'],
    };
    const result = await runCheck(check, ctx);
    expect(result.passed).toBe(true);
  });
});

describe('parseChecks — new types', () => {
  it('parses contains_any checks', () => {
    const raw = {
      checks: [
        { type: 'contains_any', values: ['option-a', 'option-b'] },
      ],
    };
    const checks = parseChecks(raw);
    expect(checks).toHaveLength(1);
    expect(checks[0].type).toBe('contains_any');
    if (checks[0].type === 'contains_any') {
      expect(checks[0].values).toEqual(['option-a', 'option-b']);
    }
  });

  it('parses not_contains checks', () => {
    const raw = {
      checks: [
        { type: 'not_contains', values: ['forbidden-a', 'forbidden-b'] },
      ],
    };
    const checks = parseChecks(raw);
    expect(checks).toHaveLength(1);
    expect(checks[0].type).toBe('not_contains');
    if (checks[0].type === 'not_contains') {
      expect(checks[0].values).toEqual(['forbidden-a', 'forbidden-b']);
    }
  });

  it('handles mixed check types including new ones', () => {
    const raw = {
      checks: [
        { type: 'keyword_present', keywords: ['test'] },
        { type: 'contains_any', values: ['a', 'b'] },
        { type: 'not_contains', values: ['bad'] },
        { type: 'llm_judge', model: 'claude-haiku-4-5', rubric: 'Score it', min_score: 3 },
      ],
    };
    const checks = parseChecks(raw);
    expect(checks).toHaveLength(4);
    expect(checks.map((c) => c.type)).toEqual([
      'keyword_present', 'contains_any', 'not_contains', 'llm_judge',
    ]);
  });
});

describe('runChecks with new types', () => {
  it('runs mixed checks including contains_any and not_contains', async () => {
    const checks = parseChecks({
      checks: [
        { type: 'contains_any', values: ['security', 'vulnerability'] },
        { type: 'not_contains', values: ['LGTM'] },
        { type: 'keyword_present', keywords: ['review'] },
      ],
    });

    const result = await runChecks(checks, {
      cwd: process.cwd(),
      output: 'This review found a security vulnerability in the auth middleware',
    });

    expect(result.allPassed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.avgScore).toBe(1);
  });

  it('fails when not_contains finds forbidden content', async () => {
    const checks = parseChecks({
      checks: [
        { type: 'contains_any', values: ['review'] },
        { type: 'not_contains', values: ['LGTM'] },
      ],
    });

    const result = await runChecks(checks, {
      cwd: process.cwd(),
      output: 'LGTM, this review looks good',
    });

    expect(result.allPassed).toBe(false);
    // contains_any passes (found "review"), not_contains fails (found "LGTM")
    expect(result.results[0].passed).toBe(true);
    expect(result.results[1].passed).toBe(false);
  });
});
