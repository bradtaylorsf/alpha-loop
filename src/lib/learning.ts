/**
 * Learning Extractor — extract and aggregate learnings from completed runs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';
import { spawnAgent } from './agent.js';
import { buildLearnPrompt } from './prompts.js';
import type { Config } from './config.js';

export type ExtractLearningsOptions = {
  issueNum: number;
  title: string;
  status: string;
  retries: number;
  duration: number;
  diff: string;
  testOutput: string;
  reviewOutput: string;
  verifyOutput: string;
  body: string;
  config: Config;
};

/**
 * Extract learnings from a completed run.
 * Invokes an agent with the learn prompt and saves the output.
 */
export async function extractLearnings(options: ExtractLearningsOptions): Promise<void> {
  const { config } = options;

  if (config.skipLearn) {
    log.info('Skipping learning extraction (skipLearn=true)');
    return;
  }

  log.step('Extracting learnings from run...');

  const learningsDir = join(process.cwd(), 'learnings');
  mkdirSync(learningsDir, { recursive: true });

  const timestamp = formatTimestamp(new Date());
  const learningFile = join(learningsDir, `issue-${options.issueNum}-${timestamp}.md`);

  const prompt = buildLearnPrompt({
    issueNum: options.issueNum,
    title: options.title,
    status: options.status,
    retries: options.retries,
    duration: options.duration,
    diff: options.diff,
    testOutput: options.testOutput,
    reviewOutput: options.reviewOutput,
    verifyOutput: options.verifyOutput,
    body: options.body,
  });

  if (config.dryRun) {
    log.dry(`Would extract learnings to ${learningFile}`);
    return;
  }

  const result = await spawnAgent({
    agent: 'claude',
    model: config.reviewModel,
    prompt,
    cwd: process.cwd(),
    logFile: undefined,
  });

  if (result.exitCode !== 0 || !result.output.trim()) {
    log.warn('Learning extraction failed, skipping');
    return;
  }

  const output = result.output.trim();

  // Validate output has frontmatter, wrap if not
  if (output.startsWith('---')) {
    writeFileSync(learningFile, output + '\n');
    log.success(`Learning saved to ${learningFile}`);
  } else {
    const today = new Date().toISOString().split('T')[0];
    const wrapped = `---
issue: ${options.issueNum}
status: ${options.status}
retries: ${options.retries}
duration: ${options.duration}
date: ${today}
---
${output}`;
    writeFileSync(learningFile, wrapped + '\n');
    log.success(`Learning saved to ${learningFile} (added frontmatter)`);
  }
}

/**
 * Count learning files in the learnings directory.
 */
export function countLearnings(learningsDir: string): number {
  if (!existsSync(learningsDir)) return 0;
  return readdirSync(learningsDir)
    .filter((f) => f.startsWith('issue-') && f.endsWith('.md'))
    .length;
}

/**
 * Get learning context for injection into implementation prompts.
 * Reads the last N learning files and extracts key sections.
 */
export function getLearningContext(learningsDir: string): string {
  if (!existsSync(learningsDir)) return '';

  const files = readdirSync(learningsDir)
    .filter((f) => f.startsWith('issue-') && f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, 5);

  if (files.length === 0) return '';

  const sections: string[] = ['## Learnings from Previous Runs', ''];

  for (const file of files) {
    const content = readFileSync(join(learningsDir, file), 'utf-8');

    // Extract issue number and status from frontmatter
    const issueMatch = content.match(/^issue:\s*(.+)$/m);
    const statusMatch = content.match(/^status:\s*(.+)$/m);
    const issue = issueMatch?.[1] ?? 'unknown';
    const status = statusMatch?.[1] ?? 'unknown';

    sections.push(`### Run #${issue} (${status})`);

    // Extract What Worked section
    const workedMatch = content.match(/## What Worked\n([\s\S]*?)(?=\n## |$)/);
    if (workedMatch) sections.push(workedMatch[1].trim());

    // Extract What Failed section
    const failedMatch = content.match(/## What Failed\n([\s\S]*?)(?=\n## |$)/);
    if (failedMatch) sections.push(failedMatch[1].trim());

    sections.push('');
  }

  // Extract anti-patterns from recent learnings
  const antiPatterns: string[] = [];
  const recentFiles = readdirSync(learningsDir)
    .filter((f) => f.startsWith('issue-') && f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, 10);

  for (const file of recentFiles) {
    const content = readFileSync(join(learningsDir, file), 'utf-8');
    const apMatch = content.match(/## Anti-Patterns\n([\s\S]*?)(?=\n## |$)/);
    if (apMatch) antiPatterns.push(apMatch[1].trim());
  }

  if (antiPatterns.length > 0) {
    sections.push('', '## Known Anti-Patterns to Avoid');
    sections.push(antiPatterns.join('\n'));
  }

  return sections.join('\n');
}

function formatTimestamp(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}${s}`;
}
