---
name: alpha-loop-learning-review
description: Review accumulated alpha-loop learnings and propose skill/agent improvements with independent harness research. Use when the user asks to review learnings, improve the loop, evolve skills, run review, propose skill updates, or audit recent runs. Runs `alpha-loop review --dry-run`, conducts independent research against learning files and recent PRs, then walks the user through each proposed change with rationale.
auto_load: true
priority: high
---

# Alpha Loop Learning Review

## Trigger

Use this skill when the user wants to review accumulated Alpha Loop learnings or decide how the loop should improve.

Treat phrases like these as triggers:

- "review learnings"
- "improve the loop"
- "propose skill updates"
- "evolve skills"
- "run review"
- "audit recent runs"
- "what should alpha-loop learn from recent work?"

Do not treat the review pipeline's proposal as the final answer. This skill exists to give the user two perspectives: the `alpha-loop review` proposal and the harness's own independent research.

## Command Resolution

Resolve the Alpha Loop command from the project repo root before starting:

1. Prefer the adjacent checkout: `../alpha-loop/dist/cli.js`
2. If unavailable, use the global executable: `alpha-loop`
3. If neither exists, use the package fallback: `npx @bradtaylorsf/alpha-loop`

Keep using the same resolved command for the whole review cycle. In examples below, `<alpha-loop>` means the resolved command. If direct execution of `../alpha-loop/dist/cli.js` fails because it is not executable, retry with `node ../alpha-loop/dist/cli.js` and report the fallback.

## Phase 1 - Run Alpha Loop Review Dry-Run

Run the review pipeline in dry-run mode first:

```bash
<alpha-loop> review --dry-run
```

Then identify and read the generated proposal file:

```bash
ls -t .alpha-loop/learnings/proposed-updates/*-proposals.md | head -1
```

Read the proposal end to end. Surface these facts to the user before doing your independent analysis:

- The proposal file path.
- The review window or run count it claims to cover.
- Any success-rate, failure-rate, retry, or trend metrics it reports.
- The count of proposed changes.
- The files each proposal would touch.

If no proposal file is generated, stop and report the exact `alpha-loop review --dry-run` output, the expected directory, and whether learning files exist. Do not invent proposals.

## Phase 2 - Independent Harness Research

After reading the proposal, conduct your own research before recommending anything. Read from source artifacts directly rather than relying on the proposal summary.

### Read Learnings Directly

Inspect `.alpha-loop/learnings/issue-*.md` files yourself:

```bash
ls -t .alpha-loop/learnings/issue-*.md | head -20
```

Read at least the 10 most recent learning files. If the proposal cites `N` runs, read at least `N + 5` recent learning files so you can see what the proposal excluded. If there are fewer than 10, read all available issue learning files and say so.

Track evidence by learning file path and issue number. Note repeated patterns, one-off failures, stale warnings, and contradictions.

### Cross-Reference PRs And Commits

For every cited learning, cross-reference the actual PR or commit that produced it when available:

```bash
gh pr view <N> --json number,title,state,mergedAt,headRefName,body,files,commits
git log -- <file>
```

If a learning names an issue but not a PR, search recent PRs and branch names for the issue number before giving up:

```bash
gh pr list --state all --search "<issue-number>" --json number,title,state,mergedAt,headRefName
git log --oneline --all --grep "#<issue-number>"
```

When GitHub access is unavailable, use local git history and say which PR checks could not be performed.

### Verify Each Proposed Update

For each proposed skill or agent update, verify all of these points:

- The cited evidence actually says what the proposal claims. Counter-check for hallucinated, exaggerated, or truncated citations.
- The proposed change is consistent with the current skill or agent file. Read the current `SKILL.md` or agent `.md` and compare it with the proposed edit.
- The change would not conflict with other recent updates. Check `git log -- <skill-or-agent-file>` and inspect recent commits when relevant.
- The reasoning generalizes beyond a single issue. Prefer patterns seen across multiple learnings, recurring review findings, or a clear systemic failure mode.

Flag any proposed update that is true but too narrow, correct but already present, contradicted by the codebase, or missing enough rationale for a user to trust it.

