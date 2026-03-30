# Alpha Loop

Agent-agnostic automated development loop. Pulls issues from your GitHub project board, implements them with an AI coding agent, runs tests, reviews the code, creates PRs, and optionally auto-merges -- then moves to the next issue.

**The Loop:** Plan (GitHub Issues) -> Build (AI Agent) -> Test -> Review -> Ship (PR)

## Quick Start

### Prerequisites

- [Node.js 22+](https://nodejs.org/) (via nvm: `nvm install 22`)
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [GitHub CLI](https://cli.github.com/) (`brew install gh && gh auth login`)
- [Claude Code](https://claude.ai/code) or another AI coding CLI
- [jq](https://jqlang.github.io/jq/) (`brew install jq`)

### Install

```bash
git clone https://github.com/bradtaylorsf/alpha-loop.git
cd alpha-loop
nvm use
pnpm install
```

### Run the Loop

```bash
# Process one issue from your project board
MODEL=opus bash scripts/loop.sh --once

# Process all Todo issues
MODEL=opus bash scripts/loop.sh --once

# Dry run (preview, no changes)
DRY_RUN=true bash scripts/loop.sh --once

# Auto-merge PRs to a session branch
AUTO_MERGE=true MODEL=opus bash scripts/loop.sh --once

# Auto-merge directly to master
AUTO_MERGE=true MERGE_TO=master MODEL=opus bash scripts/loop.sh --once
```

## How It Works

1. The loop reads your **GitHub Project board** for items in the `Todo` column
2. For each item (in board order -- you control priority by dragging):
   - Creates an isolated **git worktree** so work doesn't conflict
   - Invokes the AI agent (`claude -p`) with the issue requirements
   - Runs **tests** (`pnpm test`) -- retries up to 3 times if they fail
   - Runs a **code review** agent that fixes issues it finds
   - Creates a **PR** with the review report and test results
   - Optionally **auto-merges** to your target branch
   - Updates the **project board** (Todo -> In progress -> Done)
   - Updates **issue labels** and posts a comment
   - Cleans up the worktree
3. Moves to the next issue

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REPO` | `bradtaylorsf/alpha-loop` | GitHub repo (`owner/name`) |
| `REPO_OWNER` | `bradtaylorsf` | GitHub username (for project board) |
| `PROJECT_NUM` | `2` | GitHub Project number |
| `MODEL` | `sonnet` | AI model for implementation |
| `REVIEW_MODEL` | `sonnet` | AI model for code review |
| `MAX_TURNS` | `30` | Max agent turns per issue |
| `POLL_INTERVAL` | `60` | Seconds between polls (continuous mode) |
| `BASE_BRANCH` | `master` | Branch to create PRs against |
| `MAX_ISSUES` | `0` | Max issues per run (0 = unlimited) |
| `MAX_TEST_RETRIES` | `3` | Times to retry failing tests |
| `AUTO_MERGE` | `false` | Auto-merge PRs after creation |
| `MERGE_TO` | *(auto)* | Branch to merge into (default: `session/YYYYMMDD-HHMMSS`) |
| `DRY_RUN` | `false` | Preview mode, no changes made |
| `SKIP_TESTS` | `false` | Skip test execution |
| `SKIP_REVIEW` | `false` | Skip code review |
| `SKIP_INSTALL` | `false` | Skip `pnpm install` in worktree |
| `AUTO_CLEANUP` | `true` | Remove worktrees after completion |
| `LABEL_READY` | `ready` | GitHub label that marks issues as ready |

### Example: Run on a different repo

```bash
REPO=myorg/my-app \
REPO_OWNER=myorg \
PROJECT_NUM=1 \
MODEL=opus \
AUTO_MERGE=true \
MERGE_TO=develop \
bash scripts/loop.sh --once
```

## Commands

| Command | Description |
|---------|-------------|
| `pnpm loop` | Run the loop continuously |
| `pnpm loop:once` | Process issues once and exit |
| `pnpm loop:dry` | Dry run |
| `pnpm test` | Run all tests |

## Project Structure

```
alpha-loop/
├── scripts/
│   └── loop.sh              # Main loop script (the product)
├── agents/                  # Agent definitions (YAML+Markdown)
├── learnings/               # Self-improvement data
│   └── proposed-updates/    # Proposed agent prompt updates
├── reference/               # Battle-tested code from previous project
├── .claude/
│   ├── agents/              # Agent definitions for Claude
│   └── skills/              # Reusable skill definitions
├── logs/                    # Per-issue log files
└── config.yaml              # Loop configuration file
```

## GitHub Setup

### Labels

The loop uses these labels to track state (create them on your repo):

| Label | Color | Purpose |
|-------|-------|---------|
| `ready` | green | Issue is ready for the loop to pick up |
| `in-progress` | yellow | Loop is actively working on it |
| `in-review` | blue | PR created, awaiting review |
| `done` | green | Merged and complete |
| `failed` | red | Loop failed after retries |

### Project Board

The loop reads from a GitHub Project board. Items are processed in the order they appear on the board (you control priority by dragging).

The board should have at least these columns:
- **Todo** -- issues the loop will pick up
- **In progress** -- being worked on
- **Done** -- completed

### Issue Format

Issues work best with structured acceptance criteria:

```markdown
## Description
What needs to be done.

## Acceptance Criteria
- [ ] Specific, testable criterion
- [ ] Another criterion

## Test Requirements
- Unit test for X
- API test for Y
```

## Agents & Skills

### Agents

Agent definitions live in `.claude/agents/` as Markdown files with YAML frontmatter:

```yaml
---
name: implementer
description: Implements GitHub issues
tools: Read, Write, Edit, Glob, Grep, Bash
model: opus
skills: api-patterns, testing-patterns, git-workflow
---

# Implementer Agent

Instructions for the agent...
```

### Skills

Skills are reusable checklists and patterns in `.claude/skills/`:

| Skill | Purpose |
|-------|---------|
| `api-patterns` | REST API conventions, Zod validation |
| `api-contracts` | Shared types between backend/frontend |
| `testing-patterns` | TDD flow, test structure, naming |
| `jest-mock-patterns` | Jest mocking gotchas |
| `code-review` | Review checklist, fix-or-defer policy |
| `git-workflow` | Branch naming, conventional commits |
| `implementation-planning` | Two-layer feature planning |
| `security-analysis` | OWASP vulnerability scanning |

## License

MIT
