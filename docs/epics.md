# Epics

Epics let you group related issues into a single, end-to-end deliverable that Alpha Loop ships as one unit. You plan the pieces, mark the parent issue with the `epic` label, and the loop builds the sub-issues in order, auto-links their PRs, verifies completeness when the last one merges, and closes the epic on pass.

## What is an Epic

An epic is a GitHub issue with:

1. The `epic` label applied.
2. A GitHub task-list in the body that references sub-issues by number.

Run `alpha-loop init` to install the epic issue template at `.github/ISSUE_TEMPLATE/epic.yml`. The template applies the `epic` label and includes fields for the goal, ordered sub-issues, acceptance criteria, dependencies, sequencing notes, and verification expectations.

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

## Dependencies
- None

## Sequencing Notes
- Run data model changes before API middleware changes.

## Verification Expectations
- Confirm each merged sub-issue satisfies its acceptance criteria.
- Confirm the integrated tenant workflow works end to end.
```

The task-list lines are the source of truth for both ordering and completion tracking.

## How Epics Are Detected

- The `epic` **label is authoritative**. An issue with no `epic` label is never treated as an epic, regardless of body content.
- If an issue has a task-list body with three or more `- [ ] #N` items but no `epic` label, it is treated as a **hint** — the picker may flag it as a candidate, but the loop will not process it as an epic until you add the label.

This keeps epic detection explicit. You opt in by labeling.

## Milestones + Epics

Alpha Loop's recommended planning flow is epic-first:

1. `alpha-loop triage` groups related open issues into parent epics. It can create a new parent epic or update an existing open issue labeled `epic`, then comments on child issues with a backlink to the parent.
2. `alpha-loop roadmap` schedules the parent epic issue into a milestone. It uses the ordered child checklist as planning context, but does not assign those child issues separately as standalone roadmap items.
3. `alpha-loop run --epic <N>` ships the child issues from the epic checklist in order. You can also run `alpha-loop run --milestone "<name>"`; when that milestone has exactly one open parent epic, the loop processes that epic.
4. The verification pass evaluates the completed child issues against the parent epic's acceptance criteria.

Milestones and epics answer different questions:

| Concept | Source of truth | What it controls |
|---------|-----------------|------------------|
| Milestone | GitHub milestone on the parent epic issue | Which delivery window or release the epic belongs to |
| Epic | Parent issue labeled `epic` | Goal, acceptance criteria, ordered child issue checklist, completion verification |
| Child issue | Task-list item inside the epic body | The concrete implementation unit processed by agents |
| Standalone issue | Open issue not listed in any open epic | Can be scheduled directly into a milestone by `roadmap` |

When a child issue is processed from an epic, the implementation, planning, review, batch, and session-review prompts include parent epic context: the parent goal/body summary, parent acceptance criteria, and the full ordered sibling checklist. This keeps each child narrowly scoped while preserving the integration expectations of the whole epic.

## Running the Loop Against an Epic

### Interactive

```bash
alpha-loop run
```

The picker lists open epics above milestones:

```
  Open Epics
  1  Multi-tenant support #165 (0/7 done · milestone v1.1)
  2  Billing revamp #170 (2/5 done)

  Open Milestones
  3  v1.1 — Polish (10 open, 3/13 done · 1 scheduled epic)

  0  All ready issues (no filter)

  Select [0-3]:
```

### Forced

```bash
alpha-loop run --epic 165
```

Processes epic `#165` directly, skipping the picker.

`--epic` is the explicit override. If you also pass `--milestone`, the milestone filter is ignored and the selected epic's checklist is processed.

### Milestone Scheduled

```bash
alpha-loop run --milestone "v1.1"
```

When a milestone contains open parent issues labeled `epic`, Alpha Loop applies this rule before fetching flat issues:

1. Exactly one scheduled epic: process that epic's checklist.
2. Multiple scheduled epics: print their issue numbers and titles, then exit. Re-run with `--epic <N>` to choose one.
3. No scheduled epics: use the existing flat milestone flow and process ready non-epic issues in that milestone.

### Excluded

```bash
alpha-loop run --skip-epic --milestone "v1.1"
```

Skips epic discovery entirely and uses the flat milestone issue flow. Useful when you want to work on standalone issues in a milestone that also has scheduled parent epics.

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
- **Automatic epic creation during `run`.** The run loop does not turn loose issues into an epic while processing work. Use `alpha-loop triage` to propose or apply epic groupings before roadmap scheduling.
- **GitHub Projects v2 native sub-issues API.** The loop reads task-lists from the issue body, not from the Projects v2 sub-issue hierarchy.

## Example Workflow

A walk-through of epic `#165` "Multi-tenant support" with 7 sub-issues.

**1. Create the epic.** You open issue `#165` with the installed epic template, confirm the `epic` label is applied, and populate the body:

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
