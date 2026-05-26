---
name: alpha-loop-runner
description: Run and monitor alpha-loop sessions or epics safely. Use whenever the user asks to run alpha-loop, start the loop on an epic, prepare an epic run, monitor loop progress, verify an alpha-loop session, or validate completed epic issues. Performs dry-run validation, checks ready labels, syncs skills/agents, chooses batch/test/verify settings, and stops on skipped checklist items or missing pre-conditions.
auto_load: true
priority: high
---

# Alpha Loop Runner

## Trigger

Use this skill whenever the user asks to run `alpha-loop`, "the loop", an Alpha Loop session, or a GitHub epic through Alpha Loop.

Treat phrases like "run the loop on epic 238", "monitor alpha-loop", "verify the session", "prepare an epic run", and "check whether the epic finished" as triggers. The user should not need to remember the dry-run, validation, sync, batching, monitoring, or completion checks.

## Command Resolution

Resolve the Alpha Loop command from the project repo root before doing any run work. Use this precedence exactly:

1. Prefer the adjacent checkout: `../alpha-loop/dist/cli.js`
2. If that is unavailable, use the global executable: `alpha-loop`
3. If neither exists, use the package fallback: `npx @bradtaylorsf/alpha-loop`

After choosing the command, keep using the same resolved command for the entire session. In examples below, `<alpha-loop>` means the resolved command. If direct execution of `../alpha-loop/dist/cli.js` fails because the file is not executable, retry with `node ../alpha-loop/dist/cli.js` and report that the adjacent checkout needed the Node prefix.

## Pre-Flight Checks

Run pre-flight checks before any dry run or real run:

```bash
git status --short --branch
gh auth status
<alpha-loop> --version
<alpha-loop> run --help
ps -axo pid,ppid,etime,command | grep -E 'alpha-loop|dist/cli.js' | grep -v grep
```

Use `alpha-loop --version` to confirm the version matches the expected checkout or package. If the version is missing, stale, or clearly from the wrong installation, flag it as a version-reporting or command-resolution mismatch before continuing.

Read `.alpha-loop.yaml` and surface the active settings to the user:

- `repo`
- `agent`
- `base_branch`
- `label`
- `test_command`
- `auto_merge`
- `batch`
- `batch_size`
- `max_issues`
- `max_session_duration`
- `skip_tests`
- `skip_verify`

Check for a project vision file before running the loop. Prefer `.alpha-loop/vision.md`; if the repo documents an equivalent vision or scope file, use that and name it. If no vision file exists, stop and walk the user through:

```bash
<alpha-loop> vision
```

Do not start a real run while another Alpha Loop process is active. If the process check finds an existing `alpha-loop run` or `dist/cli.js run`, inspect it first and ask the user whether to monitor, wait, or stop it.

## Skill Sync Source Of Truth

Alpha Loop uses two template locations with different jobs:

- `templates/` at the alpha-loop package root is the distribution source shipped to new users by `alpha-loop init`.
- `.alpha-loop/templates/` inside a project is that project's source of truth for harness instructions, skills, and agents.

For normal project work, edit project skills only under:

```text
.alpha-loop/templates/skills/<name>/
```

Then sync before any real run:

```bash
<alpha-loop> sync
git status --short
```

Confirm the skill appears in every configured harness output directory from `.alpha-loop.yaml` (`.claude/skills/`, `.agents/skills/`, or another harness-specific path).

Until issue #185 lands, `alpha-loop sync` can delete skills that exist only in generated harness directories. If sync removes a useful harness-only skill, recover it by restoring the file from git or shell history, copying it into `.alpha-loop/templates/skills/<name>/`, and running `<alpha-loop> sync` again. Never treat `.claude/skills/`, `.agents/skills/`, or other harness outputs as canonical.

## Repo-Specific Posture

Populate this block during onboarding for each project. Keep it short and operational so the harness can apply it during runs.

```markdown
### Repo-Specific Posture

- Repo:
- Default base branch:
- Ready label:
- Preferred agent and harnesses:
- Normal implementation test command:
- Expensive or final-only verification commands:
- When to set `skip_verify: true`:
- Batch-size preference:
- Project-specific stop conditions:
- Project-specific completion gates:
- Known environment requirements:
```

Tailor these sections for the project:

- `## Repo-Specific Posture`
- Project-specific test commands
- Project-specific stop conditions
- Project-specific completion gates

Do not bake another repository's posture into this seeded skill. If the user is running in a project that has not filled in the block, infer conservative defaults from `.alpha-loop.yaml`, package scripts, and the issue's acceptance criteria, then report the assumptions.

## Running An Epic

Follow this ordered playbook for `alpha-loop run --epic <N>` work.

1. Confirm the epic issue number and repo from `.alpha-loop.yaml`.

   ```bash
   gh issue view <N> --json number,title,state,labels,body --repo <owner/repo>
   ```

   Stop if the issue is not open or does not have the `epic` label.

2. Parse the ordered child list from the epic body. Prefer `## Ordered Sub-Issues`; also accept equivalent sections such as `## Ordered Work`, `## Sub-issues`, or a clearly ordered task-list queue. Treat unchecked task-list issue references like `- [ ] #123` as the exact execution order.

3. Check each intended child issue before the dry run.

   ```bash
   gh issue view <child> --json number,title,state,labels --repo <owner/repo>
   ```

   Every child to be processed must be open and have the configured ready label from `.alpha-loop.yaml`. If a child is intentionally skipped, the epic body must make that explicit. If labels are missing, stop and ask before changing them unless the user specifically asked you to get the epic ready.

