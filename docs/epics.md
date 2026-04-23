# Epics

Epics let you group related issues into a single, end-to-end deliverable that Alpha Loop ships as one unit. You plan the pieces, mark the parent issue with the `epic` label, and the loop builds the sub-issues in order, auto-links their PRs, verifies completeness when the last one merges, and closes the epic on pass.

## What is an Epic

An epic is a GitHub issue with:

1. The `epic` label applied.
2. A GitHub task-list in the body that references sub-issues by number.

Example epic body:

```markdown
## Goal
Add multi-tenant support to the API layer.

## Sub-issues
- [ ] #158 Add tenant column to users table
- [ ] #159 Add tenant middleware to Express router
- [ ] #160 Scope existing queries by tenant
- [ ] #161 Add tenant header validation
- [ ] #162 Update docs for tenant header

## Acceptance Criteria
- [ ] All endpoints scoped by tenant
- [ ] Backward-compatible for single-tenant deployments
```

The task-list lines are the source of truth for both ordering and completion tracking.

## How Epics Are Detected

- The `epic` **label is authoritative**. An issue with no `epic` label is never treated as an epic, regardless of body content.
- If an issue has a task-list body with three or more `- [ ] #N` items but no `epic` label, it is treated as a **hint** — the picker may flag it as a candidate, but the loop will not process it as an epic until you add the label.

This keeps epic detection explicit. You opt in by labeling.

## Running the Loop Against an Epic

### Interactive

```bash
alpha-loop run
```

The picker lists open epics above milestones:

```
  Open Epics
  1  #165 Multi-tenant support (0/7 sub-issues done)
  2  #170 Billing revamp (2/5 sub-issues done)

  Open Milestones
  3  v1.1 — Polish (10 open)

  Select [1-3]:
```

### Forced

```bash
alpha-loop run --epic 165
```

Processes epic `#165` directly, skipping the picker.

### Excluded

```bash
alpha-loop run --no-epic
```

Skips the epic picker entirely and goes straight to milestones. Useful when you want to work on standalone issues in a repo that has open epics.

## Sub-Issue Ordering

Sub-issues are processed in the order they appear in the epic's task-list — **not** by issue number. To reorder, edit the epic body and rearrange the `- [ ] #N` lines.

For the epic above, the loop processes `#158` first, then `#159`, `#160`, `#161`, `#162` — regardless of the order those issues were created.

## Skip Rules

The loop skips a sub-issue (with a warning, not a hard error) when:

| Condition | Reason |
|-----------|--------|
| Sub-issue has no `ready` label | The issue is not ready to work on; fix by adding `ready` and re-running |
| Sub-issue has the `epic` label | Nested epics are unsupported in v1 |
| Sub-issue reference is cross-repo (e.g. `- [ ] owner/other-repo#42`) | Ignored silently |
| Sub-issue is already closed | Skipped; checklist is flipped to `- [x]` if not already |

Skipped sub-issues do not block the rest of the epic. The loop continues to the next item and reports skipped items in the epic summary.

## PR Body Additions

Each sub-issue PR gets `Part of #<epic>` appended to its body. For epic `#165` with sub-issue `#158`:

```markdown
## Summary
Adds tenant column to users table...

## Test Plan
...

Part of #165
```

This gives GitHub the linkage needed to surface the PR on the epic's timeline and makes it trivial to find every PR that contributed to the epic.

## Checklist Auto-Flip

When a sub-issue's PR merges, the loop edits the epic body and flips the corresponding line from `- [ ]` to `- [x]`:

```diff
 ## Sub-issues
-- [ ] #158 Add tenant column to users table
+- [x] #158 Add tenant column to users table
 - [ ] #159 Add tenant middleware to Express router
```

GitHub's progress indicator on the epic updates automatically from this.

### Safety Rail

The checklist updater throws loudly if it cannot find the expected `- [ ] #N` line in the epic body. This is the **one-agent-per-epic contract**: if two loop sessions are editing the same epic, they will trip each other's safety checks and the second will fail rather than silently double-writing.

