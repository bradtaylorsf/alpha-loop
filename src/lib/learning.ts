/**
 * Learning Extractor — extract and aggregate learnings from completed runs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';
import { formatTimestamp } from './shell.js';
import { spawnAgent } from './agent.js';
import { buildLearnPrompt } from './prompts.js';
import { resolveStepConfig } from './config.js';
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
  outputRoot?: string;
  agentCwd?: string;
  sessionLogsDir?: string;
  sessionName?: string;
};

export type SessionLearningRepairResult = {
  repaired: number;
  created: number;
  skipped: number;
  failed: number;
};

export type SessionLearningRepairIssue = {
  issueNum: number;
  title?: string;
  status?: string;
  duration?: number;
  retries?: number;
};

export type SessionSummaryResult = {
  issueNum: number;
  title: string;
  status: string;
  duration: number;
  recoveryMode?: string;
};

/** Expected sections in learning output. */
const LEARNING_SECTIONS = [
  '## What Worked',
  '## What Failed',
  '## Patterns',
  '## Anti-Patterns',
  '## Suggested Skill Updates',
];

const SESSION_SUMMARY_SECTIONS = [
  '## Overview',
  '## Recurring Patterns',
  '## Recurring Anti-Patterns',
  '## Recommendations',
  '## Metrics',
];

type MarkdownCandidate = {
  frontmatter: string | null;
  sections: string;
  hasMeaningfulSections: boolean;
  sectionCount: number;
};

type FrontmatterBlock = {
  start: number;
  end: number;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripListMarker(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

function isPlaceholderLine(line: string): boolean {
  const normalized = stripListMarker(line).replace(/\s+/g, ' ').trim();
  return normalized.startsWith('(') && normalized.endsWith(')');
}

function hasMeaningfulContent(content: string): boolean {
  return content
    .split(/\r?\n/)
    .map(stripListMarker)
    .filter((line) => line.length > 0)
    .some((line) => !isPlaceholderLine(line));
}

function trimTrailingCliNoise(content: string): string {
  const cliNoiseLine = /^(?:tokens used|token usage|session id|openai codex|workdir|provider|model|approval|sandbox|reasoning effort|reasoning summaries|warning|reading prompt from stdin)(?:\b|:|\.\.\.$)/i;
  const timestampedCliLogLine = /^\d{4}-\d{2}-\d{2}T\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\b/;
  const transcriptRoleLine = /^(?:user|assistant|codex|system|developer|thinking)$/i;
  const transcriptDelimiterLine = /^-{8,}$/;
  const lines = content.trim().split(/\r?\n/);
  const noiseIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return (
      cliNoiseLine.test(trimmed)
      || timestampedCliLogLine.test(trimmed)
      || transcriptRoleLine.test(trimmed)
      || transcriptDelimiterLine.test(trimmed)
    );
  });

  return (noiseIndex === -1 ? lines : lines.slice(0, noiseIndex)).join('\n').trim();
}

function removePlaceholderLines(content: string): string {
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length === 0 || !isPlaceholderLine(line))
    .join('\n')
    .trim();
}

function extractSection(markdown: string, header: string): string | null {
  const pattern = new RegExp(`^${escapeRegex(header)}[ \\t]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`, 'm');
  const match = markdown.match(pattern);
  if (!match) return null;
  return removePlaceholderLines(trimTrailingCliNoise(match[1]));
}

