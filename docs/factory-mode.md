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

## Running it

```
alpha-loop factory [--developers n] [--epic <ids>] [--once] [--until-idle] [--max-ticks n]
                   [--max-runtime <min>] [--no-pm] [--no-ship] [--ship-merge] [--base <branch>]
                   [--dry-run] [--verbose]
alpha-loop factory status [--json]
alpha-loop factory idea <text...>
alpha-loop factory questions [--all]
alpha-loop factory answer <id> <text...>
```

Flags override the `factory:` config block for one run. How the run ends:

| Flag | Behaviour |
|---|---|
| (none) | Runs until SIGINT/SIGTERM |
| `--once` | One tick of new work, then waits for the workers it started and exits |
| `--max-ticks n` / `--max-runtime m` | Stops starting new work after n ticks / m minutes, keeps reaping until the running workers finish (or hit their timeout), then exits |
| `--until-idle` | Exits when no worker is running, the last plan had free slots but nothing to dispatch, no idea is pending (or the PM is off), no answer is waiting to be applied, and no session PR is waiting on CI. The CI wait is capped at 30 minutes after the last worker finished |
| `--dry-run` | Computes one plan (ideas the PM would take, answers it would apply, issues it would dispatch with skip reasons, ship decisions) and prints it. No lease, no spawns, no file or GitHub writes |

Only one supervisor runs per state directory. A second one exits with `factory already running (pid N)`
and exit code 2.

### Each tick

1. **Reap** finished workers and release their leases.
   - Developer `success`: counted, and a ship pass runs this tick.
   - Developer `waiting`: asks `Issue #N paused and needs your input` (key `dev:N:waiting`).
   - Developer `failure`, a missing or invalid `result.json`, a non-zero exit, or a timeout kill: asks
     key `dev:N:failed` with the failure messages and the worker log path. The issue is not dispatched
     again in this run until that question is answered.
   - PM results update the inbox (see below).
2. **Apply answers.** Issue questions: the answer is recorded on the issue through feedback ingest
   (falling back to a plain comment with a `<!-- factory:answer=Q-… -->` marker), the issue is
   relabeled `ready`, and `needs-human-input` and `failed` are removed. Idea questions: the idea goes
   back to pending and the PM re-runs it with every answer given for that idea. Ship questions are
   recorded only; you act on GitHub and the next ship pass re-evaluates the PR. Each answer is retried
   at most 3 times per run if applying it fails, and one bad answer never blocks the others.
3. **PM intake.** One PM worker at a time takes the first pending idea (`max_ideas_per_tick` is
   effectively 1).
4. **Dispatch.** The planner fills free developer slots. Each issue's lease is taken before its worker
   starts, and worker starts are spaced `spawn_stagger_seconds` apart.
5. **Ship** every `ship.interval_seconds`, and right after any developer success.
6. Write `state.json` and append to `events.jsonl`.

### PM outcomes

| PM result | Inbox | Question |
|---|---|---|
| issue / epic | `[x]` with the created issue numbers | — |
| question | `[?]` with the question id | `pm:<idea>` |
| duplicate / reject | `[-]` with the reason | — |
| failure (first) | back to `[ ]`, `attempts=1` | — |
| failure (second) | `[?]` | `pm:<idea>:failed` |
| failure after creating some issues | `[?]` noting the created issues; never re-run automatically | `pm:<idea>:partial` |

A PM worker running longer than twice `pm.timeout_seconds` plus 5 minutes is killed and counts as a
failed attempt.

## Roles

| Role | What it does | How it runs |
|---|---|---|
| **PM** | Takes one inbox idea and turns it into an issue, an epic with ordered children, a duplicate or reject note, or a question for you | Child process. The agent runs in a scratch directory, so it can never edit the repo |
| **Planner** | Picks which `ready` issues fill free developer slots | Deterministic, inside the supervisor |
| **Developer ×N** | Runs the normal plan → implement → test → review → PR pipeline for one issue | One child process per issue (`alpha-loop run --issue N --factory-worker …`) with its own session `session/issue-N-<slug>`, worktree, and session PR |
| **Shipper** | Merges the session PRs this factory's developers finished, once CI is green and they are mergeable. Raises a question for blockers only a human can clear | Inside the supervisor, every `ship.interval_seconds` |

