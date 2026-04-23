# Add alpha-loop add command for quick issue creation

## Summary

Add a new `alpha-loop add` subcommand that takes a free-form description
and asks the configured agent to turn it into a well-formed GitHub issue
(title, body with acceptance criteria, labels).

## Acceptance Criteria

- [ ] `alpha-loop add` prompts for a description or reads `--seed <file>`
- [ ] Agent output is shaped into a title + body + labels
- [ ] `--dry-run` prints the issue without creating it
- [ ] `--milestone` overrides milestone assignment
