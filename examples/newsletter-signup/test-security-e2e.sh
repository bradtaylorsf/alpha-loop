#!/usr/bin/env bash
# Newsletter security-profile demo end-to-end.
# Builds newsletter-signup:template only when missing; never rebuilds if present.
# Creates/uses a demo GitHub repo, branches (or forks), runs alpha-loop --sec-mile,
# executes application oracles against the template container, writes the report.
#
# Env:
#   DEMO_REPO     owner/name (default: <gh-user>/newsletter-signup-demo)
#   DEMO_FORK=1   fork instead of branching the demo repo
#   DRY_RUN=1     skip live Docker/gh where needed; still write report shape
#   NEWSLETTER_PORT  host port (default 3100)
#   ALPHA_LOOP_BIN   path to alpha-loop CLI (default: repo dist/cli.js)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALPHA_LOOP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE_IMAGE="newsletter-signup:template"
NEWSLETTER_PORT="${NEWSLETTER_PORT:-3100}"
NEWSLETTER_BASE_URL="${NEWSLETTER_BASE_URL:-http://127.0.0.1:${NEWSLETTER_PORT}}"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
BRANCH="security-run/${TIMESTAMP}"
DRY_RUN="${DRY_RUN:-0}"
COMPOSE_UP=0
WORKDIR=""
CLONE_DIR=""
EVIDENCE_DIR="${ALPHA_LOOP_ROOT}/test-results/newsletter-security-demo"
mkdir -p "${EVIDENCE_DIR}"
LOG_FILE="${EVIDENCE_DIR}/e2e-${TIMESTAMP}.log.txt"

log() { printf '[newsletter-e2e] %s\n' "$*" | tee -a "${LOG_FILE}"; }
fail() { log "FAIL: $*"; exit 1; }

cleanup() {
  local code=$?
  if [[ "${COMPOSE_UP}" -eq 1 ]]; then
    log "compose down (keeping image ${TEMPLATE_IMAGE})"
    (cd "${SCRIPT_DIR}" && NEWSLETTER_PORT="${NEWSLETTER_PORT}" docker compose down) >>"${LOG_FILE}" 2>&1 || true
  fi
  if [[ -n "${WORKDIR}" && -d "${WORKDIR}" ]]; then
    rm -rf "${WORKDIR}" || true
  fi
  exit "${code}"
}
trap cleanup EXIT

resolve_alpha_loop() {
  if [[ -n "${ALPHA_LOOP_BIN:-}" && -x "${ALPHA_LOOP_BIN}" ]]; then
    echo "${ALPHA_LOOP_BIN}"
    return
  fi
  if [[ -x "${ALPHA_LOOP_ROOT}/dist/cli.js" ]]; then
    echo "node ${ALPHA_LOOP_ROOT}/dist/cli.js"
    return
  fi
  if command -v alpha-loop >/dev/null 2>&1; then
    command -v alpha-loop
    return
  fi
  (cd "${ALPHA_LOOP_ROOT}" && pnpm build) >>"${LOG_FILE}" 2>&1
  echo "node ${ALPHA_LOOP_ROOT}/dist/cli.js"
}

gh_ok() {
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1
}

docker_ok() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

ensure_image() {
  if docker image inspect "${TEMPLATE_IMAGE}" >/dev/null 2>&1; then
    log "image ${TEMPLATE_IMAGE} already present — skip build"
    return
  fi
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "DRY_RUN=1 and image missing — continuing without Docker image"
    return
  fi
  log "building ${TEMPLATE_IMAGE} (first time only)"
  (cd "${SCRIPT_DIR}" && docker build -t "${TEMPLATE_IMAGE}" .) >>"${LOG_FILE}" 2>&1
}

wait_health() {
  local url="$1"
  local i
  for i in $(seq 1 60); do
    if curl -sf "${url}/api/health" >/dev/null 2>&1; then
      log "health 200 at ${url}/api/health"
      return 0
    fi
    sleep 1
  done
  return 1
}

