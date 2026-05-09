/**
 * Init Command — full project onboarding for alpha-loop.
 *
 * Steps:
 * 1. Scan codebase + run setup wizard, then write config (.alpha-loop.yaml)
 * 2. Set up .gitignore
 * 3. Detect and migrate legacy layout (skills/ at root, .claude/agents/)
 * 4. Seed .alpha-loop/templates/ from distribution (fills gaps only)
 * 5. Install playwright-cli skills (if available)
 * 6. Run vision (interactive, if TTY)
 * 7. Run scan (generates context + instructions)
 * 8. Sync templates to configured harnesses
 * 9. Install GitHub issue templates
 * 10. Commit generated files
 */
import { existsSync, writeFileSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { detectRepo, loadConfig } from '../lib/config.js';
import { exec } from '../lib/shell.js';
import { ghExec } from '../lib/rate-limit.js';
import { log } from '../lib/logger.js';
import { syncAgentAssets, migrateToTemplates, resolveHarnesses } from './sync.js';
import { findDistributionTemplatesDir } from '../lib/templates.js';
import { shouldOfferLocalMode, getTotalMemoryGB } from '../lib/hardware.js';
import { scanProject, type ProjectScan } from '../lib/init-scan.js';

const CONFIG_FILE = '.alpha-loop.yaml';

export type InitOptions = {
  /** Skip all interactive prompts and accept smart defaults. */
  yes?: boolean;
};

/** Answers collected from the setup wizard, used to populate the YAML. */
type WizardAnswers = {
  agent: 'claude' | 'codex' | 'opencode';
  baseBranch: string;
  testCommand: string;
  devCommand: string;
  autoMerge: boolean;
  maxIssues: number;
};

const AGENT_READY_ISSUE_TEMPLATE = `name: Agent-Ready Task
description: A well-structured task for the automated agent loop to implement
title: ""
labels: ["ready"]
body:
  - type: markdown
    attributes:
      value: |
        This template creates issues that the automated agent loop can pick up and implement.
        Be specific -- the agent will use these fields to plan, implement, and verify.

  - type: textarea
    id: description
    attributes:
      label: Description
      description: Clear description of what needs to be done
      placeholder: Describe the change, feature, or fix...
    validations:
      required: true

  - type: textarea
    id: acceptance-criteria
    attributes:
      label: Acceptance Criteria
      description: Specific, testable criteria that define "done"
      placeholder: |
        - [ ] Criterion 1
        - [ ] Criterion 2
        - [ ] Criterion 3
    validations:
      required: true

  - type: textarea
    id: test-requirements
    attributes:
      label: Test Requirements
      description: What tests should be written or updated?
      placeholder: |
        - Unit tests for...
        - E2E test for...

  - type: textarea
    id: affected-files
    attributes:
      label: Affected Files/Areas
      description: Known files or areas of the codebase that will be touched
      placeholder: |
        - src/...
        - tests/...

  - type: dropdown
    id: complexity
    attributes:
      label: Complexity
      options:
        - trivial (< 30 min)
        - small (1-2 hours)
        - medium (half day)
        - large (full day)
    validations:
      required: true

  - type: textarea
    id: context
    attributes:
      label: Additional Context
      description: Any background, constraints, or references the agent should know
`;

const EPIC_ISSUE_TEMPLATE = `name: Epic
description: Group ordered agent-ready sub-issues into one deliverable
title: "[Epic] "
labels: ["epic"]
body:
  - type: markdown
    attributes:
      value: |
        This template creates an Alpha Loop epic. The \`epic\` label is required and is applied automatically by this template.
        If GitHub does not apply template labels in your repository, add \`epic\` manually before running \`alpha-loop run --epic <number>\`.
        Put sub-issues in the exact order Alpha Loop should process them, one per task-list line: \`- [ ] #123 Short description\`.

  - type: textarea
    id: goal
    attributes:
      label: Goal
      description: The outcome this epic should deliver
      placeholder: Describe the end-to-end capability or user value this epic delivers...
    validations:
      required: true

  - type: textarea
    id: sub-issues
    attributes:
      label: Sub-issues
      description: Ordered task-list of issue numbers. Alpha Loop processes these from top to bottom.
      placeholder: |
        - [ ] #123 First agent-ready task
        - [ ] #124 Second agent-ready task
        - [ ] #125 Third agent-ready task
    validations:
      required: true

  - type: textarea
    id: acceptance-criteria
    attributes:
      label: Acceptance Criteria
      description: Epic-level criteria that define done across all sub-issues
      placeholder: |
        - [ ] End-to-end workflow is complete
        - [ ] Required docs are updated
        - [ ] All sub-issue acceptance criteria are satisfied
    validations:
      required: true

  - type: textarea
    id: dependencies
    attributes:
      label: Dependencies
      description: External blockers, prerequisite decisions, or upstream work
      placeholder: |
        - Depends on...
        - Blocked by...

  - type: textarea
    id: sequencing-notes
    attributes:
      label: Sequencing Notes
      description: Notes about ordering, coupling, or handoff between sub-issues
      placeholder: Describe why the checklist order matters or where parallel work is safe...

  - type: textarea
    id: verification-expectations
    attributes:
      label: Verification Expectations
      description: What the final epic verification pass should confirm
      placeholder: |
        - Verify merged PRs satisfy each sub-issue's acceptance criteria
        - Confirm the integrated workflow works end to end
        - Note any manual checks required before closing the epic
    validations:
      required: true
`;

const ISSUE_TEMPLATES = [
  {
    filename: 'agent-ready.yml',
    description: 'agent-ready task',
    content: AGENT_READY_ISSUE_TEMPLATE,
  },
  {
    filename: 'epic.yml',
    description: 'epic',
    content: EPIC_ISSUE_TEMPLATE,
  },
] as const;

/**
 * Build the full annotated `.alpha-loop.yaml` for a fresh project. Active
 * settings get values from the wizard/scan; everything else is commented out
 * so users can see all available options at a glance.
 */
function configTemplate(repo: string, scan: ProjectScan, answers: WizardAnswers): string {
  const stackHint = scan.framework
    ? `${scan.language} / ${scan.framework}`
    : scan.language;
  const harness = harnessForAgent(answers.agent);

  return `# Alpha Loop configuration
# ----------------------------------------------------------------------------
# Detected stack: ${stackHint || 'unknown'} (package manager: ${scan.packageManager})
# Docs: https://github.com/bradtaylorsf/alpha-loop#configuration
#
# Most settings have sensible defaults. Uncomment and edit anything you want
# to override. Settings are grouped by section — read top-to-bottom on first
# setup, then come back to tune the advanced sections later.
# ----------------------------------------------------------------------------

# === Project ================================================================
# Identifies the GitHub repo + project board the loop reads from.
repo: ${repo}
# project: 0           # GitHub Project number (from project URL: /projects/N)
# milestone: ""        # Process this milestone's scheduled epic, or ready flat issues if none

# === Agent ==================================================================
# The CLI agent that drives Plan/Build/Test/Review. Supported values:
#   claude     — Anthropic Claude Code (recommended, best tool-use support)
#   codex      — OpenAI Codex CLI
#   opencode   — Open-source coding harness
#   lmstudio   — LM Studio (local models, requires running server)
#   ollama     — Ollama (local models, requires running daemon)
agent: ${answers.agent}
# model: ""            # Override default model (e.g., opus, sonnet, gpt-5.4)
# review_model: ""     # Different model for review step (defaults to model)
# agent_timeout: 1800  # Agent call timeout in seconds (default: 30 min)

# === Workflow ===============================================================
# Branch and label conventions for the loop.
base_branch: ${answers.baseBranch}
label: ready                  # Issues with this label are queued for the loop
auto_merge: ${answers.autoMerge}            # Auto-merge PRs to session branch when checks pass
# merge_to: ""                # Reuse an existing session branch instead of creating one
# auto_cleanup: true          # Delete worktrees and branches after success
# prefer_epics: false         # Auto-pick a single open epic instead of prompting

# === Testing ================================================================
# Commands the loop runs to verify changes.
test_command: ${answers.testCommand}
dev_command: ${answers.devCommand}
# setup_command: ""           # Run once before the session (e.g., "pnpm install")
# smoke_test: ""              # Final smoke command after review (e.g., "curl localhost:3000/health")
# max_test_retries: 3         # How many times to let the agent fix failing tests
# skip_tests: false           # Skip test execution entirely (not recommended)
# skip_review: false          # Skip the code review step
# skip_e2e: false             # Skip end-to-end tests (Playwright, etc.)
# skip_preflight: false       # Skip pre-session validation
# skip_verify: false          # Skip the verify step (epic mode)
# skip_learn: false           # Skip learning extraction
# skip_install: false         # Skip auto-running setup_command on session start

# === Safety limits ==========================================================
# Caps to keep an unattended loop from running away. 0 = unlimited.
max_issues: ${answers.maxIssues}
max_session_duration: 7200    # Total session wall-clock budget, in seconds (2h)
# poll_interval: 60           # Seconds between issue queue polls when running continuously

# === Harnesses ==============================================================
# Coding harnesses to sync skills/agents to. When empty, alpha-loop picks one
# based on \`agent\` above. Set explicitly if you use multiple harnesses.
harnesses:
  - ${harness}

# === Pipeline overrides (advanced) ==========================================
# Use a different agent or model for specific pipeline steps. Useful for
# routing cheap models to grunt work and reserving the expensive ones for
# planning and review. Each step accepts { agent?, model? }.
# pipeline:
#   plan:
#     agent: claude
#     model: opus
#   implement:
#     agent: claude
#     model: sonnet
#   test_fix:
#     model: haiku
#   review:
#     model: opus
#   verify:
#     model: sonnet
#   learn:
#     model: haiku

# === Routing (advanced, hybrid local/cloud) =================================
# Route Loop stages to specific models on specific endpoints. Powerful for
# hybrid setups (e.g., local 30B coder for build/test, cloud Opus for plan/
# review). See docs/routing-profiles.md for ready-to-paste profiles.
# routing:
#   profile: hybrid-v1                # Or list for A/B: [hybrid-v1, cloud-only]
#   endpoints:
#     local:
#       type: openai_compat
#       base_url: http://localhost:1234/v1
#     cloud:
#       type: anthropic
#       base_url: https://api.anthropic.com
#   stages:
#     plan:       { model: claude-opus-4-6,    endpoint: cloud }
#     build:      { model: qwen3-coder-30b-a3b, endpoint: local }
#     test_write: { model: qwen3-coder-30b-a3b, endpoint: local }
#     test_exec:  { model: qwen3-coder-30b-a3b, endpoint: local }
#     review:     { model: claude-opus-4-6,    endpoint: cloud }
#     summary:    { model: claude-haiku-4-5,   endpoint: cloud }
#   fallback:
#     on_tool_error: escalate         # escalate | retry | fail
#     escalate_to: { model: claude-sonnet-4-6, endpoint: cloud }
#     escalation_window_issues: 10    # Rolling window for error-rate guardrail
#     escalation_error_threshold: 0.08
#     escalation_revert_ms: 86400000  # 24h

# === Batch mode (advanced) ==================================================
# Process multiple issues in a single agent call. Faster + fewer tokens, but
# less isolation between issues — best for small, mechanical tasks.
# batch: false
# batch_size: 5

# === Evaluation =============================================================
# Settings for the eval harness used by \`alpha-loop review\` and CI eval runs.
# eval_dir: .alpha-loop/evals
# eval_model: ""              # Defaults to the top-level model
# eval_timeout: 300           # Per-case timeout in seconds
# skip_eval: false
# auto_capture: true          # Capture session failures as eval cases automatically
# eval:
#   include_agent_prompts: true   # Mirror this repo's agent prompts during eval
#   include_skills: true          # Mirror this repo's skills during eval

# === Post-session review ====================================================
# Holistic code review and security scan after the session completes.
# post_session:
#   review: true
#   security_scan: true

# === Logging ================================================================
# log_dir: logs
# verbose: false
# dry_run: false              # Preview without making changes (overridable via --dry-run)

# === Pricing (cost tracking) ================================================
# Per-million-token pricing for cost reports. Defaults cover Anthropic + OpenAI
# common models; add your own here.
# pricing:
#   claude-opus-4-6:   { input: 15.0, output: 75.0 }
#   claude-sonnet-4-6: { input: 3.0,  output: 15.0 }
#   claude-haiku-4-5:  { input: 0.80, output: 4.0 }
#   gpt-4o:            { input: 2.50, output: 10.0 }
#   gpt-4o-mini:       { input: 0.15, output: 0.60 }
`;
}

/** Map an agent CLI to its default harness directory name. */
function harnessForAgent(agent: string): string {
  switch (agent) {
    case 'codex':
      return 'codex';
    case 'opencode':
      return 'opencode';
    case 'lmstudio':
    case 'ollama':
    case 'claude':
    default:
      return 'claude-code';
  }
}

/**
 * Read a YAML file as text and return the set of top-level keys present.
 * Comment-aware (skips `#` lines) but doesn't try to parse — we just want to
 * know which keys the user has already touched so we don't trample them.
 */
function existingTopLevelKeys(yamlPath: string): Set<string> {
  if (!existsSync(yamlPath)) return new Set();
  const keys = new Set<string>();
  const text = readFileSync(yamlPath, 'utf-8');
  for (const line of text.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (match) keys.add(match[1]!);
  }
  return keys;
}

/**
 * Append commented-out hints for top-level keys missing from an existing
 * config. Preserves all user content and writes only at end-of-file.
 *
 * The hints come from the same fresh template, so users see the same
 * documentation comments they'd see on a fresh init.
 */
function mergeMissingKeys(yamlPath: string, freshTemplate: string): string[] {
  const existing = readFileSync(yamlPath, 'utf-8');
  const existingKeys = existingTopLevelKeys(yamlPath);

  // Pull each top-level setting block out of the fresh template
  const blocks: Array<{ key: string; lines: string[] }> = [];
  const freshLines = freshTemplate.split('\n');
  let current: { key: string; lines: string[] } | null = null;
  for (const line of freshLines) {
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:/);
    if (match) {
      if (current) blocks.push(current);
      current = { key: match[1]!, lines: [line] };
    } else if (current && (line.startsWith(' ') || line.startsWith('\t') || line === '')) {
      current.lines.push(line);
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);

  const missing = blocks.filter((b) => !existingKeys.has(b.key));
  if (missing.length === 0) return [];

  const addedKeys: string[] = [];
  let appendix = '\n# === Added by alpha-loop init (new settings) ===\n';
  appendix += '# These options were added in a newer alpha-loop release. They\'re commented out\n';
  appendix += '# so your current behavior is unchanged — uncomment to opt in.\n\n';
  for (const block of missing) {
    addedKeys.push(block.key);
    // Re-emit each line as a comment so the merge is non-destructive
    for (const line of block.lines) {
      appendix += line === '' ? '#\n' : `# ${line}\n`;
    }
    appendix += '\n';
  }

  const suffix = existing.endsWith('\n') ? '' : '\n';
  writeFileSync(yamlPath, existing + suffix + appendix);
  return addedKeys;
}

/**
 * Smart-defaults setup wizard. Asks 4-6 short questions, accepts any blank
 * answer to fall through to the auto-detected default. Skips silently when
 * --yes is set or stdin is not a TTY.
 */
async function runWizard(scan: ProjectScan, opts: InitOptions): Promise<WizardAnswers> {
  const defaults: WizardAnswers = {
    agent: 'claude',
    baseBranch: scan.baseBranch,
    testCommand: scan.testCommand,
    devCommand: scan.devCommand,
    autoMerge: true,
    maxIssues: 20,
  };

  if (opts.yes || !process.stdin.isTTY) return defaults;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, (a) => resolve(a.trim())));

  log.info('Setup wizard — press Enter to accept the default in [brackets].');

  const agentAns = (await ask(`  AI agent (claude/codex/opencode) [${defaults.agent}]: `)) || defaults.agent;
  const baseAns = (await ask(`  Base branch [${defaults.baseBranch}]: `)) || defaults.baseBranch;
  const testAns = (await ask(`  Test command [${defaults.testCommand}]: `)) || defaults.testCommand;
  const devAns = (await ask(`  Dev command [${defaults.devCommand}]: `)) || defaults.devCommand;
  const mergeAns = (await ask(`  Auto-merge PRs to session branch? (y/n) [${defaults.autoMerge ? 'y' : 'n'}]: `)).toLowerCase();
  const maxAns = (await ask(`  Max issues per session (0 = unlimited) [${defaults.maxIssues}]: `)) || String(defaults.maxIssues);

  rl.close();

  const validAgents = ['claude', 'codex', 'opencode'] as const;
  const agent = validAgents.includes(agentAns as typeof validAgents[number])
    ? (agentAns as 'claude' | 'codex' | 'opencode')
    : defaults.agent;
  if (agent !== agentAns) {
    log.warn(`Unknown agent "${agentAns}" — falling back to ${defaults.agent}`);
  }

  const maxParsed = Number.parseInt(maxAns, 10);
  const maxIssues = Number.isFinite(maxParsed) && maxParsed >= 0 ? maxParsed : defaults.maxIssues;

  return {
    agent,
    baseBranch: baseAns,
    testCommand: testAns,
    devCommand: devAns,
    autoMerge: mergeAns === '' ? defaults.autoMerge : mergeAns === 'y' || mergeAns === 'yes',
    maxIssues,
  };
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  exec(`cp -R "${src}/"* "${dest}/" 2>/dev/null || true`);
}

