# Implementation Plan: #171 — Epic-aware run

Branch: `feature/171-epic-aware-run`

## Overview

Add first-class epic support to `alpha-loop run`. An "epic" is a GitHub issue with the `epic` label whose body contains a `- [ ] #N` task list of sub-issues. The feature: auto-discovers open epics, presents them above milestones in an interactive picker, processes their sub-issues in checklist order, flips checklist boxes as sub-issues merge, and triggers a verification pass (agent-powered AC verdict) when the last sub-issue ships.

Non-goals (v1): nested epics, cross-repo sub-issues, automatic epic creation, GitHub Projects v2 native sub-issues API.

---

## Architecture: New and Modified Files

### New files
- `src/lib/epics.ts` — checklist parsing, sub-issue resolution, progress tracking, checklist mutation
- `src/lib/verify-epic.ts` — verification pass: per-sub-issue AC verdict, epic close/comment logic
- `tests/lib/epics.test.ts` — unit tests for epics module
- `tests/lib/verify-epic.test.ts` — unit tests for verify-epic module
- `docs/epics.md` — feature documentation

### Modified files
| File | Change |
|------|--------|
| `src/lib/github.ts` | Add `listEpics()`, `getEpicSubIssues()`, `updateEpicChecklist()`, `getIssuePR()` |
| `src/lib/session.ts` | Add `epic?: number` field to `SessionContext`; slug epic into session name |
| `src/lib/pipeline.ts` | Append `Part of #<epic>` to PR body in `buildPRBody()` when session has epic |
| `src/lib/config.ts` | Add `preferEpics: boolean` to `Config` type + DEFAULTS + YAML key map |
| `src/commands/run.ts` | Add `--epic`, `--no-epic`, `--verify-only` CLI options; refactor `pickMilestone()` into unified `pickTarget()`; add epic execution flow |
| `src/cli.ts` | Wire `--epic <N>`, `--no-epic`, `--verify-only <N>` options on the `run` command |
| `src/commands/init.ts` | Create `epic` label during `alpha-loop init` if absent |
| `README.md` | Add section on epic workflow |

---

## Implementation Steps

### Step 1: Add `epic` GitHub label (Complexity: Low)

**What**: Create the `epic` label in the repo during `alpha-loop init`. Document the label convention.

**Files**:
- `src/commands/init.ts` — after the existing label-creation logic, call `createLabel(repo, 'epic', '8B5CF6')` guarded by a `listLabels` check (same pattern used for the `ready` label)

**Key points**:
- Use `--force` flag already in `createLabel()` so this is idempotent
- Color `8B5CF6` (purple) to distinguish epics visually

**Testing**: Manual — run `alpha-loop init --dry-run` and confirm label appears in output
**Acceptance criteria satisfied**: AC #1 (`epic` label created in repo and documented)

---

### Step 2: `src/lib/epics.ts` — core epic primitives (Complexity: Medium)

**What**: New module with pure functions for checklist parsing and sub-issue management.

**Files**:
- `src/lib/epics.ts` (new)

**Exported types and functions**:

```typescript
export type SubIssueRef = {
  number: number;
  checked: boolean;    // true if "- [x]"
  lineIndex: number;   // position in body lines array (for surgical replacement)
};

export type EpicSummary = {
  number: number;
  title: string;
  subIssues: SubIssueRef[];
  doneCount: number;
  totalCount: number;
};

/** Parse "- [ ] #N" / "- [x] #N" lines from an issue body. Cross-repo refs ignored. */
export function parseSubIssues(body: string): SubIssueRef[]

/** Flip one checklist line from unchecked to checked (or vice versa). Returns new body string. */
export function flipChecklistItem(body: string, subIssueNum: number, checked: boolean): string

/** True when body qualifies as an epic by heuristic (≥3 task-list issue refs). */
export function looksLikeEpic(body: string): boolean

/** Build an EpicSummary from a parsed issue. */
export function buildEpicSummary(issue: Issue): EpicSummary
```

