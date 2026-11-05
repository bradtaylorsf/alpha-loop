jest.mock('../../src/lib/shell', () => ({ exec: jest.fn() }));
jest.mock('../../src/lib/logger', () => ({ log: { rate: jest.fn() } }));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import {
  ghExec,
  parseRateLimitHeaders,
  stripDebugOutput,
  getThrottleTier,
  getRateLimitStatus,
  resetRateLimitState,
  getProjectCache,
  setProjectCache,
  clearProjectCache,
} from '../../src/lib/rate-limit';

beforeEach(() => {
  resetRateLimitState();
  clearProjectCache();
});

describe('ghExec mutation budget', () => {
  let root: string;
  let budgetPath: string;
  let previousBudget: string | undefined;
  let clock: number;
  let sleep: jest.Mock<void, [number]>;
  const mockExec = jest.mocked(exec);
  const deps = () => ({ now: () => clock, sleep });
  const mutate = () => ghExec('gh issue edit 1', undefined, true, deps());
  const readBudget = () => JSON.parse(readFileSync(budgetPath, 'utf-8')) as { lastMutationAt: number };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gh-budget-'));
    budgetPath = join(root, 'gh-budget.json');
    previousBudget = process.env.ALPHA_LOOP_SHARED_GH_BUDGET;
    delete process.env.ALPHA_LOOP_SHARED_GH_BUDGET;
    clock = Date.parse('2026-11-05T10:00:00Z');
    sleep = jest.fn((ms: number) => { clock += ms; });
    mockExec.mockReset().mockImplementation(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    jest.mocked(log.rate).mockClear();
  });

  afterEach(() => {
    if (previousBudget === undefined) delete process.env.ALPHA_LOOP_SHARED_GH_BUDGET;
    else process.env.ALPHA_LOOP_SHARED_GH_BUDGET = previousBudget;
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps process-local completion pacing without the opt-in', () => {
    mockExec.mockImplementationOnce(() => {
      clock += 200;
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    mutate();
    clock += 250;
    mutate();
    expect(sleep.mock.calls).toEqual([[500]]);
    expect(readdirSync(root)).toEqual([]);
    resetRateLimitState();
    mutate();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('leaves read-only calls outside the shared budget, even with invalid state', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    ghExec('gh issue list', { cwd: root, timeout: 1000 }, false, deps());
    expect(readdirSync(root)).toEqual([]);
    writeFileSync(budgetPath, 'broken');
    ghExec('gh issue list', undefined, false, deps());
    expect(readFileSync(budgetPath, 'utf-8')).toBe('broken');
    expect(sleep).not.toHaveBeenCalled();
    expect(mockExec).toHaveBeenCalledWith('gh issue list', { cwd: root, timeout: 1000, env: { GH_DEBUG: 'api' } });
  });

  it('creates missing parent directories and claims the first slot before execution', () => {
    budgetPath = join(root, 'nested', 'gh-budget.json');
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    mockExec.mockImplementationOnce(() => {
      expect(readBudget()).toEqual({ lastMutationAt: clock });
      expect(existsSync(`${budgetPath}.lock`)).toBe(false);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    expect(mutate().stdout).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
    expect(readdirSync(join(root, 'nested'))).toEqual(['gh-budget.json']);
  });

  it.each([[0, 750], [250, 500], [749, 1], [750, 0], [751, 0]])(
    'enforces the remaining gap after %i ms', (elapsed, wait) => {
      process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
      writeFileSync(budgetPath, JSON.stringify({ lastMutationAt: clock - elapsed }));
      mutate();
      expect(sleep.mock.calls).toEqual(wait ? [[wait]] : []);
      expect(readBudget()).toEqual({ lastMutationAt: clock });
    },
  );

  it('preserves the shared clock across local state resets', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    mutate();
    resetRateLimitState();
    mutate();
    expect(sleep.mock.calls).toEqual([[750]]);
  });

  it('coordinates independent module instances through the same file', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    let otherGhExec!: typeof ghExec;
    jest.isolateModules(() => {
      otherGhExec = (require('../../src/lib/rate-limit') as typeof import('../../src/lib/rate-limit')).ghExec;
      const otherExec = (require('../../src/lib/shell') as typeof import('../../src/lib/shell')).exec;
      jest.mocked(otherExec).mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    });
    mutate();
    otherGhExec('gh issue edit 2', undefined, true, deps());
    mutate();
    expect(sleep.mock.calls).toEqual([[750], [750]]);
  });

  it('reads the environment at call time and keeps separate budget files independent', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    mutate();
    const first = readBudget();
    resetRateLimitState();
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = join(root, 'other.json');
    mutate();
    expect(sleep).not.toHaveBeenCalled();
    expect(readBudget()).toEqual(first);
    resetRateLimitState();
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    mutate();
    expect(sleep.mock.calls).toEqual([[750]]);
  });

  it('also respects this process\'s completion timestamp', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    mockExec.mockImplementationOnce(() => {
      clock += 1000;
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    mutate();
    mutate();
    expect(sleep.mock.calls).toEqual([[750]]);
  });

  it('releases the lock during waits and rereads a competing claim before admission', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    mutate();
    const first = readBudget();
    sleep.mockImplementationOnce((ms) => {
      expect(existsSync(`${budgetPath}.lock`)).toBe(false);
      expect(readBudget()).toEqual(first); // no reservation of a future slot
      clock += ms;
      writeFileSync(budgetPath, JSON.stringify({ lastMutationAt: clock - 100 }));
    });
    mutate();
    expect(sleep.mock.calls).toEqual([[750], [650]]);
    expect(readBudget()).toEqual({ lastMutationAt: clock });
  });

  it.each(['nonzero exit', 'exception'])('charges a failed mutation (%s)', (failure) => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    if (failure === 'exception') {
      mockExec.mockImplementationOnce(() => { throw new Error('execution failed'); });
      expect(mutate).toThrow('execution failed');
    } else {
      mockExec.mockReturnValueOnce({ stdout: '', stderr: 'failed', exitCode: 1 });
      expect(mutate().exitCode).toBe(1);
    }
    expect(readBudget()).toEqual({ lastMutationAt: clock });
    expect(existsSync(`${budgetPath}.lock`)).toBe(false);
    resetRateLimitState();
    mutate();
    expect(sleep.mock.calls).toEqual([[750]]);
  });

  it.each(['broken', 'null', '[]', '{}', '{"lastMutationAt":"123"}', '{"lastMutationAt":-1}', '{"lastMutationAt":1.5}', '{"lastMutationAt":1e999}'])(
    'rejects invalid state %s without executing and releases the lock', (raw) => {
      process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
      writeFileSync(budgetPath, raw);
      expect(mutate).toThrow(/shared GitHub mutation budget/i);
      expect(mockExec).not.toHaveBeenCalled();
      expect(readFileSync(budgetPath, 'utf-8')).toBe(raw);
      expect(readdirSync(root)).toEqual(['gh-budget.json']);
    },
  );

  it('fails closed on filesystem errors', () => {
    writeFileSync(budgetPath, 'not a directory');
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = join(budgetPath, 'nested.json');
    expect(mutate).toThrow();
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('fails closed on a read error and releases the lock', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    mkdirSync(budgetPath);
    expect(mutate).toThrow();
    expect(mockExec).not.toHaveBeenCalled();
    expect(existsSync(`${budgetPath}.lock`)).toBe(false);
  });

  it('cleans up a failed atomic write and preserves the previous budget', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    const raw = JSON.stringify({ lastMutationAt: clock - 1000 });
    writeFileSync(budgetPath, raw);
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === budgetPath) throw new Error('rename failed');
      rename(from, to);
    });
    expect(mutate).toThrow('rename failed');
    expect(mockExec).not.toHaveBeenCalled();
    expect(readFileSync(budgetPath, 'utf-8')).toBe(raw);
    expect(readdirSync(root)).toEqual(['gh-budget.json']);
  });

  it('uses injected time and sleep for lock contention and fails closed on timeout', () => {
    process.env.ALPHA_LOOP_SHARED_GH_BUDGET = budgetPath;
    const held = JSON.stringify({ version: 1, pid: process.pid, hostname: hostname(), token: 'holder', acquiredAt: new Date(clock).toISOString() });
    writeFileSync(`${budgetPath}.lock`, held);
    expect(mutate).toThrow(/Timed out.*waiting for lock/);
    expect(sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBe(120_000);
    expect(mockExec).not.toHaveBeenCalled();
    expect(readFileSync(`${budgetPath}.lock`, 'utf-8')).toBe(held);
  });

  it('waits for a 125-second reset in bounded chunks and logs the wait once', () => {
    mockExec.mockReturnValueOnce({
      stdout: '', exitCode: 1,
      stderr: `< X-Ratelimit-Limit: 5000\n< X-Ratelimit-Remaining: 0\n< X-Ratelimit-Reset: ${(clock + 125_000) / 1000}\nquota exhausted`,
    });
    expect(ghExec('gh issue list', undefined, false, deps()).stderr).toBe('quota exhausted');
    expect(mutate().exitCode).toBe(0);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000], [5000]]);
    const notifications = jest.mocked(log.rate).mock.calls.filter(([message]) => message.includes('Waiting'));
    expect(notifications).toEqual([['Rate limit critical (0/5000). Waiting 125s for reset...']]);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});

