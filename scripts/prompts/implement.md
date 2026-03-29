# Task: Implement GitHub Issue #{NUMBER}

## Issue: {TITLE}

{BODY}

## Instructions

You are an autonomous coding agent implementing a GitHub issue. Follow these steps precisely:

### Step 1: Understand the Requirements
- Read the issue description and acceptance criteria above carefully
- Identify the specific files and areas of the codebase that need changes
- Note any test requirements mentioned

### Step 2: Explore the Codebase
- Read the relevant files to understand existing patterns
- Check for related tests that may need updating
- Understand the project's conventions from CLAUDE.md

### Step 3: Plan Your Approach
- Decide which files to create or modify
- Plan the implementation order (types first, then implementation, then tests)
- Consider edge cases mentioned in the acceptance criteria

### Step 4: Implement the Changes
- Write clean, well-typed TypeScript code
- Follow existing patterns in the codebase
- Keep changes focused on the issue requirements -- do NOT refactor unrelated code

### Step 5: Write Tests
- Add unit tests for new functions/modules
- Add API tests for new endpoints
- Update existing tests if behavior changed
- Ensure test names clearly describe what they verify

### Step 6: Verify Everything Works
- Run `pnpm test` to verify all tests pass
- Run `pnpm type-check` to verify TypeScript compiles
- Install any missing dependencies with `pnpm add` or `pnpm add -D` as needed

### Step 7: Commit Your Changes
- Stage only the files you changed: `git add <specific files>`
- Write a conventional commit message: `feat:`, `fix:`, `test:`, `refactor:`, etc.
- Include the issue reference: `Closes #{NUMBER}` or `Refs #{NUMBER}`
- Example: `feat: add health check endpoint (closes #{NUMBER})`

## Rules
- Follow the project's CLAUDE.md guidelines strictly
- Use pnpm (not npm or yarn)
- Use TypeScript strict mode with explicit types for exports
- Use .js extensions in imports (ESM)
- Prefer functions over classes
- Do NOT add features beyond what the issue requests
- Do NOT modify unrelated files
- Do NOT add unnecessary comments or documentation
- Ensure ALL tests pass before committing
