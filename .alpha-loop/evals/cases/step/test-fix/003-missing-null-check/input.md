# Test Failure Output

```
FAIL tests/services/user.service.test.ts

  ● getDisplayName › handles null user input

    TypeError: Cannot read properties of null (reading 'name')

      7 | export function getDisplayName(user: User | null): string {
      8 |   return user.name ?? user.email;
        |              ^
      9 | }

      at getDisplayName (src/services/user.service.ts:8:14)
      at Object.<anonymous> (tests/services/user.service.test.ts:18:5)

  Test:
    it('handles null user input', () => {
      expect(getDisplayName(null)).toBe('Anonymous');
    });
```

## Source Code

```typescript
// src/services/user.service.ts
interface User {
  name: string | null;
  email: string;
}

export function getDisplayName(user: User | null): string {
  return user.name ?? user.email;
}
```
