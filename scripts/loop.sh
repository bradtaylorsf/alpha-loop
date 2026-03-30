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
#   bash scripts/loop.sh init         # Create .alpha-loop.yaml template
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
#   SKIP_PREFLIGHT  - Skip pre-flight test validation (default: false)
#   SKIP_E2E        - Skip Playwright E2E tests in the loop (default: false)
#   SKIP_LEARN      - Skip learning extraction after runs (default: false)
#   SKIP_LEARNINGS  - Alias for SKIP_LEARN (default: false)
#   RUN_FULL        - Bypass API response cache, hit real APIs (default: false)
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
RUN_FULL="${RUN_FULL:-false}"
SKIP_PREFLIGHT="${SKIP_PREFLIGHT:-false}"
SKIP_E2E="${SKIP_E2E:-false}"
SKIP_VERIFY="${SKIP_VERIFY:-false}"
VERIFY_COMMAND="${VERIFY_COMMAND:-}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-120}"
SKIP_LEARN="${SKIP_LEARN:-false}"
SKIP_LEARNINGS="${SKIP_LEARNINGS:-$SKIP_LEARN}"
AUTO_MERGE="${AUTO_MERGE:-false}"
MERGE_TO="${MERGE_TO:-}"
RUN_ONCE=""
SUBCOMMAND=""
HISTORY_ARG=""
HISTORY_QA=""
HISTORY_CLEAN=""
for arg in "$@"; do
  case "$arg" in
    --once) RUN_ONCE="--once" ;;
    --run-full) RUN_FULL="true" ;;
    --skip-preflight) SKIP_PREFLIGHT="true" ;;
    --skip-verify) SKIP_VERIFY="true" ;;
    --skip-learn) SKIP_LEARNINGS="true" ;;
    --qa) HISTORY_QA="true" ;;
    --clean) HISTORY_CLEAN="true" ;;
    init) SUBCOMMAND="init" ;;
    scan) SUBCOMMAND="scan" ;;
    vision) SUBCOMMAND="vision" ;;
    auth) SUBCOMMAND="auth" ;;
    history) SUBCOMMAND="history" ;;
    *)
      # Capture the session name argument for history subcommand
      if [[ "$SUBCOMMAND" == "history" && -z "$HISTORY_ARG" && "$arg" != "--"* ]]; then
        HISTORY_ARG="$arg"
      fi
      ;;
  esac
done

# Session branch: if MERGE_TO is not set, create a session branch for this run
if [[ -z "$MERGE_TO" ]]; then
  SESSION_BRANCH="session/$(date +%Y%m%d-%H%M%S)"
else
  SESSION_BRANCH="$MERGE_TO"
fi

# Session name for session storage (derived from SESSION_BRANCH)
SESSION_NAME="${SESSION_BRANCH}"

# Resolve paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PROJECT_DIR is the current working directory (the repo being worked on),
# NOT the directory where loop.sh lives (which would be alpha-loop)
PROJECT_DIR="$(pwd)"
PROMPTS_DIR="$SCRIPT_DIR/prompts"

# State
ISSUES_PROCESSED=0
ORIGINAL_DIR="$(pwd)"
PREFLIGHT_IGNORE_FILE=""

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
# Repo Auto-Detection from git remote
# ---------------------------------------------------------------------------
detect_repo() {
  local remote_url
  remote_url=$(git remote get-url origin 2>/dev/null) || return 1

  # HTTPS: https://github.com/owner/repo.git -> owner/repo
  if [[ "$remote_url" =~ github\.com/([^/]+)/([^/.]+) ]]; then
    echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    return 0
  fi

  # SSH: git@github.com:owner/repo.git -> owner/repo
  if [[ "$remote_url" =~ github\.com:([^/]+)/([^/.]+) ]]; then
    echo "${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"
    return 0
  fi

  return 1
}

# ---------------------------------------------------------------------------
# Config File Loading (.alpha-loop.yaml)
# ---------------------------------------------------------------------------
load_config() {
  local config_file="${1:-.alpha-loop.yaml}"

  if [[ ! -f "$config_file" ]]; then
    return 1
  fi

  # Parse YAML key-value pairs (simple flat format)
  # Sets CONFIG_* variables for each key found
  while IFS= read -r line; do
    # Skip comments and empty lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// /}" ]] && continue

    # Match "key: value" pairs
    if [[ "$line" =~ ^([a-z_]+):[[:space:]]+(.*) ]]; then
      local key="${BASH_REMATCH[1]}"
      local value="${BASH_REMATCH[2]}"
      # Trim trailing whitespace and quotes
      value="${value%"${value##*[![:space:]]}"}"
      value="${value#\"}"
      value="${value%\"}"
      value="${value#\'}"
      value="${value%\'}"

      case "$key" in
        repo)           CONFIG_REPO="$value" ;;
        project)        CONFIG_PROJECT="$value" ;;
        model)          CONFIG_MODEL="$value" ;;
        review_model)   CONFIG_REVIEW_MODEL="$value" ;;
        max_turns)      CONFIG_MAX_TURNS="$value" ;;
        label)          CONFIG_LABEL="$value" ;;
        merge_strategy) CONFIG_MERGE_STRATEGY="$value" ;;
        test_command)   CONFIG_TEST_COMMAND="$value" ;;
        dev_command)    CONFIG_DEV_COMMAND="$value" ;;
        base_branch)    CONFIG_BASE_BRANCH="$value" ;;
        poll_interval)  CONFIG_POLL_INTERVAL="$value" ;;
      esac
    fi
  done < "$config_file"

  return 0
}

# ---------------------------------------------------------------------------
# Init Subcommand -- creates .alpha-loop.yaml template
# ---------------------------------------------------------------------------
run_init() {
  local config_file=".alpha-loop.yaml"

  if [[ -f "$config_file" ]]; then
    log_warn "$config_file already exists. Remove it first to regenerate."
    exit 1
  fi

  # Auto-detect repo from git remote
  local detected_repo=""
  detected_repo=$(detect_repo 2>/dev/null) || true

  if [[ -z "$detected_repo" ]]; then
    detected_repo="owner/repo"
    log_warn "Could not auto-detect repo from git remote. Using placeholder."
  else
    log_success "Auto-detected repo: $detected_repo"
  fi

  cat > "$config_file" <<EOF
# Alpha Loop configuration
# Generated by: bash scripts/loop.sh init

repo: ${detected_repo}
project: 3
model: opus
review_model: opus
max_turns: 30
label: ready
merge_strategy: session
test_command: pnpm test
dev_command: pnpm dev
EOF

  log_success "Created $config_file"
  cat "$config_file"
}

