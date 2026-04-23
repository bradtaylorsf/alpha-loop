# Enhance error handling and staging process in applyChanges

## Summary

`applyChanges` swallows errors during `git add` and produces a confusing
"nothing to commit" failure. It should surface the underlying error and
keep the staging process idempotent.

## Acceptance Criteria

- [ ] Stderr from `git add` is returned up through the error object
- [ ] Staging is skipped when nothing has actually changed
- [ ] Error messages name the specific path that failed