**Concurrent sessions against the same epic are not supported.** Running two `alpha-loop run --epic 165` processes in parallel will corrupt the checklist or error out; always run one at a time.

## Verification Pass

When every sub-issue in the task-list is either merged or skipped, the loop runs a **verification pass**:

1. The review model (see `pipeline.review.model` in `.alpha-loop.yaml`) reads each sub-issue's Acceptance Criteria checklist.
2. For each sub-issue, it inspects the merged PR's diff and judges whether each AC item is satisfied.
3. It aggregates into an overall verdict: `pass`, `partial`, or `fail`.
4. It posts a structured comment on the epic with the per-sub-issue breakdown.

Verdict outcomes:

| Verdict | Action |
|---------|--------|
| `pass` | Epic is closed with reason `completed` |
| `partial` | Epic stays open; `needs-human-input` label is added |
| `fail` | Epic stays open; `needs-human-input` label is added |

### Re-running Verification Only

```bash
alpha-loop run --verify-only 165
```

Re-runs just the verification pass on epic `#165`. This is **permissive**: it works even if some sub-issues are not yet merged. When any sub-issue is still open, the overall verdict caps at `partial` — a `pass` is only possible when every sub-issue has shipped.

Use this when you have edited a sub-issue PR, re-tuned the AC, or want to re-judge after a manual fix.

## Config: `prefer_epics`

```yaml
# .alpha-loop.yaml
prefer_epics: true
```

When this is `true` and there is exactly one open epic in the repo, the loop auto-selects it without prompting. If there are zero or multiple open epics, the picker is shown normally.

This is useful for teams that keep one active epic at a time and want `alpha-loop run` to "just start" without interaction.

## Non-Goals (v1)

- **Nested epics.** Sub-issues with the `epic` label are skipped with a warning. Build a flat epic instead.
- **Cross-repo sub-issue references.** Lines like `- [ ] owner/other-repo#42` are ignored silently. Sub-issues must live in the same repo as the epic.
- **Automatic epic creation.** You create the epic issue and populate its task-list yourself. The loop does not turn loose issues into an epic.
- **GitHub Projects v2 native sub-issues API.** The loop reads task-lists from the issue body, not from the Projects v2 sub-issue hierarchy.

## Example Workflow

A walk-through of epic `#165` "Multi-tenant support" with 7 sub-issues.

**1. Create the epic.** You open issue `#165`, add the `epic` label, and populate the body:

```markdown
## Sub-issues
- [ ] #158 Add tenant column to users table
- [ ] #159 Add tenant middleware
- [ ] #160 Scope existing queries by tenant
- [ ] #161 Add tenant header validation
- [ ] #162 Update docs
- [ ] #163 Add tenant admin dashboard
- [ ] #164 Backfill migration for existing rows
```

Each sub-issue has its own AC checklist and the `ready` label. `#163` does not yet have `ready`.

**2. Start the loop.**

```bash
alpha-loop run --epic 165
```

**3. Sub-issues run in checklist order.**

The loop processes `#158`, `#159`, `#160`, `#161`, `#162`. Each PR gets `Part of #165` appended. As each merges, the corresponding line in the epic body flips to `- [x]`.

**4. `#163` is skipped.** It has no `ready` label. The loop logs a warning and moves on.

**5. `#164` runs and merges.** Checklist flips.

**6. Verification pass runs.** One sub-issue (`#163`) is still open, so the verdict caps at `partial`. The loop posts a structured comment on `#165` summarizing per-sub-issue AC coverage and adds the `needs-human-input` label. Epic stays open.

**7. You review the comment.** `#163` genuinely was not ready; you add the `ready` label and run:

```bash
alpha-loop run --epic 165
```

The loop picks up where it left off — only `#163` is unchecked — processes it, and on merge runs verification again.

**8. Verification passes.** All seven sub-issues' AC items are satisfied. The loop closes epic `#165` with reason `completed`.