resolve_demo_repo() {
  if [[ -n "${DEMO_REPO:-}" ]]; then
    echo "${DEMO_REPO}"
    return
  fi
  local user
  user="$(gh api user -q .login 2>/dev/null || true)"
  if [[ -z "${user}" ]]; then
    echo "newsletter-signup-demo"
  else
    echo "${user}/newsletter-signup-demo"
  fi
}

create_or_update_demo_repo() {
  local repo="$1"
  if gh repo view "${repo}" >/dev/null 2>&1; then
    log "demo repo exists: ${repo}"
    return
  fi
  log "creating demo repo ${repo} from template (default branch = unmodified template)"
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/newsletter-demo-seed.XXXXXX")"
  rsync -a --exclude node_modules --exclude .next --exclude data/signups.json \
    "${SCRIPT_DIR}/" "${WORKDIR}/"
  (
    cd "${WORKDIR}"
    git init -b main
    git add -A
    git -c user.email="newsletter-demo@example.com" -c user.name="newsletter-demo" \
      commit -m "chore: newsletter signup template"
    # --source pushes main as the template default branch.
    gh repo create "${repo}" --public --source=. --remote=origin --push \
      --description "Alpha Loop security-profile newsletter demo (template default branch)"
  ) >>"${LOG_FILE}" 2>&1
  rm -rf "${WORKDIR}"
  WORKDIR=""
}

prepare_run_copy() {
  local repo="$1"
  local branch="$2"
  CLONE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/newsletter-security-run.XXXXXX")"

  if [[ "${DEMO_FORK:-0}" == "1" ]]; then
    log "DEMO_FORK=1: creating fork of ${repo}"
    local fork_name
    fork_name="$(basename "${repo}")"
    local owner
    owner="$(gh api user -q .login)"
    if ! gh repo view "${owner}/${fork_name}" >/dev/null 2>&1; then
      gh repo fork "${repo}" --clone=false >>"${LOG_FILE}" 2>&1
      # Wait briefly for fork availability
      sleep 3
    fi
    DEMO_REPO_EFFECTIVE="${owner}/${fork_name}"
    gh repo clone "${DEMO_REPO_EFFECTIVE}" "${CLONE_DIR}" >>"${LOG_FILE}" 2>&1
    (
      cd "${CLONE_DIR}"
      git checkout -b "${branch}"
      # Refresh template files onto the fork branch without touching template default.
      rsync -a --exclude node_modules --exclude .next --exclude .git \
        --exclude data/signups.json "${SCRIPT_DIR}/" "${CLONE_DIR}/"
      git add -A
      git -c user.email="newsletter-demo@example.com" -c user.name="newsletter-demo" \
        commit -m "chore: security-run ${TIMESTAMP}" || true
      git push -u origin "${branch}" >>"${LOG_FILE}" 2>&1
    )
  else
    DEMO_REPO_EFFECTIVE="${repo}"
    log "cloning ${repo} and creating branch ${branch}"
    gh repo clone "${repo}" "${CLONE_DIR}" >>"${LOG_FILE}" 2>&1
    (
      cd "${CLONE_DIR}"
      git checkout -b "${branch}"
      rsync -a --exclude node_modules --exclude .next --exclude .git \
        --exclude data/signups.json "${SCRIPT_DIR}/" "${CLONE_DIR}/"
      git add -A
      git -c user.email="newsletter-demo@example.com" -c user.name="newsletter-demo" \
        commit -m "chore: security-run ${TIMESTAMP}" || true
      git push -u origin "${branch}" >>"${LOG_FILE}" 2>&1
    )
  fi

  # Point .alpha-loop.yaml repo at the effective remote.
  if [[ -f "${CLONE_DIR}/.alpha-loop.yaml" ]]; then
    if grep -q '^repo:' "${CLONE_DIR}/.alpha-loop.yaml"; then
      sed -i.bak "s|^repo:.*|repo: ${DEMO_REPO_EFFECTIVE}|" "${CLONE_DIR}/.alpha-loop.yaml"
      rm -f "${CLONE_DIR}/.alpha-loop.yaml.bak"
    fi
  fi
}

