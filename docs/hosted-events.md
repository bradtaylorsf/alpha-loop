# Hosted Lifecycle Events

Alpha Loop can emit session lifecycle events to logs, webhooks, and local commands. The canonical event is JSON and includes repo, issue, PR, session, branch, worktree, logs, screenshots, preview URL, QA checklist, feedback, web/app browser artifacts, and harness metadata.
When automation policy pauses work, the payload also includes `policy.latestDecision` and the session's `policy.decisions` history.
For `qa.requested` events from `web_app`, the payload includes `screenshots`, `previewUrl`, `qaChecklist`, and `webApp` metadata with `artifactPath`, `browserResultPath`, `consoleErrors`, and `networkErrors`.

Supported events:

- `session.started`
- `session.paused`
- `human_input.requested`
- `qa.requested`
- `feedback.received`
- `session.resumed`
- `session.completed`
- `session.failed`
- `daemon.started`
- `daemon.idle`
- `daemon.health`
- `daemon.work.selected`
- `daemon.work.skipped`
- `daemon.resume.requested`
- `daemon.shutdown`
- `daemon.failed`

## Base Configuration

```yaml
events:
  include_prompt_text: false
  redact:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY
    - SANITY_TOKEN
  destinations:
    audit_log:
      type: log
      events: ['*']
```

`include_prompt_text: false` keeps prompt text out of external payloads while retaining prompt paths and hashes. Redaction entries match object keys and replace matching env var values or literal values anywhere in the event.

## Slack

Set `SLACK_WEBHOOK_URL` in the runtime environment.

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

## Microsoft Teams

Set `TEAMS_WEBHOOK_URL` to an incoming webhook URL.

```yaml
events:
  destinations:
    teams_status:
      type: webhook
      events: [session.started, qa.requested, session.completed, session.failed]
      url_env: TEAMS_WEBHOOK_URL
      format: teams
      required: false
```

## Discord

Set `DISCORD_WEBHOOK_URL` to a Discord webhook.

```yaml
events:
  destinations:
    discord_alerts:
      type: webhook
      events: [human_input.requested, feedback.received, session.failed]
      url_env: DISCORD_WEBHOOK_URL
      format: discord
      required: false
```

## Email Via Script

Command destinations receive canonical event JSON on stdin. The command is run from the repo root.

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

## Custom Web Service

Use `format: json` for the canonical payload. If `secret_env` is set, Alpha Loop signs the JSON body with HMAC-SHA256 and sends it in `x-alpha-loop-signature` as `sha256=<hex>`.

```yaml
events:
  include_prompt_text: false
  redact:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY
    - SANITY_TOKEN
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

Delivery attempts and responses are appended to `.alpha-loop/sessions/<session>/logs/events.jsonl`. In `alpha-loop run --dry-run`, matching destinations are printed and no webhook or command is executed.