**Key points**:
- Parse regex: `/^- \[([ xX])\] #(\d+)/gm` — match `[ ]` or `[x]`/`[X]` only; ignore `- [ ] text` without `#N`
- `flipChecklistItem` must be surgical: replace only the matching line, preserve all surrounding markdown. Do NOT re-render the full body.
- `looksLikeEpic` returns true when ≥3 `#N` task-list lines found — used only as a warning hint, not as the authoritative epic detection
- Cross-repo refs (containing `/`) are silently skipped

**Testing**: `tests/lib/epics.test.ts` — see Step 7

---

### Step 3: `src/lib/github.ts` — epic-specific GitHub helpers (Complexity: Low)

**What**: Add four new exported functions.

**Files**:
- `src/lib/github.ts`

**New functions**:

```typescript
/** List all open issues with the 'epic' label. */
export function listEpics(repo: string): Issue[]

/** Fetch an epic issue and return parsed sub-issue refs. */
export function getEpicSubIssues(repo: string, epicNum: number): SubIssueRef[]

/** Flip the checklist box for subIssueNum in the epic body. */
export function updateEpicChecklist(repo: string, epicNum: number, subIssueNum: number, checked: boolean): void

/** Get the merged PR URL for an issue, or null if none found. */
export function getMergedPRForIssue(repo: string, issueNum: number): string | null
```

**Key points**:
- `listEpics`: use `gh issue list --label "epic" --state open` — reuse the `ghExec` + JSON pattern already established in `pollIssuesByLabel`
- `updateEpicChecklist`: fetch current body via `getIssueWithComments`, call `flipChecklistItem` from `epics.ts`, then call `updateIssue` with new body. If the expected `- [ ] #N` line is not present in the fetched body, **throw** (`Error: epic #<epicNum> body no longer contains expected checklist line for sub-issue #<subIssueNum>`). Callers let this bubble up — one-agent-per-epic is the contract, so a missing line is a loud failure, not a silent drift.
- `getMergedPRForIssue`: `gh pr list --repo <repo> --search "closes:#N" --state merged --json url --limit 1` — needed for the verification pass

**Testing**: extend `tests/lib/github.test.ts` with mock-based tests for each new function

---

### Step 4: `src/lib/config.ts` — add `preferEpics` config field (Complexity: Low)

**What**: Add a new boolean config option `prefer_epics` / `preferEpics`.

**Files**:
- `src/lib/config.ts`

**Changes**:
1. Add `preferEpics: boolean` to the `Config` type (after `batch` / `batchSize`)
2. Add default `preferEpics: false` to `DEFAULTS`
3. Add `prefer_epics: 'preferEpics'` to the YAML key map
4. Add `PREFER_EPICS: 'preferEpics'` to ENV var map

**Testing**: extend `tests/lib/config.test.ts` with a test that sets `prefer_epics: true` in a YAML fixture and asserts `config.preferEpics === true`

---

### Step 5: `src/lib/session.ts` — add `epic` to `SessionContext` (Complexity: Low)

**What**: Record which epic (if any) a session is scoped to, and use it to name the session.

**Files**:
- `src/lib/session.ts`

**Changes**:
1. Add `epic?: number` to the `SessionContext` type
2. In `createSession`, accept an optional `epicNum?: number` parameter alongside `milestone?`
3. When `epicNum` is provided, form the session slug as `epic-${epicNum}-${slugifiedTitle}` so the branch is named `session/epic-165-hybrid-routing` (matching the issue design spec)
4. Return `epic: epicNum` in the returned `SessionContext`

**Key points**:
- The session PR title (in `finalizeSession`) should say `Epic #<N>: <title>` when `session.epic` is set, matching the design spec

**Testing**: extend `tests/lib/session.test.ts`

---

### Step 6: `src/lib/pipeline.ts` — append `Part of #<epic>` to PR body (Complexity: Low)

**What**: When the session has an epic, append an epic reference to the individual sub-issue PR body.

**Files**:
- `src/lib/pipeline.ts`