local_copy_only() {
  CLONE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/newsletter-security-local.XXXXXX")"
  rsync -a --exclude node_modules --exclude .next --exclude data/signups.json \
    "${SCRIPT_DIR}/" "${CLONE_DIR}/"
  (
    cd "${CLONE_DIR}"
    git init -b main
    git add -A
    git -c user.email="newsletter-demo@example.com" -c user.name="newsletter-demo" \
      commit -m "chore: local security-run ${TIMESTAMP}"
  ) >>"${LOG_FILE}" 2>&1
  DEMO_REPO_EFFECTIVE="${DEMO_REPO:-local/newsletter-signup-demo}"
  BRANCH="security-run/${TIMESTAMP}-local"
  log "local-only copy at ${CLONE_DIR}"
}

# --- main ---
log "start timestamp=${TIMESTAMP} dry_run=${DRY_RUN}"
ALPHA_LOOP_CMD="$(resolve_alpha_loop)"
log "alpha-loop: ${ALPHA_LOOP_CMD}"

IMAGE_ID="(missing)"
if docker_ok; then
  ensure_image
  if docker image inspect "${TEMPLATE_IMAGE}" >/dev/null 2>&1; then
    IMAGE_ID="$(docker image inspect -f '{{.Id}}' "${TEMPLATE_IMAGE}")"
    log "template image id=${IMAGE_ID}"
  fi
else
  log "docker unavailable"
  DRY_RUN=1
fi

if [[ "${DRY_RUN}" != "1" ]] && docker image inspect "${TEMPLATE_IMAGE}" >/dev/null 2>&1; then
  log "compose up from ${TEMPLATE_IMAGE}"
  (cd "${SCRIPT_DIR}" && NEWSLETTER_PORT="${NEWSLETTER_PORT}" docker compose up -d) >>"${LOG_FILE}" 2>&1
  COMPOSE_UP=1
  wait_health "${NEWSLETTER_BASE_URL}" || fail "health check did not return 200"
else
  log "skipping compose (dry-run or no image)"
  DRY_RUN=1
fi

DEMO_REPO_RESOLVED="$(resolve_demo_repo)"
log "DEMO_REPO=${DEMO_REPO_RESOLVED}"

if [[ "${DRY_RUN}" != "1" ]] && gh_ok; then
  create_or_update_demo_repo "${DEMO_REPO_RESOLVED}"
  prepare_run_copy "${DEMO_REPO_RESOLVED}" "${BRANCH}"
else
  log "gh unavailable or dry-run — using local copy (milestones skipped)"
  local_copy_only
  DRY_RUN_MILESTONES=1
fi

