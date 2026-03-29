#!/usr/bin/env bash
###############################################################################
# Agent Issue Loop
# ================
# Automated pipeline: GitHub Issue -> Implement -> Test -> Review -> PR
#
# Usage:
#   bash scripts/loop.sh              # Run continuously
#   bash scripts/loop.sh --once       # Process one issue and exit
#   DRY_RUN=true bash scripts/loop.sh # Preview without changes
#
# Configuration (env vars):
#   REPO            - GitHub repo (default: bradtaylorsf/alpha-loop)
#   MODEL           - Claude model for implementation (default: opus)
#   REVIEW_MODEL    - Claude model for review (default: opus)
#   MAX_TURNS       - Max turns per implementation (default: 30)
#   POLL_INTERVAL   - Seconds between polls (default: 60)
#   DRY_RUN         - Preview mode, no changes (default: false)
#   BASE_BRANCH     - Branch to create PRs against (default: master)
#   LOG_DIR         - Log directory (default: logs)
#   MAX_ISSUES      - Max issues per run, 0=unlimited (default: 0)
#   SKIP_TESTS      - Skip test execution (default: false)
#   SKIP_REVIEW     - Skip code review (default: false)
#   SKIP_INSTALL    - Skip pnpm install in worktree (default: false)
#   AUTO_CLEANUP    - Auto-remove worktrees (default: true)
#   LABEL_READY     - Label to pick up issues (default: ready)
###############################################################################

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REPO="${REPO:-bradtaylorsf/alpha-loop}"
REPO_OWNER="${REPO_OWNER:-bradtaylorsf}"
PROJECT_NUM="${PROJECT_NUM:-2}"
MODEL="${MODEL:-opus}"
REVIEW_MODEL="${REVIEW_MODEL:-opus}"
MAX_TURNS="${MAX_TURNS:-30}"
POLL_INTERVAL="${POLL_INTERVAL:-60}"
DRY_RUN="${DRY_RUN:-false}"
BASE_BRANCH="${BASE_BRANCH:-master}"
LOG_DIR="${LOG_DIR:-logs}"
MAX_ISSUES="${MAX_ISSUES:-0}"
SKIP_TESTS="${SKIP_TESTS:-false}"
SKIP_REVIEW="${SKIP_REVIEW:-false}"
SKIP_INSTALL="${SKIP_INSTALL:-false}"
AUTO_CLEANUP="${AUTO_CLEANUP:-true}"
LABEL_READY="${LABEL_READY:-ready}"
MAX_TEST_RETRIES="${MAX_TEST_RETRIES:-3}"
AUTO_MERGE="${AUTO_MERGE:-false}"
MERGE_TO="${MERGE_TO:-}"
RUN_ONCE="${1:-}"

# Session branch: if MERGE_TO is not set, create a session branch for this run
if [[ -z "$MERGE_TO" ]]; then
  SESSION_BRANCH="session/$(date +%Y%m%d-%H%M%S)"
else
  SESSION_BRANCH="$MERGE_TO"
fi

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROMPTS_DIR="$SCRIPT_DIR/prompts"

# State
ISSUES_PROCESSED=0
ORIGINAL_DIR="$(pwd)"

# ---------------------------------------------------------------------------
# Colors & Logging
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC}  $(date '+%H:%M:%S') $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}    $(date '+%H:%M:%S') $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC}  $(date '+%H:%M:%S') $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $(date '+%H:%M:%S') $*"; }
log_step()    { echo -e "${CYAN}[STEP]${NC}  $(date '+%H:%M:%S') ${BOLD}$*${NC}"; }
log_dry()     { echo -e "${YELLOW}[DRY]${NC}   $(date '+%H:%M:%S') $*"; }