### Find Missed Patterns

Look for recurring evidence that the proposal missed. Include a harness-only candidate when you find a pattern such as:

- The same failure mode appears across 3 or more learning files but is absent from the proposal.
- A skill or agent has not been touched in several runs despite repeated relevant signals.
- The proposal focuses on recent tail events and misses an older but recurring pattern.
- The proposed file is the wrong home for the learning, but another skill or agent should change.
- Recent PR history shows a drift between what the skills say and how the code now behaves.

Do not add harness-only changes just to be comprehensive. They need evidence, a target file, and a reason they are better handled now than deferred.

## Phase 3 - Walk The User Through Changes

Before applying anything, walk the user through each proposed change and each harness-only candidate. Use this exact structure for every item:

```markdown
### <number>. <short title> [proposal | harness-only]

**What**: <file path> - <section or behavior touched>

**Why (proposal)**: <verbatim rationale from the alpha-loop review proposal, or "N/A - harness-only">

**Why (harness)**: <your independent rationale, evidence checked, and any disagreement with the proposal>

**Risk**: <what could go wrong, what could be over-fit, and what to watch after applying>

**Recommendation**: <apply | apply-with-edits | defer | reject> - <reasoning>
```

The proposal rationale must be quoted or copied closely enough that the user can distinguish it from your analysis. Keep quotes short when the proposal is long; summarize only after preserving the core rationale.

Use the recommendation labels consistently:

- `apply`: The proposal is well-supported and can be applied as-is.
- `apply-with-edits`: The direction is right, but wording, scope, target file, or evidence needs adjustment.
- `defer`: The evidence is plausible but not strong enough, not urgent, or blocked by another issue.
- `reject`: The proposal is unsupported, already covered, contradicted by evidence, or likely harmful.

After the walkthrough, ask the user which items to apply. Do not run the apply step until the user confirms the selection.

## Phase 4 - Apply Selectively

Apply only the changes the user approved.

If the user wants the alpha-loop proposal applied as-is, run:

```bash
<alpha-loop> review --apply
```

If the installed version has already flipped dry-run behavior and no longer needs `--apply`, use the current help output to choose the equivalent non-dry-run apply command, and report the command you used.

If the user chooses `apply-with-edits`, `defer`, `reject`, or any harness-only addition, edit the selected skill or agent files manually in their source-of-truth location:

```text
.alpha-loop/templates/skills/<name>/SKILL.md
.alpha-loop/templates/agents/<name>.md
```

For distribution changes inside the alpha-loop repo itself, mirror approved seeded-skill edits to:

```text
templates/skills/<name>/SKILL.md
```

After edits, sync generated harness outputs:

```bash
<alpha-loop> sync
git status --short
```

Verify changed files with the relevant test or review command. Then open a draft PR with the selected changes and a body that lists applied, edited, deferred, rejected, and harness-only items.

## Phase 5 - Meta-Learning

Every review session must write a meta-learning artifact, even if no proposal is applied.

Create:

```text
.alpha-loop/learnings/review-cycles/<timestamp>.md
```

Use an ISO-like local timestamp such as `20260525-153000`. Include:

```markdown
# Review Cycle - <timestamp>

## Summary

- Proposal file: .alpha-loop/learnings/proposed-updates/<timestamp>-proposals.md
- Learning files reviewed: <count>
- Proposal items applied: <count>
- Proposal items applied with edits: <count>
- Proposal items deferred: <count>
- Proposal items rejected: <count>
- Harness-only additions applied: <count>

## Review Process Notes

- <Patterns about the review process itself. Example: proposal hallucinated citations 2 of 6 times; reviewer should always cross-check.>

## Evidence Notes

- <Concise notes about recurring signals, missed patterns, stale recommendations, or PR/code drift.>

## Follow-Ups

- <Any issue numbers or manual checks that should happen later.>
```

If the review proposal hallucinated citations, omitted repeated patterns, over-fit one issue, or matched the evidence well, record that. The goal is to improve the review process itself, not just the underlying skills.

Run `git status --short` after writing the meta-learning file and include it in the final handoff.
