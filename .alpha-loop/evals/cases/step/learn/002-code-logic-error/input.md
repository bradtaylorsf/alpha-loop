# Session Run Trace — Issue #53: Add pagination to /api/posts endpoint

## Session Summary

- **Issue**: #53 — Paginate the /api/posts endpoint (default 10 per page)
- **Agent**: claude
- **Duration**: 18m 45s
- **Outcome**: FAILED (tests caught the bug)
- **Test retries**: 1

## Implementation

Agent added `page` and `limit` query parameters to the posts endpoint and implemented
offset-based pagination using Prisma.

## Test Output (First Run)

```
FAIL tests/routes/posts.test.ts

  ● GET /api/posts › returns correct number of items per page

    expect(received).toBe(expected)

    Expected: 10
    Received: 11

      43 |     const res = await request(app).get('/api/posts?page=1&limit=10');
      44 |     expect(res.status).toBe(200);
    > 45 |     expect(res.body.data.length).toBe(10);
         |                                  ^
      46 |   });

  ● GET /api/posts › returns correct items on page 2

    Expected first item on page 2 to have id "post-11", received "post-10"
```

## Root Cause

The pagination implementation used `<= limit` in the Prisma query instead of `< limit`:

```typescript
// Bug: off-by-one in limit calculation
const posts = await prisma.post.findMany({
  skip: (page - 1) * limit,
  take: limit + 1,  // Should be: take: limit
});
```

The `take: limit + 1` pattern is used for "has next page" detection, but the agent failed to
slice the results before returning them, causing 11 items to be returned when 10 were expected.

## Fix Applied

Agent corrected the implementation on retry:

```typescript
const posts = await prisma.post.findMany({
  skip: (page - 1) * limit,
  take: limit + 1,
});
const hasNextPage = posts.length > limit;
return posts.slice(0, limit); // Added slice
```

## Outcome After Fix

All tests passed on second attempt.

## Files Changed

- `src/routes/posts.ts` (modified)
- `tests/routes/posts.test.ts` (modified)