/** Recursively walk a source directory and call visitor(srcFile, destFile) for each file. */
function seedDirRecursive(
  srcDir: string,
  destDir: string,
  visitor: (src: string, dest: string) => void,
): void {
  if (!existsSync(srcDir)) return;
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      seedDirRecursive(srcPath, destPath, visitor);
    } else if (entry.isFile()) {
      visitor(srcPath, destPath);
    }
  }
}

const GITIGNORE_ENTRIES = [
  '# Alpha-loop ephemeral data (not shared)',
  '.alpha-loop/sessions/',
  '.alpha-loop/auth/',
  '.alpha-loop/templates/*.bak',
  '.worktrees/',
];

function ensureGitignore(): void {
  const gitignorePath = '.gitignore';
  let content = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';
  let changed = false;

  // Remove old entry that ignored learnings (they should be tracked now)
  if (content.includes('.alpha-loop/learnings/')) {
    content = content
      .split('\n')
      .filter((line) => line.trim() !== '.alpha-loop/learnings/')
      .join('\n');
    changed = true;
    log.info('Removed .alpha-loop/learnings/ from .gitignore (learnings are now tracked)');
  }

  const missing = GITIGNORE_ENTRIES.filter((entry) => !content.includes(entry));
  if (missing.length > 0) {
    const suffix = (content.endsWith('\n') || content === '') ? '' : '\n';
    content += suffix + missing.join('\n') + '\n';
    changed = true;
  }

  if (changed) {
    writeFileSync(gitignorePath, content);
    log.success('Updated .gitignore for alpha-loop');
  }
}

