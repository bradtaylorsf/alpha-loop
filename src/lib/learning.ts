/**
 * Learning Extractor — extract and aggregate learnings from completed runs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';
import { formatTimestamp } from './shell.js';
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

  const learningsDir = join(process.cwd(), '.alpha-loop', 'learnings');
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
    log.warn(`Learning extraction failed (exit ${result.exitCode}, output ${result.output.length} chars), skipping`);
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

/**
 * Generate a session summary that aggregates learnings across all processed issues.
 * Produces a markdown summary with patterns, anti-patterns, and recommendations.
 */
export async function generateSessionSummary(options: {
  sessionName: string;
  results: Array<{ issueNum: number; title: string; status: string; duration: number }>;
  learningsDir: string;
  config: Config;
}): Promise<string | null> {
  const { sessionName, results, learningsDir, config } = options;

  if (config.skipLearn || config.dryRun || results.length === 0) return null;

  log.step('Generating session summary...');

  // Collect all learnings from this session
  const learningContents: string[] = [];
  for (const result of results) {
    const files = readdirSync(learningsDir)
      .filter((f) => f.startsWith(`issue-${result.issueNum}-`) && f.endsWith('.md'));
    for (const file of files) {
      learningContents.push(readFileSync(join(learningsDir, file), 'utf-8'));
    }
  }

  if (learningContents.length === 0) return null;

  const successCount = results.filter((r) => r.status === 'success').length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  const prompt = `Analyze these learnings from a development session and produce a concise session summary with actionable recommendations.

## Session: ${sessionName}
- Issues processed: ${results.length} (${successCount} succeeded, ${results.length - successCount} failed)
- Total duration: ${Math.round(totalDuration / 60)} minutes

## Individual Learnings

${learningContents.join('\n\n---\n\n')}

Output ONLY this markdown structure:

# Session Summary: ${sessionName}

## Overview
- (2-3 sentences summarizing the session)

## Recurring Patterns
- (patterns that appeared across multiple issues — these should be reinforced)

## Recurring Anti-Patterns
- (problems that kept happening — these need fixing)

## Recommendations
- (specific, actionable improvements for the agent prompts, project config, or workflow)
- (e.g., "Update the implement prompt to always check for X before Y")
- (e.g., "Add a pre-check for port conflicts before starting verification")

## Metrics
| Metric | Value |
|--------|-------|
| Issues processed | ${results.length} |
| Success rate | ${Math.round((successCount / results.length) * 100)}% |
| Avg duration | ${Math.round(totalDuration / results.length)}s |
| Total duration | ${Math.round(totalDuration / 60)} min |`;

  const agentResult = await spawnAgent({
    agent: 'claude',
    model: config.reviewModel,
    prompt,
    cwd: process.cwd(),
    logFile: undefined,
  });

  if (agentResult.exitCode !== 0 || !agentResult.output.trim()) {
    log.warn('Session summary generation failed');
    return null;
  }

  const summaryFile = join(learningsDir, `session-summary-${sessionName.replace(/\//g, '-')}.md`);
  writeFileSync(summaryFile, agentResult.output.trim() + '\n');
  log.success(`Session summary saved: ${summaryFile}`);

  return agentResult.output.trim();
}

