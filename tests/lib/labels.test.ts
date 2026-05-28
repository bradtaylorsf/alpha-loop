import { hasLabel, labelName } from '../../src/lib/labels';

describe('labels', () => {
  test('normalizes string and object label shapes', () => {
    expect(labelName('ready')).toBe('ready');
    expect(labelName({ name: 'bug' })).toBe('bug');
  });

  test('ignores nullish and nameless label entries', () => {
    expect(labelName(null)).toBeNull();
    expect(labelName(undefined)).toBeNull();
    expect(labelName({})).toBeNull();
    expect(labelName({ name: null })).toBeNull();
  });

  test('matches labels case-insensitively across mixed malformed entries', () => {
    expect(hasLabel([undefined, null, {}, { name: 'Epic' }, 'ready'], 'epic')).toBe(true);
    expect(hasLabel([undefined, null, {}, { name: 'ready' }], 'epic')).toBe(false);
  });
});
