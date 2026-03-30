import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec, type ExecResult } from './shell.js';

const CONTEXT_DIR = '.alpha-loop';
const CONTEXT_FILE = join(CONTEXT_DIR, 'context.md');
// Issue spec says 4 hours (loop.sh uses 7 days — we follow the issue spec)
const CONTEXT_MAX_AGE_MS = 4 * 60 * 60 * 1000;

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
 * Generate a fresh project context file by invoking the configured agent.
 */
export async function generateProjectContext(
  projectDir: string,
  agentCommand: string,
  executor: (cmd: string, cwd?: string) => Promise<ExecResult> = exec,
): Promise<void> {
  const contextDir = join(projectDir, CONTEXT_DIR);
  const contextFile = join(projectDir, CONTEXT_FILE);

  if (!existsSync(contextDir)) {
    mkdirSync(contextDir, { recursive: true });
  }

  const escapedPrompt = SCAN_PROMPT.replace(/'/g, "'\\''");
  const cmd = `echo '${escapedPrompt}' | ${agentCommand} -p --output-format text 2>/dev/null`;

  const result = await executor(cmd, projectDir);

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return; // Generation failed silently, matching bash behavior
  }

  writeFileSync(contextFile, result.stdout, 'utf-8');
}

/**
 * Read the current project context, or null if it doesn't exist.
 */
export function getProjectContext(projectDir: string = '.'): string | null {
  const contextFile = join(projectDir, CONTEXT_FILE);
  if (!existsSync(contextFile)) {
    return null;
  }
  return readFileSync(contextFile, 'utf-8');
}

/**
 * Check if context needs refreshing (older than 4 hours or doesn't exist).
 */
export function contextNeedsRefresh(
  projectDir: string = '.',
  now: number = Date.now(),
): boolean {
  const contextFile = join(projectDir, CONTEXT_FILE);
  if (!existsSync(contextFile)) {
    return true;
  }

  const mtime = statSync(contextFile).mtimeMs;
  return (now - mtime) >= CONTEXT_MAX_AGE_MS;
}

/**
 * Update context after a successful run by appending a summary under ## Active State.
 */
export function updateContextAfterRun(
  issueNum: number,
  title: string,
  status: string,
  filesChanged: number,
  projectDir: string = '.',
): void {
  const contextFile = join(projectDir, CONTEXT_FILE);
  if (!existsSync(contextFile)) {
    return;
  }

  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, '');
  const entry = `- [${timestamp}] #${issueNum} ${title} (${status}) — ${filesChanged} files changed`;

  const content = readFileSync(contextFile, 'utf-8');
  const marker = '## Active State';
  const markerIndex = content.indexOf(marker);

  if (markerIndex === -1) {
    return;
  }

  // Insert the entry on the line after the marker
  const insertPos = content.indexOf('\n', markerIndex);
  if (insertPos === -1) {
    // Marker is at end of file
    writeFileSync(contextFile, content + '\n' + entry + '\n', 'utf-8');
    return;
  }

  const updated = content.slice(0, insertPos + 1) + entry + '\n' + content.slice(insertPos + 1);
  writeFileSync(contextFile, updated, 'utf-8');
}
