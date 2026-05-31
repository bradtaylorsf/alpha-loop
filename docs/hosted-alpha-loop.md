# Hosted Alpha Loop Setup for Websites and Web Apps

Hosted Alpha Loop is a repo-scoped worker for websites and browser applications. It watches GitHub issues, runs only inside configured guardrails, opens PRs, emits lifecycle events, pauses for human input or QA, and resumes the same issue after feedback arrives.

It is not a general server automation account. Treat it like a careful teammate with a narrow job: implement ready website/app work in one repository, preserve GitHub as the source of truth, and stop when the request crosses a policy boundary.

Use this guide when you want Alpha Loop to run on a server for a marketing site, documentation site, Astro/Sanity site, Next/Vite/React app, or similar browser-facing repo.

## Recommended Install Shape

Install Alpha Loop repo-locally and commit the config that defines its authority.

```bash
cd /srv/alpha-loop/sites/example.com
pnpm add -D @bradtaylorsf/alpha-loop
pnpm exec alpha-loop init
```

Commit these files after review:

- `.alpha-loop.yaml` - repo-owned runtime config, policy, event destinations, daemon settings, and web/app verification.
- `.alpha-loop/templates/` - repo-owned agent prompts and skills used by `alpha-loop sync`.
- `.github/ISSUE_TEMPLATE/` - issue templates created by `alpha-loop init`.
- `.alpha-loop/vision.md` and `.alpha-loop/context.md` - product context for future runs.

Do not rely on a global install for hosted operation. A repo-local dev dependency pins the version used by the daemon and keeps upgrades reviewable in PRs.

## Prerequisites

Server packages and CLIs:

- Node.js 20 or newer.
- pnpm 9 or newer, usually enabled with `corepack enable`.
- git with push access to the target repo.
- GitHub CLI (`gh`) authenticated as the automation identity.
- One configured agent CLI: `claude`, `codex`, `opencode`, `lmstudio`, or `ollama`.
- Browser dependencies for web/app verification. For Playwright-based projects, run `pnpm exec playwright install --with-deps chromium` or the equivalent command used by the repo.
- A process supervisor such as systemd, Docker, launchd, or your existing job runner.

Repository requirements:

- A GitHub repo with issues enabled.
- A base branch that the automation identity can branch from and open PRs into.
- A package manager lockfile committed to the repo.
- Test, build, and dev server commands that work non-interactively.
- Any browser auth state created with `alpha-loop auth` when verification needs a logged-in session.

Secrets and environment:

- `GH_TOKEN` or GitHub CLI auth for issue, branch, PR, label, and comment operations.
- Agent provider credentials such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- Destination webhook URLs such as `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`, or `DISCORD_WEBHOOK_URL`.
- App-specific secrets needed for local build/test only. Do not give hosted Alpha Loop production deploy credentials unless production deploys are explicitly in scope and gated.
- `ALPHA_LOOP_EVENTS_SECRET` when a custom webhook should verify event signatures.

Keep secrets in the service manager, container runtime, or secret store. Do not commit `.env` files with real values.

## Server Filesystem Layout

Use one service account and one checkout per repo. Keep worktrees and session logs on durable local disk so paused work can resume after process restarts.

```text
/srv/alpha-loop/
  sites/
    example.com/                 # main repo checkout
      .alpha-loop.yaml
      .alpha-loop/
        sessions/                # gitignored durable manifests, logs, screenshots
        feedback/                # gitignored idempotency records for adapters
        auth/                    # gitignored browser auth state
      .worktrees/                # temporary issue worktrees
```

Recommended permissions:

- The service user owns the checkout, `.alpha-loop/`, and `.worktrees/`.
- No other daemon writes to the same checkout unless `daemon.lock.enabled` is disabled intentionally.
- Back up `.alpha-loop/sessions/` if losing paused work would be costly.

## GitHub Setup

Run `pnpm exec alpha-loop init` once from the repo to create default labels and templates. For hosted operation, use these labels consistently:

| Label | Who applies it | Meaning |
|-------|----------------|---------|
| `ready` | Human | The issue is clear, scoped, accepted for automation, and inside policy. |
| `in-progress` | Alpha Loop | A session is actively working on the issue. |
| `in-review` | Alpha Loop | A PR exists and needs review or QA. |
| `needs-human-input` | Alpha Loop or human | The issue is paused until a person answers or adjusts scope. |
| `blocked` | Human | The issue should not be selected until the blocker is removed. |
| `do-not-automate` | Human | The issue is permanently manual. |
| `failed` | Alpha Loop | The session failed after retries or hit an unrecoverable error. |
| `epic` | Human or template | Parent issue with an ordered sub-issue checklist. |

