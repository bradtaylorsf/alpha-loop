---
name: code-review
description: Code review standards for automated and manual reviews. Use when reviewing code changes.
auto_load: true
priority: high
---

# Code Review Skill

## Trigger
When reviewing code changes (PR review, post-implementation review).

## Review Checklist

### 1. Requirements Compliance
- [ ] All acceptance criteria met
- [ ] No scope creep (unnecessary changes)
- [ ] Edge cases handled

### 2. Code Quality
- [ ] Follows project conventions (check CLAUDE.md)
- [ ] No `any` types in TypeScript
- [ ] Functions are small and focused
- [ ] No dead code or commented-out code
- [ ] No `console.log` left in production code

### 3. Security (OWASP Top 10)
- [ ] No SQL injection (use parameterized queries)
- [ ] No XSS (sanitize user input)
- [ ] No command injection (validate shell args)
- [ ] Auth/authz checks in place
- [ ] No secrets in code

### 4. Testing
- [ ] New code has tests
- [ ] Tests cover happy path AND error cases
- [ ] Tests are deterministic (no flaky tests)
- [ ] Test names describe behavior, not implementation

### 5. Performance
- [ ] No N+1 queries
- [ ] No unnecessary re-renders
- [ ] Large lists paginated

## Action on Findings

- **CRITICAL**: Fix immediately before merge
- **WARNING**: Fix now if possible, create issue if not
- **SUGGESTION**: Note for future improvement

## Output Format

```markdown
### Review Summary
**Status**: PASS | FAIL
**Issues fixed**: N
**Issues deferred**: N (with issue links)
```