function extractLeadingFrontmatter(markdown: string): string | null {
  const match = markdown.trimStart().match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

function frontmatterValue(frontmatter: string | null, key: string): string | null {
  if (!frontmatter) return null;
  const match = frontmatter.match(new RegExp(`^${escapeRegex(key)}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function findFrontmatterBlocks(raw: string): FrontmatterBlock[] {
  const blocks: FrontmatterBlock[] = [];
  const pattern = /(?:^|\r?\n)(---\r?\n[\s\S]*?\r?\n---)(?=\r?\n|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const fullMatch = match[0];
    const prefixLength = fullMatch.startsWith('\r\n') ? 2 : fullMatch.startsWith('\n') ? 1 : 0;
    const start = match.index + prefixLength;
    const end = start + match[1].length;
    blocks.push({ start, end });
  }

  return blocks;
}

function findPrecedingFrontmatterStart(raw: string, headerIndex: number, blocks: FrontmatterBlock[]): number | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.end > headerIndex) continue;
    if (raw.slice(block.end, headerIndex).trim() === '') {
      return block.start;
    }
  }
  return null;
}

function collectLearningCandidates(raw: string): string[] {
  const frontmatterBlocks = findFrontmatterBlocks(raw);
  const starts: number[] = [];
  const headerPattern = /^## What Worked[ \t]*$/gm;
  let match: RegExpExecArray | null;

  while ((match = headerPattern.exec(raw)) !== null) {
    const start = findPrecedingFrontmatterStart(raw, match.index, frontmatterBlocks) ?? match.index;
    if (starts[starts.length - 1] !== start) starts.push(start);
  }

  if (starts.length === 0) return [raw.trim()];

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? raw.length;
    return raw.slice(start, end).trim();
  });
}

function parseLearningCandidate(markdown: string): MarkdownCandidate {
  const extracted: string[] = [];
  let meaningfulSectionCount = 0;
  let sectionCount = 0;

  for (const header of LEARNING_SECTIONS) {
    const content = extractSection(markdown, header);
    if (!content) continue;
    sectionCount++;
    if (!hasMeaningfulContent(content)) continue;

    extracted.push(`${header}\n${content}`);
    meaningfulSectionCount++;
  }

  return {
    frontmatter: extractLeadingFrontmatter(markdown),
    sections: extracted.join('\n\n'),
    hasMeaningfulSections: meaningfulSectionCount > 0,
    sectionCount,
  };
}

function hasCliNoise(content: string): boolean {
  return /(?:OpenAI Codex|Reading prompt from stdin|tokens used|codex_core_|^workdir:|^provider:|^sandbox:|^reasoning effort:)/mi.test(content);
}

function hasPlaceholderContent(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => isPlaceholderLine(line));
}

function learningArtifactIsClean(content: string): boolean {
  const parsed = parseLearningOutput(content);
  return parsed.hasMeaningfulSections
    && parsed.sections.trim().length > 0
    && !hasCliNoise(content)
    && !hasPlaceholderContent(content);
}

/**
 * Parse raw agent output and extract only the expected learning sections.
 * Discards prompt echoes, session logs, tool calls, and other noise.
 */
export function parseLearningOutput(raw: string): { frontmatter: string | null; sections: string; hasMeaningfulSections: boolean } {
  const parsedCandidates = collectLearningCandidates(raw)
    .map(parseLearningCandidate)
    .filter((candidate) => candidate.hasMeaningfulSections);

  const completeCandidates = parsedCandidates.filter((candidate) => candidate.sectionCount === LEARNING_SECTIONS.length);
  const candidates = completeCandidates.length > 0 ? completeCandidates : parsedCandidates;
  const selected = candidates[candidates.length - 1];
  return selected ?? { frontmatter: null, sections: '', hasMeaningfulSections: false };
}

function collectSessionSummaryCandidates(raw: string): string[] {
  const starts: number[] = [];
  const titlePattern = /^# Session Summary: .+$/gm;
  let match: RegExpExecArray | null;

  while ((match = titlePattern.exec(raw)) !== null) {
    starts.push(match.index);
  }

  if (starts.length === 0) return [];

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? raw.length;
    return raw.slice(start, end).trim();
  });
}

function parseSessionSummaryCandidate(markdown: string): string | null {
  const title = markdown.match(/^# Session Summary: .+$/m)?.[0].trim();
  if (!title) return null;

  const sections = new Map<string, string>();
  for (const header of SESSION_SUMMARY_SECTIONS) {
    const content = extractSection(markdown, header);
    if (!content) return null;
    sections.set(header, content);
  }

  const overview = sections.get('## Overview') ?? '';
  const narrativeSections = [
    sections.get('## Recurring Patterns') ?? '',
    sections.get('## Recurring Anti-Patterns') ?? '',
    sections.get('## Recommendations') ?? '',
  ];
  if (!hasMeaningfulContent(overview) || !narrativeSections.some(hasMeaningfulContent)) {
    return null;
  }

  return [
    title,
    '',
    ...SESSION_SUMMARY_SECTIONS.flatMap((header) => [header, sections.get(header) ?? '', '']),
  ].join('\n').trim();
}

/**
 * Extract the final session summary markdown from raw agent output.
 */
export function parseSessionSummaryOutput(raw: string): string | null {
  const validCandidates = collectSessionSummaryCandidates(raw)
    .map(parseSessionSummaryCandidate)
    .filter((candidate): candidate is string => candidate !== null);

  return validCandidates[validCandidates.length - 1] ?? null;
}

/**
 * Build trace pointers for a learning file's frontmatter.
 */
function buildTracePointers(sessionName: string, issueNum: number): string {
  const base = `.alpha-loop/sessions/${sessionName}`;
  return [
    'traces:',
    `  plan: ${base}/traces/prompts/plan-issue-${issueNum}.md`,
    `  implement: ${base}/logs/issue-${issueNum}-implement.log`,
    `  review: ${base}/traces/outputs/review-issue-${issueNum}.log`,
    `  diff: ${base}/diffs/issue-${issueNum}.diff`,
  ].join('\n');
}

function buildRepairedLearningFrontmatter(options: {
  issue: SessionLearningRepairIssue;
  existingFrontmatter: string | null;
  parsedFrontmatter: string | null;
  sessionName: string;
}): string {
  const { issue, existingFrontmatter, parsedFrontmatter, sessionName } = options;
  const retries = issue.retries
    ?? Number(frontmatterValue(existingFrontmatter, 'retries') ?? frontmatterValue(parsedFrontmatter, 'retries') ?? frontmatterValue(parsedFrontmatter, 'test_fix_retries') ?? 0);
  const duration = issue.duration
    ?? Number(frontmatterValue(existingFrontmatter, 'duration') ?? frontmatterValue(parsedFrontmatter, 'duration') ?? 0);
  const status = issue.status ?? frontmatterValue(existingFrontmatter, 'status') ?? frontmatterValue(parsedFrontmatter, 'status') ?? 'success';
  const date = frontmatterValue(existingFrontmatter, 'date')
    ?? frontmatterValue(parsedFrontmatter, 'date')
    ?? new Date().toISOString().split('T')[0];

  return [
    `issue: ${issue.issueNum}`,
    `status: ${status}`,
    `retries: ${Number.isFinite(retries) ? retries : 0}`,
    `duration: ${Number.isFinite(duration) ? duration : 0}`,
    `date: ${date}`,
    buildTracePointers(sessionName, issue.issueNum),
  ].join('\n');
}

function learningFilesForSession(learningsDir: string, issueNum: number, sessionName: string): string[] {
  if (!existsSync(learningsDir)) return [];
  const marker = `.alpha-loop/sessions/${sessionName}/`;
  return readdirSync(learningsDir)
    .filter((file) => file.startsWith(`issue-${issueNum}-`) && file.endsWith('.md'))
    .filter((file) => {
      try {
        return readFileSync(join(learningsDir, file), 'utf-8').includes(marker);
      } catch {
        return false;
      }
    })
    .sort();
}

function writeRepairedLearningFile(options: {
  targetFile: string;
  issue: SessionLearningRepairIssue;
  sessionName: string;
  rawOutput: string;
  existingContent: string;
}): boolean {
  const parsed = parseLearningOutput(options.rawOutput);
  if (!parsed.hasMeaningfulSections || !parsed.sections.trim()) return false;

  const existingFrontmatter = extractLeadingFrontmatter(options.existingContent);
  const frontmatter = buildRepairedLearningFrontmatter({
    issue: options.issue,
    existingFrontmatter,
    parsedFrontmatter: parsed.frontmatter,
    sessionName: options.sessionName,
  });
  const content = `---\n${frontmatter}\n---\n\n${parsed.sections}\n`;
  writeFileSync(options.targetFile, content);
  return true;
}

/**
 * Repair tracked learning artifacts for a session from the raw agent outputs
 * saved under `.alpha-loop/sessions/<session>/logs/learnings/`.
 *
 * This is intentionally deterministic and local: it does not call an agent.
 * It protects self-hosted runs where the parent process may have generated
 * placeholder/noisy learnings before a child issue fixed the parser on disk.
 */
export function repairSessionLearningArtifacts(options: {
  sessionName: string;
  issues: SessionLearningRepairIssue[];
  learningsDir: string;
  sessionLogsDir: string;
}): SessionLearningRepairResult {
  const result: SessionLearningRepairResult = { repaired: 0, created: 0, skipped: 0, failed: 0 };
  mkdirSync(options.learningsDir, { recursive: true });

  for (const issue of options.issues) {
    const rawPath = join(options.sessionLogsDir, 'learnings', `issue-${issue.issueNum}-raw.md`);
    const files = learningFilesForSession(options.learningsDir, issue.issueNum, options.sessionName);

    if (!existsSync(rawPath)) {
      result.skipped += files.length > 0 ? files.length : 1;
      continue;
    }

    const rawOutput = readFileSync(rawPath, 'utf-8');
    const targets = files.length > 0
      ? files.map((file) => join(options.learningsDir, file))
      : [join(options.learningsDir, `issue-${issue.issueNum}-${formatTimestamp(new Date())}.md`)];

    for (const targetFile of targets) {
      const existingContent = existsSync(targetFile) ? readFileSync(targetFile, 'utf-8') : '';
      if (existingContent && learningArtifactIsClean(existingContent)) {
        result.skipped++;
        continue;
      }

      if (writeRepairedLearningFile({
        targetFile,
        issue,
        sessionName: options.sessionName,
        rawOutput,
        existingContent,
      })) {
        if (existingContent) result.repaired++;
        else result.created++;
      } else {
        result.failed++;
        log.warn(`Could not repair learning artifact for issue #${issue.issueNum}: raw output did not contain meaningful sections`);
      }
    }
  }

  const changed = result.repaired + result.created;
  if (changed > 0 || result.failed > 0) {
    log.info(`Learning artifact repair: ${result.repaired} repaired, ${result.created} created, ${result.skipped} skipped, ${result.failed} failed`);
  }

  return result;
}