# ---------------------------------------------------------------------------
# Apply Configuration (priority: CLI/env > .alpha-loop.yaml > git remote > defaults)
# ---------------------------------------------------------------------------
apply_config() {
  # Step 1: Load .alpha-loop.yaml (if it exists)
  load_config ".alpha-loop.yaml" 2>/dev/null || true

  # Step 2: Apply priority order for each setting
  # CLI flags/env vars are already set above via ${VAR:-default}
  # Only override with config file values if env var was NOT explicitly set

  # Repo: env var > config file > git remote > hardcoded default
  if [[ "$REPO" == "bradtaylorsf/alpha-loop" ]]; then
    # REPO was not explicitly set (still at default) -- try config file, then git remote
    if [[ -n "${CONFIG_REPO:-}" ]]; then
      REPO="$CONFIG_REPO"
    else
      local detected
      detected=$(detect_repo 2>/dev/null) || true
      if [[ -n "$detected" ]]; then
        REPO="$detected"
      fi
    fi
  fi

  # Extract owner from REPO
  REPO_OWNER="${REPO%%/*}"

  # Project number
  if [[ "$PROJECT_NUM" == "2" && -n "${CONFIG_PROJECT:-}" ]]; then
    PROJECT_NUM="$CONFIG_PROJECT"
  fi

  # Model
  if [[ "$MODEL" == "opus" && -n "${CONFIG_MODEL:-}" ]]; then
    MODEL="$CONFIG_MODEL"
  fi

  # Review model
  if [[ "$REVIEW_MODEL" == "opus" && -n "${CONFIG_REVIEW_MODEL:-}" ]]; then
    REVIEW_MODEL="$CONFIG_REVIEW_MODEL"
  fi

  # Max turns
  if [[ "$MAX_TURNS" == "30" && -n "${CONFIG_MAX_TURNS:-}" ]]; then
    MAX_TURNS="$CONFIG_MAX_TURNS"
  fi

  # Label
  if [[ "$LABEL_READY" == "ready" && -n "${CONFIG_LABEL:-}" ]]; then
    LABEL_READY="$CONFIG_LABEL"
  fi

  # Base branch
  if [[ "$BASE_BRANCH" == "master" && -n "${CONFIG_BASE_BRANCH:-}" ]]; then
    BASE_BRANCH="$CONFIG_BASE_BRANCH"
  fi

  # Poll interval
  if [[ "$POLL_INTERVAL" == "60" && -n "${CONFIG_POLL_INTERVAL:-}" ]]; then
    POLL_INTERVAL="$CONFIG_POLL_INTERVAL"
  fi

  # Merge strategy from config: "session" -> auto-merge to session branch
  if [[ "$AUTO_MERGE" == "false" && -n "${CONFIG_MERGE_STRATEGY:-}" ]]; then
    case "$CONFIG_MERGE_STRATEGY" in
      session)
        AUTO_MERGE="true"
        # SESSION_BRANCH is already set to session/timestamp by default
        ;;
      master|main)
        AUTO_MERGE="true"
        SESSION_BRANCH="$BASE_BRANCH"
        ;;
      none|false)
        AUTO_MERGE="false"
        ;;
    esac
  fi

  # Final check: if repo is still the hardcoded default or empty, error out
  if [[ -z "$REPO" || "$REPO" == "owner/repo" ]]; then
    log_error "Could not determine repository."
    log_error "Set REPO env var, create .alpha-loop.yaml, or run from a git repo with a GitHub remote."
    exit 1
  fi
}

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
# Pre-flight Test Validation
# ---------------------------------------------------------------------------
run_preflight() {
  if [[ "$SKIP_PREFLIGHT" == "true" ]]; then
    log_info "Skipping pre-flight tests (--skip-preflight)"
    return 0
  fi

  if [[ "$SKIP_TESTS" == "true" ]]; then
    log_info "Skipping pre-flight tests (SKIP_TESTS=true)"
    return 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run pre-flight test validation"
    return 0
  fi

  log_step "Running pre-flight test validation..."

  # Determine test command from .alpha-loop.yaml or default
  local test_cmd="${CONFIG_TEST_COMMAND:-pnpm test}"
  log_info "Test command: $test_cmd"

  # Run tests and capture output
  # Disable set -e for entire pre-flight — test failures and grep misses are expected
  set +e

  local test_output=""
  local test_exit=0
  test_output=$(eval "$test_cmd" 2>&1)
  test_exit=$?

  # Parse test output for pass/fail/skip counts
  # Support both Jest and Vitest output formats
  local passed=0 failed=0 skipped=0
  local total_line=""

  # Jest format:  "Tests:  3 failed, 39 passed, 42 total"
  total_line=$(echo "$test_output" | grep -E "Tests:.*total" | tail -1)

  if [[ -n "$total_line" ]]; then
    passed=$(echo "$total_line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "0")
    failed=$(echo "$total_line" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo "0")
    skipped=$(echo "$total_line" | grep -oE '[0-9]+ skipped' | grep -oE '[0-9]+' || echo "0")
  fi

  # Vitest format: "Tests  1 failed | 2 passed (3)"
  if [[ -z "$total_line" ]]; then
    total_line=$(echo "$test_output" | grep -E "Tests[[:space:]].*passed" | tail -1)
    if [[ -n "$total_line" ]]; then
      passed=$(echo "$total_line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "0")
      failed=$(echo "$total_line" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo "0")
      skipped=$(echo "$total_line" | grep -oE '[0-9]+ skipped' | grep -oE '[0-9]+' || echo "0")
    fi
  fi

  # Default to 0 if empty
  passed="${passed:-0}"
  failed="${failed:-0}"
  skipped="${skipped:-0}"

  # All tests passed
  if [[ "$test_exit" -eq 0 ]]; then
    local summary="Pre-flight: ${GREEN}✓${NC} ${passed} passed, 0 failed"
    [[ "$skipped" -gt 0 ]] && summary="$summary, $skipped skipped"
    echo -e "$summary"
    log_success "Pre-flight tests passed"
    set -e
    return 0
  fi

  # Tests failed but we couldn't parse the counts — use exit code
  if [[ "$failed" -eq 0 && "$test_exit" -ne 0 ]]; then
    failed=1
    log_warn "Tests failed (exit code $test_exit) but could not parse failure count"
  fi

  # Some tests failed -- extract failing test names
  # Jest format: ● test suite name › test name
  local failing_tests=""
  failing_tests=$(echo "$test_output" | grep -E "^[[:space:]]*● " | sed 's/^[[:space:]]*//' || true)

  # Vitest format: "Test Files  1 failed (1)" + "❌ Test filename failed"
  if [[ -z "$failing_tests" ]]; then
    failing_tests=$(echo "$test_output" | grep -E "^❌ " || true)
  fi

  # Also extract FAIL lines for file-level info
  local failing_files=""
  failing_files=$(echo "$test_output" | grep -E "^[[:space:]]*FAIL " | sed 's/^[[:space:]]*//' || true)

  echo ""
  echo -e "Pre-flight: ${GREEN}✓${NC} ${passed} passed, ${RED}✗${NC} ${failed} failed"
  [[ "$skipped" -gt 0 ]] && echo -e "            $skipped skipped"
  echo ""

  if [[ -n "$failing_tests" ]]; then
    echo -e "Failing tests:"
    while IFS= read -r line; do
      echo -e "  ${RED}✗${NC} $line"
    done <<< "$failing_tests"
  elif [[ -n "$failing_files" ]]; then
    echo -e "Failing test files:"
    while IFS= read -r line; do
      echo -e "  ${RED}✗${NC} $line"
    done <<< "$failing_files"
  fi
  echo ""

  # Non-interactive mode (no TTY): default to option 2 (ignore)
  if [[ ! -t 0 ]]; then
    log_info "Non-interactive mode: ignoring pre-existing failures"
    _preflight_save_ignore_file "$test_output"
    set -e
    return 0
  fi

  # Interactive prompt
  echo -e "  ${BOLD}[1]${NC} Fix these first (auto-creates a fix session)"
  echo -e "  ${BOLD}[2]${NC} Ignore these during this session"
  echo -e "  ${BOLD}[3]${NC} Abort"
  echo ""
  read -r -p "Choose [1/2/3]: " choice

  case "$choice" in
    1)
      log_info "Creating fix session for pre-existing test failures..."
      _preflight_fix_tests "$test_output" "$failing_tests"
      ;;
    2)
      log_info "Ignoring pre-existing test failures for this session"
      _preflight_save_ignore_file "$test_output"
      ;;
    3)
      log_info "Aborting at user request."
      exit 0
      ;;
    *)
      log_error "Invalid choice. Aborting."
      exit 1
      ;;
  esac

  # Re-enable strict mode
  set -e
}

_preflight_save_ignore_file() {
  local test_output="$1"

  # Save failing test names to temp file for exclusion during session
  PREFLIGHT_IGNORE_FILE=$(mktemp "${TMPDIR:-/tmp}/preflight-ignore-XXXXXX")

  # Extract failing test names (Jest ● format) into the file
  echo "$test_output" | grep -E "^[[:space:]]*● " | sed 's/^[[:space:]]*//' > "$PREFLIGHT_IGNORE_FILE" || true

  # Also save FAIL file paths as fallback
  echo "$test_output" | grep -E "^[[:space:]]*FAIL " | sed 's/^[[:space:]]*FAIL //' >> "$PREFLIGHT_IGNORE_FILE" || true

  log_info "Saved pre-existing failures to $PREFLIGHT_IGNORE_FILE"
}

_preflight_fix_tests() {
  local test_output="$1"
  local failing_tests="$2"
  local test_cmd="${CONFIG_TEST_COMMAND:-pnpm test}"

  local fix_prompt="The following tests are failing on the current branch BEFORE any changes were made.
These are pre-existing failures that need to be fixed.

Failing tests:
${failing_tests}

Full test output:
${test_output}

Instructions:
1. Read the failing test files to understand what they expect
2. Fix the implementation code OR the tests as appropriate
3. Run ${test_cmd} to verify your fixes
4. Commit your fixes with message: fix: resolve pre-existing test failures"

  log_info "Fix-preflight agent: claude | Model: $MODEL"
  echo "$fix_prompt" | claude -p \
    --model "$MODEL" \
    --dangerously-skip-permissions \
    --verbose \
    --output-format text \
    2>&1

  # Commit any uncommitted fixes
  local uncommitted
  uncommitted=$(git status --porcelain | wc -l | tr -d ' ')
  if [[ "$uncommitted" -gt 0 ]]; then
    git add -A && git commit -m "fix: resolve pre-existing test failures" || true
  fi

  # Verify tests now pass
  log_info "Verifying tests pass after fix..."
  if eval "$test_cmd" 2>&1; then
    log_success "Pre-existing test failures fixed. Continuing to main session."
  else
    log_warn "Some tests still failing after fix attempt."
    log_info "Saving remaining failures as ignored for this session."
    local recheck_output
    recheck_output=$(eval "$test_cmd" 2>&1) || true
    _preflight_save_ignore_file "$recheck_output"
  fi
}

# ---------------------------------------------------------------------------
# Issue Polling - reads from GitHub Project board in priority order
# ---------------------------------------------------------------------------
poll_issues() {
  local limit="${1:-1}"

  # If no project configured, fall back to label-based polling
  if [[ -z "$PROJECT_NUM" || "$PROJECT_NUM" == "0" ]]; then
    poll_issues_by_label "$limit"
    return
  fi

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

# Fallback: poll issues by label when no project board is configured
poll_issues_by_label() {
  local limit="${1:-1}"
  local label="${LABEL_READY:-ready}"

  gh issue list --repo "$REPO" \
    --label "$label" \
    --state open \
    --json number,title,body,labels \
    --limit "$limit" 2>/dev/null | jq --argjson limit "$limit" '
    [.[] | {
      number: .number,
      title: .title,
      body: .body,
      labels: [.labels[].name]
    }] | sort_by(.number) | .[0:$limit]
  ' 2>/dev/null || echo "[]"
}

update_project_status() {
  local issue_num="$1" new_status="$2"

  # Skip if no project board configured
  if [[ -z "$PROJECT_NUM" || "$PROJECT_NUM" == "0" ]]; then
    return 0
  fi

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
# Project Context -- living memory that persists across runs
# ---------------------------------------------------------------------------
CONTEXT_DIR="${PROJECT_DIR}/.alpha-loop"
CONTEXT_FILE="${CONTEXT_DIR}/context.md"
VISION_FILE="${CONTEXT_DIR}/vision.md"

# ---------------------------------------------------------------------------
# Project Vision -- product context that guides agent decisions
# ---------------------------------------------------------------------------

# Interactive vision setup
run_vision() {
  mkdir -p "$CONTEXT_DIR"

  if [[ -f "$VISION_FILE" ]]; then
    echo ""
    echo -e "${BOLD}Current project vision:${NC}"
    echo ""
    cat "$VISION_FILE"
    echo ""
    read -r -p "Update this vision? [y/N]: " update_choice
    if [[ "$update_choice" != "y" && "$update_choice" != "Y" ]]; then
      return 0
    fi
  else
    echo ""
    echo -e "${BOLD}${CYAN}No project vision found. Let's set one up.${NC}"
    echo -e "This helps the agent understand what it's building and make better decisions."
    echo ""
  fi

  # Question 1: What is this project?
  echo -e "${BOLD}What is this project?${NC} (1-2 sentences)"
  read -r -p "> " project_description
  echo ""

  # Question 2: Target users
  echo -e "${BOLD}Who are the target users?${NC}"
  echo "  [1] Technical users (developers, engineers)"
  echo "  [2] Semi-technical (power users, admins)"
  echo "  [3] Non-technical (general consumers, elderly, caregivers)"
  echo "  [4] Mixed audience"
  read -r -p "> " user_type_choice
  case "$user_type_choice" in
    1) user_type="Technical users (developers, engineers)" ;;
    2) user_type="Semi-technical (power users, admins)" ;;
    3) user_type="Non-technical (general consumers, elderly, caregivers) — UI must be simple, accessible, and forgiving" ;;
    4) user_type="Mixed audience — needs both simple and advanced interfaces" ;;
    *) user_type="$user_type_choice" ;;  # freeform
  esac
  echo ""

  # Question 3: Project stage
  echo -e "${BOLD}What stage is the project in?${NC}"
  echo "  [1] Brand new / greenfield"
  echo "  [2] MVP / early development"
  echo "  [3] Working product, adding features"
  echo "  [4] Mature product, maintenance mode"
  read -r -p "> " stage_choice
  case "$stage_choice" in
    1) project_stage="Brand new / greenfield — focus on getting core architecture right" ;;
    2) project_stage="MVP / early development — focus on core flows working end-to-end" ;;
    3) project_stage="Working product — adding features without breaking existing functionality" ;;
    4) project_stage="Mature product — maintenance, optimization, and careful changes" ;;
    *) project_stage="$stage_choice" ;;
  esac
  echo ""

  # Question 4: Current priority
  echo -e "${BOLD}What matters most right now?${NC}"
  echo "  [1] Core functionality works reliably"
  echo "  [2] User experience and polish"
  echo "  [3] Scale and performance"
  echo "  [4] Security and compliance"
  echo "  [5] Something else (type it)"
  read -r -p "> " priority_choice
  case "$priority_choice" in
    1) priority="Core functionality — make it work reliably before making it pretty" ;;
    2) priority="User experience — the product works, now make it delightful" ;;
    3) priority="Scale and performance — handle more load, optimize bottlenecks" ;;
    4) priority="Security and compliance — harden, audit, meet regulatory requirements" ;;
    *) priority="$priority_choice" ;;
  esac
  echo ""

  # Question 5: UX/design guidelines
  echo -e "${BOLD}Any UX or design guidelines?${NC} (press Enter to skip)"
  echo "  Examples: 'mobile-first', 'dark mode', 'WCAG AA accessible', 'minimal UI'"
  read -r -p "> " ux_guidelines
  echo ""

  # Question 6: North star issue or additional context
  echo -e "${BOLD}Link a north star issue or paste additional context?${NC}"
  echo "  Paste a GitHub issue URL, issue number, or freeform text (Enter to skip)"
  read -r -p "> " north_star_input
  echo ""

  local north_star_content=""
  if [[ -n "$north_star_input" ]]; then
    # Check if it's a URL or issue number
    local issue_num=""
    if [[ "$north_star_input" =~ ^[0-9]+$ ]]; then
      issue_num="$north_star_input"
    elif [[ "$north_star_input" =~ issues/([0-9]+) ]]; then
      issue_num="${BASH_REMATCH[1]}"
    fi

    if [[ -n "$issue_num" ]]; then
      log_info "Fetching issue #${issue_num}..."
      local issue_data
      issue_data=$(gh issue view "$issue_num" --repo "$REPO" --json title,body 2>/dev/null) || true
      if [[ -n "$issue_data" ]]; then
        local issue_title issue_body
        issue_title=$(echo "$issue_data" | jq -r '.title')
        issue_body=$(echo "$issue_data" | jq -r '.body')
        north_star_content="### North Star: #${issue_num} — ${issue_title}

