---
name: docs-sync
description: Ensure documentation stays in sync with code changes. Trigger when modifying CLI commands, config options, directory structure, or public APIs.
when-to-use: When adding, removing, or changing CLI commands, config fields, directory layout, or user-facing behavior
---

# Documentation Sync

When making changes that affect user-facing behavior, always update the corresponding documentation.

## What to check

### CLI commands changed?
- Update `README.md` commands table
- Update `CLAUDE.md` commands section
- Update `--help` descriptions in `src/cli.ts`

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

## Rules

- Documentation updates MUST be in the same commit as the code change
- Never leave README or CLAUDE.md referencing commands, options, or paths that no longer exist
- When removing a feature, search docs for all references before committing
- Keep README under 300 lines, CLAUDE.md under 200 lines