**Changes**:
- In `buildPRBody(...)`, add an optional `epicNum?: number` parameter
- If provided, prepend `Closes #${issueNum}\nPart of #${epicNum}` instead of just `Closes #${issueNum}`
- Pass `session.epic` from `processIssue` calls down to `buildPRBody`

**Key points**:
- The `processIssue` function already receives `session: SessionContext`, so `session.epic` is available
- This is a minimal, surgical change to `buildPRBody` — no structural refactor

**Testing**: add a test in `tests/lib/pipeline.test.ts` asserting the PR body contains `Part of #165` when `epicNum` is set

---

### Step 7: `src/lib/verify-epic.ts` — verification pass (Complexity: High)

**What**: When all sub-issues have merged PRs, run an agent-powered AC verification pass and post a structured comment on the epic.

**Files**:
- `src/lib/verify-epic.ts` (new)

**Exported functions**:

```typescript
export type VerifyEpicResult = {
  verdict: 'pass' | 'partial' | 'fail';
  comment: string;   // full markdown comment body to post on the epic
};

/** Run the full verification pass on a closed-or-closing epic. */
export async function verifyEpic(
  epicIssue: Issue,
  subIssues: Issue[],
  mergedPRUrls: string[],   // parallel array with subIssues
  config: Config,
  session: SessionContext,
): Promise<VerifyEpicResult>
```

**Algorithm**:
1. Build a verification prompt containing: epic body (acceptance criteria), each sub-issue body, and the merged PR diff (fetched via `gh pr diff <number>`) — truncated to MAX_DIFF_CHARS
2. Call `spawnAgent` with `config.reviewModel` (falls back to `config.agent`)
3. Parse agent output for a structured verdict JSON blob (same `GateResult` pattern used by `readGateResult` in `pipeline.ts`)
4. Return verdict + a formatted markdown summary for the epic comment
5. The comment follows: per-sub-issue table (PR link | AC verdict | notes) + overall status

**Key points**:
- Use `config.reviewModel` (not `config.model`) — matches the spec ("respects routing config once #158/#159 land")
- Verdict parsing: look for a JSON fence in agent output like the existing `GateResult` parsing in `readGateResult`; if absent, treat as `partial`
- Prompt must be explicit: "For each sub-issue, evaluate each acceptance criterion in the issue body against the merged PR diff. Output a JSON object with: `verdict: 'pass'|'partial'|'fail'`, `findings: [{issueNum, criterion, verdict, notes}]`"

**Testing**: `tests/lib/verify-epic.test.ts` — mock `spawnAgent`, test verdict parsing, test comment formatting

---

### Step 8: Refactor `pickMilestone()` into `pickTarget()` in `src/commands/run.ts` (Complexity: Medium)

**What**: Extend the existing `pickMilestone()` function (lines 149–185) into a unified picker that shows epics first, then milestones, then a flat option.

**Files**:
- `src/commands/run.ts`

**New function signature**:

```typescript
type PickResult =
  | { type: 'epic'; epicNum: number; epicTitle: string }
  | { type: 'milestone'; title: string }
  | { type: 'all' };

async function pickTarget(repo: string, preferEpics: boolean): Promise<PickResult>
```

**Rendered menu** (matches design spec):
```
  Open Epics
  1  Hybrid cloud + local model routing #165 (0/7 done) · Hybrid Model Routing
  2  [other epic] ...

  Open Milestones
  3  Hybrid Model Routing (0 open, 0/8 done · due 2026-05-20)
  4  Core Pipeline Quality ...

  0  All ready (flat, no filter)

  Select [0-N]:
```

**Key points**:
- When no epics exist, fall back to showing milestones only (current behavior preserved)
- When non-TTY (`!process.stdin.isTTY`) skip the picker entirely — return `{ type: 'all' }` or use the `--milestone` flag value
- The `preferEpics` config: if user selects a milestone and `preferEpics: true` and there is exactly one epic in that milestone → auto-promote to epic selection
- Index offset: epics take indices 1..E, milestones take indices E+1..E+M, 0 = all. `askChoice` max = E+M

**Acceptance criteria satisfied**: AC #3 (epic picker shown when ≥1 open epic), AC #14 (non-TTY defaults to flat)

