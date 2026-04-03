# Task: Write edge case tests for the truncate utility

Write Jest tests for the `truncate` function below. Focus on edge cases — the happy path
(long string gets truncated) is already covered. Your tests must cover the cases listed below.

## Source Code

```typescript
// src/lib/truncate.ts
export function truncate(text: string | null | undefined, maxLength: number): string {
  if (text == null) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}
```

## Edge Cases to Cover

1. **Empty string** — `truncate('', 10)` returns `''`
2. **String shorter than maxLength** — `truncate('Hi', 10)` returns `'Hi'` unchanged
3. **String exactly equal to maxLength** — `truncate('Hello!', 6)` returns `'Hello!'` unchanged
4. **String longer than maxLength** — `truncate('Hello World', 6)` returns `'Hello…'`
5. **Unicode / emoji** — `truncate('Hello 🌍 World', 8)` truncates correctly without corrupting the
   emoji boundary (assert the result ends with `…` and has the expected length)
6. **Null input** — `truncate(null, 10)` returns `''`
7. **Undefined input** — `truncate(undefined, 10)` returns `''`

## Requirements

- Use Jest `describe` and `it` blocks with descriptive names
- Each edge case is a separate `it` block
- Assertions use `toBe` for exact string equality
- No mocking needed — this is a pure function
