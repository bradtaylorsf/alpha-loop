# review --apply fails when sync dirs don't exist

## Summary

`alpha-loop review --apply` calls `git add .claude .agents .codex` even
when those directories don't exist in the target repo, which aborts the
commit. It should only stage directories that actually contain proposed
changes.

## Acceptance Criteria

- [ ] `applyChanges` checks for directory existence before staging
- [ ] The overall flow succeeds when only one of the three dirs exists
- [ ] Tests cover each combination of missing directories
