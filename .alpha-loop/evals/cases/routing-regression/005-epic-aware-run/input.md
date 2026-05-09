# Epic-first planning workflow — triage, roadmap, run, verify

## Summary

Alpha Loop should support the full epic-first workflow: `triage`
groups related issues into a parent epic, `roadmap` schedules that
parent epic into a milestone, and `run --epic` or milestone-targeted
run processes child issues in checklist order with parent context.

## Acceptance Criteria

- [ ] README documents the recommended flow: triage groups, roadmap
      schedules parent epics, and run ships child issues.
- [ ] `docs/epics.md` explains that milestones schedule parent epic
      issues while the epic checklist controls child issue order.
- [ ] CLI help text for `triage` and `roadmap` mentions epic grouping
      and epic-aware milestone scheduling.
- [ ] Command-level tests mock GitHub calls across triage, roadmap,
      scheduled epic run, checklist updates, and verify-only verification.
- [ ] Child issue agent prompts include parent epic context: goal,
      acceptance criteria, and ordered sibling checklist.
