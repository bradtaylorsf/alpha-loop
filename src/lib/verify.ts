/**
 * Live Verification — start the app, use playwright-cli to test it like a real user.
 *
 * This is NOT running E2E test suites. This is an AI agent using playwright-cli
 * to interactively verify that the implemented feature actually works by:
 * 1. Starting the dev server
 * 2. Opening the app in a browser via playwright-cli
 * 3. Navigating, clicking, typing, taking screenshots
 * 4. Reporting PASS or FAIL
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from './shell.js';
import { log } from './logger.js';
import { spawnAgent } from './agent.js';
import type { Config } from './config.js';

export type VerifyResult = {
  passed: boolean;
  output: string;
};

/**
 * Run live verification using playwright-cli.
 * Starts the app, sends agent to test it, returns result.
 */
export async function runVerify(options: {
  worktree: string;
  logFile: string;
  issueNum: number;
  title: string;
  body: string;
  config: Config;
  sessionDir: string;
}): Promise<VerifyResult> {
  const { worktree, logFile, issueNum, title, body, config, sessionDir } = options;

  if (config.skipVerify) {
    log.info('Verification skipped (skipVerify=true)');
    return { passed: true, output: 'Verification skipped' };
  }

  if (config.dryRun) {
    log.dry('Would run live verification');
    return { passed: true, output: 'Verification skipped (dry run)' };
  }

  log.step(`Running live verification for issue #${issueNum}`);

  // Check if playwright-cli is available
  const whichResult = exec('which playwright-cli');
  if (whichResult.exitCode !== 0) {
    log.warn('playwright-cli not installed. Install with: npm install -g @anthropic-ai/claude-code');
    log.info('Skipping live verification (no playwright-cli)');
    return { passed: true, output: 'Verification skipped (playwright-cli not installed)' };
  }

  // Detect how to start the app
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
    return { passed: true, output: 'Verification skipped (no start command)' };
  }

  const port = config.port || 3000;

  // Start the app in the background
  log.info(`Starting app with '${devCmd}' on port ${port}...`);
  const { spawn } = await import('node:child_process');
  const appProcess = spawn('sh', ['-c', `PORT=${port} ${devCmd}`], {
    cwd: worktree,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  const appPid = appProcess.pid;

  // Wait for app to be ready (up to 60s)
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const check = exec(`curl -s -o /dev/null http://localhost:${port}`);
    if (check.exitCode === 0) {
      ready = true;
      break;
    }
    // Check if process is still alive
    try {
      process.kill(appPid!, 0);
    } catch {
      log.error('App process exited before becoming ready');
      return { passed: false, output: 'App failed to start' };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    log.error(`App did not become ready on port ${port} within 60s`);
    killProcess(appPid!);
    return { passed: false, output: `App failed to start on port ${port}` };
  }

  log.success(`App is ready on port ${port}`);

  // Load saved auth state if it exists
  const authStateDir = join(process.cwd(), '.alpha-loop', 'auth');
  if (existsSync(join(authStateDir, 'state.json'))) {
    log.info('Loading saved auth state...');
    exec(`playwright-cli state-load "${authStateDir}/state.json"`);
  }

  // Save screenshots to session directory
  const screenshotDir = join(sessionDir, 'screenshots', `issue-${issueNum}`);
  mkdirSync(screenshotDir, { recursive: true });

  // Get the diff to understand what changed
  const diffStat = exec(`git diff --stat "origin/${config.baseBranch}...HEAD"`, { cwd: worktree });

  // Get vision context
  const visionFile = join(process.cwd(), '.alpha-loop', 'vision.md');
  const visionContext = existsSync(visionFile) ? readFileSync(visionFile, 'utf-8') : '';

  // Build the verification prompt
  const verifyPrompt = `You are a QA tester verifying that issue #${issueNum} was implemented correctly.

## Issue: ${title}

${body}

## What Changed
${diffStat.stdout || 'No diff available'}

${visionContext ? `## Product Vision\n${visionContext}\n` : ''}
## Your Task

The app is running at http://localhost:${port}. Use the playwright-cli to test it.

### Playwright CLI Commands Available
- \`playwright-cli open http://localhost:${port}\` — Open the app in a browser
- \`playwright-cli goto <url>\` — Navigate to a page
- \`playwright-cli snapshot\` — Get a snapshot of the current page with element refs
- \`playwright-cli click <ref>\` — Click an element (use ref from snapshot, e.g. \`e15\`)
- \`playwright-cli type <text>\` — Type text into the focused element
- \`playwright-cli screenshot --path <file>\` — Take a screenshot and save to file
- \`playwright-cli fill <ref> <text>\` — Fill a form field
- \`playwright-cli select <ref> <value>\` — Select a dropdown option
- \`playwright-cli wait <selector>\` — Wait for an element to appear
- \`playwright-cli console\` — Check browser console for errors
- \`playwright-cli network\` — Check network requests/responses

### Testing Steps

1. Open the app: \`playwright-cli open http://localhost:${port}\`
2. Take a snapshot to see the page structure: \`playwright-cli snapshot\`
3. Navigate to the feature that was changed
4. Test the ACTUAL user flow described in the issue:
   - Can you do what the issue says should work?
   - Does the UI render correctly?
   - Do form submissions work end-to-end?
   - Check console for errors: \`playwright-cli console\`
   - Check network for failed requests: \`playwright-cli network\`
5. Take screenshots at key states (save to the screenshot directory below)
6. Check for functional gaps:
   - Is the backend wired to the frontend?
   - Are there UI elements that don't respond?
   - Does data persist after submission?

### Auth / Login
${existsSync(authStateDir) ? 'Auth state is pre-loaded. If you need to log in, use the credentials from the environment or .env file.' : 'No auth state saved.'}

## Report

After testing, output a verification report:

### Status: PASS or FAIL

### What Was Tested
- (list each action you took with playwright-cli)

### What Worked
- (list what functioned correctly)

### What Failed
- (list what didn't work, with details and screenshots)

### Console Errors
- (any browser console errors found)

### Network Issues
- (any failed API calls or missing endpoints)

### Gaps Found
- (any disconnects between frontend and backend, missing pieces, etc.)

### Screenshots
Save screenshots to this directory: ${screenshotDir}
Use descriptive filenames:
- \`playwright-cli screenshot --path "${screenshotDir}/01-initial-load.png"\`
- \`playwright-cli screenshot --path "${screenshotDir}/02-after-action.png"\`
- \`playwright-cli screenshot --path "${screenshotDir}/03-final-state.png"\`

IMPORTANT: Use playwright-cli commands to actually interact with the app.
Navigate, click, type, submit forms. Verify the feature works as a real user would use it.`;

  log.info(`Verification agent: claude + playwright-cli | Testing live at http://localhost:${port}`);

  // Run the verification agent
  const agentResult = await spawnAgent({
    agent: 'claude',
    model: config.model,
    prompt: verifyPrompt,
    cwd: worktree,
    logFile,
  });

  const verifyOutput = agentResult.output;

  // Kill the app process
  log.info('Shutting down app...');
  killProcess(appPid!);

  // Close playwright-cli browser sessions
  exec('playwright-cli close-all');

  // Check if verification passed based on agent output
  if (/Status:.*FAIL/i.test(verifyOutput)) {
    log.error('Live verification FAILED');
    return { passed: false, output: verifyOutput };
  } else if (/Status:.*PASS/i.test(verifyOutput)) {
    log.success('Live verification PASSED');
    return { passed: true, output: verifyOutput };
  } else if (agentResult.exitCode === 0) {
    log.success('Verification completed (agent exit 0)');
    return { passed: true, output: verifyOutput };
  } else {
    log.warn(`Verification unclear (agent exit ${agentResult.exitCode})`);
    return { passed: false, output: verifyOutput };
  }
}

function killProcess(pid: number): void {
  try {
    // Kill process group (negative pid)
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process already dead
    }
  }
}
