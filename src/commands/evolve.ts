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
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { log } from '../lib/logger.js';
import { loadConfig } from '../lib/config.js';
import { spawnAgent } from '../lib/agent.js';
import { loadEvalCases, evalsDir } from '../lib/eval.js';
import { readScores, latestScore, formatScoreEntry } from '../lib/score.js';
import { listTraces, readTrace } from '../lib/traces.js';
import { exec } from '../lib/shell.js';
import { runEvalSuite } from '../lib/eval-runner.js';
import type { EvalCaseWithChecks } from '../lib/eval-runner.js';
import type { Config } from '../lib/config.js';
import type { Trace } from '../lib/traces.js';
import type { ScoreEntry } from '../lib/score.js';

export type EvolveOptions = {
  maxIterations?: string;
  dryRun?: boolean;
  verbose?: boolean;
  continuous?: boolean;
  surface?: string;
  resume?: boolean;
};

/** Optimization surface levels — what the proposer is allowed to modify. */
export type SurfaceLevel = 'prompts' | 'skills' | 'config' | 'all';

const SURFACE_LEVELS: SurfaceLevel[] = ['prompts', 'skills', 'config', 'all'];

/** Allowed target paths per surface level. */
export const SURFACE_TARGETS: Record<SurfaceLevel, string[]> = {
  prompts: [
    '.alpha-loop/templates/agents/',
  ],
  skills: [
    '.alpha-loop/templates/agents/',
    '.alpha-loop/templates/skills/',
  ],
  config: [
    '.alpha-loop/templates/agents/',
    '.alpha-loop/templates/skills/',
    '.alpha-loop.yaml',
  ],
  all: [
    '.alpha-loop/templates/agents/',
    '.alpha-loop/templates/skills/',
    '.alpha-loop.yaml',
    'src/lib/prompts.ts',
    'src/lib/pipeline.ts',
  ],
};

/** Path to the evolve log TSV file. */
export const EVOLVE_LOG_PATH = '.alpha-loop/evals/evolve-log.tsv';

/** A single entry in the evolve log. */
export type EvolveLogEntry = {
  commit: string;
  score: number;
  cost: number;
  status: 'baseline' | 'keep' | 'discard' | 'crash';
  iteration: number;
  description: string;
};

const EVOLVE_LOG_HEADER = 'commit\tscore\tcost\tstatus\titeration\tdescription';

/**
 * Append an entry to the evolve log TSV.
 */
export function appendEvolveLog(entry: EvolveLogEntry, cwd?: string): void {
  const logPath = join(cwd ?? process.cwd(), EVOLVE_LOG_PATH);
  const dir = join(cwd ?? process.cwd(), '.alpha-loop', 'evals');
  mkdirSync(dir, { recursive: true });

  if (!existsSync(logPath)) {
    writeFileSync(logPath, EVOLVE_LOG_HEADER + '\n');
  }

  const line = [
    entry.commit,
    entry.score.toFixed(2),
    entry.cost.toFixed(2),
    entry.status,
    String(entry.iteration),
    entry.description,
  ].join('\t');

  appendFileSync(logPath, line + '\n');
}

/**
 * Read all entries from the evolve log TSV.
 */
export function readEvolveLog(cwd?: string): EvolveLogEntry[] {
  const logPath = join(cwd ?? process.cwd(), EVOLVE_LOG_PATH);
  if (!existsSync(logPath)) return [];

  const content = readFileSync(logPath, 'utf-8').trim();
  const lines = content.split('\n').filter(Boolean);

  // Skip header
  const entries: EvolveLogEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split('\t');
    if (parts.length < 6) continue;
    entries.push({
      commit: parts[0],
      score: parseFloat(parts[1]),
      cost: parseFloat(parts[2]),
      status: parts[3] as EvolveLogEntry['status'],
      iteration: parseInt(parts[4], 10),
      description: parts.slice(5).join('\t'), // description may contain tabs
    });
  }

  return entries;
}

/**
 * Run pre-checks before expensive eval.
 * Returns { passed, error } indicating whether the code is safe to eval.
 */