---

### Step 9: Epic execution flow in `runCommand` (Complexity: High)

**What**: When an epic is selected, change the issue queue to be the epic's sub-issues in checklist order, and after each successful merge, flip the epic checklist box.

**Files**:
- `src/commands/run.ts`

**Changes to `runCommand`**:

1. Extend `RunOptions` type:
```typescript
epic?: number;        // --epic <N>
noEpic?: boolean;     // --no-epic
verifyOnly?: number;  // --verify-only <N>
```

2. Replace `pickMilestone()` call (line 214–215) with `pickTarget()`:
```typescript
let activeEpic: number | undefined;
let activeMilestone = config.milestone;

if (!config.dryRun && process.stdin.isTTY && !options.noEpic && !options.epic && !activeMilestone) {
  const target = await pickTarget(config.repo, config.preferEpics);
  if (target.type === 'epic') { activeEpic = target.epicNum; }
  else if (target.type === 'milestone') { activeMilestone = target.title; }
}
if (options.epic) activeEpic = options.epic;
if (options.noEpic) activeEpic = undefined;
```

3. If `activeEpic` is set, build the issue queue from epic sub-issues in checklist order:
```typescript
if (activeEpic !== undefined) {
  const subRefs = getEpicSubIssues(config.repo, activeEpic);
  const openReadySubIssues = subRefs
    .filter(ref => !ref.checked)           // not already done
    .map(ref => getIssueWithComments(config.repo, ref.number))
    .filter((iss): iss is Issue => iss !== null)
    .filter(iss => {
      if (!iss.labels.includes(config.labelReady)) {
        log.warn(`Sub-issue #${iss.number} skipped: not labeled '${config.labelReady}'`);
        return false;
      }
      return true;
    });
  issuesToProcess = openReadySubIssues;   // checklist order preserved
}
```

4. After each successful `processIssue`, if `activeEpic` is set, flip the checklist:
```typescript
if (result.status === 'success' && activeEpic !== undefined) {
  updateEpicChecklist(config.repo, activeEpic, issue.number, true);
}
```

5. After the issue loop finishes, if `activeEpic` is set and all sub-issues are now done:
```typescript
const remaining = getEpicSubIssues(config.repo, activeEpic).filter(r => !r.checked);
if (remaining.length === 0) {
  // All done — run verification pass
  const verifyResult = await verifyEpic(...);
  commentIssue(config.repo, activeEpic, verifyResult.comment);
  if (verifyResult.verdict === 'pass') {
    closeIssue(config.repo, activeEpic, 'completed');
    log.success(`Epic #${activeEpic} closed: all sub-issues shipped and verified`);
  } else {
    labelIssue(config.repo, activeEpic, 'needs-human-input');
    log.warn(`Epic #${activeEpic} needs human review: verdict=${verifyResult.verdict}`);
  }
}
```

6. Epic exclusion from normal `ready` flow: in `pollIssues` (or immediately after, in `runCommand`), filter out issues that have the `epic` label. Since `pollIssues` already returns labels on each issue, this is a one-liner filter:
```typescript
issuesToProcess = issuesToProcess.filter(iss => !iss.labels.includes('epic'));
```
Apply this filter in ALL paths (flat, milestone, project-board) — before any other slicing.

7. `--verify-only <N>` path: if `options.verifyOnly` is set, skip the issue loop entirely and jump straight to the verification pass for that epic number.

**Acceptance criteria satisfied**: AC #2, #4, #5, #6, #7, #8, #9, #11, #12, #13

---

### Step 10: Wire CLI flags (Complexity: Low)

**What**: Add `--epic`, `--no-epic`, `--verify-only` options to the `run` command in `src/cli.ts`.

**Files**:
- `src/cli.ts`

**Changes** (inside the `run` command block):
```typescript
.option('--epic <n>', 'Force a specific epic by number, skip the picker', parseInt)
.option('--no-epic', 'Skip the epic picker, use flat/milestone flow')
.option('--verify-only <n>', 'Run only the verification pass on an existing epic', parseInt)
```

**Acceptance criteria satisfied**: AC #4 (`--epic <N>` and `--no-epic` work), AC #12 (`--verify-only <N>`)

---

### Step 11: Unit tests (Complexity: Medium)

**What**: Full test coverage for all new modules and modified helpers.

**Files**:
- `tests/lib/epics.test.ts` (new)
- `tests/lib/verify-epic.test.ts` (new)
- `tests/lib/github.test.ts` (extend)
- `tests/lib/pipeline.test.ts` (extend)
- `tests/lib/session.test.ts` (extend)

**Test cases for `epics.test.ts`**:
- `parseSubIssues`: unchecked `- [ ] #N`, checked `- [x] #N`, uppercase `- [X] #N`, mixed list, cross-repo ref ignored, plain task item without `#N` ignored
- `flipChecklistItem`: flips unchecked to checked, flips checked to unchecked, leaves other lines untouched
- `looksLikeEpic`: true when ≥3 items, false when <3, false when no task list
- `buildEpicSummary`: correct `doneCount` and `totalCount`

