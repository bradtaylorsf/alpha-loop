# Issue #28: Pagination returns wrong total page count

## Summary

The `GET /posts` endpoint returns an incorrect `totalPages` value. Users on the last page see a
"next page" button that leads to an empty result set.

## Reproduction

- Total records: 25
- Page size: 10
- Expected `totalPages`: 3
- Actual `totalPages`: 2

## Existing Code

```typescript
// src/lib/paginate.ts
export function paginate(total: number, page: number, limit: number) {
  return {
    page,
    limit,
    total,
    totalPages: Math.floor(total / limit),  // BUG: off-by-one when not evenly divisible
  };
}
```

```typescript
// src/routes/posts.ts
router.get('/', async (req, res) => {
  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const [posts, total] = await Promise.all([
    db.post.findMany({ skip: (page - 1) * limit, take: limit }),
    db.post.count(),
  ]);
  res.json({ data: posts, meta: paginate(total, page, limit) });
});
```

## Acceptance Criteria

- [ ] `totalPages` is calculated correctly for all combinations of total and limit
- [ ] 25 records with limit 10 returns `totalPages: 3`
- [ ] Fix is covered by a unit test
