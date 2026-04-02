import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import { assertSafeShellArg, loadConfig } from '../lib/config.js';

const SCAN_PROMPT = `Analyze this codebase and produce a concise project context file. Read the key files (package.json, entry points, config files, README, CLAUDE.md) and output ONLY this markdown structure:

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

Keep each section to 3-5 bullet points. Be specific to THIS codebase, not generic advice. Under 400 words total.`;

/**
 * Prompt for generating the lean instructions file.
 * Contains ONLY project context — procedural content (testing, git, security) lives in skills.
 */
const INSTRUCTIONS_PROMPT = `Analyze this codebase and produce a concise project instructions file for AI coding agents working in this repo.

Output ONLY this markdown structure with the marker comment on the first line:

<!-- managed by alpha-loop -->
# [Project Name]

## Overview
[2-3 sentences: what this project is, what it does, who it's for]

## Tech Stack
- Language: [e.g., TypeScript (strict mode, ESM)]
- Runtime: [e.g., Node.js 20+]
- Framework: [e.g., Express 5, React 19]
- Package manager: [e.g., pnpm]
- Key dependencies: [top 3-5 important dependencies]

## Directory Structure
[List key directories and what they contain — only the important ones, not every folder]

## Code Style
[Naming conventions, import ordering, formatting rules, architectural patterns — be specific to THIS codebase]

## Non-Negotiables
[Critical rules that must never be violated — security, data safety, patterns that break things if not followed]

IMPORTANT RULES:
- Do NOT include testing procedures, git workflow, code review checklists, or security scanning procedures — those belong in separate skills, not here.
- Do NOT include build/deploy commands — those are operational, not instructional.
- Keep it under 150 lines. Be specific to THIS codebase, not generic advice.
- The marker comment "<!-- managed by alpha-loop -->" MUST be the very first line.`;

/**
 * Prompt for merging an existing instructions file with fresh scan results.
 */
const INSTRUCTIONS_MERGE_PROMPT = `You are updating a project instructions file for AI coding agents.

Below is the EXISTING instructions file and the CURRENT state of the codebase. Your job is to:
1. PRESERVE any user customizations and project-specific rules in the existing file
2. UPDATE sections that are stale or incorrect based on the current codebase
3. ADD any important new context discovered in the codebase
4. REMOVE information that is no longer accurate

The marker comment "<!-- managed by alpha-loop -->" MUST remain as the very first line.

IMPORTANT: Do NOT add testing procedures, git workflow, code review checklists, or security scanning — those belong in skills, not instructions. Keep the same 5-section structure (Overview, Tech Stack, Directory Structure, Code Style, Non-Negotiables). Keep it under 150 lines.

## EXISTING INSTRUCTIONS FILE:

`;

export function scanCommand(): void {
  const projectDir = process.cwd();
  const contextDir = path.join(projectDir, '.alpha-loop');
  const contextFile = path.join(contextDir, 'context.md');
  const config = loadConfig();

  fs.mkdirSync(contextDir, { recursive: true });

  // --- Generate project context ---
  log.step('Scanning codebase for project context...');

  const model = assertSafeShellArg(config.model ?? 'opus', 'model');
  const result = exec(
    `echo ${JSON.stringify(SCAN_PROMPT)} | claude -p --model ${model} --dangerously-skip-permissions --output-format text 2>/dev/null`,
    { cwd: projectDir },
  );

  if (result.exitCode === 0 && result.stdout) {
    fs.writeFileSync(contextFile, result.stdout + '\n');
    log.success(`Project context saved to ${contextFile}`);
  } else if (result.stdout) {
    fs.writeFileSync(contextFile, result.stdout + '\n');
    log.warn('Claude exited with errors but produced output');
    log.success(`Project context saved to ${contextFile}`);
  } else {
    log.error(`Project context generation failed: ${result.stderr || 'empty output'}`);
  }

  // --- Generate instructions file ---
  generateInstructions(projectDir, model);
}

/**
 * Generate or update the instructions file at .alpha-loop/templates/instructions.md.
 * If no existing file, generates from scratch. If existing, merges with fresh scan.
 */
export function generateInstructions(projectDir: string, model: string): void {
  const templatesDir = path.join(projectDir, '.alpha-loop', 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });

  const instructionsFile = path.join(templatesDir, 'instructions.md');
  const existing = fs.existsSync(instructionsFile)
    ? fs.readFileSync(instructionsFile, 'utf-8')
    : null;

  if (existing) {
    // Merge mode: preserve user customizations, update stale content
    log.step('Updating instructions file...');

    // Back up existing before merge
    fs.writeFileSync(instructionsFile + '.bak', existing, 'utf-8');

    const mergePrompt = INSTRUCTIONS_MERGE_PROMPT + existing +
      '\n\n## OUTPUT:\nProduce the updated instructions file. Output ONLY the markdown content, nothing else.';

    // Write prompt to temp file to avoid shell injection from file content
    const safeModel = assertSafeShellArg(model, 'model');
    const promptFile = path.join(tmpdir(), `alpha-loop-merge-${Date.now()}.txt`);
    fs.writeFileSync(promptFile, mergePrompt, 'utf-8');
    const mergeResult = exec(
      `claude -p --model ${safeModel} --dangerously-skip-permissions --output-format text < "${promptFile}" 2>/dev/null`,
      { cwd: projectDir },
    );
    try { fs.unlinkSync(promptFile); } catch { /* cleanup best-effort */ }

    if (mergeResult.exitCode === 0 && mergeResult.stdout.trim()) {
      let output = mergeResult.stdout.trim();
      // Ensure marker is present
      if (!output.startsWith('<!-- managed by alpha-loop -->')) {
        output = '<!-- managed by alpha-loop -->\n' + output;
      }
      fs.writeFileSync(instructionsFile, output + '\n');
      log.success('Instructions file updated (backup at instructions.md.bak)');
    } else {
      log.warn('Instructions merge failed, keeping existing file');
    }
  } else {
    // Fresh generation
    log.step('Generating baseline instructions file...');

    const safeModel = assertSafeShellArg(model, 'model');
    const genPromptFile = path.join(tmpdir(), `alpha-loop-gen-${Date.now()}.txt`);
    fs.writeFileSync(genPromptFile, INSTRUCTIONS_PROMPT, 'utf-8');
    const genResult = exec(
      `claude -p --model ${safeModel} --dangerously-skip-permissions --output-format text < "${genPromptFile}" 2>/dev/null`,
      { cwd: projectDir },
    );
    try { fs.unlinkSync(genPromptFile); } catch { /* cleanup best-effort */ }

    if (genResult.exitCode === 0 && genResult.stdout.trim()) {
      let output = genResult.stdout.trim();
      if (!output.startsWith('<!-- managed by alpha-loop -->')) {
        output = '<!-- managed by alpha-loop -->\n' + output;
      }
      fs.writeFileSync(instructionsFile, output + '\n');
      log.success(`Instructions file generated: ${instructionsFile}`);
    } else if (genResult.stdout?.trim()) {
      let output = genResult.stdout.trim();
      if (!output.startsWith('<!-- managed by alpha-loop -->')) {
        output = '<!-- managed by alpha-loop -->\n' + output;
      }
      fs.writeFileSync(instructionsFile, output + '\n');
      log.warn('Claude exited with errors but produced instructions output');
    } else {
      log.warn('Instructions generation failed — will retry on next scan');
    }
  }
}
