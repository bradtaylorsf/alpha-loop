/**
 * Live Verification — use playwright-cli to test the app like a real user.
 *
 * The agent handles everything: starting the dev server, figuring out the URL
 * from the output, testing with playwright-cli, and shutting down.
 *
 * Verification is skipped for non-UI changes (config, docs, tests, etc.).
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from './shell.js';
import { log } from './logger.js';
import { spawnAgent } from './agent.js';
import type { Config } from './config.js';

export type VerifyResult = {
  passed: boolean;
  skipped: boolean;
  output: string;
};

/** File extensions that never need UI verification. */
const NON_UI_EXTENSIONS = new Set([
  '.md', '.yaml', '.yml', '.json', '.toml', '.cfg', '.ini', '.env',
  '.txt', '.csv', '.lock', '.gitignore', '.dockerignore',
  '.test.ts', '.test.tsx', '.test.js', '.test.jsx', '.spec.ts', '.spec.tsx',
]);

/**
 * Check if a diff only touches non-UI files.
 */
export function isNonUiChange(diffStat: string): boolean {
  if (!diffStat.trim()) return true;

  const lines = diffStat.trim().split('\n');
  // Last line is summary like " 5 files changed, 100 insertions(+), 20 deletions(-)"
  const fileLines = lines.slice(0, -1);

  for (const line of fileLines) {
    const filePath = line.trim().split(/\s+\|/)[0]?.trim();
    if (!filePath) continue;

    // Check if file has a non-UI extension
    const isNonUi = [...NON_UI_EXTENSIONS].some(ext => filePath.endsWith(ext));
    if (!isNonUi) return false;
  }

  return true;
}

/**
 * Run live verification using playwright-cli.
 * The agent starts the dev server, tests the app, and reports results.
 */
export async function runVerify(options: {
  worktree: string;
  logFile: string;
  issueNum: number;
  title: string;
  body: string;
  config: Config;
  sessionDir: string;
  verifyInstructions?: string;
}): Promise<VerifyResult> {
  const { worktree, logFile, issueNum, title, body, config, sessionDir, verifyInstructions } = options;

  if (config.skipVerify) {
    log.info('Verification skipped (skipVerify=true)');
    return { passed: true, skipped: true, output: 'Verification skipped' };
  }

  if (config.dryRun) {
    log.dry('Would run live verification');
    return { passed: true, skipped: true, output: 'Verification skipped (dry run)' };
  }

  // Check if playwright-cli is available
  const whichResult = exec('which playwright-cli');
  if (whichResult.exitCode !== 0) {
    log.warn('playwright-cli not installed — skipping verification');
    return { passed: true, skipped: true, output: 'Verification skipped (playwright-cli not installed)' };
  }

  // Check if the diff only touches non-UI files
  const diffStat = exec(`git diff --stat "origin/${config.baseBranch}...HEAD"`, { cwd: worktree });
  if (isNonUiChange(diffStat.stdout)) {
    log.info('Changes are non-UI (config, docs, tests) — skipping verification');
    return { passed: true, skipped: true, output: 'Verification skipped (non-UI changes only)' };
  }

  log.step(`Running live verification for issue #${issueNum}`);

  // Detect dev command
  let devCmd = config.devCommand;
  if (!devCmd) {
    const pkgJsonPath = join(worktree, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      const scripts = pkg.scripts ?? {};
      for (const name of ['dev', 'start', 'preview']) {
        if (scripts[name]) {
          devCmd = `pnpm ${name}`;
          break;
        }
      }
    }
  }

  if (!devCmd) {
    log.info('No dev/start/preview command found, skipping verification');
    return { passed: true, skipped: true, output: 'Verification skipped (no start command)' };
  }

  // Save screenshots to session directory
  const screenshotDir = join(sessionDir, 'screenshots', `issue-${issueNum}`);
  mkdirSync(screenshotDir, { recursive: true });

  // Get vision context
  const visionFile = join(process.cwd(), '.alpha-loop', 'vision.md');
  const visionContext = existsSync(visionFile) ? readFileSync(visionFile, 'utf-8') : '';

  // Load saved auth state if it exists
  const authStateDir = join(process.cwd(), '.alpha-loop', 'auth');
  if (existsSync(join(authStateDir, 'state.json'))) {
    log.info('Loading saved auth state...');
    exec(`playwright-cli state-load "${authStateDir}/state.json"`);
  }

  // Build the verification prompt — use plan instructions if available, otherwise generic
  const verifySteps = verifyInstructions
    ? `## Verification Steps (from plan)\n\n${verifyInstructions}`
    : `## Your Task

1. Start the dev server: \`${devCmd}\`
2. Read the server output to find what URL/port it starts on
3. Use playwright-cli to open the app and test the feature
4. When done, kill the dev server process`;

  const verifyPrompt = `You are a QA tester verifying that issue #${issueNum} was implemented correctly.

## Issue: ${title}

${body}

## What Changed
${diffStat.stdout || 'No diff available'}

${visionContext ? `## Product Vision\n${visionContext}\n` : ''}
${verifySteps}

### Playwright CLI Commands
- \`playwright-cli open <url>\` — Open the app
- \`playwright-cli snapshot\` — Get page structure with element refs
- \`playwright-cli click <ref>\` — Click an element
- \`playwright-cli type <text>\` — Type into focused element
- \`playwright-cli fill <ref> <text>\` — Fill a form field
- \`playwright-cli screenshot --path <file>\` — Take a screenshot
- \`playwright-cli console\` — Check browser console for errors
- \`playwright-cli network\` — Check network requests

### Screenshots
Save to: ${screenshotDir}

## Gate Result (REQUIRED)

After testing, write a JSON file to: verify-issue-${issueNum}.json

The file must contain ONLY valid JSON with this exact schema:

{
  "passed": true,
  "summary": "One-line summary of verification outcome",
  "findings": [
    {
      "severity": "critical",
      "description": "What failed or didn't work",
      "fixed": false,
      "file": "path/to/affected/file.ts"
    }
  ]
}

Rules:
- passed: true if the feature works as expected. false if there are failures.
- findings: list ALL checks performed, with severity and pass/fail status.
- If everything works, set passed=true with an empty findings array.
- If there are failures, set passed=false — the implementer will be sent back to fix them.

Also output a human-readable summary:

### Status: PASS or FAIL
### What Was Tested
### What Worked
### What Failed
### Console/Network Errors`;

  log.info(`Verification agent: ${config.agent} + playwright-cli`);

  const agentResult = await spawnAgent({
    agent: config.agent,
    model: config.model,
    prompt: verifyPrompt,
    cwd: worktree,
    logFile,
  });

  // Close any lingering playwright-cli browser sessions
  exec('playwright-cli close-all');

  const verifyOutput = agentResult.output;

  if (/Status:.*FAIL/i.test(verifyOutput)) {
    log.error('Live verification FAILED');
    return { passed: false, skipped: false, output: verifyOutput };
  } else if (/Status:.*PASS/i.test(verifyOutput)) {
    log.success('Live verification PASSED');
    return { passed: true, skipped: false, output: verifyOutput };
  } else if (agentResult.exitCode === 0) {
    log.success('Verification completed (agent exit 0)');
    return { passed: true, skipped: false, output: verifyOutput };
  } else {
    log.warn(`Verification unclear (agent exit ${agentResult.exitCode})`);
    return { passed: false, skipped: false, output: verifyOutput };
  }
}
