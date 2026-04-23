# Epic-aware run — discover, select, and close epic-driven sessions

## Summary

`alpha-loop run` should detect epics, process their sub-issues in
checklist order, and auto-close the epic when all sub-issues are done.

## Acceptance Criteria

- [ ] `run --epic <N>` processes sub-issues from the epic's checklist
- [ ] `run --skip-epic` falls back to the flat/milestone flow
- [ ] `run --verify-only <N>` runs only the epic verification pass
- [ ] Interactive picker auto-selects a single open epic when
      `prefer_epics: true` is configured