4. Detect abandoned or overlapping state before starting:

   - Open or closed session PRs for the same epic.
   - Local or remote `session/epic-<N>-*` branches.
   - Local or remote `agent/issue-*` branches for the ordered children.
   - Existing `.worktrees/issue-*` worktrees.
   - Any active Alpha Loop process from the pre-flight process check.

   Useful commands:

   ```bash
   gh pr list --state all --search "epic <N>" --json number,title,state,headRefName,mergedAt --repo <owner/repo>
   git branch --all | grep -E 'session/epic-<N>|agent/issue-'
   find .worktrees -maxdepth 1 -type d -name 'issue-*'
   ```

   Clean abandoned branches, PRs, or worktrees only when the user asks for cleanup or the state is clearly from the current interrupted run. Otherwise report what you found and ask.

5. Run sync before the dry run so every harness sees the same skills and agents.

   ```bash
   <alpha-loop> sync
   git status --short
   ```

   If sync deletes or mutates unexpected project-owned skill files, restore or report them before continuing.

6. Choose the run shape and explain it briefly before the dry run.

   - Use batch size 1 for risky, architectural, migration, security, auth, data-destructive, CI/deploy, or tightly coupled work.
   - Use batch size 2 as the default for ordinary ordered epic work.
   - Use batch size 3-5 only for small independent tasks with low file overlap, such as docs, fixtures, data-only additions, or repeated mechanical edits.
   - Keep the test command no broader than the agreed gate for the issue or epic.
   - Use `skip_verify: true` only when per-child verification is intentionally deferred to a final integrated verification child or a post-epic verification pass.

7. Always run dry-run validation first with the exact intended shape:

   ```bash
   <alpha-loop> run --epic <N> --dry-run --validate [--batch --batch-size <n>]
   ```

   The dry run must show:

   - `Skip Verify` matches the intended posture.
   - `Batch Mode` and `Batch Size` match the intended posture.
   - The first batch starts at the first unchecked ordered child.
   - No unchecked child is skipped.
   - The total issue count matches the ordered unchecked checklist.
   - Validation warnings are understood before continuing.
   - File-overlap warnings are accepted only when batching is still coherent.

8. Set a monitor before starting the real run.

   - In Codex, use an available heartbeat or keep the long-running terminal session attached and check it roughly every 5 minutes.
   - In Claude Code, use the available periodic check/reminder mechanism when present, or keep the terminal visible and poll it roughly every 5 minutes.
   - In OpenCode or another harness, use the harness's long-running task monitor if available.
   - Fallback for any harness: keep the terminal session open, poll process/output state roughly every 5 minutes, and resume completion validation immediately when the process exits.

9. Start the real run in a long-lived terminal session using the same shape that passed dry-run validation:

   ```bash
   <alpha-loop> run --epic <N> --validate [--batch --batch-size <n>]
   ```

10. Watch for skip warnings, wrong starting child, failed tests, repeated verification loops, checklist update errors, rate limits, merge conflicts, missing learning files, and the final session PR.

Do not run two `alpha-loop run --epic <N>` processes against the same epic. The epic checklist is a single-writer queue.

## Stop Conditions

Interrupt the run, or stop before starting it, and report exact status if any of these occur:

- A child issue is skipped unexpectedly.
- The run starts at any child other than the first unchecked ordered child.
- The chosen test command is broader than the user agreed to run.
- A duplicate Alpha Loop process appears for the same repo or epic.
- Repeated verification failures indicate the issue needs new planning or human input instead of another retry.
- A merge conflict, missing dependency, service startup failure, or auth failure prevents safe unattended progress.
- A per-issue learning file is not written after an issue exits.
- Sync deletes a useful harness-only skill and it has not been restored into `.alpha-loop/templates/skills/`.
- The user says stop, pause, wait, hold, or questions the queue order.

When interrupted, pause any heartbeat automation, wait for Alpha Loop cleanup/finalization when safe, inspect `git status --short --branch`, and summarize the exact PRs, branches, issues, worktrees, and files touched.

## Learning-File Guarantee

Every issue exit, success or failure, must produce a learning file:

```text
.alpha-loop/learnings/issue-<N>-YYYYMMDD-HHMMSS.md
```

Before the run, count existing learning files for the ordered child issues. After the run, count again and verify that every processed issue gained one new learning file. If any processed issue is missing a learning file, write it manually before declaring the run complete. Capture:

- Issue number and title.
- Whether the issue succeeded, failed, or was interrupted.
- What the agent attempted.
- The exact failure or completion signal.
- Tests or verification that ran.
- Anti-patterns or future skill updates the project should learn from.

## Completion Validation

Do not report only that the process "exited." Validate the outcome.

1. Inspect the terminal output and session log enough to know whether the run succeeded, failed, or stopped early.
2. Verify the session PR exists with `gh pr list` or `gh pr view`.
3. Inspect the epic and child issues. Confirm completed child issues are closed, their PRs are merged, and the parent epic checklist boxes are checked.
4. Confirm every processed issue has a learning file under `.alpha-loop/learnings/`.
5. Re-run the relevant project gates from `.alpha-loop.yaml` and the repo-specific posture:
   - Build or typecheck for code changes.
   - Lint or formatting checks when the project uses them.
   - Unit/integration/e2e tests for touched surfaces.
   - `<alpha-loop> run --verify-only <N>` when epic verification is expected.
   - Manual or external deployment checks only when the repo-specific posture calls for them.
6. If validation is partial, name the issue numbers, unchecked boxes, missing PRs, missing learning files, failed gates, and the next safest command.

Only declare the epic complete when the session PR, child issue state, checklist state, learning files, and completion gates all line up.