# Sync latest oracles/scripts into the copy (already done via rsync for remote path).
log "running alpha-loop init --sec-mile --yes in copy"
(
  cd "${CLONE_DIR}"
  # Prefer non-interactive: --yes on init.
  # shellcheck disable=SC2086
  ${ALPHA_LOOP_CMD} init --sec-mile --yes
) >>"${LOG_FILE}" 2>&1 || {
  log "init --sec-mile failed (see log); attempting dry-run plan seed"
  mkdir -p "${CLONE_DIR}/.alpha-loop"
  if [[ ! -f "${CLONE_DIR}/.alpha-loop/security-plan.json" ]]; then
    cat >"${CLONE_DIR}/.alpha-loop/security-plan.json" <<'JSON'
{
  "version": 1,
  "profiles": {
    "application": {
      "url": "https://github.com/mitre/cti",
      "ref": "master",
      "watch": ["enterprise-attack/enterprise-attack.json"],
      "acceptedSha": "dry-run-sha"
    }
  },
  "checks": [
    {
      "source": "application",
      "sourceUrl": "https://github.com/mitre/cti",
      "techniqueId": "T1190",
      "catalogRevision": "dry-run-sha",
      "surface": "public-http",
      "target": "application",
      "command": "node scripts/oracle-checks.mjs health",
      "passExit": 0,
      "timeoutSec": 30,
      "selected": true,
      "milestone": "T1190 [public-http]"
    },
    {
      "source": "application",
      "sourceUrl": "https://github.com/mitre/cti",
      "techniqueId": "T1133",
      "catalogRevision": "dry-run-sha",
      "surface": "public-http",
      "target": "application",
      "command": "node scripts/oracle-checks.mjs reject-empty",
      "passExit": 0,
      "timeoutSec": 30,
      "selected": true,
      "milestone": "T1133 [public-http]"
    },
    {
      "source": "application",
      "sourceUrl": "https://github.com/mitre/cti",
      "techniqueId": "T1078",
      "catalogRevision": "dry-run-sha",
      "surface": "public-http",
      "target": "application",
      "command": "node scripts/oracle-checks.mjs accept-valid",
      "passExit": 0,
      "timeoutSec": 30,
      "selected": true,
      "milestone": "T1078 [public-http]"
    },
    {
      "source": "application",
      "sourceUrl": "https://github.com/mitre/cti",
      "techniqueId": "T1552",
      "catalogRevision": "dry-run-sha",
      "surface": "credentials-at-rest",
      "target": "application",
      "command": "node scripts/oracle-checks.mjs store-not-public",
      "passExit": 0,
      "timeoutSec": 30,
      "selected": true,
      "milestone": "T1552 [credentials-at-rest]"
    }
  ]
}
JSON
  fi
  DRY_RUN=1
}

# If init wrote a plan but we are in dry-run for executor only when health unavailable.
EXEC_DRY="${DRY_RUN}"
if [[ "${COMPOSE_UP}" -eq 1 ]]; then
  EXEC_DRY=0
fi

log "running security executor (DRY_RUN=${EXEC_DRY})"
ALPHA_LOOP_ROOT="${ALPHA_LOOP_ROOT}" \
WORKTREE="${CLONE_DIR}" \
NEWSLETTER_BASE_URL="${NEWSLETTER_BASE_URL}" \
TEMPLATE_IMAGE_ID="${IMAGE_ID}" \
DEMO_REPO="${DEMO_REPO_EFFECTIVE}" \
DEMO_BRANCH="${BRANCH}" \
DRY_RUN="${EXEC_DRY}" \
  node "${SCRIPT_DIR}/scripts/run-security-executor.mjs" | tee -a "${LOG_FILE}"

REPORT_PATH="${CLONE_DIR}/security-profile-report.md"
if [[ ! -f "${REPORT_PATH}" ]]; then
  fail "missing security-profile-report.md"
fi

# Copy report into evidence + template tree for local inspection.
cp "${REPORT_PATH}" "${EVIDENCE_DIR}/security-profile-report-${TIMESTAMP}.md"
cp "${REPORT_PATH}" "${SCRIPT_DIR}/security-profile-report.md"
log "report: ${REPORT_PATH}"
log "evidence copy: ${EVIDENCE_DIR}/security-profile-report-${TIMESTAMP}.md"

# Push report onto the run branch when remote exists.
if [[ "${DRY_RUN_MILESTONES:-0}" != "1" ]] && [[ -d "${CLONE_DIR}/.git" ]]; then
  (
    cd "${CLONE_DIR}"
    git add security-profile-report.md .alpha-loop/security-plan.json .alpha-loop.yaml 2>/dev/null || true
    if ! git diff --cached --quiet; then
      git -c user.email="newsletter-demo@example.com" -c user.name="newsletter-demo" \
        commit -m "docs: security profile report ${TIMESTAMP}"
      git push origin "HEAD:${BRANCH}" >>"${LOG_FILE}" 2>&1 || true
    fi
  ) || true
fi

# Confirm image was not removed and (on second conceptual check) still tagged.
if docker image inspect "${TEMPLATE_IMAGE}" >/dev/null 2>&1; then
  log "image ${TEMPLATE_IMAGE} retained after run"
fi

log "done overall report follows:"
sed -n '1,80p' "${REPORT_PATH}" | tee -a "${LOG_FILE}"
