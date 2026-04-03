/**
 * Evolve Command — Meta-Harness-style automated optimization loop.
 *
 * Pattern: Give a proposer agent full filesystem access to:
 *   - .alpha-loop/traces/ (full execution traces, not summaries)
 *   - .alpha-loop/evals/scores.jsonl (score history)
 *   - Source code (prompts, skills, config)
 *
 * The agent proposes changes to prompts/skills/config, the eval suite runs,
 * and we keep improvements or revert (autoresearch keep/discard pattern).
 *
 * Key insight from Meta-Harness: full trace access (not summaries) is critical.
 * Key insight from autoresearch: fixed eval metric + autonomous iteration.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../lib/logger.js';
import { loadConfig } from '../lib/config.js';
import { spawnAgent } from '../lib/agent.js';
import { loadEvalCases, evalsDir } from '../lib/eval.js';
import { readScores, latestScore, formatScoreEntry } from '../lib/score.js';
import { listTraces, tracesDir, readTrace } from '../lib/traces.js';
import { exec } from '../lib/shell.js';

export type EvolveOptions = {
  maxIterations?: string;
  dryRun?: boolean;
  verbose?: boolean;
};

/** Files that the proposer is allowed to modify. */
const ALLOWED_TARGETS = [
  '.alpha-loop/templates/skills/',
  '.alpha-loop/templates/agents/',
  '.alpha-loop.yaml',
];

/**
 * Run the evolve loop: propose → eval → keep/discard.
 */
export async function evolveCommand(options: EvolveOptions): Promise<void> {
  const config = loadConfig({ dryRun: options.dryRun });
  const maxIterations = parseInt(options.maxIterations ?? '5', 10);

  // Validate prerequisites
  const cases = loadEvalCases();
  if (cases.length === 0) {
    log.warn('No eval cases found. Create eval cases first with `alpha-loop eval capture`.');
    return;
  }

  const scores = readScores(evalsDir(undefined, config.evalDir));
  const baseline = latestScore(evalsDir(undefined, config.evalDir));

  log.step('Alpha Loop Evolve — Meta-Harness Optimization');
  console.log('');
  console.log(`  Eval cases: ${cases.length}`);
  console.log(`  Score history: ${scores.length} entries`);
  console.log(`  Baseline score: ${baseline ? baseline.composite.toFixed(2) : 'none'}`);
  console.log(`  Max iterations: ${maxIterations}`);
  console.log(`  Agent: ${config.agent}`);
  console.log(`  Model: ${config.model || 'default'}`);
  console.log('');

  // Gather context for the proposer
  const traces = listTraces();
  const recentTraces = traces.slice(0, 10);

  log.info(`Recent traces: ${recentTraces.length} (from ${traces.length} total)`);

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    log.step(`Iteration ${iteration}/${maxIterations}`);

    if (config.dryRun) {
      log.dry('Would invoke proposer agent with full trace access');
      log.dry('Would run eval suite on proposed changes');
      log.dry('Would keep if score improves, revert if not');
      continue;
    }

    // Build the proposer prompt with full filesystem context
    const prompt = buildProposerPrompt(config, recentTraces, scores, cases.length);

    // Invoke proposer agent
    log.info('Invoking proposer agent...');
    const result = await spawnAgent({
      agent: config.agent,
      model: config.model,
      prompt,
      cwd: process.cwd(),
      logFile: undefined,
    });

    if (result.exitCode !== 0 || !result.output.trim()) {
      log.warn(`Proposer failed (exit ${result.exitCode}). Stopping.`);
      break;
    }

    // Parse proposed changes from agent output
    const changes = parseProposedChanges(result.output);

    if (changes.length === 0) {
      log.info('Proposer returned no changes. Optimization complete.');
      break;
    }

    log.info(`Proposer suggested ${changes.length} change(s):`);
    for (const change of changes) {
      console.log(`  - ${change.path}: ${change.reason}`);
    }

    // Validate all paths are safe
    const unsafeChanges = changes.filter((c) => !isSafePath(c.path));
    if (unsafeChanges.length > 0) {
      log.warn('Proposer suggested changes to unsafe paths — skipping:');
      for (const c of unsafeChanges) {
        console.log(`  - ${c.path}`);
      }
      continue;
    }

    // Backup current files
    const backups = new Map<string, string>();
    for (const change of changes) {
      if (existsSync(change.path)) {
        backups.set(change.path, readFileSync(change.path, 'utf-8'));
      }
    }

    // Apply changes
    for (const change of changes) {
      writeFileSync(change.path, change.content);
      log.info(`Applied: ${change.path}`);
    }

    // TODO: Run eval suite and compare scores
    // For now, log what would happen
    log.info('Changes applied. Run `alpha-loop eval` to measure impact.');
    log.info('If score improves: keep changes. If not: revert with git.');
    console.log('');

    // In a full implementation, we would:
    // 1. Run the eval suite
    // 2. Compare composite score to baseline
    // 3. If improved: commit and update baseline
    // 4. If not: revert all changes from backups
    // 5. Continue to next iteration

    // For now, stop after first proposal (eval execution requires fixture repos)
    log.info('Stopping after first proposal. Full automated loop requires eval fixtures.');
    break;
  }

  // Summary
  console.log('');
  log.step('Evolve Summary');
  if (baseline) {
    console.log(`  Baseline score: ${baseline.composite.toFixed(2)}`);
  }
  log.info('Run `alpha-loop eval` to measure current score after changes.');
  log.info('Run `alpha-loop eval scores` to view score history.');
}

