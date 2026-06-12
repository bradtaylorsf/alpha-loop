# Aging Sidekick Hosted Pilot Blueprint

This blueprint documents an Aging Sidekick-style hosted Alpha Loop pilot for a modest Astro and Sanity marketing site. It is a concrete downstream recipe for co-founder website requests, not new Alpha Loop core behavior.

Use it with the [Hosted Alpha Loop Setup Guide](hosted-alpha-loop.md), [Hosted Automation Policy](hosted-policy.md), [Web/App Verification Profile](web-app-profile.md), and [Hosted Lifecycle Events](hosted-events.md).

## Pilot Goal

The pilot proves the request-to-PR-to-feedback loop on safe marketing-site work:

1. A co-founder submits a website request in Slack or a website form.
2. An adapter creates a GitHub issue using the co-founder website request template.
3. A human or triage automation applies labels and confirms the request is inside policy.
4. Hosted Alpha Loop selects one `ready` issue, checks automation policy, and runs `alpha-loop run --issue <N>` or the daemon run tick.
5. Alpha Loop opens a PR, captures preview/browser artifacts, and emits a `qa.requested` event to Slack or a custom service.
6. A human reviews the PR preview and sends feedback in GitHub, Slack, or the website form.
7. The feedback adapter calls `alpha-loop feedback ingest`, which creates a canonical GitHub comment and records a resume request.
8. Alpha Loop resumes the same issue with `alpha-loop resume --issue <N>` or a daemon resume tick, or a human opens a follow-up issue for new scope.

The intended first wins are copy, content, generated images, SEO metadata, visual polish, and small Astro component or route changes. Production deploys and risky repo or CMS changes stay human-gated.

## Workflow

### 1. Request Intake

Slack and website requests should become GitHub issues. GitHub remains the source of truth; Slack threads and website submissions are external sources with stable ids.

Minimum normalized issue body:

```markdown
## Request

Update the homepage hero copy to make the caregiver offer clearer.

## Acceptance Criteria

- [ ] Homepage headline mentions support for adult children coordinating care.
- [ ] Primary CTA still points to `/contact`.
- [ ] Mobile and desktop previews have no layout overlap.

## Page or Route

`/`

## Assets and Copy Source

- Copy source: Slack thread `C123:1710000000.000100`
- Assets: none

## QA Notes

Check homepage desktop and mobile screenshots.

## Risk Flags

- [ ] Sanity schema
- [ ] Auth
- [ ] Analytics
- [ ] Dependency upgrade
- [ ] Secrets
- [ ] Production deploy
- [ ] Major redesign
```

Example adapter command after a Slack shortcut or website submission has been normalized:

```bash
gh issue create \
  --repo aging-sidekick/marketing-site \
  --title "Homepage: clarify caregiver hero copy" \
  --label ready \
  --label copy \
  --label content \
  --body-file issue.md
```

Only apply `ready` automatically when the adapter can prove the request is low-risk and complete. Otherwise create the issue with `needs-human-input` or `human-gated` and let a person triage it.

### 2. Triage and Policy Check

Triage decides whether the issue is safe to automate, needs clarification, or must stay manual.

Safe request:

- Has clear acceptance criteria.
- Names the page, route, Sanity content entry, or component area.
- Provides required copy, assets, screenshots, or source links.
- Has no checked risk flags.
- Has `ready` plus one or more scope labels such as `copy`, `content`, `SEO`, `visual-polish`, `generated-image`, `minor-astro`, or `sanity-content`.

Needs human input:

- Missing copy source, route, acceptance criteria, or asset rights.
- Subjective enough that Alpha Loop would need to invent product direction.
- Apply `needs-human-input`; do not apply `ready`.

Human-gated:

- Sanity schema changes, auth, analytics, dependency upgrades, secrets, production deploys, or major redesigns.
- Apply `human-gated` or `do-not-automate`; do not apply `ready`.

Hosted Alpha Loop enforces the policy labels in `automation_policy.require_labels` and `automation_policy.block_labels` before work starts, and checks protected paths before PR creation.

### 3. Implementation

For an attended first pilot, run exactly one issue:

```bash
pnpm exec alpha-loop run --issue 42
```

For hosted operation, the daemon should run one repo-scoped worker with `max_active_sessions: 1`. It may triage, select safe work, emit events, poll feedback, and resume paused sessions, but it should not merge or deploy production changes automatically.

### 4. PR Preview and QA Handoff

The downstream repo should provide a preview URL through either `web_app.preview.url` or `web_app.preview.command`. Alpha Loop includes the preview, screenshots, browser artifacts, and QA checklist in PR/session output and emits `qa.requested`.

Example QA checklist for Aging Sidekick:

```markdown
## Human QA Checklist

- [ ] Open the PR preview homepage on desktop.
- [ ] Open the PR preview homepage at 390x844 mobile size.
- [ ] Confirm requested copy appears exactly where expected.
- [ ] Confirm CTA links, images, and SEO metadata still match the issue.
- [ ] Leave approval or requested changes in the GitHub issue, PR, Slack thread, or website feedback form.
```

### 5. Feedback and Resume

GitHub comments are canonical. External feedback should be adapted into Alpha Loop feedback payloads with stable external ids.

When feedback requests changes:

```bash
pnpm exec alpha-loop feedback ingest --body-file slack-feedback.json --request-resume
pnpm exec alpha-loop resume --issue 42
```

When feedback is approval-only:

```bash
pnpm exec alpha-loop feedback ingest --body-file qa-approval.json
```

If feedback introduces new scope, create a follow-up issue instead of resuming the current PR unless the scope is small and still inside the current acceptance criteria.

## Recommended Labels

Only the policy labels in this table are enforced by the starter policy. Scope labels help triage, reporting, and issue selection, but do not replace path protection or human review.

| Label | Type | Meaning |
|-------|------|---------|
| `ready` | Policy | The request is complete, accepted, and eligible for automation. |
| `needs-human-input` | Policy | Clarification is required before automation can proceed or resume. |
| `do-not-automate` | Policy | The work is manual and should never be selected by hosted Alpha Loop. |
| `blocked` | Policy | The issue is temporarily blocked by an external dependency. |
| `human-gated` | Policy | The issue may be useful to track, but execution requires a person. |
| `content` | Scope | Edit Sanity-managed content copy, markdown content, or page content. |
| `copy` | Scope | Adjust words without changing product behavior. |
| `SEO` | Scope | Edit metadata, titles, descriptions, sitemap copy, or structured content in allowed files. |
| `visual-polish` | Scope | Small spacing, responsive, contrast, image placement, or component polish. |
| `generated-image` | Scope | Generate or replace marketing imagery in `public/` with reviewable assets. |
| `minor-astro` | Scope | Small Astro component, route, layout, or static rendering changes. |
| `sanity-content` | Scope | Edit content records or content fixtures, not schema definitions. |
| `in-progress` | State | Alpha Loop is actively working. |
| `in-review` | State | A PR exists and needs human review or QA. |
| `failed` | State | Alpha Loop hit an unrecoverable error or exhausted retries. |

The starter policy blocks `needs-human-input`, `do-not-automate`, `blocked`, and `human-gated`. Do not rely on labels like `SEO` or `minor-astro` as guardrails by themselves.

## Co-Founder Website Request Template

Place this in the downstream repo as `.github/ISSUE_TEMPLATE/cofounder-website-request.yml`.

```yaml
name: Co-founder website request
description: Request a safe Aging Sidekick marketing-site update for Alpha Loop
title: "[Website] "
labels: ["needs-human-input"]
body:
  - type: textarea
    id: request
    attributes:
      label: Request
      description: Describe the website change in plain language.
      placeholder: Update the homepage hero copy so caregivers understand the offer faster.
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      description: List concrete checks a reviewer can verify.
      placeholder: |
        - [ ] Homepage headline mentions adult children coordinating care.
        - [ ] Primary CTA still points to /contact.
        - [ ] Mobile preview has no text overlap.
    validations:
      required: true
  - type: input
    id: route
    attributes:
      label: Page or route
      placeholder: /
    validations:
      required: true
  - type: textarea
    id: assets
    attributes:
      label: Assets and copy source
      description: Link Slack threads, docs, screenshots, Sanity entries, or approved images.
      placeholder: Slack thread C123:1710000000.000100; use copy from the pinned message.
  - type: textarea
    id: qa
    attributes:
      label: QA notes
      description: Name the preview states that matter.
      placeholder: Check desktop homepage, mobile homepage, and CTA link.
  - type: checkboxes
    id: safe_scope
    attributes:
      label: Safe automation scope
      options:
        - label: Copy update
        - label: Content update
        - label: Generated image
        - label: SEO metadata
        - label: Visual polish
        - label: Minor Astro change
        - label: Sanity content update without schema changes
  - type: checkboxes
    id: risk_flags
    attributes:
      label: Human-gated risk flags
      description: If any of these apply, use human-gated or do-not-automate instead of ready.
      options:
        - label: Sanity schema change
        - label: Auth or permissions
        - label: Analytics or tracking configuration
        - label: Dependency upgrade
        - label: Secrets or credentials
        - label: Production deploy
        - label: Major redesign
```

Recommended triage rule:

- Default new issues to `needs-human-input`.
- Replace `needs-human-input` with `ready` only after a person or trusted adapter confirms the request is complete and safe.
- Add exactly the scope labels that describe the work.
- Add `human-gated` or `do-not-automate` when any risk flag is checked.

## Safe Automation Policy

This policy is for a typical Astro marketing site with Sanity content. Adjust paths to the real downstream repo before enabling the daemon.

```yaml
web_app:
  setup_command: pnpm install --frozen-lockfile
  build_command: pnpm build
  test_command: pnpm test
  dev_command: pnpm dev -- --host 127.0.0.1
  dev_url: http://127.0.0.1:4321
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
  block_labels: [do-not-automate, needs-human-input, blocked, human-gated]
  max_active_sessions: 1
  max_paused_sessions: 10
  max_issues_per_session: 1
  max_session_minutes: 60
  max_session_cost_usd: 15
  max_issue_cost_usd: 5
  allowed_paths:
    - src/pages/**
    - src/components/**
    - src/layouts/**
    - src/content/**
    - content/**
    - public/**
    - tests/**
  protected_paths:
    - package.json
    - pnpm-lock.yaml
    - package-lock.json
    - yarn.lock
    - .github/workflows/**
    - .env*
    - sanity/schema/**
    - sanity/schemas/**
    - studio/schema/**
    - studio/schemas/**
    - src/lib/auth/**
    - src/middleware/**
    - src/pages/api/**
    - scripts/deploy/**
    - netlify.toml
    - vercel.json
  allowed_commands:
    - pnpm install
    - pnpm install --frozen-lockfile
    - pnpm test
    - pnpm build
    - pnpm dev -- --host 127.0.0.1
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
```

Safe initial automation scope:

- Copy updates in Astro pages, components, and Sanity content files.
- Content additions and edits in approved content directories.
- Generated marketing images saved under `public/` with human QA before merge.
- SEO title, description, Open Graph, sitemap content, and structured copy changes in allowed files.
- Visual fixes such as spacing, responsive layout, contrast, image placement, and small component polish.
- Minor Astro changes that do not alter auth, APIs, data migrations, deployment, analytics, or build tooling.

Human-gated scope:

- Sanity schema changes, migrations, or Studio structure changes.
- Auth, permissions, sessions, middleware, or protected routes.
- Analytics, tracking pixels, consent tooling, or event taxonomy changes. The current Alpha Loop policy categories do not include an `analytics` semantic gate, so protect analytics paths and use `human-gated`.
- Dependency upgrades, lockfile changes, package manager changes, and runtime version changes.
- Secrets, credentials, API tokens, environment variables, or production CMS tokens.
- Production deploys, deploy scripts, hosting config, domain/DNS, and rollback operations.
- Major redesigns, brand system changes, or subjective direction-setting work.

## Event Destinations

Use Slack for human-readable QA handoff and a custom JSON webhook when a website service or internal dashboard needs canonical event data.

```yaml
events:
  include_prompt_text: false
  redact:
    - OPENAI_API_KEY
    - ANTHROPIC_API_KEY
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
    website_events:
      type: webhook
      events: [qa.requested, feedback.received, feedback.classified, session.resume_requested, session.completed, session.failed]
      url_env: AGING_SIDEKICK_ALPHA_LOOP_EVENTS_URL
      secret_env: AGING_SIDEKICK_ALPHA_LOOP_EVENTS_SECRET
      format: json
      retries: 2
      timeout: 10
      required: false
```

Example `qa.requested` payload shape delivered to the custom service:

```json
{
  "type": "qa.requested",
  "repo": "aging-sidekick/marketing-site",
  "issue": {
    "number": 42,
    "title": "Homepage: clarify caregiver hero copy"
  },
  "pr": {
    "number": 108,
    "url": "https://github.com/aging-sidekick/marketing-site/pull/108"
  },
  "session": {
    "id": "session-20260531-120000",
    "name": "20260531-120000"
  },
  "previewUrl": "https://aging-sidekick-git-alpha-loop-42.vercel.app",
  "screenshots": [
    ".alpha-loop/sessions/session-20260531-120000/screenshots/issue-42/home-desktop.png",
    ".alpha-loop/sessions/session-20260531-120000/screenshots/issue-42/home-mobile.png"
  ],
  "qaChecklist": [
    "Open the PR preview homepage on desktop.",
    "Open the PR preview homepage at 390x844 mobile size.",
    "Confirm requested copy appears exactly where expected."
  ],
  "webApp": {
    "browserResultPath": ".alpha-loop/sessions/session-20260531-120000/browser-result.json",
    "consoleErrors": [],
    "networkErrors": []
  },
  "harness": {
    "agent": "codex",
    "command": "alpha-loop run --issue 42",
    "transcriptPath": ".alpha-loop/sessions/session-20260531-120000/transcript.jsonl"
  }
}
```

