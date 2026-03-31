import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectRepo } from '../lib/config.js';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import { syncAgentAssets } from './sync.js';

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
model: opus
review_model: opus
max_turns: 30
label: ready
base_branch: main
test_command: pnpm test
dev_command: pnpm dev
port: 3000
auto_merge: false
`;
}

/**
 * Copy a directory recursively using the shell (simple and reliable).
 */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  exec(`cp -R "${src}/"* "${dest}/" 2>/dev/null || true`);
}

export function initCommand(): void {
  if (existsSync(CONFIG_FILE)) {
    log.warn(`${CONFIG_FILE} already exists. Remove it first to regenerate.`);
    process.exit(1);
  }

  let repo = detectRepo();
  if (repo) {
    log.success(`Auto-detected repo: ${repo}`);
  } else {
    repo = 'owner/repo';
    log.warn('Could not auto-detect repo from git remote. Using placeholder.');
  }

  writeFileSync(CONFIG_FILE, configTemplate(repo));
  log.success(`Created ${CONFIG_FILE}`);

  // Install playwright-cli skills if playwright-cli is available
  const which = exec('which playwright-cli');
  if (which.exitCode === 0) {
    log.info('Installing playwright-cli skills...');
    const result = exec('playwright-cli install --skills');
    if (result.exitCode === 0) {
      log.success('Playwright CLI skills installed');

      // playwright-cli installs to .claude/skills/ only.
      // Copy to skills/ (source of truth) so our sync propagates to .agents/skills/ too.
      const installed = join('.claude', 'skills', 'playwright-cli');
      const sourceOfTruth = join('skills', 'playwright-cli');
      if (existsSync(installed) && !existsSync(sourceOfTruth)) {
        mkdirSync('skills', { recursive: true });
        copyDir(installed, sourceOfTruth);
        log.info('Copied playwright-cli skill to skills/ (source of truth)');
      }
    } else {
      log.warn('Could not install playwright-cli skills');
    }
  } else {
    log.info('playwright-cli not found — skipping skill install. Install with: npm install -g @playwright/cli@latest');
  }

  // Install GitHub issue template for structured agent-ready issues
  const templateDir = join('.github', 'ISSUE_TEMPLATE');
  const templateFile = join(templateDir, 'agent-ready.yml');
  if (!existsSync(templateFile)) {
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(templateFile, ISSUE_TEMPLATE);
    log.success('Created GitHub issue template: .github/ISSUE_TEMPLATE/agent-ready.yml');
  }

  // Sync agent assets so skills land in both .claude/skills/ and .agents/skills/
  const syncResult = syncAgentAssets();
  if (syncResult.synced) {
    log.success('Agent assets synced across .claude/ and .agents/');
  }
}
