import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { exec, run } from '../lib/shell.js';
import { loadConfig } from '../lib/config.js';
import { log } from '../lib/logger.js';

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

export async function authCommand(): Promise<void> {
  // Check for playwright-cli
  const whichResult = exec('which playwright-cli');
  if (whichResult.exitCode !== 0) {
    log.error('playwright-cli not installed. Install with: npm install -g @playwright/cli@latest');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const projectDir = process.cwd();
  const authDir = path.join(projectDir, '.alpha-loop', 'auth');
  fs.mkdirSync(authDir, { recursive: true });

  console.log('');
  console.log('\x1b[1m\x1b[36mSave authenticated browser state\x1b[0m');
  console.log('');
  console.log('This will open a browser. Log in to your app, then the state');
  console.log('(cookies, localStorage, sessions) will be saved for future');
  console.log('verification runs.');
  console.log('');

  const defaultUrl = `http://localhost:3000`;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const customUrl = await ask(rl, `App URL [${defaultUrl}]: `);
    const appUrl = customUrl || defaultUrl;

    console.log('');
    console.log(`Opening browser at ${appUrl}...`);
    console.log('Log in, then come back here and press Enter to save state.');
    console.log('');

    // Open browser in background
    const browserPromise = run('playwright-cli', ['open', appUrl, '--headed', '--persistent']);

    await ask(rl, 'Press Enter after you\'ve logged in... ');

    // Save browser state
    const saveResult = exec(`playwright-cli state-save "${authDir}/state.json"`);
    if (saveResult.exitCode !== 0) {
      log.warn('Could not save state via playwright-cli, trying cookie export...');
      exec(`playwright-cli cookie-export "${authDir}/cookies.json"`);
      exec(`playwright-cli localstorage-export "${authDir}/localstorage.json"`);
    }

    // Close browser
    exec('playwright-cli close-all');
    // Also wait for the background process to finish (it may already be done)
    await Promise.race([browserPromise, new Promise((r) => setTimeout(r, 2000))]);

    const stateExists = fs.existsSync(path.join(authDir, 'state.json'));
    const cookiesExist = fs.existsSync(path.join(authDir, 'cookies.json'));

    if (stateExists || cookiesExist) {
      log.success(`Auth state saved to ${authDir}`);
      console.log('');
      console.log('Future verification runs will load this state automatically.');
      console.log("Re-run 'auth' if your session expires.");

      // Add to .gitignore
      ensureGitignore(projectDir);
    } else {
      log.error('Failed to save auth state');
      process.exitCode = 1;
    }
  } finally {
    rl.close();
  }
}

function ensureGitignore(projectDir: string): void {
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '.alpha-loop/auth/\n');
    log.info('Created .gitignore with .alpha-loop/auth/');
    return;
  }

  const content = fs.readFileSync(gitignorePath, 'utf-8');
  if (!content.includes('.alpha-loop/auth')) {
    fs.appendFileSync(gitignorePath, '\n.alpha-loop/auth/\n');
    log.info('Added .alpha-loop/auth/ to .gitignore');
  }
}
