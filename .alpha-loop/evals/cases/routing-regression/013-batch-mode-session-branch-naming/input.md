# Batch mode + session branch naming fixes

## Summary

Batch mode should group multiple issues into a single agent call and
commit to a single session branch. Existing session branch names collide
when two sessions start in the same minute; add a monotonically-increasing
suffix.

## Acceptance Criteria

- [ ] `--batch` processes up to `--batch-size` issues per agent invocation
- [ ] Session branches follow `session/YYYYMMDD-HHMMSS-<suffix>` format
- [ ] PRs in a batch all target the session branch, not master directly