${issue_body}"
        log_success "Fetched issue #${issue_num}: ${issue_title}"
      else
        log_warn "Could not fetch issue #${issue_num}"
        north_star_content="$north_star_input"
      fi
    else
      north_star_content="$north_star_input"
    fi
  fi

  # Question 7: Anything else?
  echo -e "${BOLD}Anything else the agent should always keep in mind?${NC} (Enter to skip)"
  read -r -p "> " additional_context
  echo ""

  # Now synthesize with Claude
  log_step "Generating project vision..."

  local vision_prompt
  vision_prompt=$(cat <<VEOF
Synthesize the following inputs into a concise project vision document. This will be read by AI agents before every task to guide their decisions.

Project description: ${project_description}
Target users: ${user_type}
Project stage: ${project_stage}
Current priority: ${priority}
UX guidelines: ${ux_guidelines:-"None specified"}
Additional context: ${additional_context:-"None"}

${north_star_content:+North star context:
${north_star_content}}

Output ONLY this markdown structure. Be specific and actionable. Under 500 words total.

## What We're Building
(2-3 sentences synthesizing the project description and north star)

## Who It's For
(Target users and what that means for UX/design decisions)

## Current Stage & Priority
(Where the project is and what matters most right now)

## Decision Guidelines
(5-7 bullet points the agent should follow when making choices about implementation, UX, what to build vs defer, etc. Derived from all inputs above.)

## What Good Looks Like
(3-4 bullet points describing the quality bar — what a successful implementation looks like for this project)
VEOF
)

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would generate project vision"
    return 0
  fi

  local vision_output
  set +e
  vision_output=$(echo "$vision_prompt" | claude -p \
    --model "${MODEL:-opus}" \
    --dangerously-skip-permissions \
    --output-format text \
    2>/dev/null)
  local vision_exit=$?
  set -e

  if [[ "$vision_exit" -ne 0 || -z "$vision_output" ]]; then
    # Fallback: write raw inputs without synthesis
    log_warn "Claude synthesis failed, saving raw inputs"
    cat > "$VISION_FILE" <<RAWEOF
## What We're Building
${project_description}

## Who It's For
${user_type}

## Current Stage & Priority
${project_stage}
Priority: ${priority}

## UX Guidelines
${ux_guidelines:-"None specified"}

${north_star_content:+## North Star
${north_star_content}}

${additional_context:+## Additional Context
${additional_context}}
RAWEOF
  else
    echo "$vision_output" > "$VISION_FILE"
  fi

  log_success "Project vision saved to $VISION_FILE"
  echo ""
  cat "$VISION_FILE"
}

# Get vision context for prompts (brief version)
get_vision_context() {
  if [[ -f "$VISION_FILE" ]]; then
    cat "$VISION_FILE"
  fi
}

# Check if vision exists
has_vision() {
  [[ -f "$VISION_FILE" ]]
}

# ---------------------------------------------------------------------------
# Generate or update project context by scanning the codebase
generate_project_context() {
  local worktree="${1:-$PROJECT_DIR}"

  mkdir -p "$CONTEXT_DIR"

  log_step "Scanning codebase for project context..."

  local scan_prompt
  scan_prompt=$(cat <<'SCANEOF'
Analyze this codebase and produce a concise project context file. Read the key files (package.json, entry points, config files, README, CLAUDE.md) and output ONLY this markdown structure:

## Architecture
- Entry points and how they connect (e.g., "Express server in src/server/index.ts mounts routes from routes/*.ts")
- Database (type, schema location, how to query)
- Key directories and what they contain

## Conventions
- Language, framework, coding patterns used
- How tests are structured and run
- How new features should be wired in (e.g., "new routes must be imported in index.ts")

## Critical Rules
- Files/directories that must not be deleted or modified without care
- Integration points that break if not updated together
- Common mistakes to avoid in this codebase

## Active State
- Test status: (will be filled in by the loop)
- Recent changes: (will be filled in by the loop)

Keep each section to 3-5 bullet points. Be specific to THIS codebase, not generic advice. Under 400 words total.
SCANEOF
)

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would generate project context"
    return 0
  fi

  local context_output
  context_output=$(cd "$worktree" && echo "$scan_prompt" | claude -p \
    --model "${MODEL:-opus}" \
    --dangerously-skip-permissions \
    --output-format text \
    2>/dev/null) || {
    log_warn "Project context generation failed"
    return 0
  }

  if [[ -n "$context_output" ]]; then
    echo "$context_output" > "$CONTEXT_FILE"
    log_success "Project context saved to $CONTEXT_FILE"
  fi
}

# Read project context (returns empty string if not available)
get_project_context() {
  if [[ -f "$CONTEXT_FILE" ]]; then
    cat "$CONTEXT_FILE"
  fi
}

# Update the "Active State" section of project context after a run
update_context_after_run() {
  local issue_num="$1" title="$2" status="$3" files_changed="$4"

  if [[ ! -f "$CONTEXT_FILE" ]]; then
    return 0
  fi

  # Append to active state
  local timestamp
  timestamp=$(date +%Y-%m-%dT%H:%M:%S)

  # Update the Active State section with latest run info
  # Use a simple append approach -- the learning aggregation will clean this up
  local state_update="- [${timestamp}] #${issue_num} ${title} (${status}) — ${files_changed} files changed"

  # Check if Active State section exists
  if grep -q "^## Active State" "$CONTEXT_FILE" 2>/dev/null; then
    # Append under Active State, keep only last 5 entries
    local temp_file="${CONTEXT_FILE}.tmp"
    awk -v new_entry="$state_update" '
      /^## Active State/ { in_section=1; print; next }
      in_section && /^## / {
        # Print last 5 entries then the new section header
        in_section=0; print; next
      }
      { print }
      END { if (in_section) print new_entry }
    ' "$CONTEXT_FILE" > "$temp_file"
    # Add new entry at end of Active State
    sed -i.bak "/^## Active State/a\\
${state_update}" "$CONTEXT_FILE" 2>/dev/null || {
      # macOS sed needs different syntax
      sed -i '' "/^## Active State/a\\
${state_update}" "$CONTEXT_FILE" 2>/dev/null || true
    }
    rm -f "${CONTEXT_FILE}.bak" "$temp_file" 2>/dev/null
  fi
}

# Save a session result summary for the next issue to read
save_session_result() {
  local issue_num="$1" title="$2" status="$3" files_summary="$4"
  local session_dir="$PROJECT_DIR/sessions/$SESSION_NAME"
  mkdir -p "$session_dir"

  cat > "$session_dir/issue-${issue_num}-result.md" <<RESULTEOF
## Previous Issue Result
- Issue: #${issue_num} — ${title}
- Status: ${status}
- Files changed: ${files_summary}
- Completed: $(date +%Y-%m-%dT%H:%M:%S)

Note: Build on this work. If this issue created new modules, make sure your changes integrate with them.
RESULTEOF
}

# Get the result from the previous issue in this session
get_previous_result() {
  local session_dir="$PROJECT_DIR/sessions/$SESSION_NAME"
  if [[ ! -d "$session_dir" ]]; then
    return 0
  fi

  # Find the most recent result file
  local latest_result
  latest_result=$(find "$session_dir" -maxdepth 1 -name "issue-*-result.md" -type f 2>/dev/null | sort -V | tail -1)

  if [[ -n "$latest_result" && -f "$latest_result" ]]; then
    cat "$latest_result"
  fi
}

# Check if project context is stale (older than 7 days or doesn't exist)
context_needs_refresh() {
  if [[ ! -f "$CONTEXT_FILE" ]]; then
    return 0  # needs refresh (doesn't exist)
  fi

  local file_age_days
  if [[ "$(uname)" == "Darwin" ]]; then
    file_age_days=$(( ($(date +%s) - $(stat -f %m "$CONTEXT_FILE")) / 86400 ))
  else
    file_age_days=$(( ($(date +%s) - $(stat -c %Y "$CONTEXT_FILE")) / 86400 ))
  fi

  [[ "$file_age_days" -ge 7 ]]
}

