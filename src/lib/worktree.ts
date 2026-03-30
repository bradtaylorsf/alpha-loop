/**
 * Worktree Manager — create and clean up isolated git worktrees.
 */
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exec } from './shell.js';
import * as logger from './logger.js';

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
  const { issueNum, projectDir, baseBranch, sessionBranch, autoMerge, skipInstall, dryRun } = options;
  const branch = `agent/issue-${issueNum}`;
  const worktreesDir = resolve(projectDir, '.worktrees');
  mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = resolve(worktreesDir, `issue-${issueNum}`);

  logger.info(`Creating worktree at ${worktreePath} (branch: ${branch})`);

  if (dryRun) {
    logger.dry(`Would create worktree: ${worktreePath}`);
    return { path: worktreePath, branch };
  }

  // Clean up existing worktree if present
  if (existsSync(worktreePath)) {
    logger.warn(`Worktree already exists at ${worktreePath}, removing...`);
    exec(`git worktree remove "${worktreePath}" --force`, { cwd: projectDir });
    exec(`git branch -D "${branch}"`, { cwd: projectDir });
  }

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
  logger.info(`Branching worktree from: ${fromBranch}`);
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
    logger.info(`Created worktree from local ${fromBranch}`);
  } else {
    logger.info(`Created worktree from origin/${fromBranch}`);
  }

  // Copy env files from main repo to worktree (gitignored files don't exist in worktrees)
  for (const envFile of ENV_FILES) {
    const src = join(projectDir, envFile);
    if (existsSync(src)) {
      copyFileSync(src, join(worktreePath, envFile));
      logger.info(`Copied ${envFile} to worktree`);
    }
  }

  // Install dependencies unless skipped
  if (!skipInstall) {
    logger.info('Installing dependencies in worktree...');
    const installResult = exec('pnpm install --frozen-lockfile', { cwd: worktreePath });
    if (installResult.exitCode !== 0) {
      // Fall back to regular install
      const fallback = exec('pnpm install', { cwd: worktreePath });
      if (fallback.exitCode !== 0) {
        logger.warn('pnpm install had issues, continuing anyway...');
      }
    }
  }

  logger.info(`Worktree ready at ${worktreePath}`);
  return { path: worktreePath, branch };
}

/**
 * Remove a worktree. Keeps the branch (needed for PR).
 */
export async function cleanupWorktree(options: CleanupWorktreeOptions): Promise<void> {
  const { issueNum, projectDir, autoCleanup = true, dryRun } = options;
  const worktreePath = resolve(projectDir, '.worktrees', `issue-${issueNum}`);

  if (!autoCleanup) {
    logger.info('Skipping worktree cleanup (autoCleanup=false)');
    return;
  }

  if (dryRun) {
    logger.dry(`Would clean up worktree: ${worktreePath}`);
    return;
  }

  if (existsSync(worktreePath)) {
    logger.info(`Removing worktree: ${worktreePath}`);
    const result = exec(`git worktree remove "${worktreePath}" --force`, { cwd: projectDir });
    if (result.exitCode !== 0) {
      logger.warn('Could not remove worktree cleanly, forcing...');
      exec(`rm -rf "${worktreePath}"`, { cwd: projectDir });
      exec('git worktree prune', { cwd: projectDir });
    }
  }

  logger.info('Worktree cleaned up');
}
