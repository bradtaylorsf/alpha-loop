/**
 * Review Command — self-improvement loop: analyze accumulated learnings and propose
 * improvements to agent prompts, skill definitions, and harness configuration.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.js';
import { log } from '../lib/logger.js';
import { exec } from '../lib/shell.js';
import { formatTimestamp } from '../lib/shell.js';
import { spawnAgent } from '../lib/agent.js';
import { createPR } from '../lib/github.js';
import { syncAgentAssets } from './sync.js';

export type ReviewOptions = {
  apply?: boolean;
  session?: string;
};

type ProposedChange = {
  path: string;
  content: string;
  reason: string;
  category: 'agent' | 'skill' | 'config' | 'testing';
};

/** Directories that proposed changes are allowed to target. */
const ALLOWED_PREFIXES = [
  '.alpha-loop/templates/skills/',
  '.alpha-loop/templates/agents/',
  '.alpha-loop/templates/instructions.md',
  '.alpha-loop.yaml',
];

/** Max total learning content to include in the prompt (chars). */
const MAX_LEARNINGS_CHARS = 50_000;

/**
 * Reject paths with traversal sequences or absolute paths.
 */
function isSafePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith('/') || filePath.includes('..')) return false;
  return ALLOWED_PREFIXES.some((prefix) =>
    filePath === prefix || filePath.startsWith(prefix),
  );
}

type LearningMeta = {
  status: string;
  retries: number;
  duration: number;
};

/**
 * Parse simple YAML-style frontmatter from a learning file.
 * Returns only the fields we care about for metrics.
 */
function parseFrontmatter(content: string): LearningMeta {
  const meta: LearningMeta = { status: 'unknown', retries: 0, duration: 0 };
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return meta;

  const fm = fmMatch[1];
  const statusMatch = fm.match(/^status:\s*(.+)$/m);
  const retriesMatch = fm.match(/^retries:\s*(\d+)$/m);
  const durationMatch = fm.match(/^duration:\s*(\d+)$/m);

  if (statusMatch) meta.status = statusMatch[1].trim();
  if (retriesMatch) meta.retries = parseInt(retriesMatch[1], 10);
  if (durationMatch) meta.duration = parseInt(durationMatch[1], 10);
  return meta;
}

type Metrics = {
  total: number;
  successes: number;
  failures: number;
  avgRetries: number;
  avgDurationSecs: number;
  failureReasons: string[];
};

/**
 * Compute summary metrics from an array of learning file contents.
 */
function computeMetrics(learnings: string[]): Metrics {
  const metas = learnings.map(parseFrontmatter);
  const total = metas.length;
  const successes = metas.filter((m) => m.status === 'success').length;
  const failures = total - successes;
  const avgRetries = total > 0
    ? Math.round((metas.reduce((s, m) => s + m.retries, 0) / total) * 10) / 10
    : 0;
  const avgDurationSecs = total > 0
    ? Math.round(metas.reduce((s, m) => s + m.duration, 0) / total)
    : 0;

  // Extract failure reasons from "What Failed" sections
  const failureReasons: string[] = [];
  for (const content of learnings) {
    const failedMatch = content.match(/## What Failed\n([\s\S]*?)(?=\n## |$)/);
    if (failedMatch) {
      const lines = failedMatch[1]
        .split('\n')
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean);
      failureReasons.push(...lines.slice(0, 3));
    }
  }

  return { total, successes, failures, avgRetries, avgDurationSecs, failureReasons };
}

/**
 * Read all files from a directory, returning { path, content } pairs.
 * Non-existent directories are silently skipped.
 */
