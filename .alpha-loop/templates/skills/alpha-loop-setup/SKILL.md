---
name: alpha-loop-setup
description: Guide a user through setting up alpha-loop in a repo, or audit an existing setup. Use when the user asks to install alpha-loop, set up the loop, configure alpha-loop, audit alpha-loop config, or add new harnesses/skills. Detects installed CLI harnesses, inspects the codebase to suggest `.alpha-loop.yaml` settings, recommends matching seed skills, and verifies the setup with a dry-run.
auto_load: false
priority: medium
---

# Alpha Loop Setup

## Trigger

Use this skill when the user asks to onboard a repo to Alpha Loop, install the loop here, set up alpha-loop, configure alpha-loop, audit an alpha-loop setup, add a harness, add seeded skills, or check whether an existing setup is healthy.

Treat phrases like "set up alpha-loop", "install the loop here", "audit my alpha-loop config", "configure alpha-loop for this repo", "add Codex to alpha-loop", and "add a harness" as triggers. The user should not need to know the config schema, harness output directories, GitHub Project setup, or dry-run checks in advance.

## Command Resolution

Resolve the Alpha Loop command from the repo root before making changes. Use this order and keep the resolved command for the whole setup:

1. If `../alpha-loop/dist/cli.js` exists, use `node ../alpha-loop/dist/cli.js`.
2. If `alpha-loop` is on PATH, use `alpha-loop`.
3. If neither is available and package execution is acceptable, use `npx @bradtaylorsf/alpha-loop`.

Run:

```bash
test -f ../alpha-loop/dist/cli.js && node ../alpha-loop/dist/cli.js --version
command -v alpha-loop && alpha-loop --version
npx @bradtaylorsf/alpha-loop --version
```

In examples below, `<alpha-loop>` means the resolved command.

## Detect Existing State

Start with a read-only audit and report the active posture before suggesting changes.

```bash
git status --short --branch
which alpha-loop || true
test -f ../alpha-loop/dist/cli.js && echo "../alpha-loop/dist/cli.js found"
test -f .alpha-loop.yaml && sed -n '1,220p' .alpha-loop.yaml
test -d .alpha-loop && find .alpha-loop -maxdepth 3 -type f | sort
for cli in claude codex opencode cursor-agent gemini; do
  if command -v "$cli" >/dev/null 2>&1; then
    printf "found: %s -> %s\n" "$cli" "$(command -v "$cli")"
  else
    printf "missing: %s\n" "$cli"
  fi
done
```

If `.alpha-loop.yaml` exists, summarize:

- `repo`
- `project`
- `agent`
- `base_branch`
- `label`
- `test_command`
- `dev_command`
- `harnesses`
- any skip flags that change safety posture

If `.alpha-loop/` exists, name the useful contents: `templates/`, `vision.md`, `sessions/`, `learnings/`, `evals/`, and whether generated harness outputs appear to be synced.

## Codebase Inspection

Build a `.alpha-loop.yaml` proposal from evidence. Do not ask the user to type config values that can be inferred locally.

Collect repo and branch evidence:

```bash
git config --get remote.origin.url
git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##'
git config --get init.defaultBranch
git branch --show-current
```

Infer `repo` from `git config --get remote.origin.url`. Convert common GitHub remote forms to `owner/name`:

- `git@github.com:owner/name.git`
- `https://github.com/owner/name.git`
- `https://github.com/owner/name`

Infer `base_branch` from `origin/HEAD`, then `init.defaultBranch`, then the current branch. If none are available, propose `main` and mark it as an assumption.

Detect the test command from project files:

```bash
test -f package.json && node -e 'const p=require("./package.json"); const s=p.scripts||{}; console.log(JSON.stringify({test:s.test, build:s.build}, null, 2));'
test -f pnpm-lock.yaml && echo "package manager: pnpm"
test -f yarn.lock && echo "package manager: yarn"
test -f package-lock.json && echo "package manager: npm"
test -f Makefile && grep -nE "^(test|check):" Makefile || true
test -f pyproject.toml && echo "python project: pyproject.toml"
test -f setup.py && echo "python project: setup.py"
test -f Cargo.toml && echo "rust project: Cargo.toml"
test -f go.mod && echo "go project: go.mod"
```

Use this preference order for `test_command`:

1. `package.json` `scripts.test`: `pnpm test`, `yarn test`, or `npm test` based on the lockfile.
2. `package.json` `scripts.build`: `pnpm build`, `yarn build`, or `npm run build`.
3. `Makefile` with `test:`: `make test`.
4. `pyproject.toml` or `setup.py`: `pytest`.
5. `Cargo.toml`: `cargo test`.
6. `go.mod`: `go test ./...`.

Report every finding and ask the user to confirm the proposed `test_command`, especially when the best local evidence is only a build command.

Set `agent` to the harness currently running this setup when the harness can identify itself. If not, choose the first installed harness from the detected list and explain the assumption.

Set `label` to `ready` by default. If GitHub labels show a clear queue convention, offer that instead:

```bash
gh label list --limit 100 --json name --jq '.[].name'
```

If a GitHub Project should be configured, derive `<owner>` from `repo`, list projects, and let the user pick or skip:

```bash
gh project list --owner <owner>
```

Present the proposal before writing:

```yaml
repo: <owner/name>
project: <number-or-empty>
agent: <current-harness-or-detected-default>
base_branch: <branch>
label: <ready-or-detected-label>
test_command: <detected-command>
harnesses:
  - <detected-harness>
```