Humans should apply `ready` only after:

- Acceptance criteria are specific enough to test.
- The request is safe for the configured `automation_policy`.
- Required content, assets, credentials, and clarifications are already present.
- The issue is not a production deploy, billing, auth, migration, schema, dependency, or secret-handling task unless your policy explicitly allows that work.
- A human is prepared to review the PR and run final QA.

Use the `Agent-Ready Task` issue template for normal work. Use the `Epic` template for ordered batches where child issues should ship in checklist order.

GitHub comments are the canonical feedback source. Slack, Teams, Discord, website forms, and custom tools should bridge feedback into GitHub comments through `alpha-loop feedback ingest` rather than becoming separate state stores.

## Safe Starter `.alpha-loop.yaml`

This starter is intentionally conservative for a website or small web app. Adjust paths and commands to match your repo before starting the daemon.

```yaml
repo: owner/repo
agent: codex
base_branch: main
label: ready
test_command: pnpm test
dev_command: pnpm dev
auto_merge: false
auto_cleanup: true
max_issues: 1
max_session_duration: 5400

web_app:
  setup_command: pnpm install --frozen-lockfile
  build_command: pnpm build
  test_command: pnpm test
  dev_command: pnpm dev
  dev_url: http://localhost:4321
  smoke_test: pnpm build
  screenshots:
    - name: home-desktop
      url: /
      viewport: desktop
    - name: home-mobile
      url: /
      viewport: mobile
      width: 390
      height: 844
  preview:
    command: ./scripts/get-preview-url.sh
    required: false

automation_policy:
  require_labels: [ready]
  block_labels: [do-not-automate, needs-human-input, blocked]
  max_active_sessions: 1
  max_paused_sessions: 20
  max_issues_per_session: 1
  max_session_minutes: 90
  max_session_cost_usd: 30
  max_issue_cost_usd: 10
  allowed_paths:
    - src/**
    - app/**
    - pages/**
    - components/**
    - content/**
    - public/**
    - tests/**
  protected_paths:
    - package.json
    - pnpm-lock.yaml
    - .github/workflows/**
    - prisma/migrations/**
    - db/migrations/**
    - sanity/schema/**
    - .env*
  allowed_commands:
    - pnpm install
    - pnpm install --frozen-lockfile
    - pnpm test
    - pnpm build
    - pnpm dev
    - ./scripts/get-preview-url.sh
  require_human_for:
    - auth
    - billing
    - production-deploy
    - dependency-upgrade
    - sanity-schema
    - secrets
    - migrations
    - destructive-content
    - ambiguous

daemon:
  mode: full
  triage_interval: 900
  feedback_interval: 60
  run_interval: 120
  health_interval: 300
  idle_sleep: 30
  feedback_poll_command: ""
  lock:
    enabled: true
    stale_after: 86400
    path: ""

session_retention:
  paused_worktree_days: 0
  completed_worktree_days: 30

events:
  include_prompt_text: false
  redact:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY
    - GITHUB_TOKEN
    - GH_TOKEN
    - SANITY_TOKEN
  destinations:
    audit_log:
      type: log
      events: ['*']
    slack_qa:
      type: webhook
      events: [qa.requested, human_input.requested, session.failed]
      url_env: SLACK_WEBHOOK_URL
      format: slack
      retries: 1
      timeout: 10
      required: false

post_session:
  review: true
  security_scan: true
```

### Marketing Site Variant

For a marketing site, keep the same daemon, events, session retention, and web app verification settings, but narrow policy to content and presentation areas:

```yaml
automation_policy:
  require_labels: [ready]
  block_labels: [do-not-automate, needs-human-input, blocked]
  max_active_sessions: 1
  max_paused_sessions: 10
  max_issues_per_session: 1
  max_session_minutes: 60
  max_session_cost_usd: 15
  max_issue_cost_usd: 5
  allowed_paths:
    - src/**
    - content/**
    - public/**
  protected_paths:
    - package.json
    - pnpm-lock.yaml
    - .github/workflows/**
    - sanity/schema/**
    - .env*
  allowed_commands:
    - pnpm install
    - pnpm install --frozen-lockfile
    - pnpm test
    - pnpm build
    - pnpm dev
  require_human_for:
    - auth
    - billing
    - production-deploy
    - dependency-upgrade
    - sanity-schema
    - secrets
    - migrations
    - destructive-content
    - ambiguous
```

