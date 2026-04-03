# Issue #55: Convert src/lib/format.js to TypeScript

## Summary

`src/lib/format.js` was written before the project adopted TypeScript. It has no type annotations and
callers get no type checking. Convert it to TypeScript with strict types.

## Existing File

```javascript
// src/lib/format.js

export function formatUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    displayName: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email.toLowerCase(),
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

export function formatCurrency(amount, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency || 'USD',
  }).format(amount);
}

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '');
}
```

## Requirements

- Rename to `src/lib/format.ts`
- Add a `User` interface for the input shape
- Add a `FormattedUser` interface for the return shape
- Add proper parameter and return type annotations to all three functions
- Handle `null`/`undefined` inputs gracefully with TypeScript types
- Must compile under `strict: true`

## Acceptance Criteria

- [ ] File renamed to `.ts`
- [ ] All functions have typed parameters and return types
- [ ] Interfaces defined for object shapes
- [ ] No use of `any`
