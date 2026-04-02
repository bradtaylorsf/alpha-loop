---
name: implementation-planning
description: Two-layer feature planning (business + technical). Use when planning any feature before implementation starts.
auto_load: true
priority: high
---

# Implementation Planning Skill

## Trigger
When planning a feature before implementation starts.

## Rules

### Two-Layer Approach

Every feature plan has two layers:

**Layer A: Non-Technical Summary**
- What are we building?
- Who benefits?
- What's the impact?

**Layer B: Technical Detail**
- What components/modules?
- What database changes?
- What API endpoints?
- What will be tested?

### Acceptance Criteria

Make them specific and testable:

Good:
```
- [ ] User can select a coach from a list
- [ ] System prevents booking overlapping sessions
- [ ] All tests pass
```

Bad:
```
- [ ] Booking system works
- [ ] It's fast
```

### Feature Breakdown

Break large features into smaller issues:
- One feature per issue (small, scoped)
- XS (< 4h), S (4-8h), M (8-16h), L (16-32h)
- Identify dependencies between issues

### Red Flags

**Blocker:**
- Acceptance criteria vague or untestable
- Technical approach missing
- Feature too large for one sprint

**Warning:**
- Dependencies not identified
- No test plan
- High-risk approach without discussion