Keep dependency, workflow, schema, migration, and secret paths protected. See [Hosted Automation Policy](hosted-policy.md) for ready-to-paste marketing-site and web-app variants.

See [Web/App Verification Profile](web-app-profile.md) for browser screenshots, preview URLs, QA checklist output, and provider-agnostic preview discovery.

## First Run Workflow

Start attended. Do not make the daemon your first execution path.

1. Install dependencies and verify the repo without Alpha Loop:

   ```bash
   pnpm install --frozen-lockfile
   pnpm test
   pnpm build
   ```

2. Authenticate GitHub as the automation identity:

   ```bash
   gh auth login
   gh auth status
   ```

3. Confirm the agent CLI works from the same service account:

   ```bash
   codex --version
   ```

4. Create or choose one small issue, fill in acceptance criteria, and apply `ready`.

5. Run a read-only preview:

   ```bash
   pnpm exec alpha-loop run --issue 42 --dry-run
   ```

6. Run exactly one issue while attended:

   ```bash
   pnpm exec alpha-loop run --issue 42
   ```

7. Review the PR, screenshots, QA checklist, session history, and lifecycle event log.

8. Exercise one daemon tick before continuous mode:

   ```bash
   pnpm exec alpha-loop daemon --once-tick
   ```

9. Start the daemon only after dry run, single-issue run, and one-tick checks behave as expected.

## Automation Policy and Human Gates

The `automation_policy` is evaluated before issue work starts, before configured shell commands run, and before PR creation when changed paths are known. It should express what the worker may do without a person.

Use policy to enforce:

- Required labels such as `ready`.
- Blocking labels such as `do-not-automate`, `needs-human-input`, and `blocked`.
- Allowed and protected paths.
- Exact command allowlists for build, test, dev server, setup, smoke test, and preview discovery commands.
- Session limits and budgets.
- Human gates for auth, billing, production deploys, dependency upgrades, schemas, secrets, migrations, destructive content, and ambiguous requests.

When Alpha Loop blocks work, it labels or comments on the issue, records the decision in the session manifest, and emits lifecycle event metadata. A human should either clarify the issue, adjust labels, split the work, or intentionally change policy in a reviewed PR.

## Event Destinations

Lifecycle events are JSON first. Destinations can log locally, post webhooks, or run local commands with event JSON on stdin. See [Hosted Lifecycle Events](hosted-events.md) for the full event list and payload details.

### Slack

Set `SLACK_WEBHOOK_URL` in the daemon environment.

```yaml
events:
  destinations:
    slack_qa:
      type: webhook
      events: [qa.requested, human_input.requested, session.failed]
      url_env: SLACK_WEBHOOK_URL
      format: slack
      retries: 1
      timeout: 10
      required: false
```

### Microsoft Teams

Set `TEAMS_WEBHOOK_URL` to an incoming webhook URL.

```yaml
events:
  destinations:
    teams_status:
      type: webhook
      events: [session.started, qa.requested, session.completed, session.failed]
      url_env: TEAMS_WEBHOOK_URL
      format: teams
      retries: 1
      timeout: 10
      required: false
```

### Discord

Set `DISCORD_WEBHOOK_URL` to a Discord webhook URL.

```yaml
events:
  destinations:
    discord_alerts:
      type: webhook
      events: [human_input.requested, feedback.received, session.failed]
      url_env: DISCORD_WEBHOOK_URL
      format: discord
      retries: 1
      timeout: 10
      required: false
```

### Email Via Script

Command destinations receive canonical event JSON on stdin and run from the repo root.

```yaml
events:
  destinations:
    email_script:
      type: command
      events: [qa.requested, session.failed]
      command: ./scripts/email-alpha-loop-event.sh
      stdin: json
      timeout: 60
      required: false
```

Example script:

```bash
#!/usr/bin/env bash
set -euo pipefail

event_json="$(cat)"
subject="$(node -e "const e=JSON.parse(process.argv[1]); console.log('Alpha Loop '+e.type+' '+(e.issue?.number ? '#'+e.issue.number : ''))" "$event_json")"
printf '%s\n' "$event_json" | mail -s "$subject" team@example.com
```

### Custom Webhook

