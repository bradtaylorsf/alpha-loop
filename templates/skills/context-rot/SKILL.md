---
name: context-rot
description: Audit a codebase for "context rot" — patterns that confuse AI coding agents like inconsistent naming, dead/orphaned implementations, stale documentation, duplicate utilities, misspellings, and inconsistent patterns (error handling, async, logging). Use this skill whenever the user asks to audit, review, or assess a repo for agent-confusion risk, AI-readiness, codebase health, or cleanup; whenever they mention "context rot," "agent rot," "AI hygiene," or "cleanup for Claude/Cursor/Copilot"; or when they ask why an agent keeps editing the wrong file, hallucinating APIs, or producing inconsistent code. Works on any language — detects and adapts. Produces either an inline report with quick fixes or Alpha Loop-ready GitHub epic and child issues, based on user choice after analysis.
auto_load: false
priority: medium
---

# Context Rot Audit

## Purpose

Codebases accumulate "context rot" — artifacts that are invisible to humans (who know which file is current) but actively mislead AI coding agents. An agent doing pattern matching on a repo will faithfully copy whatever it finds, including the dead code, the typo, and the convention nobody uses anymore. This skill finds that rot and gets it fixed.

The audit covers six categories:

1. **Naming inconsistency** — same concept named differently across files (`userId` / `user_id` / `uid`)
2. **Dead/orphaned code & old implementations** — `*.old.ts`, `_v2`, `legacy_*`, files nothing imports
3. **Inconsistent patterns** — mixed error handling, async styles, logging, config access
4. **Misspellings & typos** — especially in identifiers, where they propagate
5. **Duplicate concepts/utilities** — two `formatDate`, three `httpClient`, parallel implementations
6. **Stale documentation** — README/comments describing code that no longer exists or behaves differently

## Mental model

Frame every finding by asking: "If a fresh agent loaded this codebase tomorrow with no other context, what would it get wrong?" A typo in a comment doesn't matter much. A typo in an exported function name that's then copied into ten call sites does. A `legacy/` folder is fine if it's clearly marked; an unmarked `auth_v1.ts` next to `auth.ts` is rot. Severity always flows from "how likely is an agent to be misled."

## Workflow

Follow these phases in order. Don't skip ahead — the report quality depends on doing detection thoroughly before deciding output format.

### Phase 1 — Orient

Before running any detection, get the lay of the land. Run these in the repo root:

```bash
# Languages and rough size
git ls-files | awk -F. '{print $NF}' | sort | uniq -c | sort -rn | head -20

# Repo conventions worth knowing
ls -la | grep -E '^\.|README|CONTRIBUTING|CLAUDE|AGENTS|\.cursorrules'
test -f package.json && cat package.json | head -50
test -f pyproject.toml && cat pyproject.toml | head -50

# Recently active vs stale areas — older = more rot risk
git log --pretty=format: --name-only --since='1 year ago' | sort | uniq -c | sort -rn | head -30
```

Use this to:
- Determine primary language(s) for category-specific detection — see `references/per-language.md`
- Spot any `CLAUDE.md` / `AGENTS.md` / `.cursorrules` that document intended conventions (these become the ground truth for inconsistency findings)
- Identify hot vs cold zones (a typo in a file touched weekly is higher priority than one in untouched code)

If the repo has more than ~50k tracked files or is clearly a monorepo with vendored deps, ask the user which subdirectory to scope the audit to. Don't try to audit `node_modules` or `vendor/`.

### Phase 2 — Detect

Work through each of the six categories. For each category, read the corresponding section in `references/detection-patterns.md` for the specific commands and heuristics. The reference file is organized by category and includes both language-agnostic detection (ripgrep patterns) and language-specific tools where they meaningfully help.

Record findings as you go in a structured list. Use this shape for each finding:

```
- category: naming | dead-code | inconsistent-pattern | typo | duplicate | stale-doc
  severity: high | medium | low
  title: short imperative ("Unify userId vs user_id across auth module")
  evidence:
    - path:line — what's there
    - path:line — conflicting case
  impact: one sentence on why this misleads an agent
  fix: concrete suggestion, ideally a command or diff sketch
```

Severity rubric (apply consistently):

- **high** — actively misleading. Agent will pick the wrong file, copy the wrong pattern, or hallucinate behavior. Examples: two functions with the same name doing different things; a README describing an API that was renamed; an unmarked `_old` file that looks current.
- **medium** — inconsistency that produces drift. Agent's output will be stylistically off, code review will catch it but it wastes cycles. Examples: mixed `async/await` vs `.then()` in one module; `userId` vs `user_id` in adjacent files.
- **low** — cosmetic or low-blast-radius. Examples: typo in a private function name used in one place; a stale comment in a file that's otherwise self-explanatory.

Aim for thoroughness over speed. False positives are fine in this phase — you'll filter in Phase 3. But don't pad: if a category genuinely has nothing, say so.

### Phase 3 — Triage and summarize

