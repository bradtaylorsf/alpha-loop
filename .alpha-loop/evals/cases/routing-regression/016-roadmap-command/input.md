# Implement roadmap command — organize issues into milestones

## Summary

Add `alpha-loop roadmap` which inspects every open issue, asks the agent
to group them into logical milestones, and either prints the plan
(`--dry-run`) or assigns issues to milestones on GitHub.

## Acceptance Criteria

- [ ] Groups open issues into named milestones
- [ ] `--dry-run` previews without calling GitHub write APIs
- [ ] `-y/--yes` accepts recommendations without prompting
