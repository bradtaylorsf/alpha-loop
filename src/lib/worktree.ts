/**
 * Worktree Manager — create and clean up isolated git worktrees.
 */
import { existsSync, mkdirSync, symlinkSync, readlinkSync, unlinkSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { exec } from './shell.js';
import { log } from './logger.js';

export type WorktreeResult = {
  path: string;
  branch: string;
};

export type SetupWorktreeOptions = {
  issueNum: number;
  projectDir: string;
  baseBranch: string;
  sessionBranch?: string;
  autoMerge?: boolean;
  skipInstall?: boolean;
  setupCommand?: string;
  dryRun?: boolean;
};

export type CleanupWorktreeOptions = {
  issueNum: number;
  projectDir: string;
  autoCleanup?: boolean;
  dryRun?: boolean;
};

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

/**
 * Create an isolated git worktree for processing an issue.
 * When autoMerge is enabled and a session branch exists,
 * branches from session branch so changes stack across issues.
 */
export async function setupWorktree(options: SetupWorktreeOptions): Promise<WorktreeResult> {
  const { issueNum, projectDir, baseBranch, sessionBranch, autoMerge, skipInstall, setupCommand, dryRun } = options;
  const branch = `agent/issue-${issueNum}`;
  const worktreesDir = resolve(projectDir, '.worktrees');
  mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = resolve(worktreesDir, `issue-${issueNum}`);

  log.info(`Creating worktree at ${worktreePath} (branch: ${branch})`);

  if (dryRun) {
    log.dry(`Would create worktree: ${worktreePath}`);
    return { path: worktreePath, branch };
  }

  // Clean up existing worktree if present
  if (existsSync(worktreePath)) {
    log.warn(`Worktree already exists at ${worktreePath}, removing...`);
    exec(`git worktree remove "${worktreePath}" --force`, { cwd: projectDir });
  }

  // Delete local branch from previous runs (may exist even without worktree)
  exec(`git branch -D "${branch}"`, { cwd: projectDir });

  // Delete remote branch from previous failed runs
  exec(`git push origin --delete "${branch}"`, { cwd: projectDir });

  // Determine source branch: use session branch when auto-merging and it exists
  let fromBranch = baseBranch;
  if (autoMerge && sessionBranch && sessionBranch !== baseBranch) {
    const remoteCheck = exec(`git rev-parse --verify "origin/${sessionBranch}"`, { cwd: projectDir });
    const localCheck = exec(`git rev-parse --verify "${sessionBranch}"`, { cwd: projectDir });
    if (remoteCheck.exitCode === 0 || localCheck.exitCode === 0) {
      fromBranch = sessionBranch;
    }
  }

  // Fetch latest
  exec('git fetch origin', { cwd: projectDir });

  // Create worktree from the appropriate branch (try origin/ first, fall back to local)
  log.info(`Branching worktree from: ${fromBranch}`);
  const remoteResult = exec(
    `git worktree add "${worktreePath}" -b "${branch}" "origin/${fromBranch}"`,
    { cwd: projectDir },
  );
  if (remoteResult.exitCode !== 0) {
    const localResult = exec(
      `git worktree add "${worktreePath}" -b "${branch}" "${fromBranch}"`,
      { cwd: projectDir },
    );
    if (localResult.exitCode !== 0) {
      throw new Error(`Failed to create worktree from ${fromBranch}: ${localResult.stderr}`);
    }
    log.info(`Created worktree from local ${fromBranch}`);
  } else {
    log.info(`Created worktree from origin/${fromBranch}`);
  }

  // Symlink env files from main repo to worktree (gitignored files don't exist in worktrees)
  for (const envFile of ENV_FILES) {
    const src = join(projectDir, envFile);
    const dest = join(worktreePath, envFile);
    if (existsSync(src)) {
      // Remove existing file/symlink if present
      if (existsSync(dest)) {
        try { unlinkSync(dest); } catch { /* ignore */ }
      }
      symlinkSync(src, dest);
      log.info(`Symlinked ${envFile} to worktree`);
    }
  }

  // Set COMPOSE_PROJECT_NAME so Docker doesn't use "issue-N" as project name
  ensureComposeProjectName(worktreePath, projectDir);

  // Install dependencies unless skipped
  if (!skipInstall) {
    log.info('Installing dependencies in worktree...');
    const installResult = exec('pnpm install --frozen-lockfile', { cwd: worktreePath });
    if (installResult.exitCode !== 0) {
      // Fall back to regular install
      const fallback = exec('pnpm install', { cwd: worktreePath });
      if (fallback.exitCode !== 0) {
        log.warn('pnpm install had issues, continuing anyway...');
      }
    }
  }

  // Run custom setup command (e.g., Python venv, Ruby bundler, Go modules)
  if (setupCommand) {
    log.info(`Running setup command: ${setupCommand}`);
    const setupResult = exec(setupCommand, { cwd: worktreePath });
    if (setupResult.exitCode !== 0) {
      log.warn(`Setup command failed (exit ${setupResult.exitCode}), continuing anyway...`);
    }
  }

  log.info(`Worktree ready at ${worktreePath}`);
  return { path: worktreePath, branch };
}

/**
 * Remove a worktree. Keeps the branch (needed for PR).
 */
export async function cleanupWorktree(options: CleanupWorktreeOptions): Promise<void> {
  const { issueNum, projectDir, autoCleanup = true, dryRun } = options;
  const worktreePath = resolve(projectDir, '.worktrees', `issue-${issueNum}`);

  if (!autoCleanup) {
    log.info('Skipping worktree cleanup (autoCleanup=false)');
    return;
  }

  if (dryRun) {
    log.dry(`Would clean up worktree: ${worktreePath}`);
    return;
  }

  if (existsSync(worktreePath)) {
    log.info(`Removing worktree: ${worktreePath}`);
    const result = exec(`git worktree remove "${worktreePath}" --force`, { cwd: projectDir });
    if (result.exitCode !== 0) {
      log.warn('Could not remove worktree cleanly, forcing...');
      exec(`rm -rf "${worktreePath}"`, { cwd: projectDir });
      exec('git worktree prune', { cwd: projectDir });
    }
  }

  log.info('Worktree cleaned up');
}

/**
 * Ensure COMPOSE_PROJECT_NAME is set in the worktree's .env file
 * so Docker Compose doesn't use the worktree directory name (e.g., "issue-2")
 * as the project name for containers.
 */
function ensureComposeProjectName(worktreePath: string, projectDir: string): void {
  const repoName = basename(projectDir);
  const envPath = join(worktreePath, '.env');

  // Check if .env already has COMPOSE_PROJECT_NAME
  if (existsSync(envPath)) {
    // If it's a symlink, we can't modify it — check if the source has the var
    try {
      readlinkSync(envPath);
      // It's a symlink — check if the source .env already has COMPOSE_PROJECT_NAME
      const content = readFileSync(envPath, 'utf-8');
      if (content.includes('COMPOSE_PROJECT_NAME')) return;
      // Source doesn't have it — create a .env.compose override instead
      const composePath = join(worktreePath, '.env.compose');
      writeFileSync(composePath, `COMPOSE_PROJECT_NAME=${repoName}\n`);
      log.info(`Set COMPOSE_PROJECT_NAME=${repoName} in .env.compose`);
      return;
    } catch {
      // Not a symlink — safe to check/append
      const content = readFileSync(envPath, 'utf-8') ?? '';
      if (content.includes('COMPOSE_PROJECT_NAME')) return;
      appendFileSync(envPath, `\nCOMPOSE_PROJECT_NAME=${repoName}\n`);
      log.info(`Added COMPOSE_PROJECT_NAME=${repoName} to .env`);
      return;
    }
  }

  // No .env at all — create one with just COMPOSE_PROJECT_NAME
  writeFileSync(envPath, `COMPOSE_PROJECT_NAME=${repoName}\n`);
  log.info(`Created .env with COMPOSE_PROJECT_NAME=${repoName}`);
}