Look at the full finding list and compute:
- Total findings, broken down by category and severity
- "Quick wins" — findings that are local, low-risk, and can be applied in this session (single-file typo fix, deleting a clearly-dead file, renaming one symbol in a small module)
- "Structural" findings — anything that needs human judgment, touches >3 files, or affects public APIs

Now show the user a one-screen summary. Use this exact structure (it sets up the decision in Phase 4):

```
## Context Rot Audit — <repo name>

**Scope:** <N files, <languages>, <subdirectory if scoped>>

### Findings
- 🔴 High: <count>   ← <one-line examples>
- 🟡 Medium: <count> ← <one-line examples>
- 🟢 Low: <count>    ← <one-line examples>

### By category
| Category | Count | Notable |
|---|---|---|
| Naming inconsistency | N | ... |
| Dead/orphaned code | N | ... |
| Inconsistent patterns | N | ... |
| Misspellings | N | ... |
| Duplicates | N | ... |
| Stale docs | N | ... |

### Quick wins (can apply now)
1. ...
2. ...

### Structural items (need discussion)
1. ...
2. ...
```

If there are zero or one findings total and no high-severity items, just say so — clean bill of health, optionally apply the one-liner, done. Don't proceed to Phase 4.

### Phase 4 — Ask the user how to deliver

This is the hand-off point. Ask the user to choose between two paths. Phrase it roughly like:

> Found X findings (Y high, Z medium). How do you want to handle this?
>
> **A — Inline:** I'll write up the full report here. You can apply the quick wins now if you want, and keep the structural items for later.
>
> **B — GitHub epic:** I'll create one parent epic issue plus a child issue per structural finding using `gh`, shaped so `alpha-loop run --epic <N>` can process the checklist. Quick wins still get applied inline (they don't deserve issues).
>
> **C — Both:** Inline report now, then create issues for the structural items.

Wait for explicit choice. Don't assume.

Heuristics to mention if it helps them decide:
- Fewer than ~5 structural findings: A is usually right
- Issues will be created in the current repo unless they specify otherwise
- They need `gh` installed and authenticated for B/C

### Phase 5 — Execute the chosen path

#### Path A (inline only)

Write the full report as a markdown document. Use the summary from Phase 3 as the header, then expand each finding with full evidence. Group by severity, not by category — high-severity items should hit the eye first.

If the user wants to apply quick wins, apply them as standard edits, one at a time, with a brief diff preview before each. Don't batch.

#### Path B or C (Alpha Loop GitHub issues)

Read `references/github-issues.md` for the Alpha Loop issue templates and the exact `gh` commands. The flow is:

1. **Pre-flight:** confirm `gh auth status` is OK, confirm the repo (default: current), confirm the user wants you to proceed creating issues.
2. **Resolve Alpha Loop labels:** use `context-rot` plus `epic` on the parent, and only apply the configured ready label to children when the user confirms they are queue-ready.
3. **Create the epic** first. Capture its issue number.
4. **Create one child issue per structural finding**, each linking back to the epic with an Alpha Loop-friendly body and testable acceptance criteria.
5. **Update the epic** with a parseable checklist linking to all child issues: `- [ ] #123 - Short title`.
6. **Report back:** print the URL of the epic and a count of children created.

Apply quick wins inline (don't make issues for them) only after issue creation is complete, unless the user says otherwise.

## Tone and output rules

- The audience is a technical user who wants signal, not theater. Skip preambles like "Great question!" and don't pad findings with hedges.
- Findings should be *specific* — `src/auth/login.ts:42 uses snake_case while the rest of src/auth uses camelCase` beats "naming is inconsistent in the auth module."
- It's fine to say "no findings in this category" — clean is a real result.
- Don't fabricate severity. If the worst thing in the repo is two stale TODO comments, the report says that. Don't manufacture "high" findings to look thorough.
- When in doubt about whether something is rot vs intentional, surface it as a question, not a finding.

## Anti-patterns to avoid

- **Don't run linters and call it an audit.** Linters catch style violations; this skill catches semantic rot. If a finding is "eslint would flag this," it's probably not interesting enough to include.
- **Don't recommend mass-renames as quick wins.** Renaming a widely-used symbol is structural by definition. Even if it's "obviously right," it goes in the issue pile.
- **Don't open issues for typos in comments.** Either fix them inline or skip them. Issue-noise is its own form of rot.
- **Don't audit dependencies or generated code.** `node_modules`, `dist`, `build`, `__generated__`, `vendor`, `.next`, `target` — skip these by default. Mention if you scope-limit.

## Reference files

- `references/detection-patterns.md` — per-category detection commands, heuristics, and language-agnostic ripgrep patterns. Read the sections for the categories you're working on.
- `references/per-language.md` — language-specific tools and idioms (Python, TypeScript/JS, Go, Rust, Java, Ruby). Skim only the sections matching the repo's languages.
- `references/github-issues.md` — `gh` commands, epic template, child issue template, and labeling conventions. Read in full before Path B or C.
