import { existsSync, writeFileSync } from 'node:fs';
import { detectRepo } from '../lib/config.js';
import { log } from '../lib/logger.js';

const CONFIG_FILE = '.alpha-loop.yaml';

function configTemplate(repo: string): string {
  return `# Alpha Loop configuration
repo: ${repo}
project: 3
model: opus
review_model: opus
max_turns: 30
label: ready
merge_strategy: session
test_command: pnpm test
dev_command: pnpm dev
port: 3000
`;
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
}
