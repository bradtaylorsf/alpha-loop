# Hosted Automation Policy

`automation_policy` defines what hosted Alpha Loop may automate without a human. The policy is evaluated before an issue starts, before configured shell commands run, and before PR creation by checking changed paths.

Blocked work is labeled `needs-human-input`, receives a GitHub comment with the reason, and records the decision in the session manifest plus lifecycle event payloads.

## Marketing Site Starter

Use this for content and presentation changes where code execution should stay narrow.

```yaml
automation_policy:
  require_labels: [ready]
  block_labels: [do-not-automate, needs-human-input]
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

## Web App Starter

Use this for small product changes while keeping production operations and schema-risky work gated.

```yaml
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
    - tests/**
    - public/**
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

## Notes

- `allowed_commands` matches exact configured commands and subcommands. `pnpm install` also allows `pnpm install --frozen-lockfile`.
- Leave `allowed_paths` empty to allow any path that is not protected.
- Put schema, migration, dependency, secret, billing, auth, and production deploy work behind `require_human_for` so the worker pauses before implementation.
- Use `do-not-automate` for permanently manual work and `needs-human-input` for work that can resume after clarification.
