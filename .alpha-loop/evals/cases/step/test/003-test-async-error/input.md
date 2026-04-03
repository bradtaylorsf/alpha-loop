# Task: Write tests for async error throwing

Write Jest tests for the `fetchUser` function below. The tests must correctly assert that the
function throws (rejects) on invalid input using the proper Jest async pattern.

## Source Code

```typescript
// src/lib/fetch-user.ts
export async function fetchUser(id: string): Promise<{ id: string; name: string }> {
  if (!id) {
    throw new Error('User ID is required');
  }
  if (typeof id !== 'string') {
    throw new Error('User ID must be a string');
  }
  if (id.length < 3) {
    throw new Error('User ID must be at least 3 characters');
  }

  // Simulate async database fetch
  const user = await db.findById(id);
  if (!user) {
    throw new Error(`User not found: ${id}`);
  }
  return user;
}
```

## Requirements

- Use `await expect(fetchUser(...)).rejects.toThrow(...)` — not try/catch
- Test the happy path: resolves with user data when given a valid ID
- Test each error case:
  - Empty string throws "User ID is required"
  - ID shorter than 3 chars throws "User ID must be at least 3 characters"
  - Valid ID with no matching user throws "User not found"
- Mock the `db` module
- Each test must be an `async` function