function readDirFiles(dir: string, exts: string[]): Array<{ path: string; content: string }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ path: string; content: string }> = [];

  function walk(current: string): void {
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          if (exts.length > 0 && !exts.some((ext) => entry.name.endsWith(ext))) continue;
          try {
            const content = readFileSync(fullPath, 'utf-8');
            results.push({ path: fullPath, content });
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(dir);
  return results;
}

/**
 * Format the metrics object as a Markdown table.
 */
function formatMetricsTable(metrics: Metrics): string {
  const successRate = metrics.total > 0
    ? Math.round((metrics.successes / metrics.total) * 100)
    : 0;
  return [
    '| Metric | Value |',
    '|--------|-------|',
    `| Total runs | ${metrics.total} |`,
    `| Successes | ${metrics.successes} |`,
    `| Failures | ${metrics.failures} |`,
    `| Success rate | ${successRate}% |`,
    `| Avg retries | ${metrics.avgRetries} |`,
    `| Avg duration | ${metrics.avgDurationSecs}s |`,
  ].join('\n');
}

/**
 * Build the improvement prompt to send to Claude.
 */
function buildImprovementPrompt(options: {
  metrics: Metrics;
  learningsContent: string;
  agentDefs: Array<{ path: string; content: string }>;
  skillDefs: Array<{ path: string; content: string }>;
  harnessConfig: string;
}): string {
  const { metrics, learningsContent, agentDefs, skillDefs, harnessConfig } = options;

  const agentDefsText = agentDefs.length > 0
    ? agentDefs.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')
    : '(no agent definitions found)';

  const skillDefsText = skillDefs.length > 0
    ? skillDefs.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')
    : '(no skill definitions found)';

  return `You are a self-improvement agent for the Alpha Loop automated development system. Your job is to analyze accumulated learnings from development runs and propose specific, targeted improvements to the agent prompts, skill definitions, and configuration.

## Session Metrics

${formatMetricsTable(metrics)}

### Top Failure Reasons
${metrics.failureReasons.length > 0 ? metrics.failureReasons.map((r) => `- ${r}`).join('\n') : '- (none recorded)'}

## Accumulated Learnings

${learningsContent}

## Current Agent Definitions

${agentDefsText}

## Current Skill Definitions

${skillDefsText}

## Current Harness Configuration (.alpha-loop.yaml)

\`\`\`yaml
${harnessConfig}
\`\`\`

---

## Your Task

Analyze the learnings and propose specific improvements. Focus on:

1. **Agent prompts** (\`.alpha-loop/templates/agents/implementer.md\`, \`.alpha-loop/templates/agents/reviewer.md\`, \`.alpha-loop/templates/instructions.md\`):
   - Are there recurring patterns or anti-patterns that should be baked into the prompts?
   - Are there common mistakes the agent makes that a prompt instruction would prevent?
   - Are there successful strategies that should be reinforced?

2. **Skill definitions** (in \`.alpha-loop/templates/skills/\`, synced to harness-specific paths):
   - Should any skills be added, updated, or removed based on the learnings?
   - Are there recurring test patterns (Playwright, Jest) that deserve a skill?
   - Are there common environment issues (ports, auth, seeding) that should be documented?

3. **Testing environment**:
   - Playwright/browser configuration failures
   - Port conflict patterns
   - Authentication state issues
   - Database seeding / test data problems
   - Environment variable gaps
   - Virtual environment or dependency setup in worktrees

4. **Harness configuration** (\`.alpha-loop.yaml\` defaults):
   - Should any defaults change based on what consistently works or fails?
   - Are there timeout or retry values that need tuning?

5. **Prompt engineering**:
   - Are there prompt patterns that consistently lead to success or failure?
   - Are there structural changes to the prompts that would improve reliability?

## Output Format

Respond with ONLY a JSON array of proposed changes. Each change must have this exact structure:

\`\`\`json
[
  {
    "path": "agents/implementer.md",
    "content": "...full file content after the change...",
    "reason": "Concise explanation of why this change is proposed, referencing specific learning patterns",
    "category": "agent"
  }
]
\`\`\`

Rules:
- \`path\` must be one of: \`.alpha-loop/templates/agents/*.md\`, \`.alpha-loop/templates/skills/*\`, \`.alpha-loop/templates/instructions.md\`, or \`.alpha-loop.yaml\`
- \`content\` is the COMPLETE new file content (not a diff)
- \`category\` must be one of: \`agent\`, \`skill\`, \`config\`, \`testing\`
- Only propose changes that are clearly supported by the learnings data
- Do not propose changes just to change things — only when there is a clear pattern
- If no changes are warranted, return an empty array: \`[]\`

Output ONLY the JSON array with no other text before or after it.`;
}

/**
 * Extract a JSON array from agent output using regex.
 */
function extractJsonArray(output: string): ProposedChange[] {
  // Look for a JSON array — greedy match from first [ to last ]
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];
    const changes: ProposedChange[] = [];
    for (const item of parsed) {
      if (
        typeof item === 'object' && item !== null &&
        'path' in item && typeof (item as Record<string, unknown>).path === 'string' &&
        'content' in item && typeof (item as Record<string, unknown>).content === 'string' &&
        'reason' in item && typeof (item as Record<string, unknown>).reason === 'string' &&
        'category' in item
      ) {
        changes.push(item as ProposedChange);
      }
    }
    return changes;
  } catch {
    return [];
  }
}

