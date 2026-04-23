import { parseSubIssues, flipChecklistItem, looksLikeEpic, buildEpicSummary } from '../../src/lib/epics.js';
import type { Issue } from '../../src/lib/github.js';

// epics.ts contains only pure functions — no mocks needed.

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: 'Test epic',
    body: '',
    labels: [],
    ...overrides,
  };
}

describe('parseSubIssues', () => {
  test('parses unchecked item - [ ] #42', () => {
    const refs = parseSubIssues('- [ ] #42');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ number: 42, checked: false, lineIndex: 0 });
  });

  test('parses checked item - [x] #42', () => {
    const refs = parseSubIssues('- [x] #42');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ number: 42, checked: true, lineIndex: 0 });
  });

  test('parses uppercase checked item - [X] #42', () => {
    const refs = parseSubIssues('- [X] #42');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ number: 42, checked: true, lineIndex: 0 });
  });

  test('parses indented item   - [ ] #42', () => {
    const refs = parseSubIssues('  - [ ] #42');
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ number: 42, checked: false, lineIndex: 0 });
  });

  test('parses mixed checked and unchecked items and preserves document order', () => {
    const body = [
      '- [x] #10',
      '- [ ] #20',
      '- [X] #30',
      '- [ ] #40',
    ].join('\n');
    const refs = parseSubIssues(body);
    expect(refs).toHaveLength(4);
    expect(refs[0]).toMatchObject({ number: 10, checked: true, lineIndex: 0 });
    expect(refs[1]).toMatchObject({ number: 20, checked: false, lineIndex: 1 });
    expect(refs[2]).toMatchObject({ number: 30, checked: true, lineIndex: 2 });
    expect(refs[3]).toMatchObject({ number: 40, checked: false, lineIndex: 3 });
  });

  test('ignores cross-repo refs like - [ ] owner/repo#42', () => {
    const refs = parseSubIssues('- [ ] owner/repo#42');
    expect(refs).toHaveLength(0);
  });

  test('ignores plain task items without #N reference', () => {
    const refs = parseSubIssues('- [ ] Do some work without an issue number');
    expect(refs).toHaveLength(0);
  });

  test('returns empty array for body with no task items', () => {
    const body = '## Description\n\nThis is a regular issue body with no tasks.';
    const refs = parseSubIssues(body);
    expect(refs).toHaveLength(0);
  });

  test('returns empty array for empty string', () => {
    expect(parseSubIssues('')).toHaveLength(0);
  });

  test('records correct lineIndex in multiline body', () => {
    const body = ['# Epic Title', '', 'Some description.', '', '- [ ] #5', '- [x] #6'].join('\n');
    const refs = parseSubIssues(body);
    expect(refs).toHaveLength(2);
    expect(refs[0].lineIndex).toBe(4);
    expect(refs[1].lineIndex).toBe(5);
  });
});

describe('flipChecklistItem', () => {
  test('flips [ ] to [x] for the target sub-issue', () => {
    const body = '- [ ] #42\n- [ ] #99';
    const result = flipChecklistItem(body, 42, true);
    expect(result).toBe('- [x] #42\n- [ ] #99');
  });

  test('flips [x] to [ ] for the target sub-issue', () => {
    const body = '- [x] #42\n- [x] #99';
    const result = flipChecklistItem(body, 42, false);
    expect(result).toBe('- [ ] #42\n- [x] #99');
  });

  test('preserves surrounding markdown byte-for-byte', () => {
    const body = [
      '# My Epic',
      '',
      'Here is some context.',
      '',
      '```bash',
      'echo hello',
      '```',
      '',
      '- [ ] #7',
      '',
      '## Footer',
    ].join('\n');

    const result = flipChecklistItem(body, 7, true);

    // Only the checkbox line should change
    const expected = body.replace('- [ ] #7', '- [x] #7');
    expect(result).toBe(expected);
  });

  test('returns body unchanged when target sub-issue is not present', () => {
    const body = '- [ ] #42\n- [ ] #99';
    const result = flipChecklistItem(body, 55, true);
    expect(result).toBe(body);
  });

  test('only affects the first matching line when multiple exist', () => {
    // Duplicate lines shouldn't happen in practice, but the function should be deterministic.
    const body = '- [ ] #42\n- [ ] #42';
    const result = flipChecklistItem(body, 42, true);
    // Only the first occurrence is flipped
    expect(result).toBe('- [x] #42\n- [ ] #42');
  });

  test('handles indented lines correctly', () => {
    const body = '  - [ ] #42';
    const result = flipChecklistItem(body, 42, true);
    expect(result).toBe('  - [x] #42');
  });
});

