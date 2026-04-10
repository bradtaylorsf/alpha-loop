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
  /** True if the worktree was recovered from a previous session instead of created fresh. */
  resumed: boolean;
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
  preserveIfCommits?: boolean;
  dryRun?: boolean;
};

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

/**
 * Create an isolated git worktree for processing an issue.
 * When autoMerge is enabled and a session branch exists,
 * branches from session branch so changes stack across issues.
 *
 * Handles three resume scenarios:
 * 1. Worktree directory + branch exist → reuse as-is (resume previous work)
 * 2. Branch exists but directory was removed → recreate worktree from existing branch
 * 3. Neither exists → create fresh worktree and branch
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
    return { path: worktreePath, branch, resumed: false };
  }

  let resumed = false;

  // --- Case 1: Worktree directory exists — check if we can reuse it ---
  if (existsSync(worktreePath)) {
    const branchCheck = exec('git rev-parse --abbrev-ref HEAD', { cwd: worktreePath });
    if (branchCheck.exitCode === 0 && branchCheck.stdout.trim() === branch) {
      const commitCount = worktreeHasCommits(worktreePath);
      log.info(`Reusing existing worktree at ${worktreePath} (${commitCount} commit(s) from previous session)`);
      resumed = true;
    } else {
      // Worktree exists but on wrong branch or broken — remove and recreate
      log.warn(`Worktree at ${worktreePath} is on wrong branch, removing...`);
      exec(`git worktree remove "${worktreePath}" --force`, { cwd: projectDir });
      exec('git worktree prune', { cwd: projectDir });
    }
  }

  // --- Case 2: No worktree dir but branch exists (e.g., dir was rm -rf'd but branch persists) ---
  if (!resumed && !existsSync(worktreePath)) {
    // Prune first so git doesn't think the branch is still checked out in a deleted worktree
    exec('git worktree prune', { cwd: projectDir });

    const localBranchCheck = exec(`git rev-parse --verify "${branch}"`, { cwd: projectDir });
    if (localBranchCheck.exitCode === 0) {
      log.info(`Found existing branch ${branch}, recreating worktree from it (resuming previous work)`);
      const reuseResult = exec(`git worktree add "${worktreePath}" "${branch}"`, { cwd: projectDir });
      if (reuseResult.exitCode === 0) {
        const commitCount = worktreeHasCommits(worktreePath);
        log.info(`Resumed worktree with ${commitCount} commit(s)`);
        resumed = true;
      } else {
        // Can't reuse — force-delete branch and fall through to fresh creation
        log.warn(`Could not reuse branch ${branch}: ${reuseResult.stderr}`);
        exec(`git branch -D "${branch}"`, { cwd: projectDir });
        exec('git worktree prune', { cwd: projectDir });
      }
    }
  }

  // --- Case 3: Fresh creation (no existing worktree or branch) ---
  if (!resumed) {
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
  }

  // --- Post-creation setup (runs for both fresh and resumed worktrees) ---

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

  log.info(`Worktree ready at ${worktreePath}${resumed ? ' (resumed)' : ''}`);
  return { path: worktreePath, branch, resumed };
}

/**
 * Check if a worktree branch has commits ahead of its fork point.
 * Uses git's merge-base to find where the branch diverged from any known remote branch.
 * Returns the count of commits that would be lost if the worktree were removed.
 */
export function worktreeHasCommits(worktreePath: string): number {
  if (!existsSync(worktreePath)) return 0;
  // Find the fork point: where this branch diverged from its nearest remote ancestor
  const forkPoint = exec('git merge-base --fork-point HEAD @{upstream} 2>/dev/null', { cwd: worktreePath });
  const base = forkPoint.exitCode === 0 && forkPoint.stdout.trim()
    ? forkPoint.stdout.trim()
    // Fallback: find merge-base with origin/HEAD or origin/main
    : exec('git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null', { cwd: worktreePath }).stdout.trim();
  if (!base) return 0;
  const result = exec(`git rev-list --count "${base}..HEAD"`, { cwd: worktreePath });
  return parseInt(result.stdout.trim(), 10) || 0;
}

/**
 * Remove a worktree. Keeps the branch (needed for PR).
 * When preserveIfCommits is true and the worktree has commits, skip cleanup
 * so the user can recover the work with `alpha-loop resume`.
 */
export async function cleanupWorktree(options: CleanupWorktreeOptions): Promise<void> {
  const { issueNum, projectDir, autoCleanup = true, preserveIfCommits = false, dryRun } = options;
  const worktreePath = resolve(projectDir, '.worktrees', `issue-${issueNum}`);

  if (!autoCleanup) {
    log.info('Skipping worktree cleanup (autoCleanup=false)');
    return;
  }

  if (dryRun) {
    log.dry(`Would clean up worktree: ${worktreePath}`);
    return;
  }

  if (preserveIfCommits && existsSync(worktreePath)) {
    const commitCount = worktreeHasCommits(worktreePath);
    if (commitCount > 0) {
      log.warn(`Preserving worktree with ${commitCount} commit(s) at: ${worktreePath}`);
      log.warn('Recover with: alpha-loop resume');
      return;
    }
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
