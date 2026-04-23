# Deprecate vision command in favor of plan

## Summary

`alpha-loop vision` overlaps with `alpha-loop plan`. Mark `vision` as
deprecated, keep it functioning for one release cycle, and point users at
`plan` in the help text and docs.

## Acceptance Criteria

- [ ] Running `vision` prints a deprecation warning to stderr
- [ ] Help text reads "(deprecated) Use plan instead"
- [ ] README and CLAUDE.md command tables reflect the change