describe('looksLikeEpic', () => {
  test('returns true when body contains at least 3 sub-issue refs', () => {
    const body = '- [ ] #1\n- [ ] #2\n- [ ] #3';
    expect(looksLikeEpic(body)).toBe(true);
  });

  test('returns true when body contains more than 3 sub-issue refs', () => {
    const body = '- [ ] #1\n- [ ] #2\n- [ ] #3\n- [ ] #4\n- [ ] #5';
    expect(looksLikeEpic(body)).toBe(true);
  });

  test('returns false when body contains exactly 2 sub-issue refs', () => {
    const body = '- [ ] #1\n- [ ] #2';
    expect(looksLikeEpic(body)).toBe(false);
  });

  test('returns false when body contains exactly 1 sub-issue ref', () => {
    const body = '- [ ] #1';
    expect(looksLikeEpic(body)).toBe(false);
  });

  test('returns false when body contains zero sub-issue refs', () => {
    const body = '## Just a regular issue\n\nSome description.';
    expect(looksLikeEpic(body)).toBe(false);
  });

  test('returns false for empty body', () => {
    expect(looksLikeEpic('')).toBe(false);
  });
});

describe('buildEpicSummary', () => {
  test('returns correct doneCount and totalCount for mixed checked/unchecked', () => {
    const issue = makeIssue({
      number: 165,
      title: 'Hybrid Routing',
      body: [
        '- [x] #10',
        '- [ ] #20',
        '- [x] #30',
        '- [ ] #40',
        '- [x] #50',
      ].join('\n'),
    });

    const summary = buildEpicSummary(issue);

    expect(summary.number).toBe(165);
    expect(summary.title).toBe('Hybrid Routing');
    expect(summary.totalCount).toBe(5);
    expect(summary.doneCount).toBe(3);
    expect(summary.subIssues).toHaveLength(5);
  });

  test('returns doneCount=0 when all items are unchecked', () => {
    const issue = makeIssue({
      body: '- [ ] #1\n- [ ] #2\n- [ ] #3',
    });
    const summary = buildEpicSummary(issue);
    expect(summary.doneCount).toBe(0);
    expect(summary.totalCount).toBe(3);
  });

  test('returns doneCount equal to totalCount when all items are checked', () => {
    const issue = makeIssue({
      body: '- [x] #1\n- [x] #2',
    });
    const summary = buildEpicSummary(issue);
    expect(summary.doneCount).toBe(2);
    expect(summary.totalCount).toBe(2);
  });

  test('returns totalCount=0 for body with no task items', () => {
    const issue = makeIssue({ body: 'No tasks here.' });
    const summary = buildEpicSummary(issue);
    expect(summary.totalCount).toBe(0);
    expect(summary.doneCount).toBe(0);
    expect(summary.subIssues).toHaveLength(0);
  });

  test('each subIssue ref has correct number and checked state', () => {
    const issue = makeIssue({
      body: '- [ ] #7\n- [x] #8',
    });
    const summary = buildEpicSummary(issue);
    expect(summary.subIssues[0]).toMatchObject({ number: 7, checked: false });
    expect(summary.subIssues[1]).toMatchObject({ number: 8, checked: true });
  });
});