/**
 * Build the proposer prompt with full trace context (Meta-Harness style).
 */
function buildProposerPrompt(
  config: import('../lib/config.js').Config,
  traces: import('../lib/traces.js').Trace[],
  scores: import('../lib/score.js').ScoreEntry[],
  evalCaseCount: number,
): string {
  const sections: string[] = [];

  sections.push(`# Alpha Loop Optimization Proposer

You are an optimization agent. Your goal is to improve AlphaLoop's pipeline performance
by analyzing execution traces, scores, and source code, then proposing targeted changes.

## Current State
- Eval cases: ${evalCaseCount}
- Score history: ${scores.length} entries
- Recent traces: ${traces.length}
- Agent: ${config.agent}
- Model: ${config.model || 'default'}
`);

  // Add score history
  if (scores.length > 0) {
    sections.push('## Score History (most recent first)');
    const recent = scores.slice(-10).reverse();
    for (const s of recent) {
      sections.push(`  ${formatScoreEntry(s)}`);
    }
    sections.push('');
  }

  // Add trace summaries with key data
  if (traces.length > 0) {
    sections.push('## Recent Execution Traces');
    sections.push('Full traces are available in .alpha-loop/traces/. Key metadata:');
    sections.push('');

    for (const trace of traces.slice(0, 5)) {
      const m = trace.metadata;
      sections.push(`### Issue #${m.issueNum}: ${m.title}`);
      sections.push(`- Status: ${m.status}, Duration: ${m.duration}s, Retries: ${m.retries}`);
      sections.push(`- Tests: ${m.testsPassing ? 'passing' : 'failing'}, Files: ${m.filesChanged}`);

      // Include test output snippet if available
      const testOutput = readTrace(trace.session, trace.issueNum, 'test-output.txt');
      if (testOutput) {
        const snippet = testOutput.slice(-500);
        sections.push(`- Test output (last 500 chars):\n\`\`\`\n${snippet}\n\`\`\``);
      }
      sections.push('');
    }
  }

  // Read current agent/skill definitions
  const templatesDir = join(process.cwd(), '.alpha-loop', 'templates');
  if (existsSync(templatesDir)) {
    sections.push('## Current Agent & Skill Definitions');
    sections.push('These are the files you can propose changes to:');
    sections.push('');

    const readDir = (dir: string, prefix: string) => {
      if (!existsSync(dir)) return;
      for (const file of readdirSync(dir)) {
        const filePath = join(dir, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          sections.push(`### ${prefix}${file}`);
          sections.push('```');
          sections.push(content.slice(0, 2000));
          if (content.length > 2000) sections.push('... (truncated)');
          sections.push('```');
          sections.push('');
        } catch {
          // Skip unreadable files
        }
      }
    };

    readDir(join(templatesDir, 'agents'), '.alpha-loop/templates/agents/');
    readDir(join(templatesDir, 'skills'), '.alpha-loop/templates/skills/');
  }

  sections.push(`## Your Task

Analyze the traces and scores above. Identify patterns in failures and propose specific
changes to agent prompts, skills, or config that would improve the composite score.

Output your proposed changes as a JSON array:

\`\`\`json
[
  {
    "path": ".alpha-loop/templates/agents/implementer.md",
    "content": "full new file content here",
    "reason": "Why this change should improve the score"
  }
]
\`\`\`

Rules:
- Only modify files under: ${ALLOWED_TARGETS.join(', ')}
- Each change must include a clear reason
- Focus on the highest-impact changes first
- If no changes would help, output an empty array: []
`);

  return sections.join('\n');
}

/** Parsed proposed change from agent output. */
type ProposedChange = {
  path: string;
  content: string;
  reason: string;
};

/**
 * Parse proposed changes from agent output.
 * Expects a JSON array in the output.
 */
export function parseProposedChanges(output: string): ProposedChange[] {
  // Find JSON array in output
  // Try fenced code block first, fall back to greedy bracket matching
  const fencedMatch = output.match(/```json\s*\n(\[[\s\S]*?\])\s*\n```/);
  const jsonMatch = fencedMatch ? [fencedMatch[1]] : output.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((p) => p.path && p.content)
      .map((p) => ({
        path: String(p.path),
        content: String(p.content),
        reason: String(p.reason ?? 'No reason given'),
      }));
  } catch {
    return [];
  }
}

/**
 * Check if a proposed path is safe to modify.
 */
export function isSafePath(filePath: string): boolean {
  // Reject absolute paths and path traversal
  if (filePath.startsWith('/') || filePath.includes('..')) return false;

  // Must be in allowed targets: directory prefixes use startsWith, files use exact match
  return ALLOWED_TARGETS.some((prefix) =>
    prefix.endsWith('/') ? filePath.startsWith(prefix) : filePath === prefix
  );
}