Use `format: json` for the canonical payload. If `secret_env` is set, Alpha Loop signs the JSON body with HMAC-SHA256 and sends `x-alpha-loop-signature`.

```yaml
events:
  destinations:
    internal_service:
      type: webhook
      events: ['*']
      url_env: ALPHA_LOOP_EVENTS_URL
      secret_env: ALPHA_LOOP_EVENTS_SECRET
      format: json
      retries: 2
      timeout: 10
      required: true
```

For hosted mode, keep at least one local `log` destination enabled so you have an audit trail even if chat or webhook delivery is down.

## Feedback Ingestion and Resume

GitHub comments are the canonical feedback source. External systems should adapt their message format into Alpha Loop feedback events, then let Alpha Loop write a normalized GitHub comment and idempotency record.

Manual ingestion from a file:

```bash
pnpm exec alpha-loop feedback ingest --body-file feedback.json --request-resume
```

Adapter ingestion through the daemon:

```yaml
daemon:
  mode: full
  feedback_poll_command: ./scripts/poll-feedback.sh
```

The adapter command may return one JSON object, a JSON array, or newline-delimited JSON. Include stable ids such as `externalEventId`, `externalThreadId`, and `externalMessageId` so repeated deliveries are ignored.

Typical payload fields:

```json
{
  "repo": "owner/repo",
  "issueNumber": 42,
  "prNumber": 108,
  "sessionId": "session-20260531-120000",
  "source": "slack",
  "externalEventId": "slack:T123:C456:1710000000.000100",
  "externalThreadId": "C456:1710000000.000100",
  "author": "jane@example.com",
  "body": "The mobile nav still overlaps the logo. Please fix and resume.",
  "classification": "change-request",
  "resumeRequested": true
}
```

To resume a specific paused issue directly:

```bash
pnpm exec alpha-loop resume --issue 42
```

`resume --issue` looks for the matching durable session, reuses the saved issue/session context, and resumes from the associated branch/worktree when possible. If a worktree is missing but the branch still exists, Alpha Loop can recreate enough state to open recovery PRs.

Paused worktrees are intentionally retained by default when `session_retention.paused_worktree_days: 0`. Do not delete `.worktrees/agent-issue-*` for paused, waiting-for-feedback, or QA-requested sessions unless you are intentionally abandoning that work.

## Human QA Handoff

For web/app repos, the `web_app` profile records the material a human needs to decide whether the PR is shippable:

- Build, test, smoke test, and browser verification results.
- Preview URL from `web_app.preview.url` or `web_app.preview.command`.
- Screenshot paths under `.alpha-loop/sessions/<session>/screenshots/issue-<N>/`.
- Browser result JSON under `.alpha-loop/sessions/<session>/web-app-verification/issue-<N>.json`.
- Console and network error summaries.
- A QA checklist in the PR, session history, and `qa.requested` event payload.

Human QA should check the PR diff, preview URL, screenshots, responsive states, core user flows, and any CMS/content assumptions. If QA finds a problem, comment on the GitHub issue or PR. If the feedback comes from chat or a website form, ingest it so GitHub receives the canonical comment and the session can resume.

## Running the Daemon

Foreground command for a supervised process:

```bash
cd /srv/alpha-loop/sites/example.com
pnpm exec alpha-loop daemon
```

Useful modes:

```bash
pnpm exec alpha-loop daemon --mode full
pnpm exec alpha-loop daemon --mode triage-only
pnpm exec alpha-loop daemon --mode feedback-only
pnpm exec alpha-loop daemon --mode run-only
pnpm exec alpha-loop daemon --once-tick
```

### systemd Example

```ini
[Unit]
Description=Alpha Loop daemon for example.com
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=alpha-loop
WorkingDirectory=/srv/alpha-loop/sites/example.com
Environment=NODE_ENV=production
Environment=GH_TOKEN=replace-with-secret-manager
Environment=OPENAI_API_KEY=replace-with-secret-manager
Environment=SLACK_WEBHOOK_URL=replace-with-secret-manager
ExecStart=/usr/bin/pnpm exec alpha-loop daemon
Restart=on-failure
RestartSec=30
KillSignal=SIGINT
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
```

Prefer systemd drop-in files or a secret manager for real secrets instead of hard-coded values.

### Docker Example

```Dockerfile
FROM node:22-bookworm
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["pnpm", "exec", "alpha-loop", "daemon"]
```

