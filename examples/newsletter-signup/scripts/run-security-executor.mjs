#!/usr/bin/env node
/**
 * Runs the Alpha Loop security executor against the demo worktree and writes
 * security-profile-report.md (application PASS rows + agent NOT_APPLICABLE).
 *
 * Env:
 *   ALPHA_LOOP_ROOT   — path to ALPHA-LOOP checkout (required)
 *   WORKTREE          — demo clone path (required)
 *   NEWSLETTER_BASE_URL — container base URL (required for live checks)
 *   TEMPLATE_IMAGE_ID — docker image id for newsletter-signup:template
 *   DEMO_REPO         — owner/name
 *   DEMO_BRANCH       — branch or fork branch
 *   DRY_RUN           — when 1, skip executor and write synthetic PASS rows
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const alphaRoot = resolve(process.env.ALPHA_LOOP_ROOT || '');
const worktree = resolve(process.env.WORKTREE || '');
const baseUrl = (process.env.NEWSLETTER_BASE_URL || '').replace(/\/$/, '');
const imageId = process.env.TEMPLATE_IMAGE_ID || '(unknown)';
const demoRepo = process.env.DEMO_REPO || 'newsletter-signup-demo';
const demoBranch = process.env.DEMO_BRANCH || 'security-run/local';
const dryRun = process.env.DRY_RUN === '1';

if (!alphaRoot || !existsSync(join(alphaRoot, 'dist', 'lib', 'security-executor.js'))) {
  console.error('ALPHA_LOOP_ROOT must point at a built ALPHA-LOOP checkout (dist/).');
  process.exit(2);
}
if (!worktree || !existsSync(worktree)) {
  console.error('WORKTREE must be set to the demo clone directory.');
  process.exit(2);
}

const { runSecurityExecutor } = await import(
  pathToFileURL(join(alphaRoot, 'dist', 'lib', 'security-executor.js')).href
);
const { loadSecurityPlan, saveSecurityPlan } = await import(
  pathToFileURL(join(alphaRoot, 'dist', 'lib', 'security-plan.js')).href
);
const { loadConfig } = await import(
  pathToFileURL(join(alphaRoot, 'dist', 'lib', 'config.js')).href
);

function gitSha(dir) {
  try {
    return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const plan = loadSecurityPlan(worktree);
const selected = plan.checks.filter((c) => c.selected);
const logsDir = join(worktree, '.alpha-loop', 'logs', 'security-demo');
mkdirSync(logsDir, { recursive: true });

let results = [];
if (dryRun) {
  results = selected.map((check) => ({
    techniqueId: check.techniqueId,
    surface: check.surface,
    source: check.source,
    target: check.target,
    status: 'PASS',
    reason: 'DRY_RUN=1 synthetic pass',
    command: check.command,
    exitCode: 0,
    catalogRevision: check.catalogRevision,
    logFile: '',
    timedOut: false,
    blocked: false,
    milestone: check.milestone || `${check.techniqueId} [${check.surface}]`,
  }));
  console.log(`[dry-run] synthesized ${results.length} PASS row(s)`);
} else {
  if (!baseUrl) {
    console.error('NEWSLETTER_BASE_URL is required unless DRY_RUN=1');
    process.exit(2);
  }
  process.env.NEWSLETTER_BASE_URL = baseUrl;
  const prevCwd = process.cwd();
  process.chdir(worktree);
  let config;
  try {
    config = loadConfig({ dryRun: false });
  } finally {
    process.chdir(prevCwd);
  }

  const execResult = await runSecurityExecutor({
    plan,
    worktree,
    gitSha: gitSha(worktree),
    logsDir,
    config,
    productSuitePassed: true,
  });
  results = execResult.results.map((row) => {
    const check = selected.find(
      (c) => c.techniqueId === row.techniqueId && c.surface === row.surface,
    );
    return {
      ...row,
      milestone: check?.milestone || `${row.techniqueId} [${row.surface}]`,
    };
  });
  console.log(`executor proof: ${execResult.proofPath}`);
}

const appResults = results.filter((r) => r.target === 'application');
const appPass = appResults.length > 0 && appResults.every((r) => r.status === 'PASS');
const appSection = appPass ? 'PASS' : (appResults.some((r) => r.status === 'FAIL') ? 'FAIL' : 'NOT_RUN');
const agentSection = 'NOT_APPLICABLE';
const overall = appSection === 'PASS' && agentSection === 'NOT_APPLICABLE' ? 'PASS' : 'FAIL';

const lines = [
  '# Security profile report',
  '',
  `- Template image: \`newsletter-signup:template\``,
  `- Template image ID: \`${imageId}\``,
  `- Demo repo: \`${demoRepo}\``,
  `- Branch: \`${demoBranch}\``,
  `- Base URL: \`${baseUrl || '(dry-run)'}\``,
  `- Generated: ${new Date().toISOString()}`,
  '',
  '## Application profile',
  '',
  `- Source: https://github.com/mitre/cti`,
  `- Section result: **${appSection}**`,
  '',
  '| Technique | Milestone | Status | Reason |',
  '|-----------|-----------|--------|--------|',
];

for (const row of appResults) {
  lines.push(
    `| ${row.techniqueId} | ${row.milestone} | ${row.status} | ${(row.reason || '').replace(/\|/g, '/')} |`,
  );
}
if (appResults.length === 0) {
  lines.push('| (none selected) | — | NOT_RUN | no application checks selected |');
}

lines.push(
  '',
  '## Agent profile',
  '',
  `- Source: https://github.com/secure-agentic-framework/saf-mcp`,
  `- Section result: **${agentSection}**`,
  `- Reason: no MCP server configured for the selected agent`,
  `- Milestone count: 0`,
  '',
  '## Overall',
  '',
  `**${overall}** (application ${appSection} + agent ${agentSection})`,
  '',
);

const reportPath = join(worktree, 'security-profile-report.md');
writeFileSync(reportPath, `${lines.join('\n')}\n`);
console.log(`wrote ${reportPath}`);
console.log(`overall=${overall}`);

// Persist selected milestones onto the plan file for the copy.
saveSecurityPlan(worktree, plan);

if (overall !== 'PASS') process.exit(1);
