# GitHub Issues (Path B / C)

Used when the user chooses GitHub issue delivery. Create one Alpha Loop-ready
parent epic plus one child issue per structural finding. Quick wins are not
turned into issues; apply them inline or leave them in the report.

## Pre-flight

Before creating anything, verify:

```bash
gh auth status
gh repo view --json nameWithOwner -q .nameWithOwner
```

Resolve the Alpha Loop ready label if the repo has config:

```bash
READY_LABEL=$(awk -F: '/^label:/ {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2; exit}' .alpha-loop.yaml 2>/dev/null)
: "${READY_LABEL:=ready}"
```

Then confirm explicitly:

> I'll create the context-rot epic and N child issues in `<owner>/<repo>`.
> Children will use label `context-rot`. I will only add `<READY_LABEL>` if you
> confirm these should be queue-ready for `alpha-loop run --epic <N>`.
> Different repo or label posture? Tell me before I create anything.

Wait for confirmation. If `gh` is unavailable or unauthenticated, stop and tell
the user what failed. Do not use the GitHub API directly with curl.

## Labels

Use:

- `context-rot` on the parent epic and every child issue.
- `epic` on the parent issue.
- The configured ready label, usually `ready`, only on child issues when the
  user explicitly confirms the findings are ready for the loop.

Create missing labels when the user approves:

```bash
gh label create context-rot --color FFA500 --description "Audit finding: codebase artifacts that confuse AI agents" 2>/dev/null || true
gh label create epic --color 5319E7 --description "Tracks multiple related child issues" 2>/dev/null || true
```

If the ready label is missing, ask whether to create it, omit it, or use a
repo-specific equivalent.

## Epic Template

Create the epic first. The body intentionally follows the richer Alpha Loop epic
format so the ordered checklist is parseable by `alpha-loop run --epic <N>`.

```bash
EPIC_BODY=$(cat <<'EOF'
## Goal

Reduce context rot in <SHORT_SCOPE> so future AI coding agents can reliably
identify current files, conventions, and APIs.

## Non-Technical Summary

This audit found codebase artifacts that can mislead agents: stale docs,
parallel implementations, inconsistent names, dead files, or conflicting
patterns. This epic tracks structural cleanup that needs human judgment or
touches multiple files.

## Why This Matters

- Agents copy local patterns aggressively; inconsistent or stale examples create bad follow-up changes.
- Removing misleading artifacts improves unattended Alpha Loop runs and code review quality.
- The child issues are scoped so each cleanup can be implemented and verified independently.

## Architecture Observations

- Scope: <SCOPE_DESCRIPTION>
- Primary languages/frameworks: <LANGUAGES>
- Audit date: <DATE>
- Quick wins handled outside this epic: <QUICK_WIN_COUNT>

## Ordered Sub-Issues

- [ ] #PLACEHOLDER

## Acceptance Criteria

- [ ] High-severity context rot findings in this audit are resolved or explicitly deferred.
- [ ] Each child issue's acceptance criteria are satisfied.
- [ ] No new unmarked legacy/dead/duplicate patterns are introduced while resolving the epic.
- [ ] Final verification confirms the repo's agent-facing conventions are clear.

## Dependencies and Sequencing

- Start with high-severity children because they are most likely to mislead agents.
- Run children sequentially when they touch the same files or public APIs.
- Low-risk typo/comment fixes can be batched only when they do not overlap structural cleanup.

## Verification Expectations

- Re-run the relevant context-rot detection commands from each child issue.
- Run the repo's normal test command after code changes.
- If using Alpha Loop, run `alpha-loop run --verify-only <this epic number>` after children are complete.
EOF
)

EPIC_NUMBER=$(gh issue create \
  --title "Context Rot Audit - <SHORT_SCOPE>" \
  --body "$EPIC_BODY" \
  --label context-rot,epic \
  | grep -oE '[0-9]+$')

echo "Created epic #$EPIC_NUMBER"
```

Substitute `<DATE>`, `<SCOPE_DESCRIPTION>`, `<SHORT_SCOPE>`, `<LANGUAGES>`,
`<QUICK_WIN_COUNT>`, and summary counts before running.