# ---------------------------------------------------------------------------
# Prompt Building -- keep prompts SHORT, let skills/CLAUDE.md do the work
# ---------------------------------------------------------------------------
build_implement_prompt() {
  local issue_num="$1" title="$2" body="$3"
  local vision_context=""
  local project_context=""
  local previous_result=""
  local learning_context=""

  # 1. Product vision (what we're building, who for, decision guidelines)
  vision_context=$(get_vision_context 2>/dev/null) || true

  # 2. Technical context (architecture, conventions, rules)
  project_context=$(get_project_context 2>/dev/null) || true

  # 3. Previous issue result (session continuity)
  previous_result=$(get_previous_result 2>/dev/null) || true

  # 4. Learning context from past runs (patterns, anti-patterns)
  if [[ "$SKIP_LEARNINGS" != "true" ]]; then
    learning_context=$(get_learning_context 2>/dev/null) || true
  fi

  cat <<EOF
Implement GitHub issue #${issue_num}: ${title}

${body}
${vision_context:+

## Product Vision
${vision_context}}
${project_context:+

## Technical Context
${project_context}}
${previous_result:+

${previous_result}}
${learning_context:+

${learning_context}}

## Before You Start
1. Read the product vision and technical context above
2. Make decisions that align with the target users and current priority
3. Understand how your changes connect to existing code
4. If you're creating new files, make sure they're wired into the appropriate entry points

## After Implementing
1. Write tests for your changes
2. Run the test command to verify
3. Commit with: git commit -m "feat: ${title} (closes #${issue_num})"
EOF
}

