import {
  validateInstructionsMarkdown,
  validateProjectContextMarkdown,
} from '../../src/lib/scan-validation.js';

const validContext = `## Architecture
- src/cli.ts wires Commander commands to handlers.

## Conventions
- TypeScript strict mode with ESM imports.

## Critical Rules
- Keep generated harness files in sync with templates.

## Active State
- Test status: pending
`;

const validInstructions = `<!-- managed by alpha-loop -->
# Alpha Loop

## Overview
Alpha Loop runs an automated development loop for coding agents.

## Tech Stack
- Language: TypeScript

## Directory Structure
- src/: CLI and orchestration code

## Code Style
- Use ESM imports with .js extensions.

## Non-Negotiables
- Do not overwrite protected harness files without validation.
`;

describe('scan output validation', () => {
  it('accepts project context with the required headings', () => {
    expect(validateProjectContextMarkdown(validContext)).toEqual({ valid: true });
  });

  it('rejects context that is an agent status summary', () => {
    const result = validateProjectContextMarkdown('Wrote `PROJECT_CONTEXT.md` summarizing the current codebase.');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('agent status summary');
  });

  it('rejects context missing required headings', () => {
    const result = validateProjectContextMarkdown('## Architecture\n- only one section');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('## Conventions');
  });

  it('accepts managed instructions with the required headings', () => {
    expect(validateInstructionsMarkdown(validInstructions)).toEqual({ valid: true });
  });

  it('rejects instructions without the managed marker', () => {
    const result = validateInstructionsMarkdown(validInstructions.replace('<!-- managed by alpha-loop -->\n', ''));

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('managed marker');
  });

  it('rejects instructions that are an update summary', () => {
    const result = validateInstructionsMarkdown('Updated CLAUDE.md to reflect the current codebase.');

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('agent status summary');
  });
});
