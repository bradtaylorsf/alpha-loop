---
name: git-workflow
description: Git branch naming, commit conventions, and PR workflow. Use for all git operations.
auto_load: true
priority: high
---

# Git Workflow Skill

## Trigger
When creating branches, writing commits, or creating PRs.

## Branch Naming

```
agent/issue-{number}     # automated loop branches
feat/{description}       # feature branches
fix/{description}        # bug fix branches
```

## Commit Conventions

Use conventional commits:

```
feat: add health check endpoint (closes #1)
fix: resolve test failures for #3
test: add unit tests for runner module
refactor: simplify prompt building
docs: update CLAUDE.md with new skills
chore: update dependencies
```

Rules:
- Lowercase, no period at end
- Reference issue number when applicable
- One logical change per commit
- Commit message explains WHY, diff shows WHAT

## PR Workflow

1. Branch from the target branch (master or session branch)
2. Implement + test + commit
3. Push branch
4. Create PR with: summary, test results, review report
5. Link PR to issue with `closes #N`

## Never Do

- Force push to master/main
- Commit directly to master/main
- Commit .env files or secrets
- Create merge commits (use squash merge)
