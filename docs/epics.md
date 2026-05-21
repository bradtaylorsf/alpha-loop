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

## Multi-Epic Queues

Use one epic when the work has one integrated goal, one parent acceptance-criteria set, and one verification pass. Use a multi-epic queue when you want a long unattended run across several parent epics while keeping review scope separate. Each epic in the queue still produces its own session branch and session PR.

There are two ways to build a queue:

```bash
alpha-loop roadmap --queue
alpha-loop roadmap --queue --milestone "v1.1"
```

`roadmap --queue` is read-only. It inspects open epics, milestone order, child readiness, dependency phrases such as `depends on #N`, and likely file overlap. When at least one epic is runnable, it prints a command like:

```bash
alpha-loop run --epics 205,166,214
```

You can also provide the queue explicitly:

```bash
alpha-loop run --epics 205,166,214
```

Explicit queues are processed exactly in the order provided. Before any session starts, Alpha Loop validates that each issue exists, is labeled `epic`, is not duplicated, and is open unless already closed as completed. `--dry-run` performs the same validation and prints the queue without creating branches, PRs, GitHub comments, or queue manifests.

### Execution Model

For a non-dry-run queue, Alpha Loop writes:

```text
.alpha-loop/sessions/queue-<timestamp>/queue.json
```

The manifest records queue status, epic order, branch ancestry mode, per-epic session branch/PR URLs, dependency and overlap notes, failures, and the stop reason if the queue halts. `alpha-loop history` lists queue manifests alongside sessions, and `alpha-loop history queue-<timestamp>` prints the manifest details. If a queue stops, inspect that detail view to find the failed epic and the still-pending epics.

Queue execution is fail-stop by default. Alpha Loop stops at the first epic that fails, remains incomplete after eligible children run, hits an epic checklist consistency error, fails verification, or encounters a transient agent/rate-limit stop. Earlier successful epic PRs stay available for review. Pending epics remain `pending` in `queue.json`; rerun them with a new explicit queue once the failure is resolved.

If the process crashes inside a child issue before its branch has a PR, run `alpha-loop resume` to recover stranded `agent/issue-*` branches. Then inspect the queue manifest and continue with the remaining epic IDs.

### Branch Ancestry Modes

Queued epics always create separate session PRs that target the configured base branch. The branch ancestry controls where later session branches start.

| Mode | Command | Branch behavior | When to use |
|------|---------|-----------------|-------------|
| `stacked` | `alpha-loop run --epics 205,166,214` | The first session branch starts from the base branch. Each later session branch starts from the previous successful session branch. | Related epics where later work may build on earlier queue changes. This is the default. |
| `independent` | `alpha-loop run --epics 205,166,214 --queue-branch-mode independent` | Every session branch starts from the base branch. | Unrelated epics that only need queue order for scheduling or review coordination. |

Stacked queue PRs include merge and rebase guidance. Merge the first session PR first. After it lands on the base branch, rebase the next stacked session branch onto the base branch before final review/merge, then repeat for the rest of the queue. Independent queue PRs should still be reviewed in queue order, but they can merge independently once ready because no branch ancestry dependency was created.

Session PR bodies include an `Execution Queue` section with the queue ID, position, parent epic, previous/next epic, branch ancestry mode, dependency PR link, and risk notes. Dependency notes come from queued epic references such as `depends on #205`; overlap notes come from likely shared file paths mentioned in epic context.

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