# ---------------------------------------------------------------------------
# Prerequisites Check
# ---------------------------------------------------------------------------
check_prerequisites() {
  local missing=0

  if ! command -v gh &>/dev/null; then
    log_error "gh CLI not found. Install: https://cli.github.com/"
    missing=1
  fi

  if ! command -v claude &>/dev/null; then
    log_error "claude CLI not found. Install: https://claude.ai/code"
    missing=1
  fi

  if ! command -v git &>/dev/null; then
    log_error "git not found."
    missing=1
  fi

  if ! command -v jq &>/dev/null; then
    log_error "jq not found. Install: brew install jq"
    missing=1
  fi

  # Check gh auth
  if ! gh auth status &>/dev/null 2>&1; then
    log_error "gh not authenticated. Run: gh auth login"
    missing=1
  fi

  # Check we're in a git repo
  if ! git rev-parse --git-dir &>/dev/null 2>&1; then
    log_error "Not in a git repository."
    missing=1
  fi

  if [[ $missing -ne 0 ]]; then
    log_error "Prerequisites check failed. Fix the above issues and retry."
    exit 1
  fi

  log_success "Prerequisites check passed"
}

# ---------------------------------------------------------------------------
# Issue Polling - reads from GitHub Project board in priority order
# ---------------------------------------------------------------------------
poll_issues() {
  local limit="${1:-1}"

  # Read from the GitHub Project board -- items come in the board's display order
  # (the order you set by dragging in the project view)
  # Filter to "Todo" status only, then take the first N items
  local project_items
  project_items=$(gh project item-list "$PROJECT_NUM" \
    --owner "$REPO_OWNER" \
    --format json \
    --limit 100 2>/dev/null) || { echo "[]"; return; }

  # Filter to Todo items, extract issue number/title/body in board order, take limit
  echo "$project_items" | jq --argjson limit "$limit" '
    [.items[]
     | select(.status == "Todo")
     | select(.content.type == "Issue")
     | {
         number: .content.number,
         title: .content.title,
         body: .content.body,
         labels: [.labels[]?]
       }
    ] | .[0:$limit]
  ' 2>/dev/null || echo "[]"
}