/**
 * Repair a tracked session summary if it accidentally contains a raw Codex
 * transcript. The raw transcript often still contains a valid final markdown
 * summary later in the file, so we extract and rewrite that final candidate.
 */
export function repairSessionSummaryArtifact(options: {
  sessionName: string;
  learningsDir: string;
}): boolean {
  const summaryFile = join(options.learningsDir, `session-summary-${options.sessionName.replace(/\//g, '-')}.md`);
  if (!existsSync(summaryFile)) return false;

  const existing = readFileSync(summaryFile, 'utf-8');
  const summary = parseSessionSummaryOutput(existing);
  if (!summary) {
    log.warn(`Could not repair session summary for ${options.sessionName}: no valid summary found`);
    return false;
  }

  const next = summary + '\n';
  if (existing === next) return false;
  writeFileSync(summaryFile, next);
  log.info(`Session summary repaired: ${summaryFile}`);
  return true;
}

/**
 * Extract learnings from a completed run.
 * Invokes an agent with the learn prompt, parses the output to extract
 * only expected sections, and saves a concise learning file with trace pointers.
 * Raw agent output is saved separately to the traces directory.
 */
export async function extractLearnings(options: ExtractLearningsOptions): Promise<string | null> {
  const { config } = options;

  if (config.skipLearn) {
    log.info('Skipping learning extraction (skipLearn=true)');
    return null;
  }

  log.step('Extracting learnings from run...');

  const outputRoot = options.outputRoot ?? process.cwd();
  const agentCwd = options.agentCwd ?? outputRoot;
  const learningsDir = join(outputRoot, '.alpha-loop', 'learnings');
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
    return null;
  }

  mkdirSync(learningsDir, { recursive: true });

  const learnStep = resolveStepConfig(config, 'learn');
  const result = await spawnAgent({
    agent: learnStep.agent as typeof config.agent,
    model: learnStep.model,
    prompt,
    cwd: agentCwd,
    logFile: undefined,
  });

  if (result.exitCode !== 0 || !result.output.trim()) {
    log.warn(`Learning extraction failed (exit ${result.exitCode}, output ${result.output.length} chars), skipping`);
    return null;
  }

  const rawOutput = result.output.trim();

  // Save raw agent output to traces directory if session info is available
  if (options.sessionLogsDir) {
    const rawDir = join(options.sessionLogsDir, 'learnings');
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, `issue-${options.issueNum}-raw.md`), rawOutput + '\n');
    log.info(`Raw learning output saved to traces`);
  }

  // Parse the output to extract only expected sections
  const { frontmatter: parsedFm, sections, hasMeaningfulSections } = parseLearningOutput(rawOutput);
  if (!hasMeaningfulSections || !sections.trim()) {
    log.warn(`Learning extraction output for issue #${options.issueNum} did not contain meaningful learning sections, skipping`);
    return null;
  }

  const today = new Date().toISOString().split('T')[0];

  // Build frontmatter with trace pointers — always ensure key fields exist
  const requiredFields: Record<string, string> = {
    issue: String(options.issueNum),
    status: options.status,
    retries: String(options.retries),
    duration: String(options.duration),
    date: today,
  };

  const fmLines: string[] = [];
  if (parsedFm) {
    fmLines.push(parsedFm);
    // Inject any missing required fields
    for (const [key, value] of Object.entries(requiredFields)) {
      if (!new RegExp(`^${key}:`, 'm').test(parsedFm)) {
        fmLines.push(`${key}: ${value}`);
      }
    }
  } else {
    for (const [key, value] of Object.entries(requiredFields)) {
      fmLines.push(`${key}: ${value}`);
    }
  }

  // Add trace pointers if session info available
  if (options.sessionName) {
    fmLines.push(buildTracePointers(options.sessionName, options.issueNum));
  }

  const conciseContent = sections;
  const finalOutput = `---\n${fmLines.join('\n')}\n---\n\n${conciseContent}`;

  writeFileSync(learningFile, finalOutput + '\n');
  log.success(`Learning saved to ${learningFile}`);
  return learningFile;
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
  results: SessionSummaryResult[];
  learningsDir: string;
  config: Config;
}): Promise<string | null> {
  const { sessionName, results, learningsDir, config } = options;

  if (config.skipLearn || config.dryRun || results.length === 0) return null;

  log.step('Generating session summary...');

  // Collect all learnings from this session
  const learningContents: string[] = [];
  if (!existsSync(learningsDir)) return null;
  for (const result of results) {
    const files = learningFilesForSession(learningsDir, result.issueNum, sessionName);
    for (const file of files) {
      learningContents.push(readFileSync(join(learningsDir, file), 'utf-8'));
    }
  }

  if (learningContents.length === 0) return null;

  const recoveredResults = results.filter((r) => r.recoveryMode !== undefined);
  const naturalResults = results.filter((r) => r.recoveryMode === undefined);
  const metricResults = recoveredResults.length > 0 ? naturalResults : results;
  const successCount = metricResults.filter((r) => r.status === 'success').length;
  const failureCount = metricResults.filter((r) => r.status !== 'success').length;
  const totalDuration = metricResults.reduce((sum, r) => sum + r.duration, 0);
  const processedSummary = recoveredResults.length > 0
    ? `${results.length} (${successCount} succeeded, ${failureCount} failed, ${recoveredResults.length} recovered)`
    : `${results.length} (${successCount} succeeded, ${results.length - successCount} failed)`;
  const successRate = metricResults.length > 0
    ? `${Math.round((successCount / metricResults.length) * 100)}%`
    : 'N/A';
  const avgDuration = metricResults.length > 0
    ? `${Math.round(totalDuration / metricResults.length)}s`
    : 'N/A';
  const recoveryDetails = recoveredResults.length > 0
    ? `\n## Recovery Details

Recovered issues are excluded from failure counts and success-rate calculations because resume creates synthetic results after recovering stranded work.
- Recovered issues: ${recoveredResults.map((r) => `#${r.issueNum} ${r.title} (${r.recoveryMode})`).join(', ')}
`
    : '';
  const recoveredMetricRow = recoveredResults.length > 0
    ? `| Recovered issues | ${recoveredResults.map((r) => `#${r.issueNum} (${r.recoveryMode})`).join(', ')} |\n`
    : '';

  const prompt = `Analyze these learnings from a development session and produce a concise session summary with actionable recommendations.

## Session: ${sessionName}
- Issues processed: ${processedSummary}
- Total duration: ${Math.round(totalDuration / 60)} minutes
${recoveryDetails}

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
${recoveredMetricRow}| Success rate | ${successRate} |
| Avg duration | ${avgDuration} |
| Total duration | ${Math.round(totalDuration / 60)} min |`;

  const agentResult = await spawnAgent({
    agent: config.agent,
    model: config.reviewModel,
    prompt,
    cwd: process.cwd(),
    logFile: undefined,
  });

  if (agentResult.exitCode !== 0 || !agentResult.output.trim()) {
    log.warn('Session summary generation failed');
    return null;
  }

  const summary = parseSessionSummaryOutput(agentResult.output);
  if (!summary) {
    log.warn('Session summary generation did not return a valid markdown summary, skipping');
    return null;
  }

  const summaryFile = join(learningsDir, `session-summary-${sessionName.replace(/\//g, '-')}.md`);
  writeFileSync(summaryFile, summary + '\n');
  log.success(`Session summary saved: ${summaryFile}`);

  return summary;
}
