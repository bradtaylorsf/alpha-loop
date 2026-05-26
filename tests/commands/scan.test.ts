import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock shell.exec before importing scan module
jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  run: jest.fn(),
}));

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn().mockReturnValue({ agent: 'claude', model: '' }),
  assertSafeShellArg: jest.fn((value: string) => value),
}));

jest.mock('../../src/lib/agent', () => ({
  buildOneShotCommand: jest.fn(() => 'claude -p --allowedTools "" --output-format text'),
}));

import { scanCommand } from '../../src/commands/scan';
import { exec } from '../../src/lib/shell';
import { buildOneShotCommand } from '../../src/lib/agent';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockBuildOneShotCommand = buildOneShotCommand as jest.MockedFunction<typeof buildOneShotCommand>;

const validContext = `## Architecture
- src/cli.ts wires Commander commands to handlers.

## Conventions
- TypeScript strict mode with ESM imports.

## Critical Rules
- Do not overwrite protected agent instruction files with unvalidated output.

## Active State
- Test status: pending`;

const updatedContext = `## Architecture
- new generated content

## Conventions
- TypeScript strict mode with ESM imports.

## Critical Rules
- Validate scan output before writing generated files.

## Active State
- Test status: pending`;

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
- Do not overwrite protected harness files without validation.`;

describe('scan', () => {
  let tmpDir: string;
  let origCwd: () => string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    origCwd = process.cwd;
    process.cwd = () => tmpDir;
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    process.cwd = origCwd;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('generates context.md from Claude output', () => {
    mockExec.mockReturnValueOnce({
      stdout: validContext,
      stderr: '',
      exitCode: 0,
    }).mockReturnValueOnce({
      stdout: validInstructions,
      stderr: '',
      exitCode: 0,
    });

    scanCommand();

    const contextFile = path.join(tmpDir, '.alpha-loop', 'context.md');
    expect(fs.existsSync(contextFile)).toBe(true);
    expect(fs.readFileSync(contextFile, 'utf-8')).toContain('## Architecture');
    expect(mockBuildOneShotCommand).toHaveBeenCalledWith('claude', '', { textOnly: true });
  });

  it('overwrites existing context file on re-run', () => {
    const contextDir = path.join(tmpDir, '.alpha-loop');
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(path.join(contextDir, 'context.md'), validContext);

    mockExec.mockReturnValueOnce({ stdout: updatedContext, stderr: '', exitCode: 0 })
      .mockReturnValueOnce({ stdout: validInstructions, stderr: '', exitCode: 0 });

    scanCommand();

    const contextFile = path.join(contextDir, 'context.md');
    expect(fs.readFileSync(contextFile, 'utf-8')).toContain('new generated content');
  });

  it('handles Claude CLI failure gracefully', () => {
    mockExec.mockReturnValue({ stdout: '', stderr: 'claude not found', exitCode: 1 });

    scanCommand();

    const contextFile = path.join(tmpDir, '.alpha-loop', 'context.md');
    expect(fs.existsSync(contextFile)).toBe(false);
  });

  it('does not overwrite context.md when agent output is a status summary', () => {
    const contextDir = path.join(tmpDir, '.alpha-loop');
    fs.mkdirSync(contextDir, { recursive: true });
    const contextFile = path.join(contextDir, 'context.md');
    fs.writeFileSync(contextFile, validContext);

    mockExec.mockReturnValueOnce({
      stdout: 'Wrote `PROJECT_CONTEXT.md` summarizing the current codebase.',
      stderr: '',
      exitCode: 0,
    }).mockReturnValueOnce({
      stdout: validInstructions,
      stderr: '',
      exitCode: 0,
    });

    scanCommand();

    expect(fs.readFileSync(contextFile, 'utf-8')).toBe(validContext);
  });

  it('keeps existing instructions and does not create a backup when merge output is invalid', () => {
    const templatesDir = path.join(tmpDir, '.alpha-loop', 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    const instructionsFile = path.join(templatesDir, 'instructions.md');
    fs.writeFileSync(instructionsFile, validInstructions);

    mockExec.mockReturnValueOnce({
      stdout: validContext,
      stderr: '',
      exitCode: 0,
    }).mockReturnValueOnce({
      stdout: 'Updated CLAUDE.md to reflect the current codebase.',
      stderr: '',
      exitCode: 0,
    });

    scanCommand();

    expect(fs.readFileSync(instructionsFile, 'utf-8')).toBe(validInstructions);
    expect(fs.existsSync(instructionsFile + '.bak')).toBe(false);
  });
});
