# Learnings: External QA review of quick mode, sandbox fixes, and the parallel-execution epic

**Date:** 2026-08-11
**Scope:** PR #369 (quick mode + plan metadata), PR #378 (sandbox + auto-commit fixes), session PR #375 (epic #374).
**Source:** Independent adversarial QA review with executable reproductions — 1 CRITICAL, 4 MAJOR, 5 MINOR findings, all fixed on the session branch.

## What failed and why

### 1. Deferred verification must demote optimistic state on failure (CRITICAL)
Quick mode reports per-issue `status: 'success'` / `testsPassing: true` on plan+build alone — verification is deferred by design. But downstream consumers (epic checklist flips, session results, the session PR's `Closes #N` lines) treated that provisional success as final. When the deferred pass failed, the session PR claimed issues whose code never reached the branch.
**Rule:** any pipeline that defers verification must, on deferred-pass failure, walk back every optimistic side effect it emitted — results, checklists, labels, PR claims. Grep for every consumer of the optimistic field before shipping the deferral.

### 2. GitHub side effects must never outrun evidence (MAJOR)
Step 10 posted "**Tests**: PASSING" and moved issues to `in-review` before any test ran in quick mode. Permanent, human-visible records asserting verification that never happened.
**Rule:** comments, labels, and status changes are claims. Emit them only from code paths that hold the evidence, and prefer an honest "deferred" note over a hopeful claim.

### 3. Moving a commit earlier changes worktree disposition everywhere (MAJOR)
The auto-commit-before-pause fix (PR #378) unintentionally created `wip:` commits on the *transient* failure path, flipping `preserveIfCommits` from discard to preserve — requeued issues then reused half-finished branches and worktrees accumulated.
**Rule:** `worktreeHasCommits` gates cleanup decisions in several places; any change to *when* commits happen requires auditing every consumer of "has commits". Transient requeues want a clean slate; permanent failures want preservation.

### 4. Guard-clause conjunctions silently drop stages (MAJOR ×2)
`deferLearning && prUrl && backgroundWorktreePath` — each extra condition is a silent skip path. Quick + `auto_merge: false` produced *zero* learning artifacts with only a `log.warn` to show for it.
**Rule:** when a stage can be skipped, either the skip is loud (explicit log + recorded stage state) or the configuration is rejected up front. Incompatible config combos (quick without auto-merge) should fail fast at command start, not degrade quietly.

### 5. Control-plane artifacts leak into work product (MINOR ×2)
Reviewer gate files (`review-issue-N.json`) were committed into two child PRs; nested `alpha-loop-pause-request.json` files would be auto-committed (root-anchored pathspec). Fixed with basename filtering, glob excludes, and `.gitignore` entries.
**Rule:** every file the pipeline writes into a worktree for its own signaling must be excluded from commits by basename (not exact path) and gitignored.

### 6. Session-scoped files written per-issue race with background tasks (MINOR)
`costs.json` was overwritten wholesale by each issue; deferred background tasks made the ordering nondeterministic, clobbering later issues' costs. Fixed with per-scope sidecars (`step-costs/<scope>.json`) and recomputing the aggregate from all sidecars on every write.
**Rule:** once any stage is asynchronous, "last writer wins" session files must become derived views over per-writer records.

### 7. Sandboxed agents in linked worktrees cannot commit without an explicit grant
Codex's workspace-write sandbox covers only the cwd; a linked worktree's git index lives in the parent repo's `.git`. Fix: `-c sandbox_workspace_write.writable_roots=[<git common dir>]`, comparing the common dir against `git rev-parse --show-toplevel` (not cwd) so subdirectories of the primary checkout get no unnecessary grant.

### 8. Agent fixes must be committed at every gate outcome
The post-session review loop committed the review agent's direct fixes only on the retry path; a first-attempt pass stranded them uncommitted (same family as the pause bug — separate fix in flight).
**Rule:** after any agent that may write files, the pipeline commits dirty state before acting on the gate verdict, whatever the verdict is.

## Process learnings

- **The loop's own gates share blind spots with the loop's author.** Per-issue review, epic verification, and the post-session holistic review all passed over the CRITICAL finding — they verify the *diff*, not the *bookkeeping claims* the pipeline makes about the diff. Independent QA prompted to challenge claims-vs-evidence with executable reproductions found in hours what the gates missed entirely.
- **Test what is claimed, not just what is skipped.** The pre-existing quick-mode tests asserted which stages were skipped but never what the pipeline *told GitHub* — which is exactly where the worst finding lived. The three regression tests added (finalize-failure semantics, quick-mode GitHub claims, transient worktree disposition) all pin claims, not mechanics.
- **Cross-fork integration is a first-class QA target.** Quick mode (master) and worktree-only mutations (session branch) were written on opposite sides of a fork point; the merge reconciled them correctly, but only the QA pass verified that — nothing in the pipeline did.