const REQUIRED_PROJECT_STATUSES = ['Todo', 'In progress', 'In Review', 'Done'];

const REQUIRED_LABELS = [
  { name: 'ready', color: '0E8A16', description: 'Ready for agent processing' },
  { name: 'in-progress', color: '1D76DB', description: 'Agent is working on this' },
  { name: 'in-review', color: 'FBCA04', description: 'PR created, awaiting review' },
  { name: 'failed', color: 'D93F0B', description: 'Agent processing failed' },
  { name: 'epic', color: '8B5CF6', description: 'Tracker issue with sub-issue checklist' },
  { name: 'needs-human-input', color: 'E99695', description: 'Requires human review or decision' },
];

/**
 * On Apple Silicon + 64GB+ RAM, point users at the local-model docs.
 * Does not modify the YAML — the docs walk the user through the full setup.
 * Silent on non-matching hardware and non-TTY environments.
 */
export async function maybeOfferLocalMode(): Promise<void> {
  if (!shouldOfferLocalMode()) return;
  if (!process.stdin.isTTY) return;

  const memGB = Math.round(getTotalMemoryGB());
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `Detected Apple Silicon + ${memGB}GB RAM. Use hybrid (local build/test + cloud plan/review) mode? [y/N]: `,
      resolve,
    );
  });
  rl.close();

  if (answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes') {
    log.info('Hybrid mode setup is documented in:');
    log.info('  - docs/local-models.md     (LM Studio / Ollama install, hardware tuning)');
    log.info('  - docs/routing-profiles.md (copy-pasteable hybrid-v1 routing config)');
    log.info('Alpha-loop did not modify .alpha-loop.yaml — follow the docs when ready.');
  }
}

