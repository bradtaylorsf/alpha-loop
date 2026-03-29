import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

// --- Types ---

export interface WorktreeOptions {
  baseBranch?: string;
  installDeps?: boolean;
  repoRoot?: string;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  issueNumber: number;
}

// --- Helpers ---

export function worktreePath(repoRoot: string, issueNumber: number): string {
  return resolve(dirname(repoRoot), `issue-${issueNumber}`);
}

export function branchName(issueNumber: number): string {
  return `agent/issue-${issueNumber}`;
}

function exec(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function branchExistsLocally(branch: string, cwd?: string): boolean {
  try {
    exec(`git rev-parse --verify refs/heads/${branch}`, cwd);
    return true;
  } catch {
    return false;
  }
}

function branchExistsRemotely(branch: string, cwd?: string): boolean {
  try {
    exec(`git ls-remote --heads origin ${branch}`, cwd);
    const output = exec(`git ls-remote --heads origin ${branch}`, cwd);
    return output.length > 0;
  } catch {
    return false;
  }
}

function worktreeExists(wtPath: string, cwd?: string): boolean {
  try {
    const list = exec("git worktree list --porcelain", cwd);
    return list.includes(`worktree ${wtPath}`);
  } catch {
    return false;
  }
}

// --- Public API ---

export function createWorktree(
  issueNumber: number,
  options: WorktreeOptions = {},
): WorktreeResult {
  const { baseBranch = "main", installDeps = true } = options;
  const repoRoot = options.repoRoot ?? exec("git rev-parse --show-toplevel");
  const wtPath = worktreePath(repoRoot, issueNumber);
  const branch = branchName(issueNumber);

  try {
    // Clean up existing worktree if present
    if (worktreeExists(wtPath, repoRoot) || existsSync(wtPath)) {
      removeWorktree(issueNumber, { repoRoot });
    }

    // Delete existing local branch if it exists
    if (branchExistsLocally(branch, repoRoot)) {
      exec(`git branch -D ${branch}`, repoRoot);
    }

    // Delete existing remote branch if it exists
    if (branchExistsRemotely(branch, repoRoot)) {
      exec(`git push origin --delete ${branch}`, repoRoot);
    }

    // Create the worktree with a new branch from the base
    exec(
      `git worktree add -b ${branch} ${wtPath} ${baseBranch}`,
      repoRoot,
    );

    // Install dependencies if configured
    if (installDeps) {
      exec("pnpm install", wtPath);
    }

    return { path: wtPath, branch, issueNumber };
  } catch (error) {
    // Clean up on error — no orphaned worktrees
    try {
      removeWorktree(issueNumber, { repoRoot });
    } catch {
      // Best-effort cleanup
    }
    throw error;
  }
}

export function removeWorktree(
  issueNumber: number,
  options: Pick<WorktreeOptions, "repoRoot"> = {},
): void {
  const repoRoot =
    options.repoRoot ?? exec("git rev-parse --show-toplevel");
  const wtPath = worktreePath(repoRoot, issueNumber);

  if (worktreeExists(wtPath, repoRoot)) {
    exec(`git worktree remove --force ${wtPath}`, repoRoot);
  } else if (existsSync(wtPath)) {
    // Directory exists but not registered — force remove then prune
    exec(`rm -rf ${wtPath}`);
    exec("git worktree prune", repoRoot);
  }
}
