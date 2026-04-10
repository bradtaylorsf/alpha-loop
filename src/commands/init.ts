/**
 * Init Command — full project onboarding for alpha-loop.
 *
 * Steps:
 * 1. Create config (.alpha-loop.yaml)
 * 2. Set up .gitignore
 * 3. Detect and migrate legacy layout (skills/ at root, .claude/agents/)
 * 4. Seed .alpha-loop/templates/ from distribution (fills gaps only)
 * 5. Install playwright-cli skills (if available)
 * 6. Run vision (interactive, if TTY)
 * 7. Run scan (generates context + instructions)
 * 8. Sync templates to configured harnesses
 * 9. Install GitHub issue template
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

const CONFIG_FILE = '.alpha-loop.yaml';

const ISSUE_TEMPLATE = `name: Agent-Ready Task
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

function configTemplate(repo: string): string {
  return `# Alpha Loop configuration
repo: ${repo}
project: 0  # GitHub Project number (find it in your project URL)
agent: claude  # AI agent CLI: claude, codex, opencode
# model:       # AI model (omit to use agent's default, e.g., opus, gpt-5.4)
label: ready
base_branch: main
test_command: pnpm test
dev_command: pnpm dev
auto_merge: true

# Coding harnesses to sync skills/agents to (auto-derived from agent if empty)
harnesses:
  - claude

# Safety limits (0 = unlimited)
max_issues: 20
max_session_duration: 7200  # 2 hours in seconds
`;
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
];

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

export async function initCommand(): Promise<void> {
  const projectDir = process.cwd();

  // --- Step 1: Create config ---
  log.step('Step 1: Configuration');
  if (existsSync(CONFIG_FILE)) {
    log.info(`${CONFIG_FILE} already exists — skipping`);
  } else {
    let repo = detectRepo();
    if (repo) {
      log.success(`Auto-detected repo: ${repo}`);
    } else {
      repo = 'owner/repo';
      log.warn('Could not auto-detect repo from git remote. Using placeholder.');
    }
    writeFileSync(CONFIG_FILE, configTemplate(repo));
    log.success(`Created ${CONFIG_FILE}`);
  }

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

  // --- Step 9: GitHub issue template ---
  log.step('Step 9: Issue template');
  const templateDir = join('.github', 'ISSUE_TEMPLATE');
  const templateFile = join(templateDir, 'agent-ready.yml');
  if (!existsSync(templateFile)) {
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(templateFile, ISSUE_TEMPLATE);
    log.success('Created GitHub issue template');
  } else {
    log.info('Issue template already exists');
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