/**
 * Check for required GitHub labels and interactively create missing ones.
 */
export async function ensureLabels(repo: string, labelReady: string): Promise<void> {
  // Build the label list with the configured "ready" label name
  const labels = REQUIRED_LABELS.map(l =>
    l.name === 'ready' ? { ...l, name: labelReady } : l,
  );

  const result = ghExec(`gh label list --repo "${repo}" --json name --limit 200`);
  if (result.exitCode !== 0) {
    log.warn('Could not check labels (gh CLI issue or repo not found)');
    return;
  }

  let existing: Set<string>;
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ name: string }>;
    existing = new Set(parsed.map(l => l.name));
  } catch {
    log.warn('Could not parse label list');
    return;
  }

  const missing = labels.filter(l => !existing.has(l.name));
  if (missing.length === 0) {
    log.success('All required labels exist');
    return;
  }

  log.info(`Missing labels: ${missing.map(l => l.name).join(', ')}`);

  // Interactive confirmation if running in a TTY
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question('Create missing labels? [Y/n]: ', resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() === 'n') {
      log.info('Skipping label creation');
      return;
    }
  }

  for (const label of missing) {
    const createResult = ghExec(
      `gh label create "${label.name}" --repo "${repo}" --color "${label.color}" --description "${label.description}"`,
      undefined, true,
    );
    if (createResult.exitCode === 0) {
      log.success(`Created label: ${label.name}`);
    } else {
      log.warn(`Failed to create label: ${label.name}`);
    }
  }
}