### How the planner chooses

1. Only open issues labeled `ready`. With `--epic`, only children of those epics.
2. It skips epics, `blocked`, `needs-human-input` and `failed` issues, issues another worker holds
   (leases), and issues whose `Depends on #N` targets are still open.
3. It skips issues whose `## Touches` files overlap work already in flight (`avoid_overlap`). Two
   agents never edit the same files at once.
4. Order: priority label (`p0` … `p3`), then epic checklist order, then issue number.

### How the shipper decides (fail closed)

The shipper only considers PRs a developer worker of this factory reported as its finished session
PR (remembered in `state.json` across restarts). It never touches session PRs from ordinary
`alpha-loop run` / `--epic` sessions, or the PR of an issue a developer is still working on.

| PR state | Decision |
|---|---|
| Not produced by this factory, its issue is in flight, draft, or head branch not `session/issue-*` | skip |
| Any failing check | ask you (once) |
| No checks yet | wait. Ask once it is older than `ship.checks_timeout_minutes` |
| Checks pending | wait |
| Conflicting | ask you (once) |
| Changes requested | ask you — never admin-merged |
| Review required | ask you, or merge with `--admin` when `ship.admin_merge: true` **and** every required status check of the base branch has reported success on the head |
| Blocked by branch protection for another reason | wait; ask once older than `ship.checks_timeout_minutes` |
| Behind base | wait |
| Green and clean | merge (only when `ship.merge: true` or `--ship-merge`), then re-read and require `MERGED` |

A question you answer or dismiss is not asked again until the PR's state (head commit, checks,
mergeability, review) changes. After merging into a base branch that is not the repository's default
branch, the shipper closes the PR's issues itself (GitHub only honors `Closes #N` on the default
branch), so dependent issues can dispatch.

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
- **Lease-gated worktree setup.** Before each checkout setup, a factory worker checks the issue lease
  in the configured `state_dir`. Its issue number, worker ID (`ALPHA_LOOP_FACTORY_WORKER`), hostname
  and worker PID must match, and the lease must be valid and live. Only an owner may force-remove a
  conflicting worktree, force-delete a local issue branch after failed reuse, or delete a disposable
  remote issue branch. Other workers reuse existing local or remote work, including branches backing
  open PRs. They create fresh work only after confirming the remote branch is absent; fetch, discovery
  or recovery failures stop setup. Refusal errors identify the issue, branch and path: restore the
  worker's valid lease ownership before retrying, or resolve the conflicting checkout with its owner.
  Programmatic callers can explicitly set `SetupWorktreeOptions.allowDestructive: true`; it defaults
  to `true` for backward compatibility outside factory mode. Saved and explicitly named branches
  retain their existing protections even with permission.
- **Single writer.** Workers never write `inbox.md` or `questions.md`. They return results as JSON,
  and the supervisor writes both files atomically, re-reading them first so your edits are kept.
- **Workers skip shared setup.** Asset sync, context refresh and preflight run once in the supervisor,
  never in N workers at the same time.
- **Shutdown.** SIGINT/SIGTERM stops dispatch, sends SIGTERM to workers, waits 60 s, then sends SIGKILL
  to any still running, and releases their leases and the supervisor lease. A second SIGINT sends
  SIGKILL immediately. An interrupted PM idea goes back to pending. Interrupted developer workers are
  not counted as failures and raise no questions.
- **Timeouts.** A developer worker past `worker_timeout_minutes` gets SIGTERM, then SIGKILL 30 s later.
  Its lease is released and it is recorded as a failure with a `dev:N:failed` question.

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
    admin_merge: false          # true = bypass a required review with --admin (required checks must pass)
    require_checks: true
    checks_timeout_minutes: 60
    interval_seconds: 300
    merge_method: squash
    head_prefixes: [session/issue-]
```

## Known limits (tracked in epic #454)

- GitHub rate-limit accounting is still per process (#444).
- A PR that falls behind the base branch waits; auto-update is #445.
- Issues stranded `in-progress` by a crashed worker are not reclaimed automatically yet (#446).
- There is no independent reviewer role or post-merge QA role yet (#450, #451).
- On repos where the protected branch requires an approving review and the loop opens PRs under your
  own account, the shipper cannot merge into that branch without `ship.admin_merge`. It asks instead.
