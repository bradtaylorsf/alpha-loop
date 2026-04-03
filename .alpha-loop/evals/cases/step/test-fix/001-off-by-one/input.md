# Test Failure Output

```
FAIL tests/utils/array-helpers.test.ts

  ● processItems › handles all items in array

    RangeError: Invalid array length / Index out of bounds

      14 |   for (let i = 0; i <= arr.length; i++) {
      15 |     result.push(transform(arr[i]));
    > 16 |   }
         |   ^

      at processItems (src/utils/array-helpers.ts:15:5)
      at Object.<anonymous> (tests/utils/array-helpers.test.ts:23:5)

  ● processItems › returns empty array for empty input

    RangeError: Invalid array length / Index out of bounds

      at processItems (src/utils/array-helpers.ts:15:5)

FAIL (2 tests failed)
```

## Source Code

```typescript
// src/utils/array-helpers.ts
export function processItems<T, U>(arr: T[], transform: (item: T) => U): U[] {
  const result: U[] = [];
  for (let i = 0; i <= arr.length; i++) {
    result.push(transform(arr[i]));
  }
  return result;
}
```
