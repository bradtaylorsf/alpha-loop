# Add --yes flag for non-interactive batch mode in planning commands

## Summary

`plan`, `triage`, `roadmap`, and `add` all have interactive confirmation
prompts. For CI and scripted flows they should accept `-y / --yes` to
auto-confirm every prompt.

## Acceptance Criteria

- [ ] `plan`, `triage`, `roadmap`, `add` support `-y/--yes`
- [ ] With `--yes`, no readline prompt is drawn
- [ ] Destructive actions still print what they're about to do
