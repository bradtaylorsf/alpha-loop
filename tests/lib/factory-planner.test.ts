import {
  issuePriority, extractTouches, touchesOverlap, planDispatch, type DispatchInput,
} from '../../src/lib/factory-planner';
import type { Issue } from '../../src/lib/github';

jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(), success: jest.fn(), warn: jest.fn(), error: jest.fn(),
    step: jest.fn(), dry: jest.fn(), debug: jest.fn(), rate: jest.fn(),
  },
}));

function issue(number: number, opts: { labels?: string[]; body?: string; title?: string } = {}): Issue {
  return {
    number,
    title: opts.title ?? `Issue ${number}`,
    body: opts.body ?? '',
    labels: opts.labels ?? ['ready'],
  };
}

function input(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    readyIssues: [],
    slots: 5,
    inFlight: [],
    leasedIssues: new Set(),
    isIssueClosed: () => true,
    avoidOverlap: true,
    labels: { ready: 'ready' },
    ...overrides,
  };
}

const numbers = (plan: ReturnType<typeof planDispatch>) => plan.dispatch.map((c) => c.issue.number);

describe('issuePriority', () => {
  test.each([
    [['p0'], 0], [['P0'], 0], [['priority:p0'], 0], [['priority:critical'], 0], [['critical'], 0],
    [['p1'], 1], [['high'], 1], [['priority: high'], 1],
    [['p2'], 2], [['medium'], 2], [[], 2], [['bug', 'enhancement'], 2],
    [['p3'], 3], [['low'], 3], [['Priority:Low'], 3],
  ])('%j → %d', (labels, expected) => {
    expect(issuePriority(labels as string[])).toBe(expected);
  });

  test('most urgent label wins when several are present', () => {
    expect(issuePriority(['p3', 'p1', 'low'])).toBe(1);
  });
});

describe('extractTouches', () => {
  test('reads backticked and bare bullets from a ## Touches section', () => {
    const body = [
      '## Summary', 'Mentions `src/other.ts` outside the section.', '',
      '## Touches',
      '- `src/lib/factory.ts` — supervisor loop',
      '- tests/lib/factory.test.ts',
      '* `./src/lib/a.ts`, `src/lib/b.ts`',
      '- `src/lib/a.ts`',
      '- package.json.',
      '- none of these words',
      '',
      '## Dependencies', '- `src/ignored.ts`',
    ].join('\n');
    expect(extractTouches(body)).toEqual([
      'src/lib/factory.ts',
      'tests/lib/factory.test.ts',
      'src/lib/a.ts',
      'src/lib/b.ts',
      'package.json',
    ]);
  });

  test('globs collapse to their directory', () => {
    expect(extractTouches('## Touches\n- `src/commands/*.ts`\n- templates/skills/**')).toEqual([
      'src/commands/',
      'templates/skills/',
    ]);
  });

  test('falls back to paths anywhere in the body when there is no Touches section', () => {
    expect(extractTouches('Change `src/lib/x.ts` and src/lib/y.ts please.')).toEqual(['src/lib/x.ts', 'src/lib/y.ts']);
  });

  test('falls back when the Touches section has no usable paths', () => {
    expect(extractTouches('## Touches\n- TBD\n\nSee `src/lib/z.ts`.')).toEqual(['src/lib/z.ts']);
  });

  test('empty body → []', () => {
    expect(extractTouches('')).toEqual([]);
  });
});

describe('touchesOverlap', () => {
  test('equal paths overlap', () => {
    expect(touchesOverlap(['src/a.ts'], ['src/b.ts', 'src/a.ts'])).toBe(true);
  });

  test('directory prefix overlaps either way, with or without trailing slash', () => {
    expect(touchesOverlap(['src/lib/'], ['src/lib/x.ts'])).toBe(true);
    expect(touchesOverlap(['src/lib/x.ts'], ['src/lib'])).toBe(true);
  });

  test('sibling names that share a string prefix do not overlap', () => {
    expect(touchesOverlap(['src/lib'], ['src/library/x.ts'])).toBe(false);
    expect(touchesOverlap(['src/a.ts'], ['src/a.tsx'])).toBe(false);
  });

  test('empty arrays never overlap', () => {
    expect(touchesOverlap([], ['src/a.ts'])).toBe(false);
    expect(touchesOverlap(['src/a.ts'], [])).toBe(false);
  });
});