/**
 * Display proposed changes to the user, grouped by category.
 */
function displayProposals(changes: ProposedChange[]): void {
  const byCategory: Record<string, ProposedChange[]> = {};
  for (const change of changes) {
    const cat = change.category ?? 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(change);
  }

  const categoryLabels: Record<string, string> = {
    agent: 'Agent Prompts',
    skill: 'Skill Definitions',
    config: 'Harness Configuration',
    testing: 'Testing Environment',
  };

  for (const [category, categoryChanges] of Object.entries(byCategory)) {
    const label = categoryLabels[category] ?? category;
    log.info(`\n  ${label.toUpperCase()}`);
    for (const change of categoryChanges) {
      log.info(`    ${change.path}`);
      log.info(`      Reason: ${change.reason}`);
    }
  }
}

/**
 * Save proposals to a markdown file in .alpha-loop/learnings/proposed-updates/.
 */
function saveProposals(
  proposals: ProposedChange[],
  metrics: Metrics,
  timestamp: string,
  projectDir: string,
): string {
  const dir = join(projectDir, '.alpha-loop', 'learnings', 'proposed-updates');
  mkdirSync(dir, { recursive: true });

  const outFile = join(dir, `${timestamp}-proposals.md`);

  const lines: string[] = [
    `# Proposed Improvements — ${timestamp}`,
    '',
    '## Metrics',
    '',
    formatMetricsTable(metrics),
    '',
    '## Proposed Changes',
    '',
  ];

  if (proposals.length === 0) {
    lines.push('No changes proposed.');
  } else {
    for (const change of proposals) {
      lines.push(`### ${change.path}`);
      lines.push('');
      lines.push(`**Category:** ${change.category}`);
      lines.push('');
      lines.push(`**Reason:** ${change.reason}`);
      lines.push('');
      lines.push('```');
      lines.push(change.content);
      lines.push('```');
      lines.push('');
    }
  }

  writeFileSync(outFile, lines.join('\n'), 'utf-8');
  return outFile;
}

/**
 * Apply proposed changes to files and create a draft PR.
 */