**Test cases for `verify-epic.test.ts`**:
- `verifyEpic` with agent returning `pass` JSON → closes epic
- `verifyEpic` with agent returning `partial` → leaves open, returns structured comment
- `verifyEpic` with no parseable JSON → defaults to `partial`

**Test cases for `github.test.ts`**:
- `listEpics`: returns only issues with `epic` label
- `updateEpicChecklist`: calls `updateIssue` with correctly flipped body
- `getMergedPRForIssue`: returns URL from mock gh output

**Integration test** (mocked):
- Full mock run in `tests/commands/run.test.ts` (or a new `tests/lib/epic-run.test.ts`): synthetic epic with 3 sub-issues (one not-ready), assert order preserved, not-ready one skipped, checklist flipped, verification called after last merge

**Acceptance criteria satisfied**: AC #15, #16

---

### Step 12: Documentation (Complexity: Low)

**What**: New `docs/epics.md` and a README section.

**Files**:
- `docs/epics.md` (new) — feature overview, label setup (`alpha-loop init` creates it), example workflow, checklist format, CLI flags, config option
- `README.md` — add a "Epics" section after the existing "Milestones" section, linking to `docs/epics.md`

**Acceptance criteria satisfied**: AC #17

---

## Testing Strategy

**Unit tests** (Jest, mocked gh CLI):
- All pure functions in `src/lib/epics.ts` — markdown parsing edge cases are the highest-value tests
- Verification verdict parsing in `src/lib/verify-epic.ts` — mock `spawnAgent`
- New GitHub helpers in `src/lib/github.ts` — follow exact mock pattern in `tests/lib/github.test.ts`

**Integration / mock-run test**:
- Create a `tests/commands/epic-run.test.ts` that stubs `pollIssues`, `getEpicSubIssues`, `processIssue`, `updateEpicChecklist`, and `verifyEpic`, then calls `runCommand({ epic: 165 })` and asserts the call sequence is correct

