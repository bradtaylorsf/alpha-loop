import {
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
    expect(getProjectCache('owner1', 1)?.projectId).toBe('p1');
    expect(getProjectCache('owner2', 1)?.projectId).toBe('p2');
  });

  it('clears all cached data', () => {
    setProjectCache('owner', 1, { projectId: 'p1', fieldId: 'f1', optionMap: new Map() });
    clearProjectCache();
    expect(getProjectCache('owner', 1)).toBeNull();
  });
});