describe('parseRateLimitHeaders', () => {
  it('parses all four rate limit headers from GH_DEBUG stderr', () => {
    const stderr = [
      '* Request to https://api.github.com/repos/foo/bar/issues',
      '> GET /repos/foo/bar/issues HTTP/2',
      '< HTTP/2 200',
      '< X-Ratelimit-Limit: 5000',
      '< X-Ratelimit-Remaining: 4990',
      '< X-Ratelimit-Used: 10',
      '< X-Ratelimit-Reset: 1700000000',
    ].join('\n');

    const result = parseRateLimitHeaders(stderr);
    expect(result).toEqual({
      limit: 5000,
      remaining: 4990,
      used: 10,
      resetAt: 1700000000,
    });
  });

  it('returns null when required headers are missing', () => {
    expect(parseRateLimitHeaders('just some stderr text')).toBeNull();
    expect(parseRateLimitHeaders('')).toBeNull();
  });

  it('returns null when only one of limit/remaining is present', () => {
    expect(parseRateLimitHeaders('< X-Ratelimit-Limit: 5000')).toBeNull();
    expect(parseRateLimitHeaders('< X-Ratelimit-Remaining: 4990')).toBeNull();
  });

  it('defaults used and resetAt to 0 when not present', () => {
    const stderr = [
      '< X-Ratelimit-Limit: 5000',
      '< X-Ratelimit-Remaining: 4500',
    ].join('\n');

    const result = parseRateLimitHeaders(stderr);
    expect(result).toEqual({
      limit: 5000,
      remaining: 4500,
      used: 0,
      resetAt: 0,
    });
  });

  it('takes the last occurrence when multiple header sets are present', () => {
    // gh commands can produce multiple header sets (REST + GraphQL, or paginated GraphQL).
    // The last set reflects the most recent response with the lowest remaining budget.
    const stderr = [
      '< X-Ratelimit-Limit: 5000',
      '< X-Ratelimit-Remaining: 4995',
      '< X-Ratelimit-Used: 5',
      '< X-Ratelimit-Reset: 1700000000',
      '< X-Ratelimit-Limit: 5000',
      '< X-Ratelimit-Remaining: 1680',
      '< X-Ratelimit-Used: 3320',
      '< X-Ratelimit-Reset: 1700000100',
    ].join('\n');

    const result = parseRateLimitHeaders(stderr);
    expect(result).toEqual({
      limit: 5000,
      remaining: 1680,
      used: 3320,
      resetAt: 1700000100,
    });
  });

  it('is case-insensitive for header names', () => {
    const stderr = [
      '< x-ratelimit-limit: 5000',
      '< x-ratelimit-remaining: 3000',
      '< x-ratelimit-used: 2000',
      '< x-ratelimit-reset: 1700000000',
    ].join('\n');

    const result = parseRateLimitHeaders(stderr);
    expect(result).not.toBeNull();
    expect(result!.remaining).toBe(3000);
  });
});