build_review_prompt() {
  local issue_num="$1" title="$2" body="$3"
  local vision_context=""
  vision_context=$(get_vision_context 2>/dev/null) || true

  cat <<EOF
Review the code changes for issue #${issue_num}: ${title}

Run git diff origin/$BASE_BRANCH...HEAD to see what changed. Then read the actual files that were modified.

Original requirements:
${body}
${vision_context:+

## Product Vision (guide your review decisions)
${vision_context}}

## Review Checklist

### 1. Functional Completeness (MOST IMPORTANT)
- Does the implementation FULLY address the issue requirements?
- Are there any acceptance criteria that were NOT implemented?
- If backend API endpoints were created, are they called from the frontend?
- If frontend components were created, do they have working backend endpoints?
- Are there any dead code paths (created but never wired in)?
- Does the feature work end-to-end (data flows from UI → API → database → back to UI)?

### 2. Integration Gaps
- Are new routes/endpoints registered in the server entry point?
- Are new components imported and rendered in the app?
- Are new database tables/columns used by the API?
- Are there missing imports, missing route registrations, or orphaned files?

### 3. Code Quality
- Security issues (injection, XSS, auth bypass)
- Missing error handling for user-facing operations
- Missing tests for new functionality
- Code follows project conventions

### 4. UX Review
- Do UI changes match the target user profile?
- Are error states handled (loading, empty, error)?
- Is the feature discoverable (can users find it)?

## Actions

For any issues you find:
- CRITICAL (gaps, missing wiring, broken features): FIX THEM directly, run tests, commit with "fix: address review findings for #${issue_num}"
- WARNING (quality, security): FIX THEM directly if possible
- INFO (suggestions, minor improvements): Note them in your report but don't block

After fixing, output a structured review report:

### Findings Fixed
- (list what you found and fixed)

### Remaining Gaps
- (anything you couldn't fix — these need human attention)

### Verification Notes
- (what a human should manually check)
EOF
}

# ---------------------------------------------------------------------------
# Learning Loop -- extract learnings, aggregate, inject context
# ---------------------------------------------------------------------------

# Directory for learning files
LEARNINGS_DIR="${PROJECT_DIR}/learnings"

# Build the learning extraction prompt for Claude
build_learn_prompt() {
  local issue_num="$1" title="$2" status="$3" retries="$4" duration="$5"
  local diff="$6" test_output="$7" review_output="$8" verify_output="$9"
  local body="${10:-}"

  cat <<LEARNEOF
Analyze this completed development run. Output ONLY a markdown document with the exact structure below. Keep each section to 2-3 bullet points max. Be factual and concise -- no creative writing.

## Run Info
- Issue: #${issue_num} "${title}"
- Status: ${status}
- Retries: ${retries}
- Duration: ${duration}s

## Issue Requirements
${body:-"(no description)"}

## Code Changes
${diff:-"(no diff available)"}

## Test Results
${test_output:-"(no test output)"}

## Review Findings
${review_output:-"(no review output)"}

## Verification Results
${verify_output:-"(no verification output)"}

Output ONLY this markdown structure, nothing else:

---
issue: ${issue_num}
status: ${status}
retries: ${retries}
duration: ${duration}
date: $(date +%Y-%m-%d)
---
## What Worked
- (list what went well)

## What Failed
- (list what went wrong, or "Nothing" if all passed)

## Patterns
- (reusable patterns discovered)

## Anti-Patterns
- (mistakes to avoid in future)

## Suggested Skill Updates
- (specific skill file changes, or "None")
LEARNEOF
}

# Extract learnings from a completed run and save to learnings/ directory
run_learn() {
  local issue_num="$1" title="$2" status="$3" retries="$4" duration="$5"
  local diff="$6" test_output="$7" review_output="$8" verify_output="$9"
  local body="${10:-}"

  if [[ "$SKIP_LEARNINGS" == "true" ]]; then
    log_info "Skipping learning extraction (SKIP_LEARNINGS=true)"
    return 0
  fi

  log_step "Extracting learnings from run..."

  mkdir -p "$LEARNINGS_DIR"

  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)
  local learning_file="$LEARNINGS_DIR/issue-${issue_num}-${timestamp}.md"

  local prompt
  prompt=$(build_learn_prompt "$issue_num" "$title" "$status" "$retries" "$duration" \
    "$diff" "$test_output" "$review_output" "$verify_output" "$body")

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would extract learnings to $learning_file"
    return 0
  fi

  local learn_output
  learn_output=$(echo "$prompt" | claude -p \
    --model "${REVIEW_MODEL:-opus}" \
    --dangerously-skip-permissions \
    --output-format text \
    2>/dev/null) || {
    log_warn "Learning extraction failed, skipping"
    return 0
  }

  # Validate output has frontmatter
  if echo "$learn_output" | head -1 | grep -q "^---"; then
    echo "$learn_output" > "$learning_file"
    log_success "Learning saved to $learning_file"
  else
    # Wrap output with frontmatter if agent didn't include it
    cat > "$learning_file" <<FALLBACK
---
issue: ${issue_num}
status: ${status}
retries: ${retries}
duration: ${duration}
date: $(date +%Y-%m-%d)
---
${learn_output}
FALLBACK
    log_success "Learning saved to $learning_file (added frontmatter)"
  fi

  # Check if aggregation is due (every 5 learning files)
  local learning_count
  learning_count=$(find "$LEARNINGS_DIR" -maxdepth 1 -name "issue-*.md" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$learning_count" -gt 0 && $((learning_count % 5)) -eq 0 ]]; then
    log_info "Aggregation threshold reached ($learning_count learnings). Triggering aggregation..."
    run_aggregate || log_warn "Aggregation failed, will retry on next threshold"
  fi

  return 0
}

# Count learning files in the learnings/ directory
count_learnings() {
  find "$LEARNINGS_DIR" -maxdepth 1 -name "issue-*.md" -type f 2>/dev/null | wc -l | tr -d ' '
}

# Read the last N learning files (most recent first)
get_recent_learnings() {
  local count="${1:-5}"
  find "$LEARNINGS_DIR" -maxdepth 1 -name "issue-*.md" -type f 2>/dev/null \
    | sort -r \
    | head -n "$count"
}

# Extract anti-patterns from learning files
get_anti_patterns() {
  local files
  files=$(get_recent_learnings 10)
  if [[ -z "$files" ]]; then
    return 0
  fi

  echo "$files" | while IFS= read -r f; do
    if [[ -f "$f" ]]; then
      # Extract content between ## Anti-Patterns and the next ## heading
      sed -n '/^## Anti-Patterns$/,/^## /{/^## Anti-Patterns$/d;/^## /d;p}' "$f"
    fi
  done
}

# Build learning context to inject into implementation prompts
get_learning_context() {
  local recent_files
  recent_files=$(get_recent_learnings 5)

  if [[ -z "$recent_files" ]]; then
    return 0
  fi

  echo "## Learnings from Previous Runs"
  echo ""

  local i=0
  echo "$recent_files" | while IFS= read -r f; do
    if [[ -f "$f" ]]; then
      ((i++)) || true
      local issue_line
      issue_line=$(grep "^issue:" "$f" 2>/dev/null | head -1 | sed 's/issue: *//')
      local status_line
      status_line=$(grep "^status:" "$f" 2>/dev/null | head -1 | sed 's/status: *//')
      echo "### Run #${issue_line:-unknown} (${status_line:-unknown})"
      # Extract What Worked and What Failed sections (brief)
      sed -n '/^## What Worked$/,/^## /{/^## What Worked$/d;/^## /d;p}' "$f" 2>/dev/null
      sed -n '/^## What Failed$/,/^## /{/^## What Failed$/d;/^## /d;p}' "$f" 2>/dev/null
      echo ""
    fi
  done

  local anti_patterns
  anti_patterns=$(get_anti_patterns)
  if [[ -n "$anti_patterns" ]]; then
    echo ""
    echo "## Known Anti-Patterns to Avoid"
    echo "$anti_patterns"
  fi
}

# Aggregate learnings every N runs and propose skill/agent updates
run_aggregate() {
  log_step "Running learning aggregation..."

  mkdir -p "$LEARNINGS_DIR/proposed-updates"

  local all_learnings=""
  local files
  files=$(find "$LEARNINGS_DIR" -maxdepth 1 -name "issue-*.md" -type f 2>/dev/null | sort)

  if [[ -z "$files" ]]; then
    log_info "No learning files to aggregate"
    return 0
  fi

  # Collect all learning content
  while IFS= read -r f; do
    if [[ -f "$f" ]]; then
      all_learnings="${all_learnings}
---
$(cat "$f")
"
    fi
  done <<< "$files"

  # Read current skills and agents
  local skills_content=""
  if [[ -d "$PROJECT_DIR/.claude/skills" ]]; then
    for skill_file in "$PROJECT_DIR/.claude/skills"/*; do
      if [[ -f "$skill_file" ]]; then
        local skill_name
        skill_name=$(basename "$skill_file")
        skills_content="${skills_content}
### ${skill_name}
$(cat "$skill_file")
"
      fi
    done
  fi

  local agents_content=""
  if [[ -d "$PROJECT_DIR/.claude/agents" ]]; then
    for agent_file in "$PROJECT_DIR/.claude/agents"/*.md; do
      if [[ -f "$agent_file" ]]; then
        local agent_name
        agent_name=$(basename "$agent_file")
        agents_content="${agents_content}
### ${agent_name}
$(cat "$agent_file")
"
      fi
    done
  fi

  local aggregate_prompt
  aggregate_prompt=$(cat <<AGGEOF
Analyze the following accumulated learnings from automated development runs.
Identify repeated patterns and anti-patterns, then propose updates to skills and agents.

## All Learnings
${all_learnings}

## Current Skills
${skills_content:-"(no skills found)"}

## Current Agents
${agents_content:-"(no agents found)"}

## Instructions
1. Identify the top 5 most important patterns and anti-patterns
2. Generate a summary.md with the top patterns and anti-patterns
3. Propose specific updates to skills files (cite which issues led to each change)
4. Propose specific updates to agent files (cite which issues led to each change)

Output THREE sections separated by ===SECTION===:
1. summary.md content (markdown)
2. Skills updates as JSON array: [{"file": "skill-name", "changes": "description of changes", "reason": "citing issue numbers"}]
3. Agent updates as JSON array: [{"file": "agent-name.md", "changes": "description of changes", "reason": "citing issue numbers"}]
AGGEOF
)

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run learning aggregation"
    return 0
  fi

  local agg_output
  agg_output=$(echo "$aggregate_prompt" | claude -p \
    --model "${REVIEW_MODEL:-opus}" \
    --dangerously-skip-permissions \
    --output-format text \
    2>/dev/null) || {
    log_warn "Learning aggregation failed"
    return 1
  }

  # Save summary
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)

  # Extract summary section (everything before first ===SECTION===)
  local summary
  summary=$(echo "$agg_output" | sed '/===SECTION===/,$d')
  if [[ -n "$summary" ]]; then
    echo "$summary" > "$LEARNINGS_DIR/summary.md"
    log_success "Updated learnings/summary.md"
  fi

  # Save proposed updates
  local skills_update
  skills_update=$(echo "$agg_output" | sed -n '/===SECTION===/,/===SECTION===/{//!p}' | head -50)
  if [[ -n "$skills_update" ]]; then
    echo "$skills_update" > "$LEARNINGS_DIR/proposed-updates/${timestamp}-skills-update.md"
    log_success "Saved proposed skills update"
  fi

  local agents_update
  agents_update=$(echo "$agg_output" | awk '/===SECTION===/{n++} n==2' | head -50)
  if [[ -n "$agents_update" ]]; then
    echo "$agents_update" > "$LEARNINGS_DIR/proposed-updates/${timestamp}-agents-update.md"
    log_success "Saved proposed agents update"
  fi

  # Create a PR with proposed improvements (if we're in a git repo)
  if command -v gh &>/dev/null && [[ -d "$PROJECT_DIR/.git" ]]; then
    local improve_branch="improve/learnings-${timestamp}"
    (
      cd "$PROJECT_DIR"
      git checkout -b "$improve_branch" 2>/dev/null || true
      git add learnings/summary.md learnings/proposed-updates/ 2>/dev/null || true
      if git diff --cached --quiet 2>/dev/null; then
        log_info "No changes to commit for improvement PR"
      else
        git commit -m "improve: learning aggregation from $(count_learnings) runs

Automated aggregation of development learnings.
Includes proposed updates to skills and agents." 2>/dev/null || true

        gh pr create \
          --title "improve: Learning aggregation - proposed skill/agent updates" \
          --body "## Learning Aggregation

Based on $(count_learnings) completed runs, this PR proposes updates to skills and agents.

### Summary
See \`learnings/summary.md\` for the top patterns and anti-patterns.

### Proposed Updates
See \`learnings/proposed-updates/\` for specific change proposals.

**DO NOT auto-merge** — these need human review.

---
Automated by alpha-loop learning system" \
          --base "$BASE_BRANCH" 2>/dev/null || true

        # Return to original branch
        git checkout - 2>/dev/null || true
      fi
    )
  fi

  # Refresh project context after aggregation (learnings may have changed what matters)
  generate_project_context || true

  log_success "Learning aggregation complete"
  return 0
}

# ---------------------------------------------------------------------------
# Pipeline Steps
# ---------------------------------------------------------------------------

# Planning stage: analyze the issue, enrich with acceptance criteria, update on GitHub
run_plan() {
  local issue_num="$1" title="$2" body="$3" worktree="$4" log_file="$5"

  log_step "Planning issue #$issue_num: $title"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run planning stage"
    return 0
  fi

  local vision_context=""
  vision_context=$(get_vision_context 2>/dev/null) || true
  local project_context=""
  project_context=$(get_project_context 2>/dev/null) || true

  local plan_prompt
  plan_prompt=$(cat <<PLANEOF
You are a senior developer planning the implementation of a GitHub issue. Your job is to:

1. Analyze the issue and understand what needs to be done
2. Explore the codebase to understand the relevant files and patterns
3. Create a structured implementation plan with clear acceptance criteria

## Issue #${issue_num}: ${title}

${body}
${vision_context:+

## Product Vision
${vision_context}}
${project_context:+

## Technical Context
${project_context}}

## Your Task

Read the codebase, understand the issue, and output a structured plan in this EXACT format:

---

## Understanding
(2-3 sentences explaining what the issue is really asking for and why)

## Acceptance Criteria
- [ ] (specific, testable criterion 1)
- [ ] (specific, testable criterion 2)
- [ ] (etc.)

## Implementation Plan
1. (specific file to modify and what to change)
2. (specific file to modify and what to change)
3. (etc.)

## Test Plan
- (what tests to write or update)
- (how to verify the fix works)

## What to Test Manually
- (step-by-step instructions a human can follow to verify)
- (include URLs, clicks, expected results)

## Risks
- (anything that could go wrong or needs careful handling)

---

IMPORTANT:
- Read the actual code before planning. Don't guess at file names or structures.
- Be specific: name exact files, functions, and line numbers where possible.
- The acceptance criteria should be things that can be verified programmatically or visually.
- Do NOT make any code changes. This is planning only.
PLANEOF
)

  log_info "Agent: claude | Model: $MODEL | Planning (read-only)"

  local plan_output
  plan_output=$(cd "$worktree" && echo "$plan_prompt" | claude -p \
    --model "$MODEL" \
    --dangerously-skip-permissions \
    --output-format text \
    2>&1) || true

  echo "$plan_output" | tee -a "$log_file"

  # Extract the plan to update the GitHub issue with enriched description
  if [[ -n "$plan_output" ]]; then
    # Update the issue on GitHub with the plan appended
    local enriched_body
    enriched_body="${body}

---

## Agent Planning Notes

${plan_output}"

    # Update the issue description on GitHub (preserves original, appends plan)
    gh issue edit "$issue_num" --repo "$REPO" --body "$enriched_body" 2>/dev/null || {
      log_warn "Could not update issue #$issue_num with plan (non-fatal)"
    }
    log_success "Updated issue #$issue_num with implementation plan"

    # Save the enriched body so implement stage uses it
    ENRICHED_BODY="$enriched_body"
  fi
}

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
  log_info "Agent: claude | Model: $MODEL | CWD: $worktree"

  (cd "$worktree" && echo "$prompt" | claude -p \
    --model "$MODEL" \
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
  local test_cmd="${CONFIG_TEST_COMMAND:-pnpm test}"

  if [[ "$SKIP_TESTS" == "true" ]]; then
    log_info "Skipping tests (SKIP_TESTS=true)"
    echo "Tests skipped"
    return 0
  fi

  log_step "Running tests in worktree"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run: $test_cmd"
    echo "Tests skipped (dry run)"
    return 0
  fi

  # Set RECORD_FIXTURES when --run-full is requested so tests hit real APIs
  local test_env=""
  if [[ "$RUN_FULL" == "true" ]]; then
    test_env="RECORD_FIXTURES=true"
    log_info "Running tests in full mode (RECORD_FIXTURES=true, real API calls)"
  else
    log_info "Running tests with cached API responses"
  fi

  # Run the configured test command
  log_info "Test command: $test_cmd"
  set +e
  if (cd "$worktree" && env $test_env eval "$test_cmd" 2>&1 | tee -a "$log_file"); then
    log_success "Tests passed"
  else
    log_warn "Tests had failures"
    test_passed=false
  fi
  set -e

  if [[ "$test_passed" == "false" ]]; then
    # If we have a preflight ignore file, check if all failures are pre-existing
    if [[ -n "$PREFLIGHT_IGNORE_FILE" && -f "$PREFLIGHT_IGNORE_FILE" ]]; then
      local new_failures=false
      local combined_output
      combined_output=$(cat "$log_file" 2>/dev/null || echo "")

      # Extract current failing test names
      local current_failures
      current_failures=$(echo "$combined_output" | grep -E "^[[:space:]]*● " | sed 's/^[[:space:]]*//' || true)

      if [[ -n "$current_failures" ]]; then
        while IFS= read -r failure; do
          if ! grep -qF "$failure" "$PREFLIGHT_IGNORE_FILE" 2>/dev/null; then
            new_failures=true
            break
          fi
        done <<< "$current_failures"
      else
        # No ● lines found -- can't determine, treat as new failures
        new_failures=true
      fi

      if [[ "$new_failures" == "false" ]]; then
        log_info "All failures are pre-existing (ignored by preflight). Treating as pass."
        return 0
      fi
    fi

    log_error "Some tests failed"
    return 1
  fi

  log_success "All tests passed"
  return 0
}

run_e2e_tests() {
  local worktree="$1" log_file="$2"

  if [[ "$SKIP_E2E" == "true" ]]; then
    log_info "Skipping E2E tests (SKIP_E2E=true)"
    echo "E2E tests skipped"
    return 0
  fi

  if [[ "$SKIP_TESTS" == "true" ]]; then
    log_info "Skipping E2E tests (SKIP_TESTS=true)"
    echo "E2E tests skipped"
    return 0
  fi

  log_step "Running Playwright E2E tests"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run pnpm test:e2e"
    echo "E2E tests skipped (dry run)"
    return 0
  fi

  log_info "Running E2E tests..."
  if (cd "$worktree" && pnpm test:e2e 2>&1 | tee -a "$log_file"); then
    log_success "E2E tests passed"
    return 0
  else
    log_error "E2E tests failed"
    return 1
  fi
}

run_verify() {
  local worktree="$1" log_file="$2" issue_num="$3" title="$4" body="$5"

  if [[ "$SKIP_VERIFY" == "true" ]]; then
    log_info "Skipping verification (SKIP_VERIFY=true)"
    echo "Verification skipped"
    return 0
  fi

  log_step "Running live verification for issue #$issue_num"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_dry "Would run live verification"
    echo "Verification skipped (dry run)"
    return 0
  fi

  # Check if playwright-cli is available
  if ! command -v playwright-cli &>/dev/null; then
    log_warn "playwright-cli not installed. Install with: npm install -g @playwright/cli@latest"
    log_info "Skipping live verification (no playwright-cli)"
    echo "Verification skipped (playwright-cli not installed)"
    return 0
  fi

  # Detect how to start the app
  local dev_cmd="${CONFIG_DEV_COMMAND:-}"
  local start_script=""
  if [[ -z "$dev_cmd" ]]; then
    for script_name in dev start preview; do
      if grep -q "\"$script_name\":" "$worktree/package.json" 2>/dev/null; then
        start_script="$script_name"
        dev_cmd="pnpm $script_name"
        break
      fi
    done
  fi

  if [[ -z "$dev_cmd" ]]; then
    log_info "No dev/start/preview command found, skipping verification"
    echo "Verification skipped (no start command)"
    return 0
  fi

  # Detect port from package.json scripts or dev script
  local port=3000
  set +e
  local pkg_port=""
  if [[ -f "$worktree/package.json" ]]; then
    pkg_port=$(grep -oE 'PORT[=:-]+[[:space:]]*[0-9]{4}|--port[[:space:]]+[0-9]{4}|-p[[:space:]]+[0-9]{4}' "$worktree/package.json" "$worktree/scripts/dev.sh" 2>/dev/null | grep -oE '[0-9]{4}' | head -1) || true
  fi
  set -e
  [[ -n "$pkg_port" ]] && port="$pkg_port"

  # Start the app in the background
  log_info "Starting app with '$dev_cmd' on port $port..."
  local app_pid=""
  (cd "$worktree" && PORT="$port" eval "$dev_cmd" >> "$log_file" 2>&1) &
  app_pid=$!

  # Wait for app to be ready (up to 60s)
  local ready=false
  for i in $(seq 1 60); do
    if curl -s -o /dev/null "http://localhost:$port" 2>/dev/null; then
      ready=true
      break
    fi
    if ! kill -0 "$app_pid" 2>/dev/null; then
      log_error "App process exited before becoming ready"
      echo "App failed to start"
      return 1
    fi
    sleep 1
  done

  if [[ "$ready" != "true" ]]; then
    log_error "App did not become ready on port $port within 60s"
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
    echo "App failed to start on port $port"
    return 1
  fi

  log_success "App is ready on port $port"

  # Load saved auth state if it exists
  local auth_state_dir="${PROJECT_DIR}/.alpha-loop/auth"
  if [[ -d "$auth_state_dir" ]]; then
    log_info "Loading saved auth state..."
    playwright-cli state-load "$auth_state_dir/state.json" 2>/dev/null || true
  fi

  # Get the diff to understand what changed
  local diff_stat=""
  diff_stat=$(cd "$worktree" && git diff --stat "origin/$BASE_BRANCH...HEAD" 2>/dev/null) || true

  # Get vision context
  local vision_context=""
  vision_context=$(get_vision_context 2>/dev/null) || true

  # Build the verification prompt — agent uses playwright-cli to test the app
  local verify_prompt
  verify_prompt=$(cat <<VERIFYEOF
You are a QA tester verifying that issue #${issue_num} was implemented correctly.

## Issue: ${title}

${body}

## What Changed
${diff_stat}

${vision_context:+## Product Vision
${vision_context}
}
## Your Task

The app is running at http://localhost:${port}. Use the playwright-cli to test it.

### Playwright CLI Commands Available
- \`playwright-cli open http://localhost:${port}\` — Open the app in a browser
- \`playwright-cli goto <url>\` — Navigate to a page
- \`playwright-cli snapshot\` — Get a snapshot of the current page with element refs
- \`playwright-cli click <ref>\` — Click an element (use ref from snapshot, e.g. \`e15\`)
- \`playwright-cli type <text>\` — Type text into the focused element
- \`playwright-cli screenshot\` — Take a screenshot of the current page
- \`playwright-cli fill <ref> <text>\` — Fill a form field
- \`playwright-cli select <ref> <value>\` — Select a dropdown option
- \`playwright-cli wait <selector>\` — Wait for an element to appear
- \`playwright-cli console\` — Check browser console for errors
- \`playwright-cli network\` — Check network requests/responses

### Testing Steps

1. Open the app: \`playwright-cli open http://localhost:${port}\`
2. Take a snapshot to see the page structure: \`playwright-cli snapshot\`
3. Navigate to the feature that was changed
4. Test the ACTUAL user flow described in the issue:
   - Can you do what the issue says should work?
   - Does the UI render correctly?
   - Do form submissions work end-to-end?
   - Check console for errors: \`playwright-cli console\`
   - Check network for failed requests: \`playwright-cli network\`
5. Take screenshots at key states: \`playwright-cli screenshot\`
6. Check for functional gaps:
   - Is the backend wired to the frontend?
   - Are there UI elements that don't respond?
   - Does data persist after submission?

### Auth / Login
${auth_state_dir:+Auth state is pre-loaded. If you need to log in, use the credentials from the environment or .env file.}

## Report

After testing, output a verification report:

### Status: PASS or FAIL

### What Was Tested
- (list each action you took with playwright-cli)

### What Worked
- (list what functioned correctly)

### What Failed
- (list what didn't work, with details and screenshots)

### Console Errors
- (any browser console errors found)

### Network Issues
- (any failed API calls or missing endpoints)

### Gaps Found
- (any disconnects between frontend and backend, missing pieces, etc.)

IMPORTANT: Use playwright-cli commands to actually interact with the app.
Navigate, click, type, submit forms. Verify the feature works as a real user would use it.
VERIFYEOF
)

  log_info "Verification agent: claude + playwright-cli | Testing live at http://localhost:$port"

  # Save screenshots to session directory
  local screenshot_dir="${PROJECT_DIR}/sessions/${SESSION_NAME}/screenshots/issue-${issue_num}"
  mkdir -p "$screenshot_dir"

  local verify_output
  set +e
  verify_output=$(cd "$worktree" && \
    PLAYWRIGHT_SCREENSHOTS_DIR="$screenshot_dir" \
    echo "$verify_prompt" | claude -p \
    --model "$MODEL" \
    --dangerously-skip-permissions \
    --verbose \
    --output-format text \
    2>&1)
  local verify_exit=$?
  set -e

  echo "$verify_output" | tee -a "$log_file"

  # Save verification output for the PR
  VERIFY_OUTPUT="$verify_output"

  # Kill the app process and its children
  log_info "Shutting down app (PID $app_pid)..."
  kill "$app_pid" 2>/dev/null || true
  pkill -P "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true

  # Close playwright-cli browser sessions
  playwright-cli close-all 2>/dev/null || true

  # Check if verification passed based on agent output
  set +e
  if echo "$verify_output" | grep -qi "Status:.*FAIL"; then
    log_error "Live verification FAILED"
    set -e
    return 1
  elif echo "$verify_output" | grep -qi "Status:.*PASS"; then
    log_success "Live verification PASSED"
    set -e
    return 0
  else
    if [[ "$verify_exit" -eq 0 ]]; then
      log_success "Verification completed (agent exit 0)"
      set -e
      return 0
    else
      log_warn "Verification unclear (agent exit $verify_exit)"
      set -e
      return 1
    fi
  fi
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

generate_what_to_test() {
  local issue_num="$1" body="$2" worktree="$3"
  local manual_test_section=""

  # Try to extract manual test instructions from the issue body
  # Look for a "Manual Test Instructions" section (from the issue template)
  manual_test_section=$(echo "$body" | sed -n '/### Manual Test Instructions/,/### /{ /### Manual Test Instructions/d; /### [^M]/d; p; }' | sed '/^$/d')

  if [[ -n "$manual_test_section" ]]; then
    echo "$manual_test_section"
    return 0
  fi

  # Fallback: generate from the diff
  local diff_stat
  diff_stat=$(cd "$worktree" && git diff "origin/$BASE_BRANCH...HEAD" --stat 2>/dev/null || echo "No diff available")

  local new_endpoints
  new_endpoints=$(cd "$worktree" && git diff "origin/$BASE_BRANCH...HEAD" -- '*.ts' '*.js' 2>/dev/null | grep -E '^\+.*(app\.(get|post|put|delete|patch)|router\.(get|post|put|delete|patch))' | sed 's/^\+//' || echo "")

  local new_components
  new_components=$(cd "$worktree" && git diff "origin/$BASE_BRANCH...HEAD" -- '*.tsx' '*.jsx' 2>/dev/null | grep -E '^\+.*export.*(function|const)' | sed 's/^\+//' || echo "")

  cat <<TESTEOF
_Auto-generated from diff — no manual test instructions were provided in the issue._

**Changed files:**
\`\`\`
${diff_stat}
\`\`\`
TESTEOF

  if [[ -n "$new_endpoints" ]]; then
    cat <<TESTEOF

**New/modified endpoints detected:**
\`\`\`
${new_endpoints}
\`\`\`
TESTEOF
  fi

  if [[ -n "$new_components" ]]; then
    cat <<TESTEOF

**New/modified UI components detected:**
\`\`\`
${new_components}
\`\`\`
TESTEOF
  fi
}

create_pr() {
  local issue_num="$1" title="$2" worktree="$3" review="$4" test_output="$5" body="${6:-}"
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
  # Generate "What to Test" section
  local what_to_test
  what_to_test=$(generate_what_to_test "$issue_num" "$body" "$worktree")

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

## What to Test

${what_to_test}

---
Automated by [agent-loop](scripts/loop.sh) | [Issue #${issue_num}](https://github.com/${REPO}/issues/${issue_num})
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

## What to Test

${what_to_test}

---
Automated by [agent-loop](scripts/loop.sh) | [Issue #${issue_num}](https://github.com/${REPO}/issues/${issue_num})
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

  # Switch to session branch and pull latest so:
  # 1. Next worktree branches from the merged code (stacking)
  # 2. Local dev server hot-reloads with the new changes
  git -C "$PROJECT_DIR" fetch origin 2>/dev/null || true
  local current_branch
  current_branch=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  if [[ "$current_branch" != "$SESSION_BRANCH" ]]; then
    log_info "Switching to session branch: $SESSION_BRANCH"
    git -C "$PROJECT_DIR" checkout "$SESSION_BRANCH" 2>/dev/null || true
  fi
  git -C "$PROJECT_DIR" pull origin "$SESSION_BRANCH" 2>/dev/null || true
  log_info "Local repo updated — hot reload should pick up changes"
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

  # Setup logging -- write to sessions/{name}/logs/
  local session_logs_dir="$PROJECT_DIR/sessions/$SESSION_NAME/logs"
  mkdir -p "$session_logs_dir"
  log_file="$session_logs_dir/issue-${issue_num}.log"

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

  # Step 3: Plan (analyze issue, enrich with acceptance criteria)
  ENRICHED_BODY=""
  run_plan "$issue_num" "$title" "$body" "$worktree" "$log_file" || {
    log_warn "Planning stage failed, proceeding with original issue description"
  }
  # Use enriched body if planning produced one, otherwise use original
  local impl_body="${ENRICHED_BODY:-$body}"

  # Step 4: Implement
  if ! run_implement "$issue_num" "$title" "$impl_body" "$worktree" "$log_file"; then
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

  # Step 5: Build verification (Playwright or API checks)
  local verify_output=""
  local verify_passing=false
  if [[ "$SKIP_VERIFY" != "true" && "$SKIP_TESTS" != "true" && "$DRY_RUN" != "true" ]]; then
    for verify_attempt in $(seq 1 "$MAX_TEST_RETRIES"); do
      log_info "Verification attempt $verify_attempt of $MAX_TEST_RETRIES"

      if verify_output=$(run_verify "$worktree" "$log_file" "$issue_num" "$title" "$impl_body" 2>&1); then
        verify_passing=true
        log_success "Verification passed on attempt $verify_attempt"
        break
      fi

      if [[ "$verify_attempt" -lt "$MAX_TEST_RETRIES" ]]; then
        log_warn "Verification failed on attempt $verify_attempt, invoking Claude to fix..."
        local verify_fix_prompt="Build verification failed after implementing issue #${issue_num}.
The app was started and tested, but verification failed.

Verification output:
${verify_output}

Instructions:
1. Read the verification test files in tests/verify/ (if they exist)
2. Fix the implementation code OR the verification tests
3. Run pnpm test to make sure unit tests still pass
4. Commit your fixes with message: fix: resolve verification failures for issue #${issue_num}"

        (cd "$worktree" && echo "$verify_fix_prompt" | claude -p \
          --model "$MODEL" \
          --verbose \
          --dangerously-skip-permissions \
          --output-format text \
          2>&1) | tee -a "$log_file"

        # Commit any uncommitted fixes
        local uncommitted_verify
        uncommitted_verify=$(cd "$worktree" && git status --porcelain | wc -l | tr -d ' ')
        if [[ "$uncommitted_verify" -gt 0 ]]; then
          (cd "$worktree" && git add -A && git commit -m "fix: resolve verification failures for issue #${issue_num}") || true
        fi
      else
        log_warn "Verification still failing after $MAX_TEST_RETRIES attempts"
      fi
    done
  else
    verify_passing=true
    log_info "Verification skipped"
  fi

  # Step 6: Code review (sets REVIEW_OUTPUT global)
  REVIEW_OUTPUT=""
  run_review "$issue_num" "$title" "$body" "$worktree" "$log_file" || {
    log_warn "Code review failed, continuing without review"
    REVIEW_OUTPUT="Code review could not be completed"
  }

  # Step 7: Create PR (sets PR_URL global)
  PR_URL=""
  if ! create_pr "$issue_num" "$title" "$worktree" "$REVIEW_OUTPUT" "$test_output" "$body"; then
    log_error "Failed to create PR for issue #$issue_num"
    label_issue "$issue_num" "failed" "in-progress" || true
    comment_issue "$issue_num" "Agent loop failed: could not create PR. Branch: agent/issue-${issue_num}" || true
    cleanup_worktree "$issue_num"
    return 1
  fi

  # Step 8: Update issue
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

  # Step 9: Extract learnings
  end_time=$(date +%s)
  duration=$((end_time - start_time))

  local run_status="success"
  [[ "$tests_passing" != "true" ]] && run_status="failure"

  # Gather the diff for learning analysis
  local run_diff=""
  run_diff=$(cd "$worktree" && git diff "origin/$BASE_BRANCH...HEAD" 2>/dev/null | head -500) || true

  run_learn "$issue_num" "$title" "$run_status" "$attempt" "$duration" \
    "$run_diff" "$test_output" "${REVIEW_OUTPUT:-}" "${verify_output:-}" "$body" || true

  # Step 9b: Update project context and save session result for next issue
  local files_changed_count
  files_changed_count=$(echo "$run_diff" | grep -c "^diff --git" 2>/dev/null) || files_changed_count=0
  local files_summary
  files_summary=$(cd "$worktree" && git diff --stat "origin/$BASE_BRANCH...HEAD" 2>/dev/null | tail -1) || files_summary="${files_changed_count} files"
  update_context_after_run "$issue_num" "$title" "$run_status" "$files_changed_count" || true
  save_session_result "$issue_num" "$title" "$run_status" "$files_summary" || true

  # Emit SSE event for learning extraction
  if command -v curl &>/dev/null && [[ -n "${API_URL:-}" ]]; then
    local learn_count
    learn_count=$(count_learnings)
    curl -s -X POST "${API_URL}/api/stream" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"learning\",\"data\":{\"issue\":${issue_num},\"count\":${learn_count},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}}" || true
  fi

  # Step 10: Auto-merge if enabled
  merge_pr "$issue_num" || true

  # Step 11: Cleanup worktree (keep branch for PR if not merged)
  cleanup_worktree "$issue_num"

  log_success "Issue #$issue_num processed in ${duration}s"
  log_info "PR: $PR_URL"
  log_info "Log: $log_file"

  return 0
}

# ---------------------------------------------------------------------------
# History Subcommand
# ---------------------------------------------------------------------------
run_history() {
  local sessions_dir="$PROJECT_DIR/sessions"

  # --clean: delete sessions older than 30 days
  if [[ "$HISTORY_CLEAN" == "true" ]]; then
    history_clean "$sessions_dir"
    return 0
  fi

  # history <name> -- show detail for a specific session
  if [[ -n "$HISTORY_ARG" ]]; then
    # --qa flag: print QA checklist
    if [[ "$HISTORY_QA" == "true" ]]; then
      history_show_qa "$sessions_dir" "$HISTORY_ARG"
    else
      history_show_detail "$sessions_dir" "$HISTORY_ARG"
    fi
    return 0
  fi

  # history -- list all sessions
  history_list "$sessions_dir"
}

history_list() {
  local sessions_dir="$1"

  if [[ ! -d "$sessions_dir" ]]; then
    echo "No sessions found."
    return 0
  fi

  echo "Sessions:"

  # Find all session.yaml files, parse and display
  while IFS= read -r yaml_file; do
    [[ -z "$yaml_file" ]] && continue
    local session_dir
    session_dir=$(dirname "$yaml_file")
    local name date issue_count success_count failed_count duration

    name=$(grep -E '^name:' "$yaml_file" | head -1 | sed 's/^name:[[:space:]]*//')
    date=$(grep -E '^started:' "$yaml_file" | head -1 | sed 's/^started:[[:space:]]*//' | cut -c1-10)
    duration=$(grep -E '^duration:' "$yaml_file" | head -1 | sed 's/^duration:[[:space:]]*//')
    issue_count=$(grep -cE '^[[:space:]]*- number:' "$yaml_file" 2>/dev/null || echo "0")
    success_count=$(grep -cE 'status:[[:space:]]*success' "$yaml_file" 2>/dev/null || echo "0")
    failed_count=$(grep -cE 'status:[[:space:]]*failed' "$yaml_file" 2>/dev/null || echo "0")

    # Format duration
    local dur_str=""
    if [[ -n "$duration" && "$duration" -gt 0 ]] 2>/dev/null; then
      local mins=$((duration / 60))
      local secs=$((duration % 60))
      if [[ $mins -gt 0 ]]; then
        dur_str="${mins}m $(printf '%02d' $secs)s"
      else
        dur_str="${secs}s"
      fi
    fi

    # Format issue word
    local issue_word="issues"
    [[ "$issue_count" -eq 1 ]] && issue_word="issue"

    # Format status
    local status_parts=""
    [[ "$success_count" -gt 0 ]] && status_parts="${success_count} \u2713"
    [[ "$failed_count" -gt 0 ]] && status_parts="$status_parts ${failed_count} \u2717"

    printf "  %-30s %s  %s %-7s %-10s %s\n" \
      "${name:-unknown}" "${date:-????-??-??}" "$issue_count" "$issue_word" "$status_parts" "$dur_str"

  done < <(find "$sessions_dir" -name "session.yaml" -type f 2>/dev/null | sort -r)
}

history_show_detail() {
  local sessions_dir="$1" session_name="$2"
  local session_dir="$sessions_dir/$session_name"
  local yaml_file="$session_dir/session.yaml"

  if [[ ! -f "$yaml_file" ]]; then
    log_error "Session not found: $session_name"
    return 1
  fi

  local name repo started duration model
  name=$(grep -E '^name:' "$yaml_file" | head -1 | sed 's/^name:[[:space:]]*//')
  repo=$(grep -E '^repo:' "$yaml_file" | head -1 | sed 's/^repo:[[:space:]]*//')
  started=$(grep -E '^started:' "$yaml_file" | head -1 | sed 's/^started:[[:space:]]*//')
  duration=$(grep -E '^duration:' "$yaml_file" | head -1 | sed 's/^duration:[[:space:]]*//')
  model=$(grep -E '^model:' "$yaml_file" | head -1 | sed 's/^model:[[:space:]]*//')

  # Format date
  local date_display="${started:0:10} ${started:11:5}"

  # Format duration
  local dur_str=""
  if [[ -n "$duration" && "$duration" -gt 0 ]] 2>/dev/null; then
    local mins=$((duration / 60))
    local secs=$((duration % 60))
    if [[ $mins -gt 0 ]]; then
      dur_str="${mins}m $(printf '%02d' $secs)s"
    else
      dur_str="${secs}s"
    fi
  fi

  echo "Session: ${name:-$session_name}"
  echo "Date:    $date_display"
  [[ -n "$repo" ]] && echo "Repo:    $repo"
  [[ -n "$model" ]] && echo "Model:   $model"
  echo "Duration: $dur_str"
  echo ""

  # Parse and display issues
  echo "Issues:"

  # Use a simple line-by-line parser for the issues array
  local in_issues=false
  local num="" status="" pr_url="" error="" issue_dur=""
  while IFS= read -r line; do
    if [[ "$line" =~ ^issues: ]]; then
      in_issues=true
      continue
    fi
    if [[ "$in_issues" == false ]]; then
      continue
    fi
    # End of issues section if we hit a non-indented line
    if [[ "$in_issues" == true && ! "$line" =~ ^[[:space:]] && -n "$line" ]]; then
      break
    fi

    if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*number:[[:space:]]*(.*) ]]; then
      # Emit previous issue if we have one
      if [[ -n "$num" ]]; then
        _emit_issue_line "$num" "$status" "$pr_url" "$error" "$issue_dur"
      fi
      num="${BASH_REMATCH[1]}"
      status="" pr_url="" error="" issue_dur=""
    elif [[ "$line" =~ ^[[:space:]]*status:[[:space:]]*(.*) ]]; then
      status="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^[[:space:]]*pr_url:[[:space:]]*(.*) ]]; then
      pr_url="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^[[:space:]]*error:[[:space:]]*(.*) ]]; then
      error="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^[[:space:]]*duration:[[:space:]]*(.*) ]]; then
      issue_dur="${BASH_REMATCH[1]}"
    fi
  done < "$yaml_file"

  # Emit last issue
  if [[ -n "$num" ]]; then
    _emit_issue_line "$num" "$status" "$pr_url" "$error" "$issue_dur"
  fi

  echo ""
  echo "QA Checklist: sessions/$session_name/qa-checklist.md"
  echo "Logs:         sessions/$session_name/logs/"
}

_emit_issue_line() {
  local num="$1" status="$2" pr_url="$3" error="$4" dur="$5"

  local symbol status_text dur_str=""

  case "$status" in
    success) symbol="\u2713" ;;
    failed)  symbol="\u2717" ;;
    *)       symbol="\u2298" ;;
  esac

  if [[ "$status" == "success" && -n "$pr_url" ]]; then
    local pr_num
    pr_num=$(echo "$pr_url" | grep -oE '[0-9]+$')
    status_text="PR #${pr_num}"
  elif [[ "$status" == "failed" ]]; then
    status_text="FAILED"
  else
    status_text="SKIPPED"
  fi

  if [[ -n "$dur" && "$dur" -gt 0 ]] 2>/dev/null; then
    local mins=$((dur / 60))
    local secs=$((dur % 60))
    if [[ $mins -gt 0 ]]; then
      dur_str="${mins}m $(printf '%02d' $secs)s"
    else
      dur_str="${secs}s"
    fi
  fi

  local line
  printf -v line "  %b #%-4s %-9s (%s)" "$symbol" "$num" "$status_text" "$dur_str"
  if [[ -n "$error" ]]; then
    line="$line \u2014 $error"
  fi
  echo -e "$line"
}

history_show_qa() {
  local sessions_dir="$1" session_name="$2"
  local qa_file="$sessions_dir/$session_name/qa-checklist.md"

  if [[ ! -f "$qa_file" ]]; then
    log_error "QA checklist not found for session: $session_name"
    return 1
  fi

  cat "$qa_file"
}

history_clean() {
  local sessions_dir="$1"
  local cutoff_epoch
  cutoff_epoch=$(date -v-30d +%s 2>/dev/null || date -d "30 days ago" +%s 2>/dev/null)

  if [[ ! -d "$sessions_dir" ]]; then
    echo "No sessions found."
    return 0
  fi

  local removed=0
  while IFS= read -r yaml_file; do
    [[ -z "$yaml_file" ]] && continue
    local session_dir started session_epoch
    session_dir=$(dirname "$yaml_file")
    started=$(grep -E '^started:' "$yaml_file" | head -1 | sed 's/^started:[[:space:]]*//')

    if [[ -z "$started" ]]; then
      continue
    fi

    # Parse date to epoch (strip milliseconds if present, e.g. .310Z -> Z)
    local clean_started="${started%.*Z}Z"
    [[ "$started" != *"."*"Z" ]] && clean_started="$started"
    session_epoch=$(date -jf "%Y-%m-%dT%H:%M:%SZ" "$clean_started" +%s 2>/dev/null || \
                    date -d "$started" +%s 2>/dev/null || echo "0")

    if [[ "$session_epoch" -gt 0 && "$session_epoch" -lt "$cutoff_epoch" ]]; then
      local name
      name=$(grep -E '^name:' "$yaml_file" | head -1 | sed 's/^name:[[:space:]]*//')
      rm -rf "$session_dir"
      echo "Removed: ${name:-$session_dir}"
      ((removed++))
    fi
  done < <(find "$sessions_dir" -name "session.yaml" -type f 2>/dev/null)

  if [[ $removed -eq 0 ]]; then
    echo "No sessions older than 30 days found."
  else
    echo "Removed $removed session(s)."
  fi
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
  echo -e "  Skip Preflight:${BOLD}$SKIP_PREFLIGHT${NC}"
  echo -e "  Skip Tests:    ${BOLD}$SKIP_TESTS${NC}"
  echo -e "  Skip Review:   ${BOLD}$SKIP_REVIEW${NC}"
  echo -e "  Skip Learnings:${BOLD}$SKIP_LEARNINGS${NC}"
  echo -e "  Test Retries:  ${BOLD}$MAX_TEST_RETRIES${NC}"
  echo -e "  Auto Merge:    ${BOLD}$AUTO_MERGE${NC}"
  echo -e "  Merge To:      ${BOLD}${SESSION_BRANCH}${NC}"
  echo ""

  # Verify prerequisites
  check_prerequisites

  # Change to project directory
  cd "$PROJECT_DIR"

  # Pre-flight test validation
  run_preflight

  # Prompt for project vision if it doesn't exist (interactive only)
  if ! has_vision && [[ -t 0 ]]; then
    echo ""
    echo -e "${YELLOW}[WARN]${NC} No project vision found. The agent will make better decisions with one."
    read -r -p "Set up project vision now? [Y/n]: " vision_choice
    if [[ "$vision_choice" != "n" && "$vision_choice" != "N" ]]; then
      run_vision
    fi
  fi

  # Generate or refresh project context if needed
  if context_needs_refresh; then
    generate_project_context
  else
    log_info "Project context is fresh ($(basename "$CONTEXT_FILE"))"
  fi

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
  # Clean up preflight ignore file if it exists
  if [[ -n "${PREFLIGHT_IGNORE_FILE:-}" && -f "$PREFLIGHT_IGNORE_FILE" ]]; then
    rm -f "$PREFLIGHT_IGNORE_FILE" 2>/dev/null || true
  fi
  log_info "Agent loop stopped. Processed $ISSUES_PROCESSED issue(s)."
}
trap cleanup_on_exit EXIT

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

# Handle init subcommand before applying config (init doesn't need full config)
if [[ "$SUBCOMMAND" == "init" ]]; then
  run_init
  exit 0
fi

# Handle scan subcommand -- generate project context
if [[ "$SUBCOMMAND" == "scan" ]]; then
  generate_project_context
  if [[ -f "$CONTEXT_FILE" ]]; then
    echo ""
    cat "$CONTEXT_FILE"
  fi
  exit 0
fi

# Handle vision subcommand -- interactive project vision setup
if [[ "$SUBCOMMAND" == "vision" ]]; then
  run_vision
  exit 0
fi

# Handle auth subcommand -- save authenticated browser state for verification
if [[ "$SUBCOMMAND" == "auth" ]]; then
  if ! command -v playwright-cli &>/dev/null; then
    log_error "playwright-cli not installed. Install with: npm install -g @playwright/cli@latest"
    exit 1
  fi

  AUTH_DIR="${PROJECT_DIR}/.alpha-loop/auth"
  mkdir -p "$AUTH_DIR"

  echo ""
  echo -e "${BOLD}${CYAN}Save authenticated browser state${NC}"
  echo ""
  echo "This will open a browser. Log in to your app, then the state"
  echo "(cookies, localStorage, sessions) will be saved for future"
  echo "verification runs."
  echo ""

  # Detect app URL from dev_command in config or package.json
  APP_PORT=""
  if [[ -n "${CONFIG_DEV_COMMAND:-}" ]]; then
    APP_PORT=$(echo "$CONFIG_DEV_COMMAND" | grep -oE '\-\-port\s+([0-9]+)|PORT=([0-9]+)|-p\s+([0-9]+)' | grep -oE '[0-9]+' | head -1) || true
  fi
  if [[ -z "$APP_PORT" && -f "$PROJECT_DIR/package.json" ]]; then
    APP_PORT=$(grep -oE '\-\-port\s+([0-9]+)|PORT=([0-9]+)|-p\s+([0-9]+)|VITE_PORT:-([0-9]+)|SERVER_PORT.*([0-9]{4})' "$PROJECT_DIR/package.json" "$PROJECT_DIR/scripts/dev.sh" 2>/dev/null | grep -oE '[0-9]{4}' | head -1) || true
  fi
  APP_URL="http://localhost:${APP_PORT:-3000}"
  read -r -p "App URL [$APP_URL]: " custom_url
  [[ -n "$custom_url" ]] && APP_URL="$custom_url"

  echo ""
  echo "Opening browser at $APP_URL..."
  echo "Log in, then come back here and press Enter to save state."
  echo ""

  # Open browser with persistent profile
  playwright-cli open "$APP_URL" --headed --persistent 2>/dev/null &
  BROWSER_PID=$!

  read -r -p "Press Enter after you've logged in... "

  # Save the browser state
  playwright-cli state-save "$AUTH_DIR/state.json" 2>/dev/null || {
    log_warn "Could not save state via playwright-cli, trying cookie export..."
    playwright-cli cookie-export "$AUTH_DIR/cookies.json" 2>/dev/null || true
    playwright-cli localstorage-export "$AUTH_DIR/localstorage.json" 2>/dev/null || true
  }

  # Close the browser
  playwright-cli close-all 2>/dev/null || true
  kill "$BROWSER_PID" 2>/dev/null || true

  if [[ -f "$AUTH_DIR/state.json" ]] || [[ -f "$AUTH_DIR/cookies.json" ]]; then
    log_success "Auth state saved to $AUTH_DIR"
    echo ""
    echo "Future verification runs will load this state automatically."
    echo "Re-run 'auth' if your session expires."

    # Add to .gitignore if not already there
    if [[ -f "$PROJECT_DIR/.gitignore" ]]; then
      if ! grep -q ".alpha-loop/auth" "$PROJECT_DIR/.gitignore" 2>/dev/null; then
        echo ".alpha-loop/auth/" >> "$PROJECT_DIR/.gitignore"
        log_info "Added .alpha-loop/auth/ to .gitignore"
      fi
    fi
  else
    log_error "Failed to save auth state"
  fi

  exit 0
fi

# Handle history subcommand (doesn't need full config or prerequisites)
if [[ "$SUBCOMMAND" == "history" ]]; then
  run_history
  exit 0
fi

# Apply config from .alpha-loop.yaml and git remote auto-detection
apply_config

main "$@"