Run with persistent mounts for `.alpha-loop/sessions`, `.alpha-loop/feedback`, `.alpha-loop/auth`, and `.worktrees` if the container filesystem is ephemeral.

## Logs, Health Checks, and History

Primary places to inspect:

- `.alpha-loop/sessions/<session>/session.json` - durable session manifest with issue, branch, worktree, PR, stage, status, prompts, transcripts, and logs.
- `.alpha-loop/sessions/<session>/logs/events.jsonl` - lifecycle event delivery attempts.
- `.alpha-loop/sessions/<session>/screenshots/` - browser screenshots.
- `.alpha-loop/sessions/<session>/web-app-verification/` - browser verification JSON.
- `.alpha-loop/feedback/ingested-events/` - idempotency records for external feedback.
- Your service supervisor logs, such as `journalctl -u alpha-loop-example`.

Commands:

```bash
pnpm exec alpha-loop history
pnpm exec alpha-loop history <session>
pnpm exec alpha-loop history <session> --qa
pnpm exec alpha-loop daemon --once-tick
```

Use `daemon.health` events as the lightweight heartbeat. Alert when health events stop, when `session.failed` fires, or when paused sessions exceed your policy.

## Pausing, Cleanup, and Budgets

Pause new automation by either stopping the daemon or applying `do-not-automate` / `blocked` to issues that should not run. Pause a specific active request by commenting with the needed clarification or applying `needs-human-input`.

Budget controls live in `automation_policy`:

- `max_active_sessions`
- `max_paused_sessions`
- `max_issues_per_session`
- `max_session_minutes`
- `max_session_cost_usd`
- `max_issue_cost_usd`

Worktree cleanup is controlled separately:

```yaml
session_retention:
  paused_worktree_days: 0
  completed_worktree_days: 30
```

Run cleanup manually after reviewing what will be removed:

```bash
pnpm exec alpha-loop history --clean
```

Keep paused/waiting/QA worktrees until the issue is resolved, intentionally abandoned, or recovered into a PR.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Daemon does not pick an issue | Confirm the issue is open, has `ready`, lacks block labels, is not an epic unless targeted as an epic, and passes `automation_policy`. |
| Work is immediately paused | Read the GitHub comment and session manifest policy decision. Protected paths, missing labels, blocked categories, and command allowlists are common causes. |
| GitHub operations fail | Run `gh auth status` as the service user. Check repo permissions, `GH_TOKEN`, branch protection, and whether the token can create PRs and labels. |
| Build or test command is blocked | Add the exact command to `automation_policy.allowed_commands` in a reviewed PR, or change `web_app`/top-level commands to an allowed command. |
| Browser screenshots are missing | Verify the dev server command, `web_app.dev_url`, Playwright/browser dependencies, and whether the app needs `alpha-loop auth`. |
| Preview URL is missing | Check `web_app.preview.command`, make sure it is in `allowed_commands`, and confirm it prints one `http` or `https` URL. |
| Chat feedback creates duplicates | Ensure adapter payloads include a stable `externalEventId`; inspect `.alpha-loop/feedback/ingested-events/`. |
| `resume --issue` cannot find work | Inspect `alpha-loop history`, branch names, `.alpha-loop/sessions/<session>/session.json`, and whether paused worktrees were cleaned. |
| Daemon says another instance is running | Check `.alpha-loop/daemon.lock`, the recorded PID, and `daemon.lock.stale_after`. Do not run two full daemons against one checkout. |
| Costs are too high | Lower `max_session_cost_usd` and `max_issue_cost_usd`, narrow `ready` usage, shorten session limits, and consider routing cheaper models for non-critical stages. |

## Setup Checklist

- [ ] Repo-local Alpha Loop installed with pnpm.
- [ ] `.alpha-loop.yaml` committed and reviewed.
- [ ] GitHub CLI authenticated as the automation identity.
- [ ] Agent CLI authenticated and runnable by the service user.
- [ ] Browser dependencies installed and `alpha-loop auth` run if needed.
- [ ] Labels and issue templates created by `alpha-loop init`.
- [ ] `ready` label policy explained to the team.
- [ ] Safe `automation_policy` configured for the repo.
- [ ] At least one local log destination configured.
- [ ] Slack, Teams, Discord, email script, or custom webhook destinations tested if used.
- [ ] Feedback adapter tested with `alpha-loop feedback ingest`.
- [ ] `run --issue <N> --dry-run`, `run --issue <N>`, and `daemon --once-tick` completed before continuous daemon startup.
