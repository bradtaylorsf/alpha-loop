---
name: alpha-loop-issue-author
description: Capture new features, changes, or bugs as well-formed GitHub issues optimized for alpha-loop. Use whenever the user describes something they want built or fixed, or says "add a feature", "add an issue", "file a feature", "let's build X". Searches existing issues/epics for duplicates, decides standalone vs epic-child vs new epic, drafts in the canonical alpha-loop body format, applies correct labels, sets dependencies, and links to parent epics.
auto_load: true
priority: high
---

# Alpha Loop Issue Author

## Trigger

Use this skill whenever the user describes desired product work, code changes, bugs, fixes, refactors, tests, docs changes, or follow-up tasks that should enter the Alpha Loop backlog.

Treat phrases like these as triggers:

- "I want X"
- "let's add Y"
- "build the feature that..."
- "fix the bug where..."
- "add an issue"
- "add this to the roadmap"
- "file a feature"
- "capture this for alpha-loop"
- "make the loop do X"

Do not start implementation, branch creation, or file edits for the requested work until the issue outcome is confirmed. The default path is issue first, then `alpha-loop run`.

## Search Before Creating

Always search GitHub before creating or editing an issue. Use concise keywords from the user's request, plus obvious subsystem terms.

Run these commands first:

```bash
gh issue list --state open --search "<keywords>"
gh issue list --state open --label epic
gh issue list --state closed --search "<keywords>"
```

If the first search is too broad or too narrow, run one additional targeted search with better terms before deciding.

Report the results before taking action:

- Open possible duplicates.
- Open related work that may share scope or files.
- Open epics this work might join.
- Closed issues or PR-linked work that may explain prior attempts.

Then ask the user to classify the matches as duplicate, related, or new. Do not create an issue unless the user has seen the search results and confirmed the category.

If `gh` is unavailable or unauthenticated, stop and ask the user to authorize GitHub CLI or run the searches manually. Do not bypass the search-before-create step.

## Categorize

Choose exactly one outcome and show the decision before creating anything:

- **Comment on existing issue**: Use when an open issue already captures the request, or the request is a small clarification to existing scope.
- **New standalone issue**: Use when the work is small enough for one run, has no meaningful dependency, and no open epic fits.
- **New child of an existing epic**: Use when the work contributes to an active epic's goal and should run with sibling context.
- **New epic**: Use when the work is large, multi-step, cross-cutting, risky, or has multiple natural sub-tasks.
- **No issue yet**: Use when the request is too ambiguous to make testable. Ask focused questions until it can be filed.

State the proposed title, issue type, parent epic if any, dependency posture, label set, and whether `ready` should be applied. Ask for confirmation before using `alpha-loop add`, `gh issue create`, `gh issue edit`, or `gh issue comment`.

## Issue Body Format

Use issue bodies that are optimized for unattended `alpha-loop run` consumption: concrete scope, testable acceptance criteria, explicit non-goals, dependency context, and links.

### Feature Or Change Issue

Use this for standalone issues and child issues that add or change behavior:

```markdown
## Summary

One paragraph describing the requested change and the user-visible or maintainer-visible outcome.

## Why this matters

Explain the value, failure mode, or workflow improvement this issue unlocks.

## Proposed approach

- Preferred implementation path.
- Alternative option if there is a meaningful tradeoff.

## Acceptance criteria

- [ ] Testable outcome one.
- [ ] Testable outcome two.
- [ ] Relevant tests or verification command pass.

## Out of scope

- Work that should not be attempted in this issue.

## Related

- Parent epic: #<epic> if this is a child.
- Related issues: #<issue>
- Prior PRs or context: <links>
```

### Bug Issue

Use this for defects and regressions:

```markdown
## Problem

One paragraph describing the observed incorrect behavior and expected behavior.

## Root cause

Known or suspected cause. If unknown, say what evidence should be gathered.

## Repro

1. Concrete step.
2. Concrete step.
3. Observed failure.

## Suggested fix

- Preferred fix path.
- Alternative option if the cause is uncertain.

## Acceptance criteria

- [ ] The repro no longer fails.
- [ ] Regression coverage is added at the right layer.
- [ ] Relevant tests or verification command pass.

## Out of scope

- Related cleanup or redesign that should not be attempted here.

## Related

- Parent epic: #<epic> if this is a child.
- Related issues: #<issue>
- Prior PRs or logs: <links>
```

### Epic Issue

Use the richer epic structure used by recent Alpha Loop planning epics such as #217, #166, and #205. Keep the task list lines parseable by `alpha-loop run --epic`.

```markdown
## Goal

One paragraph describing the integrated outcome.

## Non-Technical Summary

Plain-language summary of what changes for the user or maintainer.

## Why This Matters

- Business, product, reliability, or workflow reasons.

## Architecture Observations

- Current system facts that constrain implementation.
- Subsystems likely to change.
- Known risks, migrations, or compatibility constraints.

## Ordered Sub-Issues

- [ ] #<child-1> - First concrete implementation unit.
- [ ] #<child-2> - Second concrete implementation unit.
- [ ] #<child-3> - Verification or integration follow-through if needed.

## Acceptance Criteria

- [ ] Integrated outcome is complete.
- [ ] All child acceptance criteria are satisfied.
- [ ] Epic verification passes.

## Dependencies and Sequencing

- What must happen before this epic.
- Which children must be sequential and which can run in parallel.
- File-overlap or migration notes that affect batching.

## Verification Expectations

- Commands, manual checks, or `alpha-loop run --verify-only <N>` expectations.
- Any final integrated scenario the child issues cannot prove alone.
```

