# Implement triage command — analyze and improve existing issues

## Summary

Add `alpha-loop triage` which scans the open-issue backlog for staleness,
clarity, size, and duplicate signals, then asks the agent to propose
improvements (rewrites, splits, closures).

## Acceptance Criteria

- [ ] Flags stale issues (no activity for configured window)
- [ ] Detects likely duplicates via title/body similarity
- [ ] `--dry-run` prints findings without mutating GitHub
- [ ] `-y/--yes` accepts all recommendations non-interactively