/**
 * Check for required project board statuses and create missing ones.
 */
export async function ensureProjectStatuses(repoOwner: string, project: number): Promise<void> {
  if (!project || project <= 0) {
    log.info('No project board configured — skipping status check');
    return;
  }

  // Get project ID and status field
  const projectResult = ghExec(`gh project view ${project} --owner "${repoOwner}" --format json`);
  if (projectResult.exitCode !== 0) {
    log.warn(`Could not access project board ${project}`);
    return;
  }

  let projectId: string;
  try {
    projectId = (JSON.parse(projectResult.stdout) as { id: string }).id;
  } catch {
    log.warn('Could not parse project data');
    return;
  }

  const fieldResult = ghExec(`gh project field-list ${project} --owner "${repoOwner}" --format json`);
  if (fieldResult.exitCode !== 0) {
    log.warn('Could not list project fields');
    return;
  }

  let fieldId: string | undefined;
  let existingOptions: Array<{ id: string; name: string }> = [];
  try {
    const data = JSON.parse(fieldResult.stdout) as {
      fields: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
    };
    const statusField = data.fields.find((f) => f.name === 'Status');
    if (statusField) {
      fieldId = statusField.id;
      existingOptions = statusField.options ?? [];
    }
  } catch {
    log.warn('Could not parse project fields');
    return;
  }

  if (!fieldId) {
    log.warn('No Status field found on project board');
    return;
  }

  const existingNames = new Set(existingOptions.map((o) => o.name));
  const missing = REQUIRED_PROJECT_STATUSES.filter((s) => !existingNames.has(s));

  if (missing.length === 0) {
    log.success('All required project statuses exist');
    return;
  }

  log.info(`Missing project statuses: ${missing.join(', ')}`);

  // Interactive confirmation if running in a TTY
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => {
      rl.question('Create missing project statuses? [Y/n]: ', resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() === 'n') {
      log.info('Skipping status creation');
      return;
    }
  }

  // Build the full options list (existing + new) for the update mutation
  const allOptionObjs: Array<{ name: string; id?: string }> = [
    ...existingOptions.map((o) => ({ name: o.name, id: o.id })),
    ...missing.map((name) => ({ name })),
  ];

  const optionsJson = JSON.stringify(allOptionObjs);

  const mutation = `mutation {
    updateProjectV2Field(input: {
      projectId: "${projectId}"
      fieldId: "${fieldId}"
      singleSelectOptions: ${optionsJson.replace(/"/g, '\\"')}
    }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
  }`;

  const createResult = ghExec(`gh api graphql -f query="${mutation}"`, undefined, true);
  if (createResult.exitCode === 0) {
    log.success(`Created project statuses: ${missing.join(', ')}`);
  } else {
    log.warn(`Could not create project statuses: ${createResult.stderr}`);
    log.info(`Please add these statuses manually in your project settings: ${missing.join(', ')}`);
  }
}