async function applyChanges(
  proposals: ProposedChange[],
  metrics: Metrics,
  timestamp: string,
  projectDir: string,
  config: { repo: string; baseBranch: string; model: string; reviewModel: string; harnesses: string[] },
): Promise<void> {
  const branch = `improve/learnings-${timestamp}`;

  // Create and switch to improvement branch
  log.step(`Creating branch ${branch}...`);
  const branchResult = exec(`git checkout -b "${branch}"`, { cwd: projectDir });
  if (branchResult.exitCode !== 0) {
    throw new Error(`Failed to create branch: ${branchResult.stderr}`);
  }

  // Apply each change
  const appliedPaths: string[] = [];
  for (const change of proposals) {
    if (!isSafePath(change.path)) {
      log.warn(`Skipping unsafe path: ${change.path}`);
      continue;
    }

    const fullPath = join(projectDir, change.path);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, change.content, 'utf-8');
    appliedPaths.push(change.path);
    log.success(`Applied: ${change.path}`);
  }

  if (appliedPaths.length === 0) {
    log.warn('No changes were applied (all paths were rejected). Switching back to base branch.');
    exec(`git checkout "${config.baseBranch}"`, { cwd: projectDir });
    return;
  }

  // Sync skills to all configured harnesses so editor copies stay current
  const syncResult = syncAgentAssets(config.harnesses, { projectDir });
  if (syncResult.synced) {
    log.success('Synced agent assets after applying changes');
  }

  // Stage and commit changes (including synced copies)
  const stageResult = exec(
    `git add ${appliedPaths.map((p) => JSON.stringify(p)).join(' ')} .alpha-loop/templates/ .claude/ .agents/ CLAUDE.md AGENTS.md 2>/dev/null || true`,
    { cwd: projectDir },
  );
  if (stageResult.exitCode !== 0) {
    throw new Error(`Failed to stage changes: ${stageResult.stderr}`);
  }

  const commitMsg = `improve: apply ${appliedPaths.length} learning-driven improvement(s)`;
  const commitResult = exec(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: projectDir });
  if (commitResult.exitCode !== 0) {
    throw new Error(`Failed to commit: ${commitResult.stderr}`);
  }

  // Build PR body
  const successRate = metrics.total > 0
    ? Math.round((metrics.successes / metrics.total) * 100)
    : 0;

  const prBody = [
    '## Self-Improvement: Learnings-Driven Updates',
    '',
    'This PR was generated automatically by `alpha-loop review --apply` after analyzing accumulated run learnings.',
    '',
    '## Metrics',
    '',
    formatMetricsTable(metrics),
    '',
    `Success rate: ${successRate}%`,
    '',
    '## Changes',
    '',
    ...proposals
      .filter((p) => appliedPaths.includes(p.path))
      .map((p) => `### \`${p.path}\`\n\n**Category:** ${p.category}\n\n**Reason:** ${p.reason}`),
  ].join('\n');

  // Create draft PR
  log.step('Creating draft PR...');
  const prUrl = createPR({
    repo: config.repo,
    base: config.baseBranch,
    head: branch,
    title: `improve: learning-driven agent/skill improvements (${appliedPaths.length} changes)`,
    body: prBody,
    cwd: projectDir,
  });

  log.success(`Draft PR created: ${prUrl}`);
}

/**
 * Main review command implementation.
 */