describe('planDispatch', () => {
  test('orders by priority, then issue number, and respects slots', () => {
    const plan = planDispatch(input({
      slots: 3,
      readyIssues: [
        issue(10, { labels: ['ready'] }),
        issue(4, { labels: ['ready', 'p3'] }),
        issue(7, { labels: ['ready', 'p0'] }),
        issue(2, { labels: ['ready'] }),
        issue(9, { labels: ['ready', 'p1'] }),
      ],
    }));
    expect(numbers(plan)).toEqual([7, 9, 2]);
    expect(plan.dispatch[0].priority).toBe(0);
    // Slot overflow is simply not dispatched this tick — not a skip.
    expect(plan.skipped).toEqual([]);
  });

  test('zero slots dispatches nothing', () => {
    expect(planDispatch(input({ slots: 0, readyIssues: [issue(1)] })).dispatch).toEqual([]);
  });

  test('skips epics, blocked, needs-human, failed, not-ready, in-flight and claimed issues', () => {
    const plan = planDispatch(input({
      readyIssues: [
        issue(1, { labels: ['ready', 'epic'] }),
        issue(2, { labels: ['ready', 'blocked'] }),
        issue(3, { labels: ['ready', 'needs-human-input'] }),
        issue(4, { labels: ['ready', 'failed'] }),
        issue(5, { labels: ['enhancement'] }),
        issue(6),
        issue(7),
        issue(8),
      ],
      inFlight: [{ issue: 6, touches: [] }],
      leasedIssues: new Set([7]),
    }));
    expect(numbers(plan)).toEqual([8]);
    expect(plan.skipped).toEqual([
      { issue: 1, reason: 'epic' },
      { issue: 2, reason: 'blocked' },
      { issue: 3, reason: 'needs-human' },
      { issue: 4, reason: 'failed' },
      { issue: 5, reason: 'not-ready' },
      { issue: 6, reason: 'in-flight' },
      { issue: 7, reason: 'claimed' },
    ]);
  });

  test('honours custom label names case-insensitively', () => {
    const plan = planDispatch(input({
      labels: { ready: 'Queued', blocked: 'on-hold', needsHuman: 'ask-me', failed: 'broken' },
      readyIssues: [
        issue(1, { labels: ['queued'] }),
        issue(2, { labels: ['queued', 'On-Hold'] }),
        issue(3, { labels: ['queued', 'ask-me'] }),
        issue(4, { labels: ['queued', 'broken'] }),
      ],
    }));
    expect(numbers(plan)).toEqual([1]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['blocked', 'needs-human', 'failed']);
  });

  test('open dependencies block dispatch; unknown state counts as open', () => {
    const closed = new Map<number, boolean | null>([[100, true], [101, false], [102, null]]);
    const plan = planDispatch(input({
      isIssueClosed: (n) => closed.get(n) ?? null,
      readyIssues: [
        issue(1, { body: 'Depends on #100' }),
        issue(2, { body: 'Depends on #100\nBlocked by #101' }),
        issue(3, { body: 'Requires #102' }),
        issue(4, { body: 'Depends on #4 (self reference is ignored)' }),
        issue(5, { body: 'Depends on other/repo#9 — cross-repo refs are ignored' }),
      ],
    }));
    expect(numbers(plan)).toEqual([1, 4, 5]);
    expect(plan.dispatch[0].deps).toEqual([100]);
    expect(plan.skipped).toEqual([
      { issue: 2, reason: 'open-deps', detail: '#101' },
      { issue: 3, reason: 'open-deps', detail: '#102' },
    ]);
  });

  test('avoidOverlap skips issues touching in-flight files or files already chosen this plan', () => {
    const plan = planDispatch(input({
      inFlight: [{ issue: 50, touches: ['src/lib/config.ts'] }],
      readyIssues: [
        issue(1, { body: '## Touches\n- `src/lib/config.ts`' }),
        issue(2, { body: '## Touches\n- `src/lib/`' , labels: ['ready', 'p1'] }),
        issue(3, { body: '## Touches\n- `src/commands/run.ts`' }),
        issue(4, { body: '## Touches\n- `src/commands/run.ts`' }),
        issue(5, { body: 'No paths at all' }),
      ],
    }));
    expect(numbers(plan)).toEqual([3, 5]);
    expect(plan.skipped).toEqual([
      { issue: 2, reason: 'overlap', detail: 'overlaps #50' },
      { issue: 1, reason: 'overlap', detail: 'overlaps #50' },
      { issue: 4, reason: 'overlap', detail: 'overlaps #3' },
    ]);
  });

  test('overlap-skipped candidates do not consume slots', () => {
    const plan = planDispatch(input({
      slots: 1,
      inFlight: [{ issue: 50, touches: ['src/a.ts'] }],
      readyIssues: [issue(1, { body: '`src/a.ts`' }), issue(2, { body: '`src/b.ts`' })],
    }));
    expect(numbers(plan)).toEqual([2]);
  });

  test('avoidOverlap=false dispatches overlapping work', () => {
    const plan = planDispatch(input({
      avoidOverlap: false,
      inFlight: [{ issue: 50, touches: ['src/a.ts'] }],
      readyIssues: [issue(1, { body: '`src/a.ts`' }), issue(2, { body: '`src/a.ts`' })],
    }));
    expect(numbers(plan)).toEqual([1, 2]);
  });

  test('epic scope: only children dispatch, in checklist order within a priority', () => {
    const plan = planDispatch(input({
      epicScope: new Map([[200, [30, 10, 20]], [300, [5]]]),
      readyIssues: [
        issue(5), issue(10), issue(20), issue(30), issue(40),
        issue(20, { labels: ['ready'] }), // duplicate rows are ignored
      ],
    }));
    expect(numbers(plan)).toEqual([30, 10, 20, 5]);
    expect(plan.dispatch[0]).toMatchObject({ epic: 200, epicIndex: 0 });
    expect(plan.dispatch[3]).toMatchObject({ epic: 300, epicIndex: 0 });
    expect(plan.skipped).toEqual([{ issue: 40, reason: 'out-of-scope' }]);
  });

  test('priority still beats checklist order inside an epic scope', () => {
    const plan = planDispatch(input({
      epicScope: new Map([[200, [1, 2]]]),
      readyIssues: [issue(1), issue(2, { labels: ['ready', 'p0'] })],
    }));
    expect(numbers(plan)).toEqual([2, 1]);
  });

  test('an empty epic scope map means the whole repo', () => {
    const plan = planDispatch(input({ epicScope: new Map(), readyIssues: [issue(1)] }));
    expect(numbers(plan)).toEqual([1]);
    expect(plan.dispatch[0].epic).toBeUndefined();
  });

  test('candidates carry touches and priority', () => {
    const plan = planDispatch(input({
      readyIssues: [issue(1, { labels: ['ready', 'high'], body: '## Touches\n- `src/x.ts`' })],
    }));
    expect(plan.dispatch[0]).toMatchObject({ priority: 1, touches: ['src/x.ts'], deps: [] });
  });
});