update_project_status() {
  local issue_num="$1" new_status="$2"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would update project status for #$issue_num to '$new_status'"
    return 0
  fi

  # Find the item ID for this issue in the project
  local item_id
  item_id=$(gh project item-list "$PROJECT_NUM" \
    --owner "$REPO_OWNER" \
    --format json \
    --limit 100 2>/dev/null | jq -r --argjson num "$issue_num" '
      .items[] | select(.content.number == $num) | .id
    ' 2>/dev/null)

  if [[ -z "$item_id" || "$item_id" == "null" ]]; then
    log_warn "Could not find project item for issue #$issue_num"
    return 1
  fi

  # Get the Status field ID and option ID
  local field_data
  field_data=$(gh project field-list "$PROJECT_NUM" \
    --owner "$REPO_OWNER" \
    --format json 2>/dev/null | jq -r --arg status "$new_status" '
      .fields[] | select(.name == "Status") |
      .id as $fid |
      (.options[] | select(.name == $status) | .id) as $oid |
      "\($fid)|\($oid)"
    ' 2>/dev/null)

  local field_id="${field_data%%|*}"
  local option_id="${field_data##*|}"

  if [[ -z "$field_id" || -z "$option_id" ]]; then
    log_warn "Could not resolve project field/option for status '$new_status'"
    return 1
  fi

  # Get project ID
  local project_id
  project_id=$(gh project view "$PROJECT_NUM" \
    --owner "$REPO_OWNER" \
    --format json 2>/dev/null | jq -r '.id')

  gh project item-edit \
    --project-id "$project_id" \
    --id "$item_id" \
    --field-id "$field_id" \
    --single-select-option-id "$option_id" 2>/dev/null || {
    log_warn "Failed to update project status for #$issue_num"
    return 1
  }

  log_info "Project board: #$issue_num -> $new_status"
}

get_issue_field() {
  local issues="$1" index="$2" field="$3"
  echo "$issues" | jq -r ".[$index].$field // empty"
}

get_issue_count() {
  echo "$1" | jq 'length'
}

# ---------------------------------------------------------------------------
# Label Management
# ---------------------------------------------------------------------------
label_issue() {
  local issue_num="$1" add_label="$2" remove_label="${3:-}"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would label issue #$issue_num: +$add_label ${remove_label:+-$remove_label}"
    return 0
  fi

  local args=(--repo "$REPO")
  args+=(--add-label "$add_label")
  [[ -n "$remove_label" ]] && args+=(--remove-label "$remove_label")

  gh issue edit "$issue_num" "${args[@]}" 2>/dev/null || {
    log_warn "Failed to update labels on issue #$issue_num"
    return 1
  }
}

comment_issue() {
  local issue_num="$1" body="$2"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would comment on issue #$issue_num"
    return 0
  fi

  gh issue comment "$issue_num" --repo "$REPO" --body "$body" 2>/dev/null || {
    log_warn "Failed to comment on issue #$issue_num"
    return 1
  }
}

# ---------------------------------------------------------------------------
# Worktree Management
# ---------------------------------------------------------------------------
setup_worktree() {
  local issue_num="$1"
  local branch="agent/issue-${issue_num}"
  # Set global so caller can read it without command substitution
  WORKTREE_PATH="${PROJECT_DIR}/../issue-${issue_num}"

  # Clean up existing worktree if present
  if [[ -d "$WORKTREE_PATH" ]]; then
    log_warn "Worktree already exists at $WORKTREE_PATH, removing..."
    git -C "$PROJECT_DIR" worktree remove "$WORKTREE_PATH" --force 2>/dev/null || true
    git -C "$PROJECT_DIR" branch -D "$branch" 2>/dev/null || true
  fi

  # Delete remote branch if it exists (from a previous failed run)
  git -C "$PROJECT_DIR" push origin --delete "$branch" 2>/dev/null || true

  log_info "Creating worktree at $WORKTREE_PATH (branch: $branch)"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would create worktree: $WORKTREE_PATH"
    return 0
  fi

  # When auto-merging, branch from session branch so each issue builds on previous
  # But only if the session branch actually exists (it's created on first merge)
  local from_branch="$BASE_BRANCH"
  if [[ "$AUTO_MERGE" == "true" && "$SESSION_BRANCH" != "$BASE_BRANCH" ]]; then
    # Check if session branch exists on remote or locally
    if git -C "$PROJECT_DIR" rev-parse --verify "origin/$SESSION_BRANCH" &>/dev/null || \
       git -C "$PROJECT_DIR" rev-parse --verify "$SESSION_BRANCH" &>/dev/null; then
      from_branch="$SESSION_BRANCH"
    fi
  fi

  # Ensure we're on the latest
  git -C "$PROJECT_DIR" fetch origin 2>/dev/null || true

  # Create worktree from the appropriate branch
  git -C "$PROJECT_DIR" worktree add "$WORKTREE_PATH" -b "$branch" "origin/$from_branch" 2>/dev/null || \
  git -C "$PROJECT_DIR" worktree add "$WORKTREE_PATH" -b "$branch" "$from_branch" || {
    log_error "Failed to create worktree"
    return 1
  }

  # Install dependencies unless skipped
  if [[ "$SKIP_INSTALL" != "true" ]]; then
    log_info "Installing dependencies in worktree..."
    (cd "$WORKTREE_PATH" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install) || {
      log_warn "pnpm install had issues, continuing anyway..."
    }
  fi

  log_success "Worktree ready at $WORKTREE_PATH"
}

cleanup_worktree() {
  local issue_num="$1"
  local branch="agent/issue-${issue_num}"
  local worktree="${PROJECT_DIR}/../issue-${issue_num}"

  if [[ "$AUTO_CLEANUP" != "true" ]]; then
    log_info "Skipping worktree cleanup (AUTO_CLEANUP=false)"
    return 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would clean up worktree: $worktree"
    return 0
  fi

  cd "$PROJECT_DIR"

  if [[ -d "$worktree" ]]; then
    log_info "Removing worktree: $worktree"
    git worktree remove "$worktree" --force 2>/dev/null || {
      log_warn "Could not remove worktree cleanly, forcing..."
      rm -rf "$worktree"
      git worktree prune 2>/dev/null || true
    }
  fi

  # Don't delete the branch -- it's needed for the PR
  log_success "Worktree cleaned up"
}

# ---------------------------------------------------------------------------
# Prompt Building -- keep prompts SHORT, let skills/CLAUDE.md do the work
# ---------------------------------------------------------------------------
build_implement_prompt() {
  local issue_num="$1" title="$2" body="$3"

  cat <<EOF
Implement GitHub issue #${issue_num}: ${title}

${body}

After implementing, write tests, run pnpm test to verify, and commit with: git commit -m "feat: ${title} (closes #${issue_num})"
EOF
}

build_review_prompt() {
  local issue_num="$1" title="$2" body="$3"

  cat <<EOF
Review the code changes for issue #${issue_num}: ${title}

Run git diff origin/master...HEAD to see what changed.

Original requirements:
${body}

Review for: correctness vs requirements, security issues, missing tests, code quality.

For any issues you find:
- CRITICAL or WARNING issues: fix them directly, run tests, and commit with "fix: address review findings for #${issue_num}"
- Issues you cannot fix: note them for the output

After fixing, output a brief review summary with what you found and what you fixed.
EOF
}

# ---------------------------------------------------------------------------
# Pipeline Steps
# ---------------------------------------------------------------------------
run_implement() {
  local issue_num="$1" title="$2" body="$3" worktree="$4" log_file="$5"
  local prompt

  log_step "Implementing issue #$issue_num: $title"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run claude -p in $worktree"
    return 0
  fi

  prompt=$(build_implement_prompt "$issue_num" "$title" "$body")

  # Run Claude in the worktree directory
  # CRITICAL: cd into worktree so Claude operates on the isolated copy
  log_info "Agent: claude | Model: $MODEL | Max turns: $MAX_TURNS | CWD: $worktree"

  (cd "$worktree" && echo "$prompt" | claude -p \
    --model "$MODEL" \
    --max-turns "$MAX_TURNS" \
    --dangerously-skip-permissions \
    --verbose \
    --output-format text \
    2>&1) | tee -a "$log_file"

  local exit_code=${PIPESTATUS[0]:-$?}

  # Check if any changes were made
  local changed_files
  changed_files=$(cd "$worktree" && git status --porcelain | wc -l | tr -d ' ')

  if [[ "$changed_files" -eq 0 ]]; then
    log_warn "No files changed after implementation"
    # Check if claude already committed
    local new_commits
    new_commits=$(cd "$worktree" && git log "origin/$BASE_BRANCH..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$new_commits" -eq 0 ]]; then
      log_error "Implementation produced no changes and no commits"
      return 1
    else
      log_info "Implementation created $new_commits commit(s)"
    fi
  else
    log_info "$changed_files files changed"
    # If claude didn't commit, we commit for it
    local uncommitted
    uncommitted=$(cd "$worktree" && git status --porcelain | wc -l | tr -d ' ')
    if [[ "$uncommitted" -gt 0 ]]; then
      log_info "Committing uncommitted changes..."
      (cd "$worktree" && git add -A && git commit -m "feat: implement issue #${issue_num} - ${title}

Automated implementation by agent loop.
Closes #${issue_num}") || {
        log_error "Failed to commit changes"
        return 1
      }
    fi
  fi

  log_success "Implementation complete"
  return 0
}

run_tests() {
  local worktree="$1" log_file="$2"
  local test_output=""
  local test_passed=true

  if [[ "$SKIP_TESTS" == "true" ]]; then
    log_info "Skipping tests (SKIP_TESTS=true)"
    echo "Tests skipped"
    return 0
  fi

  log_step "Running tests in worktree"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run pnpm test:unit && pnpm test:api"
    echo "Tests skipped (dry run)"
    return 0
  fi

  # Run unit tests
  log_info "Running unit tests..."
  if (cd "$worktree" && pnpm test:unit 2>&1 | tee -a "$log_file"); then
    log_success "Unit tests passed"
  else
    log_warn "Unit tests had failures"
    test_passed=false
  fi

  # Run API tests
  log_info "Running API tests..."
  if (cd "$worktree" && pnpm test:api 2>&1 | tee -a "$log_file"); then
    log_success "API tests passed"
  else
    log_warn "API tests had failures"
    test_passed=false
  fi

  if [[ "$test_passed" == "false" ]]; then
    log_error "Some tests failed"
    return 1
  fi

  log_success "All tests passed"
  return 0
}

run_review() {
  local issue_num="$1" title="$2" body="$3" worktree="$4" log_file="$5"
  local diff review_prompt

  if [[ "$SKIP_REVIEW" == "true" ]]; then
    log_info "Skipping review (SKIP_REVIEW=true)"
    REVIEW_OUTPUT="Review skipped"
    return 0
  fi

  log_step "Running code review for issue #$issue_num"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run code review"
    REVIEW_OUTPUT="Review skipped (dry run)"
    return 0
  fi

  # Check there are actual changes to review
  local has_changes
  has_changes=$(cd "$worktree" && git log "origin/$BASE_BRANCH..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ')

  if [[ "$has_changes" -eq 0 ]]; then
    log_warn "No commits to review"
    REVIEW_OUTPUT="No changes to review"
    return 0
  fi

  # Short prompt -- agent reads the diff itself and fixes issues directly
  local review_prompt
  review_prompt=$(build_review_prompt "$issue_num" "$title" "$body")

  # Review agent runs WITH edit permissions so it can fix issues it finds
  log_info "Review agent: claude | Model: $REVIEW_MODEL | CWD: $worktree"
  REVIEW_OUTPUT=$(cd "$worktree" && echo "$review_prompt" | claude -p \
    --model "$REVIEW_MODEL" \
    --max-turns 15 \
    --dangerously-skip-permissions \
    --verbose \
    --output-format text \
    2>&1)

  echo "$REVIEW_OUTPUT" >> "$log_file"
  log_success "Code review complete"
}

run_fix_tests() {
  local issue_num="$1" worktree="$2" log_file="$3" test_errors="$4"

  log_step "Attempting to fix test failures (issue #$issue_num)"

  local fix_prompt="The following tests are failing after implementing issue #${issue_num}.
Fix the test failures. Only fix tests that are actually broken by your changes -- do NOT modify tests for pre-existing issues unrelated to your changes.

Test errors:
${test_errors}

Instructions:
1. Read the failing test files to understand what they expect
2. Fix the implementation code OR the tests as appropriate
3. Run pnpm test to verify fixes
4. Commit your fixes with message: fix: resolve test failures for issue #${issue_num}"

  log_info "Fix-tests agent: claude | Model: $MODEL"
  (cd "$worktree" && echo "$fix_prompt" | claude -p \
    --model "$MODEL" \
    --max-turns 20 \
    --verbose \
    --dangerously-skip-permissions \
    --output-format text \
    2>&1) | tee -a "$log_file"

  # Commit any uncommitted fixes
  local uncommitted
  uncommitted=$(cd "$worktree" && git status --porcelain | wc -l | tr -d ' ')
  if [[ "$uncommitted" -gt 0 ]]; then
    (cd "$worktree" && git add -A && git commit -m "fix: resolve test failures for issue #${issue_num}") || true
  fi
}

create_pr() {
  local issue_num="$1" title="$2" worktree="$3" review="$4" test_output="$5"
  local branch="agent/issue-${issue_num}"

  log_step "Creating PR for issue #$issue_num"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would create PR: $title"
    PR_URL="dry-run-pr-url"
    return 0
  fi

  # Push the branch
  log_info "Pushing branch $branch..."
  (cd "$worktree" && git push -u origin "$branch" 2>&1) || {
    # Try force push if branch exists from previous attempt
    log_warn "Push failed, trying force push..."
    (cd "$worktree" && git push -u origin "$branch" --force 2>&1) || {
      log_error "Failed to push branch"
      return 1
    }
  }

  # Check if PR already exists for this branch
  local existing_pr
  existing_pr=$(gh pr list --repo "$REPO" --head "$branch" --json number --limit 1 2>/dev/null | jq -r '.[0].number // empty')
  if [[ -n "$existing_pr" ]]; then
    PR_URL="https://github.com/${REPO}/pull/${existing_pr}"
    log_info "PR already exists: $PR_URL, updating..."
    # Update the PR body
    gh pr edit "$existing_pr" --repo "$REPO" --body "$(cat <<PREOF
## Summary

Automated implementation of #${issue_num}: **${title}**

## Code Review Report

<details>
<summary>Click to expand review</summary>

${review:-No review available}

</details>

## Test Results

\`\`\`
${test_output:-Tests not captured}
\`\`\`

---
Automated by [agent-loop](scripts/loop.sh)
PREOF
)" 2>/dev/null || true
    log_success "PR updated: $PR_URL"
    return 0
  fi

  # Truncate review if too long for PR body (GitHub has limits)
  local review_truncated="${review:-No review available}"
  if [[ ${#review_truncated} -gt 30000 ]]; then
    review_truncated="${review_truncated:0:30000}

... (review truncated, see full log)"
  fi

  # Create PR
  PR_URL=$(gh pr create \
    --repo "$REPO" \
    --base "$BASE_BRANCH" \
    --head "$branch" \
    --title "feat: ${title} (closes #${issue_num})" \
    --body "$(cat <<PREOF
## Summary

Automated implementation of #${issue_num}: **${title}**

## Code Review Report

<details>
<summary>Click to expand review</summary>

${review_truncated}

</details>

## Test Results

\`\`\`
${test_output:-Tests not captured}
\`\`\`

---
Automated by [agent-loop](scripts/loop.sh)
PREOF
)" 2>&1) || {
    log_error "Failed to create PR"
    return 1
  }

  log_success "PR created: $PR_URL"
}

merge_pr() {
  local issue_num="$1"
  local branch="agent/issue-${issue_num}"

  if [[ "$AUTO_MERGE" != "true" ]]; then
    log_info "Auto-merge disabled. PR ready for manual review."
    return 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would merge PR for issue #$issue_num into $SESSION_BRANCH"
    return 0
  fi

  log_step "Auto-merging PR for issue #$issue_num"

  # Find the PR number
  local pr_num
  pr_num=$(gh pr list --repo "$REPO" --head "$branch" --json number --limit 1 2>/dev/null | jq -r '.[0].number // empty')

  if [[ -z "$pr_num" ]]; then
    log_warn "No PR found to merge for branch $branch"
    return 1
  fi

  # If merging to a session branch (not master), update the PR base
  if [[ "$SESSION_BRANCH" != "$BASE_BRANCH" ]]; then
    # Ensure session branch exists
    if ! git -C "$PROJECT_DIR" rev-parse --verify "$SESSION_BRANCH" &>/dev/null; then
      log_info "Creating session branch: $SESSION_BRANCH"
      git -C "$PROJECT_DIR" branch "$SESSION_BRANCH" "origin/$BASE_BRANCH" 2>/dev/null || true
      git -C "$PROJECT_DIR" push origin "$SESSION_BRANCH" 2>/dev/null || true
    fi

    # Rebase the PR onto the session branch
    gh pr edit "$pr_num" --repo "$REPO" --base "$SESSION_BRANCH" 2>/dev/null || {
      log_warn "Could not update PR base to $SESSION_BRANCH"
    }
  fi

  # Merge the PR
  gh pr merge "$pr_num" --repo "$REPO" --squash --delete-branch 2>&1 || {
    log_error "Failed to merge PR #$pr_num"
    return 1
  }

  log_success "PR #$pr_num merged into $SESSION_BRANCH"

  # Pull the latest into local repo so next worktree gets the merged code
  git -C "$PROJECT_DIR" fetch origin 2>/dev/null || true
  git -C "$PROJECT_DIR" pull origin "$SESSION_BRANCH" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Process a Single Issue
# ---------------------------------------------------------------------------
process_issue() {
  local issue_num="$1" title="$2" body="$3"
  local worktree log_file test_output
  local start_time end_time duration
  local attempt=0

  start_time=$(date +%s)

  # Setup logging
  mkdir -p "$PROJECT_DIR/$LOG_DIR"
  log_file="$PROJECT_DIR/$LOG_DIR/issue-${issue_num}-$(date +%Y%m%d-%H%M%S).log"

  echo "========================================" | tee "$log_file"
  echo "Processing Issue #$issue_num: $title" | tee -a "$log_file"
  echo "Started: $(date)" | tee -a "$log_file"
  echo "========================================" | tee -a "$log_file"

  # Step 1: Update status on project board and labels
  update_project_status "$issue_num" "In progress" || true
  label_issue "$issue_num" "in-progress" "$LABEL_READY" || true

  # Step 2: Setup worktree (sets WORKTREE_PATH global)
  if ! setup_worktree "$issue_num"; then
    log_error "Failed to set up worktree for issue #$issue_num"
    label_issue "$issue_num" "failed" "in-progress" || true
    comment_issue "$issue_num" "Agent loop failed: could not create worktree. Check logs." || true
    return 1
  fi
  worktree="$WORKTREE_PATH"

  # Step 3: Implement
  if ! run_implement "$issue_num" "$title" "$body" "$worktree" "$log_file"; then
    log_error "Implementation failed for issue #$issue_num"
    label_issue "$issue_num" "failed" "in-progress" || true
    comment_issue "$issue_num" "Agent loop failed during implementation. See logs for details." || true
    cleanup_worktree "$issue_num"
    return 1
  fi

  # Step 4: Run tests with retry loop
  test_output=""
  local tests_passing=false
  for attempt in $(seq 1 "$MAX_TEST_RETRIES"); do
    log_info "Test attempt $attempt of $MAX_TEST_RETRIES"

    if test_output=$(run_tests "$worktree" "$log_file" 2>&1); then
      tests_passing=true
      log_success "All tests passed on attempt $attempt"
      break
    fi

    if [[ "$attempt" -lt "$MAX_TEST_RETRIES" ]]; then
      log_warn "Tests failed on attempt $attempt, invoking Claude to fix..."
      run_fix_tests "$issue_num" "$worktree" "$log_file" "$test_output"
    else
      log_warn "Tests still failing after $MAX_TEST_RETRIES attempts"
      test_output="TESTS FAILED after $MAX_TEST_RETRIES fix attempts. Latest output:
$test_output"
    fi
  done

  # Step 5: Code review (sets REVIEW_OUTPUT global)
  REVIEW_OUTPUT=""
  run_review "$issue_num" "$title" "$body" "$worktree" "$log_file" || {
    log_warn "Code review failed, continuing without review"
    REVIEW_OUTPUT="Code review could not be completed"
  }

  # Step 6: Create PR (sets PR_URL global)
  PR_URL=""
  if ! create_pr "$issue_num" "$title" "$worktree" "$REVIEW_OUTPUT" "$test_output"; then
    log_error "Failed to create PR for issue #$issue_num"
    label_issue "$issue_num" "failed" "in-progress" || true
    comment_issue "$issue_num" "Agent loop failed: could not create PR. Branch: agent/issue-${issue_num}" || true
    cleanup_worktree "$issue_num"
    return 1
  fi

  # Step 7: Update issue
  local status_msg="Implementation done."
  [[ "$tests_passing" == "true" ]] && status_msg="$status_msg All tests passing." || status_msg="$status_msg Some tests failing -- see PR."

  update_project_status "$issue_num" "Done" || true
  label_issue "$issue_num" "in-review" "in-progress" || true
  comment_issue "$issue_num" "Automated implementation complete.

**PR**: ${PR_URL}
**Tests**: $([ "$tests_passing" == "true" ] && echo "PASSING" || echo "FAILING")
**Review**: Attached to PR body.

---
*Processed by agent-loop in ${SECONDS}s*" || true

  # Step 8: Auto-merge if enabled
  merge_pr "$issue_num" || true

  # Step 9: Cleanup worktree (keep branch for PR if not merged)
  cleanup_worktree "$issue_num"

  end_time=$(date +%s)
  duration=$((end_time - start_time))

  log_success "Issue #$issue_num processed in ${duration}s"
  log_info "PR: $PR_URL"
  log_info "Log: $log_file"

  return 0
}

# ---------------------------------------------------------------------------
# Main Loop
# ---------------------------------------------------------------------------
main() {
  echo ""
  echo -e "${BOLD}${CYAN}=====================================${NC}"
  echo -e "${BOLD}${CYAN}  Agent Issue Loop${NC}"
  echo -e "${BOLD}${CYAN}=====================================${NC}"
  echo ""
  echo -e "  Repo:          ${BOLD}$REPO${NC}"
  echo -e "  Project:       ${BOLD}#$PROJECT_NUM (${REPO_OWNER})${NC}"
  echo -e "  Model:         ${BOLD}$MODEL${NC}"
  echo -e "  Review Model:  ${BOLD}$REVIEW_MODEL${NC}"
  echo -e "  Max Turns:     ${BOLD}$MAX_TURNS${NC}"
  echo -e "  Base Branch:   ${BOLD}$BASE_BRANCH${NC}"
  echo -e "  Label:         ${BOLD}$LABEL_READY${NC}"
  echo -e "  Poll Interval: ${BOLD}${POLL_INTERVAL}s${NC}"
  echo -e "  Dry Run:       ${BOLD}$DRY_RUN${NC}"
  echo -e "  Skip Tests:    ${BOLD}$SKIP_TESTS${NC}"
  echo -e "  Skip Review:   ${BOLD}$SKIP_REVIEW${NC}"
  echo -e "  Test Retries:  ${BOLD}$MAX_TEST_RETRIES${NC}"
  echo -e "  Auto Merge:    ${BOLD}$AUTO_MERGE${NC}"
  echo -e "  Merge To:      ${BOLD}${SESSION_BRANCH}${NC}"
  echo ""

  # Verify prerequisites
  check_prerequisites

  # Change to project directory
  cd "$PROJECT_DIR"

  while true; do
    log_info "Polling for issues labeled '$LABEL_READY'..."

    local issues
    issues=$(poll_issues 100)
    local count
    count=$(get_issue_count "$issues")

    if [[ "$count" -eq 0 ]]; then
      if [[ "$RUN_ONCE" == "--once" ]]; then
        log_info "No issues found. Exiting (--once mode)."
        exit 0
      fi
      log_info "No issues found. Sleeping ${POLL_INTERVAL}s..."
      sleep "$POLL_INTERVAL"
      continue
    fi

    log_info "Found $count issue(s) to process"

    # Process each issue
    local i=0
    while [[ $i -lt $count ]]; do
      local issue_num title body

      issue_num=$(get_issue_field "$issues" "$i" "number")
      title=$(get_issue_field "$issues" "$i" "title")
      body=$(get_issue_field "$issues" "$i" "body")

      if [[ -z "$issue_num" ]]; then
        log_warn "Could not parse issue at index $i, skipping"
        ((i++))
        continue
      fi

      echo ""
      log_info "=========================================="
      log_info "Processing issue #$issue_num: $title"
      log_info "=========================================="

      process_issue "$issue_num" "$title" "$body" || {
        log_error "Failed to process issue #$issue_num, moving to next"
      }

      ((ISSUES_PROCESSED++))
      ((i++))

      # Check max issues limit
      if [[ "$MAX_ISSUES" -gt 0 && "$ISSUES_PROCESSED" -ge "$MAX_ISSUES" ]]; then
        log_info "Reached MAX_ISSUES limit ($MAX_ISSUES). Stopping."
        exit 0
      fi
    done

    if [[ "$RUN_ONCE" == "--once" ]]; then
      log_info "Processed $ISSUES_PROCESSED issue(s). Exiting (--once mode)."
      exit 0
    fi

    log_info "Cycle complete. Processed $ISSUES_PROCESSED issue(s) total. Sleeping ${POLL_INTERVAL}s..."
    sleep "$POLL_INTERVAL"
  done
}

# ---------------------------------------------------------------------------
# Cleanup on exit
# ---------------------------------------------------------------------------
cleanup_on_exit() {
  cd "$ORIGINAL_DIR" 2>/dev/null || true
  log_info "Agent loop stopped. Processed $ISSUES_PROCESSED issue(s)."
}
trap cleanup_on_exit EXIT

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
main "$@"
