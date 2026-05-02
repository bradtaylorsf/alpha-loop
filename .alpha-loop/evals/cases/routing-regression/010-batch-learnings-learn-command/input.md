# Batch learnings + alpha-loop learn command

## Summary

After a batch run, extract learnings across all issues in one pass rather
than per-issue. Expose a new `alpha-loop learn` subcommand that backfills
learnings from existing session traces.

## Acceptance Criteria

- [ ] Learnings are extracted once per session when batch mode is on
- [ ] `alpha-loop learn` re-runs extraction on any past session
- [ ] `--session <name>` filters to one session
- [ ] `--dry-run` prints what would be extracted
