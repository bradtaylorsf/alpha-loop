import {
  assertNoDoubleConventionalPrefix,
  conventionalBatchTitle,
  conventionalBatchType,
  conventionalTitle,
} from '../../src/lib/conventional-commits';

describe('conventional commits', () => {
  test.each([
    'fix',
    'feat',
    'chore',
    'docs',
    'refactor',
    'test',
    'perf',
    'build',
    'ci',
  ])('preserves an existing %s prefix without adding another prefix', (type) => {
    expect(conventionalTitle({ title: `${type}: keep this title`, labels: ['bug'] }))
      .toBe(`${type}: keep this title`);
  });

  test.each([
    [['bug'], 'fix: Correct the failure'],
    [['enhancement'], 'feat: Add the capability'],
    [['feature'], 'feat: Add the capability'],
    [['documentation'], 'docs: Explain the workflow'],
  ])('maps labels %p when the issue title has no prefix', (labels, expected) => {
    const title = expected.replace(/^[^:]+:\s*/, '');
    expect(conventionalTitle({ title, labels })).toBe(expected);
  });

  test('falls back to chore when neither title nor labels provide a type', () => {
    expect(conventionalTitle({ title: 'Maintain the workflow', labels: ['ready'] }))
      .toBe('chore: Maintain the workflow');
  });

  test('selects batch type using feat then fix then chore precedence', () => {
    expect(conventionalBatchType([
      { title: 'docs: Explain it', labels: [] },
      { title: 'Correct it', labels: ['bug'] },
    ])).toBe('fix');
    expect(conventionalBatchType([
      { title: 'Correct it', labels: ['bug'] },
      { title: 'Add it', labels: ['feature'] },
    ])).toBe('feat');
    expect(conventionalBatchType([
      { title: 'docs: Explain it', labels: [] },
      { title: 'Maintain it', labels: [] },
    ])).toBe('chore');
  });

  test('keeps a bug-only session compatible with the release script patch rule', () => {
    const title = conventionalBatchTitle([
      { title: 'Correct one', labels: ['bug'] },
      { title: 'fix: Correct two', labels: ['bug'] },
    ], 'quick session (#10, #11)');

    const bump = /BREAKING CHANGE|^[a-z]+(\([^)]+\))?!:/m.test(title)
      ? 'major'
      : (/^feat(\([^)]+\))?:/m.test(title) ? 'minor' : 'patch');

    expect(title).toBe('fix: quick session (#10, #11)');
    expect(bump).toBe('patch');
  });

  test('rejects a generated title with two supported prefixes', () => {
    expect(() => assertNoDoubleConventionalPrefix('feat: fix: whatever'))
      .toThrow('double Conventional Commit prefix');
    expect(() => conventionalTitle({ title: 'feat: fix: whatever', labels: [] }))
      .toThrow('double Conventional Commit prefix');
    expect(() => conventionalBatchTitle(
      [{ title: 'Add it', labels: ['feature'] }],
      'fix: whatever',
    )).toThrow('double Conventional Commit prefix');
  });
});