**Manual validation** (epic #165):
1. Run `alpha-loop run`, confirm epic #165 appears in the picker
2. Select it — confirm sub-issues are listed in checklist order
3. Confirm skipped-issue warning fires for any non-ready sub-issue
4. After a sub-issue merges, confirm epic body checklist is updated
5. After all merge — confirm verification comment posted, epic closed (or `needs-human-input` added)

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Checklist race / unexpected body shape**: `updateEpicChecklist` reads, mutates, writes. If the fetched body no longer contains the expected `- [ ] #N` line, something is wrong. | Low | One-agent-per-epic is the documented contract. `updateEpicChecklist` throws if the expected line is absent; `runCommand` lets it bubble up and stops processing that epic. Loud failure, not silent drift. |
| **Checklist formatting preservation**: The flip must not disturb surrounding markdown (description text, non-issue task items, headers, HTML). | High | `flipChecklistItem` uses surgical line-replacement (find line by regex match + `lineIndex`, replace only that line). Unit-test with real-world epic body samples including mixed markdown. Never regenerate the full body from AST. |
| **Verification pass prompt quality**: The agent must produce parseable JSON with per-criterion verdicts from a potentially large PR diff. | High | (1) Truncate diff per existing `MAX_DIFF_CHARS` constant. (2) Use the existing `GateResult` JSON schema so the agent already has a pattern to follow from the code review prompts. (3) If JSON parse fails → default to `partial`, never crash. (4) Trace the prompt+output to `.alpha-loop/traces/` for debugging. |
| **`epic` label not existing in target repo** | Medium | `alpha-loop init` creates it. `listEpics` gracefully returns `[]` if the label doesn't exist — no crash. `updateEpicChecklist` warns if label-add fails. |
| **`--no-epic` vs Commander.js boolean coercion**: Commander parses `--no-epic` as negating a `--epic` default, which may conflict with `--epic <N>`. | Low | Register `--no-epic` as a standalone flag (`noEpic: boolean`) separate from `--epic <N>` (which takes an integer argument). Verify with a test against the Commander config. |

---

## Acceptance Criteria Mapping

| AC | Step(s) |
|----|---------|
| 1. `epic` label created in repo and documented | Step 1, Step 12 |
| 2. Epic-labeled issues never picked up by normal `ready` flow | Step 9 |
| 3. Epic picker shown when ≥1 open epic exists (TTY only) | Step 8 |
| 4. `--epic <N>` and `--no-epic` work as specified | Step 10, Step 9 |
| 5. Sub-issues processed in checklist order | Step 9 |
| 6. Sub-issue PR bodies include `Part of #<epic>` | Step 6 |
| 7. Epic checklist boxes auto-flip as sub-issues merge | Step 9 (after each processIssue) |
| 8. Non-ready sub-issues skipped with warning | Step 9 |
| 9. Verification pass runs when final sub-issue merges | Step 9 (post-loop check) |
| 10. Verification pass posts structured per-sub-issue comment | Step 7 |
| 11. Verification auto-closes on pass; partial/fail → `needs-human-input` | Step 9, Step 7 |
| 12. `--verify-only <N>` re-runs verification | Step 9, Step 10 |
| 13. `prefer_epics: true` honored in picker | Step 4, Step 8 |
| 14. Non-TTY / CI defaults to flat, epics still excluded from ready | Step 9 |
| 15. Unit tests: parse, order, skip, exclude, verdict | Step 11 |
| 16. Integration test: mock run against synthetic epic | Step 11 |
| 17. Docs: README section + `docs/epics.md` | Step 12 |
| 18. `alpha-loop init` creates `epic` label | Step 1 |

---

## Locked Decisions

### Decision 1: Checklist race — **ERROR on conflict**

One-agent-per-epic is the contract. If `updateEpicChecklist` detects that the expected `- [ ] #N` line is missing from the fetched body (external mutation since last read, or sub-issue not actually referenced in the epic), it **throws**. The run loop bubbles the error up and stops processing that epic. No warn-and-continue.

Rationale: concurrent sessions against the same epic are not a supported workflow. A missing checklist line signals that either (a) something else is touching the epic body, or (b) we have a bug — both cases warrant a loud failure, not a silent drift.

### Decision 2: Verification verdict shape — **separate `EpicVerdict` type**

Keep `GateResult` as-is for code review. Define a new `EpicVerdict` type in `src/lib/verify-epic.ts` with its own JSON schema (`verdict`, `findings[].issueNum`, `findings[].criterion`, `findings[].verdict`, `findings[].notes`) and its own parser. Avoids awkward optionals on `GateResult`.

### Decision 3: `--verify-only` scope — **permissive**

Runs verification on whichever sub-issues have merged PRs at call time. Missing/open sub-issues are listed in the comment as "not yet merged — skipped" but do not block the pass. Useful for iterating on epic #165 during development (can re-run verification as more sub-issues land).

The verdict tally only counts sub-issues that were actually evaluated; if any sub-issue was skipped for missing PR, the overall verdict caps at `partial` (can't declare `pass` without full coverage).