## Feedback Ingestion

The Slack app or website service should convert user messages into Alpha Loop feedback payloads. It should preserve the GitHub issue number or PR number, source, author, external ids, body, attachments, timestamp, classification, and whether resume is requested.

Slack change request example:

```json
{
  "repo": "aging-sidekick/marketing-site",
  "issueNumber": 42,
  "prNumber": 108,
  "sessionId": "session-20260531-120000",
  "source": "slack",
  "externalEventId": "slack:T123:C456:1710000000.000200",
  "externalThreadId": "C456:1710000000.000100",
  "externalMessageId": "1710000000.000200",
  "author": "cofounder@example.com",
  "body": "QA failed: the mobile headline wraps awkwardly. Please shorten it and resume.",
  "attachments": [
    {
      "url": "https://files.slack.com/files-pri/T123-F456/mobile-homepage.png",
      "title": "Mobile screenshot"
    }
  ],
  "eventTimestamp": "2026-05-31T19:00:00Z",
  "classification": "change_request",
  "resumeRequested": true
}
```

Website approval example:

```json
{
  "repo": "aging-sidekick/marketing-site",
  "issueNumber": 42,
  "prNumber": 108,
  "source": "website-form",
  "externalEventId": "website-feedback:42:approve:20260531T190500Z",
  "externalThreadId": "qa-form-42",
  "externalMessageId": "approve-20260531T190500Z",
  "author": "ops@example.com",
  "body": "Approved after checking desktop and mobile previews.",
  "eventTimestamp": "2026-05-31T19:05:00Z",
  "classification": "approval",
  "resumeRequested": false
}
```

Normalized GitHub comment created by `alpha-loop feedback ingest`:

```markdown
## Alpha Loop Feedback Received

Source: `slack`
Classification: `change_request`
Author: cofounder@example.com
Session: `20260531-120000`
Issue: #42
PR: #108
External thread: `C456:1710000000.000100`
External message: `1710000000.000200`
Event timestamp: 2026-05-31T19:00:00Z

### Body

QA failed: the mobile headline wraps awkwardly. Please shorten it and resume.

### Attachments
- [Mobile screenshot](https://files.slack.com/files-pri/T123-F456/mobile-homepage.png)
```

Exact local ingestion and resume commands:

```bash
pnpm exec alpha-loop feedback ingest --body-file slack-feedback.json --request-resume
pnpm exec alpha-loop resume --issue 42
```

Daemon feedback polling shape:

```yaml
daemon:
  mode: full
  feedback_poll_command: ./scripts/poll-aging-sidekick-feedback.sh
```

The poll command may print one JSON object, a JSON array, or newline-delimited JSON. It should emit the same payload shape shown above, return only unprocessed external messages, and rely on `externalEventId` for idempotency.

## Downstream Versus Core

Reusable Alpha Loop capabilities:

| Capability | Owner |
|------------|-------|
| `alpha-loop run --issue <N>` targeted execution | Alpha Loop core |
| Durable session manifests and paused worktree retention | Alpha Loop core |
| Human feedback state machine and `resume --issue <N>` | Alpha Loop core |
| `feedback ingest` payload contract, idempotency, and GitHub comments | Alpha Loop core |
| Lifecycle event destinations for logs, Slack formatting, and JSON webhooks | Alpha Loop core |
| `automation_policy` labels, path protection, command allowlists, budgets, and human gates | Alpha Loop core |
| `web_app` verification, screenshots, preview URL discovery, and QA handoff fields | Alpha Loop core |

Aging Sidekick downstream setup:

| Setup | Owner |
|-------|-------|
| Slack shortcut, Slack app, or website form that creates GitHub issues | Aging Sidekick repo/service |
| Co-founder issue template, labels, and triage conventions | Aging Sidekick repo |
| Exact Astro, Sanity, content, asset, analytics, and deploy paths | Aging Sidekick repo |
| Preview URL discovery script such as `./scripts/get-preview-url.sh` | Aging Sidekick repo |
| Event destination secrets and Slack/channel routing | Aging Sidekick hosting environment |
| Feedback polling adapter such as `./scripts/poll-aging-sidekick-feedback.sh` | Aging Sidekick repo/service |
| Human approval for schema, auth, analytics, dependency, secret, production deploy, and redesign work | Aging Sidekick team |

Alpha Loop should not become a production Slack app, website submission backend, CMS migration tool, or deploy system for this pilot. Those integrations can stay thin adapters around GitHub issues, event webhooks, feedback ingestion, and resume.