export async function runPreChecks(
  surface: SurfaceLevel,
  cwd?: string,
): Promise<{ passed: boolean; error?: string }> {
  const projectDir = cwd ?? process.cwd();

  // Only run compile check if code files were changed
  if (surface === 'all') {
    const tscResult = exec('pnpm tsc --noEmit', { cwd: projectDir, timeout: 60_000 });
    if (tscResult.exitCode !== 0) {
      return { passed: false, error: `TypeScript compilation failed:\n${tscResult.stderr || tscResult.stdout}` };
    }
  }

  // Run unit tests for all surface levels
  const testResult = exec('pnpm test', { cwd: projectDir, timeout: 120_000 });
  if (testResult.exitCode !== 0) {
    return { passed: false, error: `Unit tests failed:\n${testResult.stderr || testResult.stdout}` };
  }

  return { passed: true };
}

/**
 * Decide whether to keep or discard based on score comparison.
 * Returns 'keep' if newScore > bestScore, 'discard' otherwise.
 */
export function keepOrDiscard(newScore: number, bestScore: number): 'keep' | 'discard' {
  return newScore > bestScore ? 'keep' : 'discard';
}

/**
 * Get the current git commit hash (short form).
 */
function getCommitHash(cwd?: string): string {
  try {
    const result = exec('git rev-parse --short HEAD', { cwd: cwd ?? process.cwd(), timeout: 5000 });
    return result.stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Check if a proposed path is safe to modify for a given surface level.
 */
export function isSafePath(filePath: string, surface?: SurfaceLevel): boolean {
  // Reject absolute paths and path traversal
  if (filePath.startsWith('/') || filePath.includes('..')) return false;

  const targets = SURFACE_TARGETS[surface ?? 'prompts'];

  // Must be in allowed targets: directory prefixes use startsWith, files use exact match
  return targets.some((prefix) =>
    prefix.endsWith('/') ? filePath.startsWith(prefix) : filePath === prefix
  );
}

/**
 * Run the evolve loop: propose → eval → keep/discard.
 */
export async function evolveCommand(options: EvolveOptions): Promise<void> {
  const config = loadConfig({ dryRun: options.dryRun });
  const surface: SurfaceLevel = parseSurface(options.surface);
  const continuous = options.continuous ?? false;
  const maxIterations = continuous ? Infinity : parseInt(options.maxIterations ?? '5', 10);

  // Validate prerequisites
  const allCases = loadEvalCases();
  if (allCases.length === 0) {
    log.warn('No eval cases found. Create eval cases first with `alpha-loop eval capture`.');
    return;
  }

  const evalDir = evalsDir(undefined, config.evalDir);
  const scores = readScores(evalDir);
  const baseline = latestScore(evalDir);

  // Resume support: pick up where we left off
  let startIteration = 1;
  let bestScore = baseline?.composite ?? 0;
  let totalKept = 0;
  let totalDiscarded = 0;
  let totalCrashed = 0;
  let totalCost = 0;

  if (options.resume) {
    const priorLog = readEvolveLog();
    if (priorLog.length > 0) {
      const lastEntry = priorLog[priorLog.length - 1];
      startIteration = lastEntry.iteration + 1;

      // Find best score from kept entries
      const keptEntries = priorLog.filter((e) => e.status === 'keep');
      if (keptEntries.length > 0) {
        bestScore = Math.max(...keptEntries.map((e) => e.score));
      }

      totalKept = priorLog.filter((e) => e.status === 'keep').length;
      totalDiscarded = priorLog.filter((e) => e.status === 'discard').length;
      totalCrashed = priorLog.filter((e) => e.status === 'crash').length;
      totalCost = priorLog.reduce((sum, e) => sum + e.cost, 0);

      log.info(`Resuming from iteration ${startIteration} (best score: ${bestScore.toFixed(2)})`);
    } else {
      log.info('No prior evolve log found. Starting fresh.');
    }
  }

  log.step('Alpha Loop Evolve — Meta-Harness Optimization');
  console.log('');
  console.log(`  Eval cases: ${allCases.length}`);
  console.log(`  Score history: ${scores.length} entries`);
  console.log(`  Baseline score: ${bestScore > 0 ? bestScore.toFixed(2) : 'none (will run baseline)'}`);
  console.log(`  Iterations: ${continuous ? 'continuous (until stopped)' : maxIterations}`);
  console.log(`  Surface: ${surface}`);
  console.log(`  Agent: ${config.agent}`);
  console.log(`  Model: ${config.model || 'default'}`);
  if (options.resume) console.log(`  Resuming from: iteration ${startIteration}`);
  console.log('');

  // Graceful shutdown for --continuous
  let shutdownRequested = false;
  if (continuous) {
    const handler = () => {
      log.info('Shutdown requested. Finishing current iteration...');
      shutdownRequested = true;
    };
    process.on('SIGINT', handler);
    process.on('SIGTERM', handler);
  }

  // Gather context for the proposer (refreshed every 5 iterations)
  let recentTraces = listTraces().slice(0, 10);

  log.info(`Recent traces: ${recentTraces.length}`);

  // Step 0: Run baseline eval if no baseline score exists
  if (bestScore === 0 && !options.dryRun) {
    log.step('Running baseline eval...');
    const stepCases = loadEvalCases({ type: 'step' }) as EvalCaseWithChecks[];
    if (stepCases.length > 0) {
      const baselineResult = await runEvalSuite(stepCases, config, { verbose: options.verbose });
      bestScore = baselineResult.composite;
      const commit = getCommitHash();
      appendEvolveLog({
        commit,
        score: bestScore,
        cost: 0,
        status: 'baseline',
        iteration: 0,
        description: 'initial baseline eval',
      });
      log.info(`Baseline score: ${bestScore.toFixed(2)} (${baselineResult.passCount}/${stepCases.length} passing)`);
    } else {
      log.warn('No step-level eval cases found. Using full cases for eval.');
    }
  }

  for (let iteration = startIteration; iteration <= (startIteration + maxIterations - 1); iteration++) {
    if (shutdownRequested) {
      log.info('Graceful shutdown: stopping before next iteration.');
      break;
    }

    log.step(`Iteration ${iteration}${continuous ? '' : `/${startIteration + maxIterations - 1}`}`);

    if (config.dryRun) {
      log.dry('Would invoke proposer agent with full trace access');
      log.dry(`Would modify files in surface: ${surface}`);
      log.dry('Would run pre-checks (compile + tests)');
      log.dry('Would run step-level eval, then e2e eval if step passes');
      log.dry('Would keep if score improves, revert if not');
      continue;
    }

    // Refresh traces every 5 iterations so the proposer sees recent data
    if ((iteration - startIteration) > 0 && (iteration - startIteration) % 5 === 0) {
      recentTraces = listTraces().slice(0, 10);
    }

    // Read evolve log for proposer context
    const evolveLog = readEvolveLog();

    // Build the proposer prompt with full filesystem context
    const prompt = buildProposerPrompt(config, recentTraces, scores, allCases.length, surface, evolveLog);

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
      log.warn(`Proposer failed (exit ${result.exitCode}). Skipping iteration.`);
      appendEvolveLog({
        commit: getCommitHash(),
        score: bestScore,
        cost: 0,
        status: 'crash',
        iteration,
        description: 'proposer agent failed',
      });
      totalCrashed++;
      continue;
    }

    // Parse proposed changes from agent output
    const changes = parseProposedChanges(result.output);

    if (changes.length === 0) {
      log.info('Proposer returned no changes. Optimization may be complete.');
      if (!continuous) break;
      continue;
    }

    log.info(`Proposer suggested ${changes.length} change(s):`);
    for (const change of changes) {
      console.log(`  - ${change.path}: ${change.reason}`);
    }

    // Validate all paths are safe for the current surface level
    const unsafeChanges = changes.filter((c) => !isSafePath(c.path, surface));
    if (unsafeChanges.length > 0) {
      log.warn('Proposer suggested changes to paths outside surface — skipping:');
      for (const c of unsafeChanges) {
        console.log(`  - ${c.path}`);
      }
      appendEvolveLog({
        commit: getCommitHash(),
        score: bestScore,
        cost: 0,
        status: 'crash',
        iteration,
        description: `unsafe paths: ${unsafeChanges.map((c) => c.path).join(', ')}`,
      });
      totalCrashed++;
      continue;
    }

    // Backup current files
    const backups = new Map<string, string | null>();
    for (const change of changes) {
      if (existsSync(change.path)) {
        backups.set(change.path, readFileSync(change.path, 'utf-8'));
      } else {
        backups.set(change.path, null); // file didn't exist before
      }
    }

    // Apply changes
    for (const change of changes) {
      const dir = dirname(change.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(change.path, change.content);
      log.info(`Applied: ${change.path}`);
    }

    // Pre-checks: compile + unit tests
    log.info('Running pre-checks...');
    const preCheckResult = await runPreChecks(surface);
    if (!preCheckResult.passed) {
      log.warn(`Pre-checks failed: ${preCheckResult.error?.split('\n')[0]}`);
      revertChanges(backups);
      appendEvolveLog({
        commit: getCommitHash(),
        score: bestScore,
        cost: 0,
        status: 'crash',
        iteration,
        description: `pre-check failed: ${preCheckResult.error?.split('\n')[0] ?? 'unknown'}`,
      });
      totalCrashed++;
      continue;
    }
    log.info('Pre-checks passed.');

    // Step-level eval (fast gate)
    log.info('Running step-level eval...');
    const stepCases = loadEvalCases({ type: 'step' }) as EvalCaseWithChecks[];
    let stepScore = bestScore;
    let iterationCost = 0;

    if (stepCases.length > 0) {
      const stepResult = await runEvalSuite(stepCases, config, { verbose: options.verbose });
      stepScore = stepResult.composite;
      iterationCost += stepResult.totalCost;

      if (stepScore < bestScore) {
        log.warn(`Step-level eval regressed: ${stepScore.toFixed(2)} < ${bestScore.toFixed(2)}. Discarding.`);
        revertChanges(backups);
        appendEvolveLog({
          commit: getCommitHash(),
          score: stepScore,
          cost: iterationCost,
          status: 'discard',
          iteration,
          description: `step-level regression: ${changes.map((c) => c.reason).join('; ')}`,
        });
        totalDiscarded++;
        totalCost += iterationCost;
        continue;
      }

      log.info(`Step-level eval: ${stepScore.toFixed(2)} (baseline: ${bestScore.toFixed(2)})`);
    }

    // E2E eval (slow, full validation)
    const fullCases = loadEvalCases({ type: 'full' }) as EvalCaseWithChecks[];
    let compositeScore = stepScore;

    if (fullCases.length > 0) {
      log.info('Running e2e eval...');
      const e2eResult = await runEvalSuite(fullCases, config, { verbose: options.verbose });
      compositeScore = e2eResult.composite;
      iterationCost += e2eResult.totalCost;
    }

    // Keep or discard
    const decision = keepOrDiscard(compositeScore, bestScore);
    totalCost += iterationCost;

    if (decision === 'keep') {
      log.info(`Score improved: ${compositeScore.toFixed(2)} > ${bestScore.toFixed(2)}. Keeping changes.`);

      // Commit the changes
      const description = changes.map((c) => c.reason).join('; ');
      for (const change of changes) {
        exec(`git add "${change.path}"`, { cwd: process.cwd() });
      }
      // Write commit message to a temp file to avoid shell injection
      const commitMsg = `evolve(${iteration}): ${description.slice(0, 200)}`;
      const commitMsgFile = join(process.cwd(), '.alpha-loop', 'evals', '.commit-msg.tmp');
      writeFileSync(commitMsgFile, commitMsg);
      exec(`git commit --file "${commitMsgFile}"`, { cwd: process.cwd() });
      try { unlinkSync(commitMsgFile); } catch { /* non-fatal */ }

      bestScore = compositeScore;
      totalKept++;

      appendEvolveLog({
        commit: getCommitHash(),
        score: compositeScore,
        cost: iterationCost,
        status: 'keep',
        iteration,
        description,
      });
    } else {
      log.info(`Score did not improve: ${compositeScore.toFixed(2)} <= ${bestScore.toFixed(2)}. Discarding.`);
      revertChanges(backups);
      totalDiscarded++;

      appendEvolveLog({
        commit: getCommitHash(),
        score: compositeScore,
        cost: iterationCost,
        status: 'discard',
        iteration,
        description: changes.map((c) => c.reason).join('; '),
      });
    }

    console.log('');
  }

  // Summary
  console.log('');
  log.step('Evolve Summary');
  const totalIterations = totalKept + totalDiscarded + totalCrashed;
  console.log(`  Iterations run: ${totalIterations}`);
  console.log(`  Kept: ${totalKept}`);
  console.log(`  Discarded: ${totalDiscarded}`);
  console.log(`  Crashed: ${totalCrashed}`);
  console.log(`  Best score: ${bestScore.toFixed(2)}`);
  console.log(`  Total cost: ~$${totalCost.toFixed(2)}`);
  console.log('');
  log.info('Run `alpha-loop eval scores` to view score history.');
  log.info(`Evolve log: ${EVOLVE_LOG_PATH}`);
}

/**
 * Revert file changes from backups.
 * For new files, also removes empty parent directories that were created.
 */
function revertChanges(backups: Map<string, string | null>): void {
  for (const [path, content] of backups) {
    if (content === null) {
      // File didn't exist before — remove it and clean empty parents
      try {
        unlinkSync(path);
        // Walk up removing empty directories until we hit a non-empty one
        let dir = dirname(path);
        while (dir && dir !== '.' && dir !== '/') {
          try {
            rmdirSync(dir); // throws if non-empty
            dir = dirname(dir);
          } catch {
            break; // directory not empty, stop
          }
        }
      } catch { /* ignore */ }
    } else {
      writeFileSync(path, content);
    }
  }
}

/**
 * Parse and validate the surface option.
 */
function parseSurface(surface?: string): SurfaceLevel {
  if (!surface) return 'prompts';
  if (SURFACE_LEVELS.includes(surface as SurfaceLevel)) return surface as SurfaceLevel;
  log.warn(`Unknown surface level '${surface}'. Using 'prompts'. Valid: ${SURFACE_LEVELS.join(', ')}`);
  return 'prompts';
}

/**
 * Build the proposer prompt with full trace context (Meta-Harness style).
 */
function buildProposerPrompt(
  config: Config,
  traces: Trace[],
  scores: ScoreEntry[],
  evalCaseCount: number,
  surface: SurfaceLevel,
  evolveLog: EvolveLogEntry[],
): string {
  const sections: string[] = [];
  const targets = SURFACE_TARGETS[surface];

  sections.push(`# Harness Optimization Skill

You are optimizing AlphaLoop's harness configuration to improve its eval score.

## Current State
- Eval cases: ${evalCaseCount}
- Score history: ${scores.length} entries
- Recent traces: ${traces.length}
- Agent: ${config.agent}
- Model: ${config.model || 'default'}
- Optimization surface: ${surface}

## Your Environment
- \`.alpha-loop/evals/results/\` — filesystem of ALL prior eval runs
  - Each run has: harness snapshot, scores, costs, and full execution traces
  - Use grep/cat to inspect prior code, traces, and scores
- \`.alpha-loop/templates/\` — current prompts and skills (YOUR optimization target)
${surface === 'all' ? '- `src/lib/prompts.ts` — prompt builder functions (modifiable)\n- `src/lib/pipeline.ts` — pipeline orchestration (modifiable)\n' : ''}
## What You Can Modify
${targets.map((t) => `- \`${t}\``).join('\n')}

## What You CANNOT Modify
- \`.alpha-loop/evals/\` — eval cases and results (read-only)
- Test files
- Any file not listed above
`);

  // Add evolve log history
  if (evolveLog.length > 0) {
    sections.push('## Prior Evolve Iterations');
    sections.push('Learn from both successes and failures:');
    sections.push('');
    sections.push('```');
    sections.push(EVOLVE_LOG_HEADER);
    for (const entry of evolveLog.slice(-20)) {
      sections.push(`${entry.commit}\t${entry.score.toFixed(2)}\t${entry.cost.toFixed(2)}\t${entry.status}\t${entry.iteration}\t${entry.description}`);
    }
    sections.push('```');
    sections.push('');
  }

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

  sections.push(`## Your Process
1. Read at least 5 prior runs (traces, scores, evolve log) before proposing a change
2. Identify failure patterns and form hypotheses
3. Compare traces from passing vs failing cases
4. Propose targeted, additive changes (prefer adding info over changing flow)
5. Explain your reasoning clearly

## Key Lessons from Meta-Harness
- Additive changes are safer than structural rewrites (iteration 7 won by ADDING info, not changing flow)
- Prompt edits that modify control flow are high-risk (5 of 7 regressions came from these)
- If multiple prior changes regressed, the common factor is the problem (confound detection)

## Your Task

Analyze the traces, scores, and evolve log above. Identify patterns in failures and propose
specific changes that would improve the composite score.

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
- Only modify files under: ${targets.join(', ')}
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
