# GitHub API rate limit optimization

## Summary

Large sessions occasionally hit the 5000/hr GitHub API limit. Batch
`gh api` calls, cache issue/PR metadata for the session duration, and
back off when `X-RateLimit-Remaining` falls below a configured threshold.

## Acceptance Criteria

- [ ] Issue metadata is cached per session (invalidated on label/title change)
- [ ] Back-off kicks in automatically near the remaining-budget threshold
- [ ] No more than one `gh api rate_limit` call per session