export async function reviewCommand(options: ReviewOptions): Promise<void> {
  const config = loadConfig();
  const projectDir = process.cwd();
  const timestamp = formatTimestamp(new Date());

  log.step('Starting self-improvement review...');

  // --- Gather learnings ---
  const learningsDir = join(projectDir, '.alpha-loop', 'learnings');

  if (!existsSync(learningsDir)) {
    log.warn('No learnings directory found at .alpha-loop/learnings/. Run the loop first to accumulate learnings.');
    return;
  }

  let learningFiles = readdirSync(learningsDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  if (learningFiles.length === 0) {
    log.warn('No learning files found. Run the loop first to accumulate learnings.');
    return;
  }

  // Filter to session if --session is provided
  if (options.session) {
    const sessionSlug = options.session;
    const before = learningFiles.length;
    learningFiles = learningFiles.filter((f) => f.includes(sessionSlug));
    if (learningFiles.length === 0) {
      log.warn(`No learnings found for session "${sessionSlug}" (checked ${before} files).`);
      return;
    }
    log.info(`Filtered to ${learningFiles.length} learning(s) for session "${sessionSlug}"`);
  } else {
    log.info(`Found ${learningFiles.length} learning file(s)`);
  }

  // Read learning contents
  const learnings = learningFiles.map((f) => {
    try {
      return readFileSync(join(learningsDir, f), 'utf-8');
    } catch {
      return '';
    }
  }).filter(Boolean);

  // Truncate combined learnings if too long
  let learningsContent = learnings.join('\n\n---\n\n');
  if (learningsContent.length > MAX_LEARNINGS_CHARS) {
    log.info(`Learnings truncated from ${learningsContent.length} to ${MAX_LEARNINGS_CHARS} chars`);
    learningsContent = learningsContent.slice(0, MAX_LEARNINGS_CHARS) + '\n\n[... truncated ...]';
  }

  // --- Compute metrics ---
  const metrics = computeMetrics(learnings);
  log.info(`Metrics: ${metrics.total} runs, ${metrics.successes} succeeded, ${metrics.failures} failed`);

  // --- Gather agent definitions from .alpha-loop/templates/ (source of truth) ---
  const templateAgentsDir = join(projectDir, '.alpha-loop', 'templates', 'agents');
  const agentDefs = readDirFiles(templateAgentsDir, ['.md', '.yaml', '.yml']);
  const instructionsPath = join(projectDir, '.alpha-loop', 'templates', 'instructions.md');
  if (existsSync(instructionsPath)) {
    agentDefs.push({ path: instructionsPath, content: readFileSync(instructionsPath, 'utf-8') });
  }
  log.info(`Found ${agentDefs.length} agent definition(s)`);

  // --- Gather skill definitions from .alpha-loop/templates/ (source of truth) ---
  const templateSkillsDir = join(projectDir, '.alpha-loop', 'templates', 'skills');
  const allSkills = readDirFiles(templateSkillsDir, []);
  log.info(`Found ${allSkills.length} skill definition(s)`);

  // --- Gather harness config ---
  const harnessConfigPath = join(projectDir, '.alpha-loop.yaml');
  const harnessConfig = existsSync(harnessConfigPath)
    ? readFileSync(harnessConfigPath, 'utf-8')
    : '(no .alpha-loop.yaml found)';

  // --- Build and send improvement prompt ---
  log.step('Sending improvement prompt to Claude...');
  const prompt = buildImprovementPrompt({
    metrics,
    learningsContent,
    agentDefs: agentDefs.map((f) => ({
      path: f.path.replace(projectDir + '/', ''),
      content: f.content,
    })),
    skillDefs: allSkills.map((f) => ({
      path: f.path.replace(projectDir + '/', ''),
      content: f.content,
    })),
    harnessConfig,
  });

  const agentResult = await spawnAgent({
    agent: 'claude',
    model: config.reviewModel,
    prompt,
    cwd: projectDir,
  });

  if (agentResult.exitCode !== 0 || !agentResult.output.trim()) {
    log.error(`Agent invocation failed (exit ${agentResult.exitCode}). Cannot produce proposals.`);
    return;
  }

  // --- Parse proposals ---
  const proposals = extractJsonArray(agentResult.output);

  if (proposals.length === 0) {
    log.info('No improvements proposed. The agent found no clear patterns to act on.');
    return;
  }

  // Filter out unsafe paths before doing anything further
  const safeProposals = proposals.filter((p) => {
    if (!isSafePath(p.path)) {
      log.warn(`Rejected proposal for unsafe path: ${p.path}`);
      return false;
    }
    return true;
  });

  log.success(`${safeProposals.length} improvement(s) proposed`);
  displayProposals(safeProposals);

  // --- Apply or save ---
  if (options.apply) {
    if (!config.repo) {
      log.error('No repo configured in .alpha-loop.yaml. Cannot create PR.');
      return;
    }
    log.step('Applying changes and creating draft PR...');
    await applyChanges(safeProposals, metrics, timestamp, projectDir, {
      repo: config.repo,
      baseBranch: config.baseBranch,
      model: config.model,
      reviewModel: config.reviewModel,
      harnesses: config.harnesses,
    });
  } else {
    const savedPath = saveProposals(safeProposals, metrics, timestamp, projectDir);
    log.success(`Proposals saved to ${savedPath}`);
    log.info('Run with --apply to apply the changes and create a draft PR.');
  }
}
