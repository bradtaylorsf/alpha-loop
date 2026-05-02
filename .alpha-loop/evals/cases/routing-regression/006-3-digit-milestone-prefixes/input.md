# 3-digit zero-padded milestone prefixes

## Summary

Generated milestone titles currently use `M1`, `M2`, …; once the project
has more than nine milestones they sort lexically in the wrong order.
Switch to zero-padded three-digit prefixes (`M001`, `M010`, `M100`) so
GitHub sorts them correctly.

## Acceptance Criteria

- [ ] `plan` and `roadmap` emit 3-digit prefixes
- [ ] Existing milestone parsing accepts both old and new formats
