import { test } from 'node:test';
import assert from 'node:assert/strict';

test('email shape acceptance', () => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  assert.equal(re.test('a@b.co'), true);
  assert.equal(re.test(''), false);
});
