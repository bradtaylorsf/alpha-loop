import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec } from '../lib/shell.js';
import { logError, logStep, logSuccess, logWarn } from '../lib/logger.js';
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

export function scanCommand(): void {
  const projectDir = process.cwd();
  const contextDir = path.join(projectDir, '.alpha-loop');
  const contextFile = path.join(contextDir, 'context.md');
  const config = loadConfig();

  fs.mkdirSync(contextDir, { recursive: true });

  logStep('Scanning codebase for project context...');

  const model = assertSafeShellArg(config.model ?? 'opus', 'model');
  const result = exec(
    `echo ${JSON.stringify(SCAN_PROMPT)} | claude -p --model ${model} --dangerously-skip-permissions --output-format text 2>/dev/null`,
    { cwd: projectDir },
  );

  if (result.exitCode === 0 && result.stdout) {
    fs.writeFileSync(contextFile, result.stdout + '\n');
    logSuccess(`Project context saved to ${contextFile}`);
  } else if (result.stdout) {
    fs.writeFileSync(contextFile, result.stdout + '\n');
    logWarn('Claude exited with errors but produced output');
    logSuccess(`Project context saved to ${contextFile}`);
  } else {
    logError(`Project context generation failed: ${result.stderr || 'empty output'}`);
  }
}
