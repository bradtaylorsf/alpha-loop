import { commandExists, execAsync } from './shell.js';

export interface PrerequisiteConfig {
  agent: string; // e.g. 'claude', 'codex', 'opencode'
}

const AGENT_INSTALL_URLS: Record<string, string> = {
  claude: 'https://claude.ai/code',
  codex: 'https://github.com/openai/codex',
  opencode: 'https://github.com/sst/opencode',
  // lmstudio/ollama re-use the claude/codex CLIs at runtime; install URLs
  // point users at the local model server setup.
  lmstudio: 'https://lmstudio.ai/',
  ollama: 'https://ollama.com/',
};

export class PrerequisiteError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join('\n'));
    this.name = 'PrerequisiteError';
  }
}

/**
 * Verify required tools are installed: gh, git, and the configured agent CLI.
 * Throws PrerequisiteError with all failures if any checks fail.
 */
export async function checkPrerequisites(config: PrerequisiteConfig): Promise<void> {
  const errors: string[] = [];

  // Check git
  if (!commandExists('git')) {
    errors.push('git not found. Please install git.');
  } else {
    // Check we're in a git repo
    const gitCheck = await execAsync('git rev-parse --git-dir');
    if (gitCheck.exitCode !== 0) {
      errors.push('Not in a git repository.');
    }
  }

  // Check gh CLI
  if (!commandExists('gh')) {
    errors.push('gh CLI not found. Install: https://cli.github.com/');
  } else {
    // Check gh auth
    const authCheck = await execAsync('gh auth status');
    if (authCheck.exitCode !== 0) {
      errors.push('gh not authenticated. Run: gh auth login');
    }
  }

  // Check agent CLI. lmstudio/ollama piggy-back on the claude/codex CLIs, so
  // check those instead of looking for a literal "lmstudio" binary.
  const agent = config.agent;
  const cliCommand = agent === 'lmstudio' ? 'claude'
    : agent === 'ollama' ? 'codex'
    : agent;
  if (!commandExists(cliCommand)) {
    const installUrl = AGENT_INSTALL_URLS[agent] ?? '';
    const installHint = installUrl ? ` Install: ${installUrl}` : '';
    errors.push(`${cliCommand} CLI not found (required by agent "${agent}").${installHint}`);
  }

  if (errors.length > 0) {
    throw new PrerequisiteError(errors);
  }
}