When creating a new epic and the child issues do not exist yet, either create draft child issues first and then add their numbers to `## Ordered Sub-Issues`, or leave clearly named placeholder checklist entries only if the user confirms they want a planning draft instead of a queue-ready epic.

## Labels

Show proposed labels to the user and ask for approval before applying them.

Use these defaults:

- `bug` for defects and regressions.
- `enhancement` for features, behavior changes, and improvements.
- `epic` for parent epic issues.
- Subsystem labels such as `engine`, `planning`, `learning`, `eval`, `github`, `sync`, `testing`, `docs`, or repo-specific equivalents based on likely changed areas.
- The configured ready label, usually `ready`, only when the user confirms the issue is queue-ready.

Do not auto-apply `ready` to draft issues, ambiguous issues, issues with unresolved dependencies, or issues waiting for epic placement.

Before using labels, inspect what exists when needed:

```bash
gh label list --limit 100 --json name --jq '.[].name'
```

If a needed label is absent, ask whether to create it, omit it, or use a repo-specific equivalent.

## Dependencies & Batching

For standalone issues, state whether the work has no known dependencies or name the prerequisite issue or PR.

For children of an existing epic:

1. Read the epic body and sibling issue bodies.

   ```bash
   gh issue view <epic> --json number,title,body,url,labels
   gh issue view <sibling> --json number,title,body,url,labels,state
   ```

2. Decide where the new child belongs in the ordered checklist.
3. Identify required predecessors, follow-up children, and siblings that can run in parallel.
4. Mention likely file overlap using concrete paths when known.
5. Add batching guidance to the issue body or epic sequencing notes.

Use language like:

```text
Batching note: this child likely touches `src/lib/foo.ts`, which sibling #<N> also touches. Recommend batch size 1 if these run in the same epic session.
```

If the work is independent and file overlap is unlikely, say it can run in parallel with named sibling issues.

## Config Implications

Check whether the requested work implies `.alpha-loop.yaml`, harness, test, branch, or verification changes.

Call this out in the issue body when relevant:

- New or changed `test_command`, `dev_command`, or final verification command.
- New harness or changed `agent` / `harnesses` posture.
- Different `base_branch`, labels, project, milestone, or ready-label convention.
- Batch, `skip_tests`, `skip_verify`, timeout, environment, auth, or secrets requirements.
- Browser auth or external service setup that implementers must know before running tests.

If no config change is expected, state that explicitly in `## Related` or `## Proposed approach` so the implementer does not spend time looking for one.

## Epic Membership & Backlinks

When filing a child issue for an existing epic:

1. Include the parent epic in the child body's `## Related` section.
2. Create the child issue with approved labels.
3. Add a child comment exactly like:

   ```markdown
   Part of #<epic>
   ```

   Command shape:

   ```bash
   gh issue comment <child> --body "Part of #<epic>"
   ```

4. Update the parent epic body's `## Ordered Sub-Issues` checklist to include the new child in the confirmed position.

   ```bash
   gh issue view <epic> --json body --jq .body > /tmp/alpha-loop-epic-<epic>.md
   # Edit the temp file to insert: - [ ] #<child> - <short title>
   gh issue edit <epic> --body-file /tmp/alpha-loop-epic-<epic>.md
   ```

5. Re-read the epic and child to verify the backlink and checklist line are present.

Do not add a child to an epic checklist if its dependencies or acceptance criteria are still unclear. Leave it unready or ask the user for more detail first.

## Creation Commands

Prefer `alpha-loop add` when creating a simple standalone issue and the CLI is available, because it can reuse project planning context:

```bash
alpha-loop add "<short description>"
```

Use `gh issue create` when you need exact control over body files, labels, epic child placement, or comments:

```bash
gh issue create --title "<title>" --body-file /tmp/alpha-loop-issue.md --label "enhancement" --label "ready"
```

Avoid shell-quoting mistakes by writing issue bodies to a temporary Markdown file and passing `--body-file`. Never interpolate untrusted user text into a shell command without proper quoting.

## Handoff

After filing or updating issues, print:

- New issue URL.
- Epic URL if this is a child or new epic.
- Final labels applied, including whether `ready` was applied.
- Dependency and batching notes.
- Recommended next command.

Choose the next command from the actual state:

```bash
alpha-loop triage
alpha-loop roadmap
alpha-loop run --once
alpha-loop run --epic <N>
alpha-loop run --verify-only <N>
```

Use `alpha-loop triage` when backlog shape, labels, or dependencies need re-validation. Use `alpha-loop run --epic <N>` when a confirmed epic child checklist is ready. Use `alpha-loop run --once` only for a ready standalone issue.