describe('stripDebugOutput', () => {
  it('removes lines starting with *, >, or < followed by a space', () => {
    const stderr = [
      '* Request to https://api.github.com',
      '> GET /repos/foo/bar HTTP/2',
      '< HTTP/2 200',
      '< X-Ratelimit-Remaining: 4990',
      'actual error message here',
    ].join('\n');

    expect(stripDebugOutput(stderr)).toBe('actual error message here');
  });

  it('preserves non-debug lines', () => {
    expect(stripDebugOutput('some error\nanother line')).toBe('some error\nanother line');
  });

  it('returns empty string for all-debug input', () => {
    expect(stripDebugOutput('* debug\n> request\n< response')).toBe('');
  });

  it('trims whitespace', () => {
    expect(stripDebugOutput('  \n* debug\nhello\n  ')).toBe('hello');
  });
});

describe('getThrottleTier', () => {
  it('returns normal when ratio > 0.5', () => {
    expect(getThrottleTier(0.8)).toEqual({ tier: 'normal', delayMs: 0 });
    expect(getThrottleTier(0.51)).toEqual({ tier: 'normal', delayMs: 0 });
    expect(getThrottleTier(1.0)).toEqual({ tier: 'normal', delayMs: 0 });
  });

  it('returns cautious when ratio is between 0.2 and 0.5', () => {
    expect(getThrottleTier(0.5)).toEqual({ tier: 'cautious', delayMs: 200 });
    expect(getThrottleTier(0.3)).toEqual({ tier: 'cautious', delayMs: 200 });
    expect(getThrottleTier(0.21)).toEqual({ tier: 'cautious', delayMs: 200 });
  });

  it('returns slow when ratio is between 0.05 and 0.2', () => {
    expect(getThrottleTier(0.2)).toEqual({ tier: 'slow', delayMs: 1000 });
    expect(getThrottleTier(0.1)).toEqual({ tier: 'slow', delayMs: 1000 });
    expect(getThrottleTier(0.06)).toEqual({ tier: 'slow', delayMs: 1000 });
  });

  it('returns critical when ratio <= 0.05', () => {
    expect(getThrottleTier(0.05)).toEqual({ tier: 'critical', delayMs: 0 });
    expect(getThrottleTier(0.01)).toEqual({ tier: 'critical', delayMs: 0 });
    expect(getThrottleTier(0)).toEqual({ tier: 'critical', delayMs: 0 });
  });
});

