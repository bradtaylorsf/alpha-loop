# Alpha Loop

Agent-agnostic automated development loop. Pulls issues from your GitHub project board, implements them with an AI coding agent, runs tests, reviews the code, and creates PRs — then moves to the next issue.

**The Loop:** Plan (GitHub Issues) → Build (AI Agent) → Test → Review → Ship (PR)

## Installation

```bash
# Install globally
npm install -g alpha-loop

# Or run directly
npx alpha-loop
```

## Quick Start

```bash
# 1. Initialize config in your project
cd your-project
alpha-loop init

# 2. Edit .alpha-loop.yaml with your repo and agent settings

# 3. Run the loop on one issue
alpha-loop run --once

# 4. Run in dry-run mode (preview, no changes)
alpha-loop run --once --dry-run
```

## Requirements

- **Node.js 20+**
- **git** — for worktree isolation
- **[GitHub CLI](https://cli.github.com/)** (`gh`) — authenticated (`gh auth login`)
- **AI agent CLI** — one of:
  - [Claude Code](https://claude.ai/code) (`claude`)
  - [Codex](https://github.com/openai/codex) (`codex`)
  - [OpenCode](https://github.com/sst/opencode) (`opencode`)

## Commands

| Command | Description |
|---------|-------------|
| `alpha-loop init` | Create `.alpha-loop.yaml` config template |
| `alpha-loop run` | Run the loop continuously |
| `alpha-loop run --once` | Process one issue and exit |
| `alpha-loop run --dry-run` | Preview without making changes |
| `alpha-loop scan` | Generate/refresh project context |
| `alpha-loop vision` | Interactive project vision setup |
| `alpha-loop auth` | Save authenticated browser state |
| `alpha-loop history` | View session history |
| `alpha-loop history <name>` | View a specific session |
| `alpha-loop history <name> --qa` | Show QA checklist for session |
| `alpha-loop history --clean` | Remove old session data |

### Run Options

```bash
alpha-loop run [options]

Options:
  --once              Process one issue and exit
  --dry-run           Preview without changes
  --model <model>     AI model to use
  --skip-tests        Skip test execution
  --skip-review       Skip code review
  --skip-learn        Skip learning extraction
  --auto-merge        Auto-merge PRs to session branch
  --merge-to <branch> Use existing branch instead of creating session branch
```

## Configuration

Running `alpha-loop init` creates a `.alpha-loop.yaml` file:

```yaml
repo: owner/repo-name
baseBranch: main
agent: claude
model: sonnet
maxTurns: 30
maxTestRetries: 3
testCommand: npm test
labels:
  ready: ready
  inProgress: in-progress
  inReview: in-review
  done: done
  failed: failed
```

### Environment Variables

Configuration can also be set via environment variables:

| Variable | Description |
|----------|-------------|
| `REPO` | GitHub repo (`owner/name`) |
| `MODEL` | AI model for implementation |
| `BASE_BRANCH` | Branch to create PRs against |
| `MAX_TURNS` | Max agent turns per issue |
| `MAX_TEST_RETRIES` | Times to retry failing tests |
| `DRY_RUN` | Set to `true` for preview mode |
| `SKIP_TESTS` | Set to `true` to skip tests |
| `SKIP_REVIEW` | Set to `true` to skip review |

## How It Works

1. Reads your **GitHub Project board** for issues labeled `ready`
2. For each issue (in board order — you control priority):
   - Creates an isolated **git worktree** so work doesn't conflict
   - Generates a **prompt** with issue requirements, project context, and learnings
   - Invokes the **AI agent** to implement the changes
   - Runs **tests** — retries up to 3 times if they fail
   - Runs a **code review** agent that fixes issues it finds
   - Creates a **PR** with the review report and test results
   - Optionally **auto-merges** to your target branch
   - Updates **issue labels** and posts a comment
   - Extracts **learnings** for future sessions
   - Cleans up the worktree
3. Moves to the next issue

## GitHub Setup

### Labels

Create these labels on your repo:

| Label | Purpose |
|-------|---------|
| `ready` | Issue is ready for the loop |
| `in-progress` | Loop is actively working on it |
| `in-review` | PR created, awaiting review |
| `done` | Merged and complete |
| `failed` | Loop failed after retries |

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
- Integration test for Y
```

## Development

```bash
git clone https://github.com/bradtaylorsf/alpha-loop.git
cd alpha-loop
pnpm install
pnpm build
pnpm test

# Run in development mode
pnpm dev -- run --once --dry-run
```

## License

MIT
