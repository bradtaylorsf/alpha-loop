# Factory mode

`alpha-loop factory` runs Alpha Loop as a code factory. A long-running supervisor turns rough ideas
into issues, picks what to build next, builds several issues in parallel, and merges the green PRs. It
asks you something only when it is genuinely blocked, and it does that in exactly one place: a
questions file.

```
ideas inbox ──► PM ──► GitHub issues / epics ──► planner ──► N developers (parallel worktrees)
                                                                   │ plan → build → test → review → PR
you ◄── questions.md ◄── any role that is blocked                  ▼
                                                      shipper ──► CI-gated merge ──► base branch
```

GitHub stays the database. Issues are the kanban, labels are the state machine, and PRs are the
reviews. Factory state on disk is only coordination: who holds which issue, and which questions are
open.

## Quick start

```bash
alpha-loop factory idea "Let the shipper auto-rebase PRs that fall behind master"
alpha-loop factory --dry-run          # show what the next tick would ingest, dispatch, and ship
alpha-loop factory --developers 3     # run continuously
alpha-loop factory status             # in another terminal
alpha-loop factory questions          # what the factory needs from you
alpha-loop factory answer Q-20261104-001 "Yes — allow admin merge for session PRs"
```

To run one epic overnight against a feature branch, so that nothing touches `master`:

```bash
alpha-loop factory --epic 454 --base feat/factory-mode --developers 3 --until-idle --ship-merge
```

## Roles

| Role | What it does | How it runs |
|---|---|---|
| **PM** | Takes one inbox idea and turns it into an issue, an epic with ordered children, a duplicate or reject note, or a question for you | Child process. The agent runs in a scratch directory, so it can never edit the repo |
| **Planner** | Picks which `ready` issues fill free developer slots | Deterministic, inside the supervisor |
| **Developer ×N** | Runs the normal plan → implement → test → review → PR pipeline for one issue | One child process per issue (`alpha-loop run --issue N --factory-worker …`) with its own session `session/issue-N-<slug>`, worktree, and session PR |
| **Shipper** | Merges session PRs whose CI is green and that are mergeable. Raises a question for blockers only a human can clear | Inside the supervisor, every `ship.interval_seconds` |

### How the planner chooses

1. Only open issues labeled `ready`. With `--epic`, only children of those epics.
2. It skips epics, `blocked`, `needs-human-input` and `failed` issues, issues another worker holds
   (leases), and issues whose `Depends on #N` targets are still open.
3. It skips issues whose `## Touches` files overlap work already in flight (`avoid_overlap`). Two
   agents never edit the same files at once.
4. Order: priority label (`p0` … `p3`), then epic checklist order, then issue number.

### How the shipper decides (fail closed)

| PR state | Decision |
|---|---|
| Draft, or head branch not `session/*` | skip |
| Any failing check | ask you (once) |
| No checks yet | wait. Ask once it is older than `ship.checks_timeout_minutes` |
| Checks pending | wait |
| Conflicting | ask you (once) |
| Review required / blocked by branch protection | ask you, or merge with `--admin` only when `ship.admin_merge: true` |
| Behind base | wait |
| Green and clean | merge (only when `ship.merge: true` or `--ship-merge`), then re-read and require `MERGED` |

`ship.merge` defaults to `false`. Out of the box the shipper only reports what it would merge.

## The two files you use

Both live under `.alpha-loop/factory/` by default (gitignored). You can point `inbox_path` and
`questions_path` somewhere central, such as a notes folder, so one inbox can feed one repo from anywhere.

### `inbox.md` — rough ideas in

```md
- [ ] Let the shipper auto-rebase stale PRs
- [~] Being turned into issues right now          <!-- factory:id=I-3f2a1c -->
- [x] Done → #512, #513                           <!-- factory:id=I-9b1e22 -->
- [?] Needs your answer → Q-20261104-002           <!-- factory:id=I-77aa01 -->
- [-] Rejected → dup of #300                       <!-- factory:id=I-0c0c0c -->
```

Write anything as a `- [ ]` bullet, including several lines indented under it. The factory leaves
every other line alone.

### `questions.md` — the only way the factory interrupts you

```md
## Q-20261104-001 · open · shipper · PR #512
- key: ship:512:review-required
- pr: #512

**Question:** PR #512 is green but master requires an approving review the loop cannot give. …

**Answer:**
```

Type under `**Answer:**` and save, or run `alpha-loop factory answer <id> "<text>"`. The next tick
applies the answer:
- issue questions: posts the answer as an issue comment and moves the issue from `needs-human-input`
  to `ready`
- idea questions: re-queues the idea with your answer as context

A blocker is asked once per key and is not repeated while the question is still open.

## Safety model

- **Child processes, not threads.** Every git and gh call in Alpha Loop is synchronous, so each worker
  is its own process started from the project root. Each worker writes to its own log at
  `.alpha-loop/factory/workers/<id>/worker.log`.
- **Leases.** One lease file per in-flight issue (`leases/issue-N.lock`) plus a singleton lease for
  the supervisor. A stale lease (owner and worker both dead, or past its TTL) is reclaimed with an
  atomic rename. Two reclaimers can never both win.
- **Shared `.git`.** Worktree creation, fetch and prune run under a repo-level file lock, so parallel
  workers do not fail on `.git` ref locks.
- **Single writer.** Workers never write `inbox.md` or `questions.md`. They return results as JSON,
  and the supervisor writes both files atomically, re-reading them first so your edits are kept.
- **Workers skip shared setup.** Asset sync, context refresh and preflight run once in the supervisor,
  never in N workers at the same time.
- **Shutdown.** SIGINT/SIGTERM stops dispatch, sends SIGTERM to workers, waits 60 s, then sends SIGKILL
  to any still running, and releases their leases. A worker past `worker_timeout_minutes` is killed and
  its issue is released.

## Configuration

```yaml
factory:
  developers: 2                 # parallel developer workers (1-16)
  tick_seconds: 30
  spawn_stagger_seconds: 15     # space out worker starts
  max_runtime_minutes: 0        # 0 = until stopped
  state_dir: .alpha-loop/factory
  inbox_path: ""                # default <state_dir>/inbox.md
  questions_path: ""            # default <state_dir>/questions.md
  avoid_overlap: true
  epics: []                     # restrict dispatch to children of these epics
  worker_timeout_minutes: 120
  pm:
    enabled: true
    agent: ""                   # default: top-level agent
    model: ""
    auto_ready: true            # label PM-created issues `ready`
    max_ideas_per_tick: 1
    timeout_seconds: 600
  ship:
    enabled: true
    merge: false                # true = actually merge green PRs
    admin_merge: false          # true = bypass required reviews with --admin
    require_checks: true
    checks_timeout_minutes: 60
    interval_seconds: 300
    merge_method: squash
    head_prefixes: [session/]
```

## Known limits (tracked in epic #454)

- GitHub rate-limit accounting is still per process (#444).
- A PR that falls behind the base branch waits; auto-update is #445.
- Issues stranded `in-progress` by a crashed worker are not reclaimed automatically yet (#446).
- There is no independent reviewer role or post-merge QA role yet (#450, #451).
- On repos where the protected branch requires an approving review and the loop opens PRs under your
  own account, the shipper cannot merge into that branch without `ship.admin_merge`. It asks instead.