## Harness Sync Targets

Suggest `harnesses:` from installed CLI tools, then ask the user to accept or edit the list.

Use this mapping:

- `claude` on PATH -> `claude-code`
- `codex` on PATH -> `codex`
- `opencode` on PATH -> `opencode`
- `cursor-agent` on PATH -> `cursor`
- `gemini` on PATH -> `gemini-cli`

If multiple harnesses are installed, include all likely active harnesses so `alpha-loop sync` writes skills and agents to each output directory. If no harness CLI is detected, set `harnesses:` to the current harness if known; otherwise leave it empty and explain that Alpha Loop will infer from `agent`.

## Skill Recommendations

Scan the codebase and recommend seeded skills that match real signals. Check whether each recommended skill exists under `templates/skills/` or `.alpha-loop/templates/skills/` before promising it will be installed.

Always recommend these general loop and engineering skills:

- `alpha-loop-runner`
- `alpha-loop-issue-author`
- `alpha-loop-learning-review`
- `git-workflow`
- `code-review`
- `testing-patterns`

Use these heuristics:

- `package.json` with `react`, `vue`, `svelte`, or `next` dependencies -> recommend `api-contracts`; also recommend `playwright-testing` if `@playwright/test`, `playwright`, `cypress`, or an `e2e` script is present.
- `pyproject.toml` or `setup.py` -> recommend `testing-patterns`, noting that the Jest-specific examples should be translated to Python equivalents such as `pytest` fixtures and mocks.
- `src/api/`, `routes/`, `controllers/`, `server/`, or `app/api/` -> recommend `api-patterns` and `security-analysis`.
- Any source code at all -> recommend `git-workflow`, `code-review`, and `testing-patterns`.

Useful scan commands:

```bash
test -f package.json && node -e 'const p=require("./package.json"); console.log(JSON.stringify({...p.dependencies, ...p.devDependencies}, null, 2));'
find . -maxdepth 3 -type d \( -name src -o -name routes -o -name controllers -o -name server -o -path "./app/api" \) | sort
find . -maxdepth 3 -type f \( -name "pyproject.toml" -o -name "setup.py" -o -name "Cargo.toml" -o -name "go.mod" \) | sort
find templates/skills .alpha-loop/templates/skills -maxdepth 2 -name SKILL.md 2>/dev/null | sort
```

If a heuristic points to a skill that is not present in the current seed set, call it a recommended follow-up instead of claiming setup will install it.

## Vision File

Check for project vision before running setup verification:

```bash
test -f .alpha-loop/vision.md && sed -n '1,220p' .alpha-loop/vision.md
```

If `.alpha-loop/vision.md` is missing, offer to walk the user through `alpha-loop plan` or the older `alpha-loop vision` command. Gather:

- product goal
- target users
- constraints and non-goals
- success metrics
- near-term milestones

Prefer:

```bash
<alpha-loop> plan
```

Use `<alpha-loop> vision` only for older installations that still expose it or when the user explicitly asks for that flow.

## GitHub Authorization

Verify GitHub CLI auth before applying or verifying:

```bash
gh auth status
gh auth status 2>&1 | grep -i "project" || true
```

If unauthenticated, walk the user through:

```bash
gh auth login
```

If authenticated but missing Project scope, run:

```bash
gh auth refresh -s project
```

If repo operations fail with scope errors, refresh with both repo and project scopes:

```bash
gh auth refresh -s repo -s project
```

Do not proceed to project selection or dry-run verification until auth errors are resolved or the user explicitly chooses to skip GitHub Project setup.

## Apply

For a new setup, run:

```bash
<alpha-loop> init
```

For an existing setup, update `.alpha-loop.yaml` only after showing the proposed diff and getting confirmation. Preserve user-specific settings that were not part of the requested change.

After init or config edits, run:

```bash
<alpha-loop> sync
git status --short
```

Confirm the expected skills appear in every configured harness output directory. Common locations are:

```bash
find .claude/skills .agents/skills -maxdepth 2 -name SKILL.md 2>/dev/null | sort
```

If `harnesses:` includes another supported harness, check that harness's configured skill directory too. Treat `.alpha-loop/templates/skills/` as the source of truth; do not hand-edit generated harness directories.

## Verify

Run a dry-run before handing the repo back:

```bash
<alpha-loop> run --dry-run --once
```

If the repo has no ready issues, use the dry-run output to confirm pre-flight behavior and queue discovery. If the user has a known no-op issue, dry-run that issue shape instead. Verification passes when:

- command resolution is stable
- `.alpha-loop.yaml` loads without errors
- GitHub auth works
- labels and project settings are accepted or intentionally skipped
- the test command is visible in the run plan
- no sync or pre-flight errors appear

If verification fails, report the exact failing check, fix setup/config issues that are in scope, and rerun the dry-run.

## Hand-Off

Finish by printing the active config posture, installed harness targets, recommended skills, and the next commands:

```bash
<alpha-loop> plan
<alpha-loop> add
<alpha-loop> run --epic <N>
<alpha-loop> run --once
```

Tell the user which command is the best next step for their repo state:

- Use `plan` when the repo needs milestones and initial issues.
- Use `add` when the user has one feature or fix to capture as an issue.
- Use `run --epic <N>` when an epic already has an ordered checklist.
- Use `run --once` when there is one ready issue to process.