## Child Issue Template

For each structural finding, create one child issue. Use the standard Alpha Loop
feature/change issue shape: summary, value, proposed approach, acceptance
criteria, out of scope, and related links.

```bash
CHILD_BODY=$(cat <<EOF
## Summary

<One paragraph describing the context-rot finding and the desired cleanup.>

## Why this matters

<Explain what an AI coding agent would get wrong because this artifact exists. Be specific: wrong file, wrong naming convention, stale API, duplicate helper, or outdated docs.>

## Proposed approach

- <Concrete fix step one.>
- <Concrete fix step two if needed.>
- Verification: \`<grep/test command>\`

## Acceptance criteria

- [ ] <The misleading artifact is removed, renamed, documented, or consolidated.>
- [ ] <All referenced call sites/docs/tests are updated consistently.>
- [ ] No new occurrences of this rot pattern remain (verify with: \`<command>\`).

## Out of scope

- <Related cleanup that should not be attempted in this issue.>

## Related

- Part of #${EPIC_NUMBER}
- Severity: <High | Medium | Low>
- Category: <Naming inconsistency | Dead/orphaned code | Inconsistent pattern | Typo | Duplicate | Stale doc>

### Evidence

- \`<path>:<line>\` - <what's there>
- \`<path>:<line>\` - <conflicting or related evidence>
EOF
)

LABELS="context-rot"
# Only append the ready label after explicit user confirmation.
# LABELS="${LABELS},${READY_LABEL}"

CHILD_NUMBER=$(gh issue create \
  --title "<TITLE>" \
  --body "$CHILD_BODY" \
  --label "$LABELS" \
  | grep -oE '[0-9]+$')

echo "Created child #$CHILD_NUMBER"
```

Title conventions for child issues:

- Use imperative voice: "Unify userId casing across auth module."
- Include the category prefix: `[naming]`, `[dead-code]`, `[pattern]`,
  `[typo]`, `[duplicate]`, or `[stale-doc]`.
- Keep under 80 characters.

Examples:

- `[naming] Unify userId vs user_id across src/auth/`
- `[dead-code] Remove auth.old.ts and its orphan helpers`
- `[pattern] Standardize async handling in src/api/`
- `[duplicate] Consolidate formatDate implementations`
- `[stale-doc] Update README quick-start for renamed initClient API`

## Updating The Epic Checklist

After all child issues are created, replace the placeholder with parseable Alpha
Loop task-list lines. Use `- [ ] #123 - Short title`; do not use markdown links
for the issue number in this checklist.

```bash
CHECKLIST=$(printf -- '- [ ] %s\n' "${CHILD_ITEMS[@]}")
CURRENT_BODY=$(mktemp)
UPDATED_BODY=$(mktemp)

gh issue view "$EPIC_NUMBER" --json body -q .body > "$CURRENT_BODY"
awk -v checklist="$CHECKLIST" '
  $0 == "- [ ] #PLACEHOLDER" { printf "%s", checklist; next }
  { print }
' "$CURRENT_BODY" > "$UPDATED_BODY"

gh issue edit "$EPIC_NUMBER" --body "$(cat "$UPDATED_BODY")"
```

Build `CHILD_ITEMS` as strings like `#123 - [naming] Unify userId casing`.

## After Creation

Report:

- Epic URL and number.
- Number of child issues created by severity and category.
- Whether the ready label was applied.
- Quick wins applied inline, if any.

If any `gh` command fails mid-flow, stop and tell the user which step failed.
Do not retry silently.

## Edge Cases

- **Dry-run requested:** print the epic title, child titles, labels, and one-line
  summaries instead of running `gh issue create`.
- **Repo has issue templates:** mention it, but use these templates unless the
  user asks you to adapt to the repo's issue-template fields.
- **GitHub Projects:** if the user mentions a Project board, add
  `--project <name>` to the create commands. Otherwise do not touch projects.
- **Too many findings:** if more than about 25 child issues would be created,
  pause and ask whether to consolidate related findings or split by category.
