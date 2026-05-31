---
name: docs-sync
description: Ensure documentation stays in sync with code changes. Trigger on src/commands/*.ts command/flag/help changes, src/cli.ts help text changes, README.md/CLAUDE.md Commands entries, config options, directory structure, or public APIs.
when-to-use: When adding, removing, or changing CLI commands, flags, arguments, help text, config fields, directory layout, public APIs, or Commands documentation in README.md or CLAUDE.md
---

# Documentation Sync

When making changes that affect user-facing behavior, always update the corresponding documentation.

## Must trigger on

- Any diff under `src/commands/*.ts` that adds, removes, renames, or changes a command, flag, option, argument, help text, output mode, or user-facing behavior. This includes focused command handlers such as `src/commands/history.ts`.
- Any `src/cli.ts` change to `.command()`, `.description()`, `.option()`, arguments, aliases, examples, or generated `--help` text.
- Any new, removed, or changed command entry in the `## Commands` section or table of `README.md` or `CLAUDE.md`.
- Config option, directory structure, skill/agent template, public API, or other user-facing behavior changes.

## What to check

### CLI commands changed?
- Capture the actual CLI help text, including top-level help and every touched command's help.
- Diff command names, descriptions, arguments, flags/options, and aliases against `README.md` and `CLAUDE.md`.
- Update `README.md` Commands table for every changed command or option.
- Update `CLAUDE.md` Commands section for every changed command or option.
- Update `--help` descriptions in `src/cli.ts` if docs reveal unclear or stale help text.

### CLI docs drift workflow
1. Identify touched CLI surfaces from the diff:
   - `src/cli.ts` means capture `alpha-loop --help`.
   - `src/commands/<name>.ts` means capture `alpha-loop <name> --help` plus top-level help.
   - If a docs-only diff changes `README.md` or `CLAUDE.md` Commands entries, still compare against actual help.
2. Prefer built help when available:
   - `pnpm build`
   - `node dist/cli.js --help`
   - `node dist/cli.js <command> --help`
   If building is not practical during review or learn, inspect `src/cli.ts` and the touched `src/commands/*.ts` handler directly, then state that the help comparison was source-based.
3. Compare actual CLI help and command-handler behavior against:
   - `README.md` `## Commands`
   - `CLAUDE.md` `## Commands`
4. Propose patches for every mismatch. Do not just say docs may be stale; name the exact file and command entry that needs to change.

### Config options changed?
- Update `README.md` Configuration Reference table
- Update `README.md` config example block
- Update `CLAUDE.md` if it references config
- Update the config template in `src/commands/init.ts`

### Directory structure changed?
- Update `CLAUDE.md` Directory Structure section
- Update `README.md` Project Artifacts table

### New skill or agent added?
- Skill: create `templates/skills/<name>/SKILL.md` with frontmatter
- Agent: create `templates/agents/<name>.md` with frontmatter
- Run `alpha-loop sync` to distribute

### Public API or behavior changed?
- Update relevant README sections
- Update CLAUDE.md if architectural

## Worked example

A diff changes `src/commands/history.ts` so `alpha-loop history queue-<timestamp>` inspects a multi-epic queue manifest. `CLAUDE.md` still says:

```text
alpha-loop history       # View session history
```

This must trigger `docs-sync` because `src/commands/history.ts` is a CLI command handler. Capture or inspect `alpha-loop history --help`, compare it against both docs, and propose patches like:

```text
alpha-loop history       # View session and queue history
alpha-loop history queue-<timestamp> # Inspect a multi-epic queue manifest
```

For `README.md`, add or update the corresponding Commands table rows for `alpha-loop history` and `alpha-loop history queue-<timestamp>`.

## Rules

- Documentation updates MUST be in the same commit as the code change
- Never leave README or CLAUDE.md referencing commands, options, or paths that no longer exist
- When removing a feature, search docs for all references before committing
- Review and learn stages must load this skill for `src/commands/*.ts` diffs even when `src/cli.ts` did not change
- If docs are protected in the current workflow, still propose the exact patch and mark it as a required follow-up
- Keep README under 300 lines, CLAUDE.md under 200 lines
