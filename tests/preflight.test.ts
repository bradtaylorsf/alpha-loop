import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { runPreflight, parseFailingTests } from '../src/lib/preflight.js';
import type { ExecResult } from '../src/lib/shell.js';

const makeExecutor = (exitCode: number, stdout: string, stderr: string = '') =>
  async (): Promise<ExecResult> => ({ stdout, stderr, exitCode });

describe('runPreflight', () => {
  it('returns passed when tests succeed', async () => {
    const executor = makeExecutor(0, 'Tests:  5 passed, 5 total');

    const result = await runPreflight({ testCommand: 'pnpm test' }, executor);
    expect(result.passed).toBe(true);
    expect(result.preExistingFailures).toEqual([]);
    expect(result.ignoreFile).toBeUndefined();
  });

  it('returns failures when tests fail (Jest format)', async () => {
    const output = [
      'FAIL tests/foo.test.ts',
      '  ● Auth › should authenticate user',
      '  ● Auth › should reject bad token',
      'Tests:  2 failed, 3 passed, 5 total',
    ].join('\n');
    const executor = makeExecutor(1, output);

    const result = await runPreflight({ testCommand: 'pnpm test' }, executor);
    expect(result.passed).toBe(false);
    expect(result.preExistingFailures).toEqual([
      '● Auth › should authenticate user',
      '● Auth › should reject bad token',
    ]);
    expect(result.ignoreFile).toBeDefined();

    // Verify ignore file was created with the right content
    const content = readFileSync(result.ignoreFile!, 'utf-8');
    expect(content).toContain('● Auth › should authenticate user');
    expect(content).toContain('● Auth › should reject bad token');

    // Cleanup
    if (existsSync(result.ignoreFile!)) unlinkSync(result.ignoreFile!);
  });

  it('returns failures when tests fail (Vitest format)', async () => {
    const output = [
      '❌ Auth should authenticate user',
      '❌ Auth should reject bad token',
      'Tests  2 failed | 3 passed (5)',
    ].join('\n');
    const executor = makeExecutor(1, output);

    const result = await runPreflight({ testCommand: 'vitest run' }, executor);
    expect(result.passed).toBe(false);
    expect(result.preExistingFailures).toEqual([
      '❌ Auth should authenticate user',
      '❌ Auth should reject bad token',
    ]);

    if (result.ignoreFile && existsSync(result.ignoreFile)) unlinkSync(result.ignoreFile);
  });

  it('falls back to FAIL lines when no test names found', async () => {
    const output = [
      'FAIL tests/broken.test.ts',
      'Tests:  1 failed, 1 total',
    ].join('\n');
    const executor = makeExecutor(1, output);

    const result = await runPreflight({ testCommand: 'pnpm test' }, executor);
    expect(result.passed).toBe(false);
    expect(result.preExistingFailures).toEqual(['FAIL tests/broken.test.ts']);

    if (result.ignoreFile && existsSync(result.ignoreFile)) unlinkSync(result.ignoreFile);
  });

  it('skips when skipPreflight is true', async () => {
    const executor = jest.fn();
    const result = await runPreflight({ testCommand: 'pnpm test', skipPreflight: true }, executor);

    expect(result.passed).toBe(true);
    expect(result.preExistingFailures).toEqual([]);
    expect(executor).not.toHaveBeenCalled();
  });

  it('skips when skipTests is true', async () => {
    const executor = jest.fn();
    const result = await runPreflight({ testCommand: 'pnpm test', skipTests: true }, executor);

    expect(result.passed).toBe(true);
    expect(executor).not.toHaveBeenCalled();
  });

  it('skips when dryRun is true', async () => {
    const executor = jest.fn();
    const result = await runPreflight({ testCommand: 'pnpm test', dryRun: true }, executor);

    expect(result.passed).toBe(true);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe('parseFailingTests', () => {
  it('parses Jest ● format', () => {
    const output = '  ● Suite › test one\n  ● Suite › test two\n';
    expect(parseFailingTests(output)).toEqual([
      '● Suite › test one',
      '● Suite › test two',
    ]);
  });

  it('parses Vitest ❌ format', () => {
    const output = '❌ test one\n❌ test two\n';
    expect(parseFailingTests(output)).toEqual([
      '❌ test one',
      '❌ test two',
    ]);
  });

  it('returns empty array when no failures', () => {
    expect(parseFailingTests('Tests:  5 passed, 5 total')).toEqual([]);
  });
});