export async function initCommand(options: InitOptions = {}): Promise<void> {
  const projectDir = process.cwd();

  // --- Step 1: Scan + wizard + create/merge config ---
  log.step('Step 1: Configuration');
  const scan = scanProject(projectDir);
  log.info(
    `Detected ${scan.language || 'unknown stack'}${scan.framework ? ` / ${scan.framework}` : ''}, ` +
    `package manager: ${scan.packageManager}, base branch: ${scan.baseBranch}`,
  );

  if (existsSync(CONFIG_FILE)) {
    // Existing config: don't trample user values, just expose any new options
    // they don't have yet by appending commented-out blocks at the end.
    let repo = detectRepo() ?? 'owner/repo';
    const placeholder: WizardAnswers = {
      agent: 'claude',
      baseBranch: scan.baseBranch,
      testCommand: scan.testCommand,
      devCommand: scan.devCommand,
      autoMerge: true,
      maxIssues: 20,
    };
    const fresh = configTemplate(repo, scan, placeholder);
    const added = mergeMissingKeys(CONFIG_FILE, fresh);
    if (added.length > 0) {
      log.success(`Added ${added.length} new commented option(s) to ${CONFIG_FILE}: ${added.join(', ')}`);
    } else {
      log.info(`${CONFIG_FILE} is already up to date`);
    }
  } else {
    let repo = detectRepo();
    if (repo) {
      log.success(`Auto-detected repo: ${repo}`);
    } else {
      repo = 'owner/repo';
      log.warn('Could not auto-detect repo from git remote. Using placeholder.');
    }
    const answers = await runWizard(scan, options);
    writeFileSync(CONFIG_FILE, configTemplate(repo, scan, answers));
    log.success(`Created ${CONFIG_FILE}`);
  }
  await maybeOfferLocalMode();

  // --- Step 2: Set up .gitignore ---
  log.step('Step 2: Git ignore');
  ensureGitignore();

  // --- Step 3: Detect and migrate legacy layout (before seeding, to preserve user skills) ---
  log.step('Step 3: Legacy migration');
  migrateToTemplates(projectDir);

  // --- Step 4: Seed .alpha-loop/templates/ from distribution (only fills gaps) ---
  log.step('Step 4: Seed templates');
  const distTemplatesDir = findDistributionTemplatesDir();
  const projectTemplatesDir = join(projectDir, '.alpha-loop', 'templates');

  if (distTemplatesDir) {
    // Seed skills
    const distSkills = join(distTemplatesDir, 'skills');
    const projectSkills = join(projectTemplatesDir, 'skills');
    if (existsSync(distSkills)) {
      const skillNames = readdirSync(distSkills, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
      let installed = 0;
      for (const name of skillNames) {
        const dest = join(projectSkills, name);
        if (!existsSync(dest)) {
          copyDir(join(distSkills, name), dest);
          installed++;
        }
      }
      if (installed > 0) {
        log.success(`Seeded ${installed} skill(s) to .alpha-loop/templates/skills/`);
      }
    }

    // Seed agents
    const distAgents = join(distTemplatesDir, 'agents');
    const projectAgents = join(projectTemplatesDir, 'agents');
    if (existsSync(distAgents)) {
      mkdirSync(projectAgents, { recursive: true });
      const agentFiles = readdirSync(distAgents).filter((f) => f.endsWith('.md'));
      let installed = 0;
      for (const file of agentFiles) {
        const dest = join(projectAgents, file);
        if (!existsSync(dest)) {
          copyFileSync(join(distAgents, file), dest);
          installed++;
        }
      }
      if (installed > 0) {
        log.success(`Seeded ${installed} agent(s) to .alpha-loop/templates/agents/`);
      }
    }
    // Seed distribution eval cases
    const distEvals = join(distTemplatesDir, 'evals', 'cases');
    const projectEvalsDir = join(projectDir, '.alpha-loop', 'evals', 'cases');
    if (existsSync(distEvals)) {
      let seededEvals = 0;
      seedDirRecursive(distEvals, projectEvalsDir, (src, dest) => {
        if (!existsSync(dest)) {
          mkdirSync(join(dest, '..'), { recursive: true });
          copyFileSync(src, dest);
          seededEvals++;
        }
      });
      if (seededEvals > 0) {
        log.success(`Seeded ${seededEvals} eval file(s) to .alpha-loop/evals/cases/`);
      }
    }
  } else {
    log.warn('Distribution templates not found — skipping seed');
  }

  // --- Step 5: Install playwright-cli skills ---
  log.step('Step 5: Playwright CLI');
  installPlaywrightSkills(projectDir, projectTemplatesDir);

  // --- Step 6: Vision ---
  {
    const { hasVision } = await import('../lib/vision.js');
    if (!hasVision()) {
      log.step('Step 6: Project vision');
      log.info('Run "alpha-loop plan" to set up your project vision and scope');
    } else {
      log.step('Step 6: Project vision (already exists)');
    }
  }

  // --- Step 7: Scan (context + instructions) ---
  log.step('Step 7: Scan codebase');
  const { scanCommand } = await import('./scan.js');
  scanCommand();

  // --- Step 8: Sync to harnesses ---
  log.step('Step 8: Sync to harnesses');
  const config = loadConfig();
  const harnesses = resolveHarnesses(config.harnesses, config.agent);
  const syncResult = syncAgentAssets(harnesses);
  if (syncResult.synced) {
    log.success(`Synced templates to ${harnesses.join(', ')}`);
  }

  // --- Step 9: GitHub issue templates ---
  log.step('Step 9: Issue templates');
  const templateDir = join('.github', 'ISSUE_TEMPLATE');
  const createdTemplates: string[] = [];
  for (const template of ISSUE_TEMPLATES) {
    const templateFile = join(templateDir, template.filename);
    if (!existsSync(templateFile)) {
      mkdirSync(templateDir, { recursive: true });
      writeFileSync(templateFile, template.content);
      createdTemplates.push(template.description);
    }
  }
  if (createdTemplates.length > 0) {
    log.success(`Created GitHub issue template(s): ${createdTemplates.join(', ')}`);
  } else {
    log.info('Issue templates already exist');
  }

  // --- Step 10: GitHub labels ---
  log.step('Step 10: GitHub labels');
  await ensureLabels(config.repo, config.labelReady);

  // --- Step 11: Project board statuses ---
  log.step('Step 11: Project board statuses');
  await ensureProjectStatuses(config.repoOwner, config.project);

  // --- Step 12: Commit ---
  log.step('Step 11: Commit generated files');
  const statusResult = exec('git status --porcelain .alpha-loop/ .claude/ .agents/ .codex/ CLAUDE.md AGENTS.md .gitignore .github/');
  if (statusResult.stdout.trim()) {
    exec('git add .alpha-loop/ .claude/ .agents/ .codex/ CLAUDE.md AGENTS.md .gitignore .github/ 2>/dev/null || true');
    const diffCheck = exec('git diff --cached --quiet');
    if (diffCheck.exitCode !== 0) {
      exec('git commit -m "chore: initialize alpha-loop (skills, agents, context, instructions)"');
      log.success('Committed generated files');
    }
  } else {
    log.info('No new files to commit');
  }

  log.success('Alpha-loop initialization complete!');
}

/**
 * Install playwright-cli skills into .alpha-loop/templates/skills/ (source of truth).
 * playwright-cli install --skills writes to .claude/ by default, so we move the
 * installed skills into templates and let the normal sync handle distribution.
 */
export function installPlaywrightSkills(projectDir: string, templatesDir?: string): boolean {
  const projectTemplatesDir = templatesDir ?? join(projectDir, '.alpha-loop', 'templates');

  const which = exec('which playwright-cli');
  if (which.exitCode !== 0) {
    log.warn('playwright-cli not installed — live verification will not be available');
    log.info('  Install: npm install -g @anthropic-ai/claude-code');
    log.info('  Then run: alpha-loop init (or playwright-cli install --skills)');
    return false;
  }

  // Run playwright-cli install --skills (writes to .claude/skills/)
  const result = exec('playwright-cli install --skills', { cwd: projectDir });
  if (result.exitCode !== 0) {
    log.warn('Could not install playwright-cli skills');
    return false;
  }

  log.success('Playwright CLI skills installed');

  // Move installed skills from .claude/skills/ to templates source of truth
  // playwright-cli may install multiple skill directories — move any new ones
  const claudeSkillsDir = join(projectDir, '.claude', 'skills');
  const templateSkillsDir = join(projectTemplatesDir, 'skills');

  if (existsSync(claudeSkillsDir)) {
    const installed = readdirSync(claudeSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('playwright'));

    for (const dir of installed) {
      const dest = join(templateSkillsDir, dir.name);
      const src = join(claudeSkillsDir, dir.name);
      if (!existsSync(dest)) {
        mkdirSync(dest, { recursive: true });
        copyDir(src, dest);
        log.info(`Moved ${dir.name} skill to .alpha-loop/templates/skills/`);
      }
      // Remove from .claude/ so sync doesn't conflict
      exec(`rm -rf "${src}"`);
    }
  }

  return true;
}