describe('getRateLimitStatus', () => {
  it('returns default state with ratio 1.0 after reset', () => {
    const status = getRateLimitStatus();
    expect(status.remaining).toBe(5000);
    expect(status.limit).toBe(5000);
    expect(status.ratio).toBe(1);
  });
});

describe('project metadata cache', () => {
  it('returns null for uncached project', () => {
    expect(getProjectCache('owner', 1)).toBeNull();
  });

  it('stores and retrieves project metadata', () => {
    const cache = {
      projectId: 'proj-123',
      fieldId: 'field-456',
      optionMap: new Map([['Todo', 'opt-1'], ['Done', 'opt-2']]),
    };
    setProjectCache('owner', 1, cache);
    expect(getProjectCache('owner', 1)).toBe(cache);
  });

  it('scopes cache by owner and project number', () => {
    const cache1 = { projectId: 'p1', fieldId: 'f1', optionMap: new Map() };
    const cache2 = { projectId: 'p2', fieldId: 'f2', optionMap: new Map() };
    setProjectCache('owner1', 1, cache1);
    setProjectCache('owner2', 1, cache2);
    expect(getProjectCache('owner1', 1)).toMatchObject({ projectId: 'p1' });
    expect(getProjectCache('owner2', 1)).toMatchObject({ projectId: 'p2' });
  });

  it('stores and retrieves disabled project metadata', () => {
    const cache = { disabled: true as const, reason: 'Could not resolve project Status field' };

    setProjectCache('owner', 1, cache);

    expect(getProjectCache('owner', 1)).toBe(cache);
  });

  it('clears all cached data', () => {
    setProjectCache('owner', 1, { projectId: 'p1', fieldId: 'f1', optionMap: new Map() });
    clearProjectCache();
    expect(getProjectCache('owner', 1)).toBeNull();
  });
});
