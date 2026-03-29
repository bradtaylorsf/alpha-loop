/**
 * Git Worktree Manager
 * ====================
 *
 * Manages git worktrees for session and task isolation.
 *
 * Session Worktrees (temporary):
 *   Location: ~/.alphaagent/worktrees/{projectId}/session-{sessionId}-{type}/
 *   Lifecycle: Created at session start, removed at session end
 *   Use case: Isolated environment for single session execution
 *
 * Task Worktrees (persistent):
 *   Location: ~/.alphaagent/worktrees/{projectId}/task-{taskId}-{slug}/
 *   Lifecycle: Created when task enters PLANNING, removed when DONE or deleted
 *   Use case: Persistent workspace across multiple sessions for same task
 *
 * Benefits:
 * - Total isolation: User's working directory is never touched by sessions/tasks
 * - Concurrent sessions: Multiple sessions can run simultaneously on same project
 * - Persistent task work: Task progress preserved across sessions
 * - Clean state: Each worktree starts with clean checkout
 * - Safe merges: Merge operations don't affect user's current branch
 *
 * @see https://git-scm.com/docs/git-worktree
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, mkdir, rm, copyFile, readdir, stat, readFile, constants } from 'fs/promises';
import { join, relative } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('WorktreeManager');

/**
 * Dangerous patterns that could be exploited in git commands
 * These patterns could be used for command injection or path traversal
 */
const DANGEROUS_GIT_PATTERNS = [
  /^-/, // Starts with hyphen (could be interpreted as flag)
  /\.\./, // Directory traversal
  /^refs\//i, // Git internal paths
  /^HEAD$/i, // Reserved git name
  /[\x00-\x1f]/, // Control characters
  /[<>:"|?*\\]/, // Characters invalid in paths on Windows
];

/**
 * Files that should not be copied from worktrees to working directory.
 * These are typically temporary/session-specific files that shouldn't be synced.
 */
const COPY_EXCLUDED_FILES = [
  '.agent-session.lock',
  '.claude-session.lock',
  '.session.lock',
];

/**
 * Check if a name is safe for use in git branch names and file paths
 *
 * @param name - The name to validate
 * @returns true if safe, false if potentially dangerous
 */
export function isGitSafeName(name: string): boolean {
  if (!name || name.length === 0) return false;

  for (const pattern of DANGEROUS_GIT_PATTERNS) {
    if (pattern.test(name)) {
      logger.warn('Rejected unsafe git name', { name, pattern: pattern.toString() });
      return false;
    }
  }

  return true;
}

/**
 * Sanitize session type for use in branch names and paths
 *
 * Task 3.1: Add sessionType Sanitization
 *
 * Removes or replaces characters that could cause issues in:
 * - Git branch names
 * - File system paths
 * - Shell commands
 *
 * Security: Uses underscore instead of hyphen to prevent flag injection
 *
 * @param sessionType - Raw session type from database
 * @returns Sanitized session type safe for use in paths and branches
 */
export function sanitizeSessionType(sessionType: string): string {
  const sanitized = sessionType
    // Replace any characters that aren't alphanumeric or underscore (NO hyphens for safety)
    .replace(/[^a-zA-Z0-9_]/g, '_')
    // Replace multiple underscores with single
    .replace(/_+/g, '_')
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '')
    // Limit length
    .slice(0, 30)
    // Ensure it's not empty
    || 'unknown';

  // Add prefix if it somehow starts with a dangerous character
  if (sanitized.startsWith('-')) {
    return 'session_' + sanitized;
  }

  return sanitized;
}

/**
 * Retry configuration for worktree operations
 *
 * Task 3.2: Add Worktree Creation Retry Logic
 */
const RETRY_CONFIG = {
  /** Maximum number of retry attempts */
  maxAttempts: 3,
  /** Base delay in ms (doubles with each retry) */
  baseDelayMs: 500,
  /** Errors that are worth retrying */
  retryableErrors: [
    'fatal: cannot lock ref',
    'another git process seems to be running',
    'Unable to create',
    '.lock: File exists',
  ],
};

/**
 * Check if an error is retryable
 */
function isRetryableError(errorMessage: string): boolean {
  return RETRY_CONFIG.retryableErrors.some((pattern) =>
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Environment files that should be copied to worktrees
 * These are typically gitignored but needed for the app to run
 */
const ENV_FILES_TO_COPY = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
];

/**
 * Worktree information from git worktree list --porcelain
 */
export interface WorktreeInfo {
  /** Absolute path to worktree directory */
  path: string;
  /** Current HEAD commit SHA */
  head: string;
  /** Branch name (null if detached HEAD) */
  branch: string | null;
  /** Whether worktree is locked */
  locked: boolean;
  /** Lock reason if locked */
  lockReason?: string;
  /** Whether worktree is prunable (stale) */
  prunable: boolean;
}

/**
 * Result of creating a session worktree
 */
export interface CreateWorktreeResult {
  success: boolean;
  /** Absolute path to created worktree */
  worktreePath?: string;
  /** Branch name used for the worktree */
  branchName?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of worktree operations
 */
export interface WorktreeOperationResult {
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Result of removing a worktree
 */
export interface RemoveWorktreeResult extends WorktreeOperationResult {}

/**
 * Result of copying changes from worktree to working directory
 */
export interface CopyChangesResult {
  success: boolean;
  /** List of files that were copied */
  copiedFiles: string[];
  /** Target directory where files were copied */
  targetPath: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Information about a changed file in a worktree
 */
export interface ChangedFile {
  /** Relative path to the file */
  path: string;
  /** Git status of the file */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
}

/**
 * Get the base directory for all AlphaAgent data
 * @returns Path to ~/.alphaagent
 */
export function getAlphaAgentBaseDir(): string {
  return join(homedir(), '.alphaagent');
}

/**
 * Get the base directory for all worktrees
 * @returns Path to ~/.alphaagent/worktrees
 */
export function getWorktreesBaseDir(): string {
  return join(getAlphaAgentBaseDir(), 'worktrees');
}

/**
 * Get the worktree directory for a specific project
 *
 * @param projectId - Project ID from database
 * @returns Path to ~/.alphaagent/worktrees/{projectId}
 */
export function getProjectWorktreeDir(projectId: number): string {
  return join(getWorktreesBaseDir(), String(projectId));
}

/**
 * Get the full worktree path for a specific session
 *
 * @param projectId - Project ID from database
 * @param sessionId - Session ID
 * @param sessionType - Session type (coding, review, etc.) - will be sanitized
 * @returns Full path to ~/.alphaagent/worktrees/{projectId}/session-{sessionId}-{type}
 */
export function getSessionWorktreePath(
  projectId: number,
  sessionId: number,
  sessionType: string
): string {
  const safeSessionType = sanitizeSessionType(sessionType);
  return join(getProjectWorktreeDir(projectId), `session-${sessionId}-${safeSessionType}`);
}

/**
 * Generate a safe slug from a task title
 *
 * Converts task titles to snake_case slugs suitable for branch names and paths.
 * Uses underscores instead of hyphens to prevent git flag injection attacks.
 *
 * Example: "Add User Authentication" -> "add_user_authentication"
 * Example: "--reference=/evil" -> "reference_evil" (dangerous patterns removed)
 *
 * Security notes:
 * - No hyphens (could be interpreted as flags)
 * - No dots (directory traversal prevention)
 * - Only lowercase alphanumeric and underscores
 * - Prefixed with "task_" if starts with underscore after sanitization
 *
 * @param title - Task title
 * @returns Slug (max 30 characters)
 * @throws Error if title cannot be sanitized to a safe value
 */
export function generateTaskSlug(title: string): string {
  if (!title || typeof title !== 'string') {
    return 'untitled';
  }

  let slug = title
    .toLowerCase()
    // Only allow alphanumeric characters
    .replace(/[^a-z0-9]/g, '_')
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Remove leading/trailing underscores
    .replace(/^_+|_+$/g, '')
    // Enforce length limit
    .slice(0, 30);

  // Ensure slug doesn't start with a character that could be dangerous
  if (!slug || slug.length === 0) {
    slug = 'untitled';
  }

  // Add prefix if starts with number (some git operations don't like this)
  if (/^[0-9]/.test(slug)) {
    slug = 'task_' + slug;
    slug = slug.slice(0, 30);
  }

  // Final safety check
  if (!isGitSafeName(slug)) {
    logger.warn('Generated slug failed safety check, using fallback', { title, slug });
    return 'task_' + Date.now().toString(36);
  }

  return slug;
}

/**
 * Get the full worktree path for a specific task
 *
 * @param projectId - Project ID from database
 * @param taskId - Task ID
 * @param taskTitle - Task title (will be slugified)
 * @returns Full path to ~/.alphaagent/worktrees/{projectId}/task-{taskId}-{slug}
 */
export function getTaskWorktreePath(
  projectId: number,
  taskId: number,
  taskTitle: string
): string {
  const slug = generateTaskSlug(taskTitle);
  return join(getProjectWorktreeDir(projectId), `task-${taskId}-${slug}`);
}

/**
 * Ensure the worktree base directories exist
 *
 * @param projectId - Project ID
 */
async function ensureWorktreeDirs(projectId: number): Promise<void> {
  const projectDir = getProjectWorktreeDir(projectId);

  // Check if directory exists
  try {
    await access(projectDir, constants.F_OK);
  } catch {
    // Directory doesn't exist, create it
    await mkdir(projectDir, { recursive: true });
    logger.info('Created worktree directory', { path: projectDir });
  }
}

/**
 * Copy environment files from source project to worktree
 *
 * Git worktrees don't include untracked/gitignored files like .env,
 * but these are needed for the app to run properly.
 *
 * @param sourcePath - Main project path
 * @param worktreePath - Worktree path
 */
async function copyEnvFilesToWorktree(sourcePath: string, worktreePath: string): Promise<void> {
  const copiedFiles: string[] = [];

  for (const envFile of ENV_FILES_TO_COPY) {
    const sourceFile = join(sourcePath, envFile);
    const destFile = join(worktreePath, envFile);

    // Check if source exists and dest doesn't
    const sourceExists = await access(sourceFile, constants.F_OK).then(() => true).catch(() => false);
    const destExists = await access(destFile, constants.F_OK).then(() => true).catch(() => false);

    if (sourceExists && !destExists) {
      try {
        await copyFile(sourceFile, destFile);
        copiedFiles.push(envFile);
      } catch (error) {
        logger.warn('Failed to copy env file', {
          file: envFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Also check for server/.env if the project has a server subdirectory
  const serverEnvSource = join(sourcePath, 'server', '.env');
  const serverEnvDest = join(worktreePath, 'server', '.env');
  const serverDirPath = join(worktreePath, 'server');

  const serverEnvSourceExists = await access(serverEnvSource, constants.F_OK).then(() => true).catch(() => false);
  const serverDirExists = await access(serverDirPath, constants.F_OK).then(() => true).catch(() => false);
  const serverEnvDestExists = await access(serverEnvDest, constants.F_OK).then(() => true).catch(() => false);

  if (serverEnvSourceExists && serverDirExists && !serverEnvDestExists) {
    try {
      await copyFile(serverEnvSource, serverEnvDest);
      copiedFiles.push('server/.env');
    } catch (error) {
      logger.warn('Failed to copy server env file', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (copiedFiles.length > 0) {
    logger.info('Copied environment files to worktree', {
      worktreePath,
      files: copiedFiles,
    });
  }
}

/**
 * Create a worktree for a session
 *
 * Creates an isolated working directory where the session runs.
 * The user's main working directory is never modified.
 *
 * @param projectPath - Main project path (source repository)
 * @param projectId - Project ID from database
 * @param sessionId - Session ID
 * @param sessionType - Session type (coding, review, etc.)
 * @param baseBranch - Base branch to create from (default: auto-detect main/master)
 * @returns CreateWorktreeResult with worktree path and branch name
 *
 * @example
 * const result = await createSessionWorktree('/path/to/project', 1, 123, 'coding');
 * if (result.success) {
 *   // Run session in result.worktreePath
 * }
 */
export async function createSessionWorktree(
  projectPath: string,
  projectId: number,
  sessionId: number,
  sessionType: string,
  baseBranch?: string
): Promise<CreateWorktreeResult> {
  const safeSessionType = sanitizeSessionType(sessionType);
  const worktreePath = getSessionWorktreePath(projectId, sessionId, sessionType);
  const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const branchName = `session-${sessionId}-${safeSessionType}-${timestamp}`;

  logger.info('Creating session worktree', {
    projectPath,
    projectId,
    sessionId,
    sessionType,
    worktreePath,
    branchName,
  });

  try {
    // Ensure directories exist
    await ensureWorktreeDirs(projectId);

    // Check if worktree already exists
    const worktreeExists = await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
    if (worktreeExists) {
      logger.warn('Worktree already exists, removing and recreating', { worktreePath });
      await removeSessionWorktree(projectPath, projectId, sessionId, sessionType, true);
    }

    // Determine base branch if not provided
    let targetBase = baseBranch;
    if (!targetBase) {
      targetBase = await getMainBranch(projectPath);
    }

    // Create new branch and worktree with retry logic (Task 3.2)
    // git worktree add -b <branch> <path> <start-point>
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      try {
        await execFileAsync(
          'git',
          ['worktree', 'add', '-b', branchName, worktreePath, targetBase],
          { cwd: projectPath }
        );

        // Copy environment files (these are gitignored but needed for app to run)
        await copyEnvFilesToWorktree(projectPath, worktreePath);

        logger.info('Session worktree created successfully', {
          worktreePath,
          branchName,
          baseBranch: targetBase,
          attempt,
        });

        return {
          success: true,
          worktreePath,
          branchName,
        };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;

        // Check if error is retryable
        if (isRetryableError(errorMessage) && attempt < RETRY_CONFIG.maxAttempts) {
          const delayMs = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
          logger.warn('Retrying worktree creation', {
            attempt,
            maxAttempts: RETRY_CONFIG.maxAttempts,
            delayMs,
            error: errorMessage,
          });
          await sleep(delayMs);
        } else {
          // Not retryable or max attempts reached
          break;
        }
      }
    }

    // All attempts failed
    const errorMessage = lastError?.message || 'Unknown error';
    logger.error('Failed to create session worktree after all attempts', {
      projectPath,
      projectId,
      sessionId,
      attempts: RETRY_CONFIG.maxAttempts,
      error: errorMessage,
    });

    return {
      success: false,
      error: `Failed to create worktree: ${errorMessage}`,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to create session worktree', {
      projectPath,
      projectId,
      sessionId,
      error: errorMessage,
    });

    return {
      success: false,
      error: `Failed to create worktree: ${errorMessage}`,
    };
  }
}

/**
 * Remove a session worktree
 *
 * Cleans up the worktree directory and associated git metadata.
 *
 * @param projectPath - Main project path (source repository)
 * @param projectId - Project ID
 * @param sessionId - Session ID
 * @param sessionType - Session type
 * @param force - Force remove even with uncommitted changes (default: false)
 * @returns WorktreeOperationResult
 */
export async function removeSessionWorktree(
  projectPath: string,
  projectId: number,
  sessionId: number,
  sessionType: string,
  force: boolean = false
): Promise<WorktreeOperationResult> {
  const worktreePath = getSessionWorktreePath(projectId, sessionId, sessionType);

  logger.info('Removing session worktree', {
    worktreePath,
    force,
  });

  try {
    const worktreeExists = await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
    if (!worktreeExists) {
      logger.info('Worktree does not exist, nothing to remove', { worktreePath });
      return { success: true };
    }

    const args = ['worktree', 'remove'];
    if (force) {
      args.push('--force');
    }
    args.push(worktreePath);

    await execFileAsync('git', args, { cwd: projectPath });

    logger.info('Session worktree removed', { worktreePath });
    return { success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // SAFETY: Do NOT force removal of worktrees with uncommitted changes
    // This prevents data loss - user must explicitly commit or discard changes
    if (!force && errorMessage.includes('contains modified or untracked files')) {
      logger.error('BLOCKED: Worktree has uncommitted changes - refusing to delete to prevent data loss', {
        worktreePath,
        sessionId,
        hint: 'Commit changes with git add && git commit, or use force=true if you want to discard them',
      });
      return {
        success: false,
        error: `Worktree "${worktreePath}" has uncommitted changes. Refusing to delete to prevent data loss. Either commit the changes first, or explicitly pass force=true to discard them.`,
      };
    }

    // Handle case where worktree directory was manually deleted
    if (errorMessage.includes('is not a working tree')) {
      logger.warn('Worktree metadata stale, running prune', { worktreePath });
      await pruneWorktrees(projectPath);
      // Clean up the directory if it still exists
      const dirExists = await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
      if (dirExists) {
        await rm(worktreePath, { recursive: true, force: true });
      }
      return { success: true };
    }

    logger.error('Failed to remove session worktree', {
      worktreePath,
      error: errorMessage,
    });

    return {
      success: false,
      error: `Failed to remove worktree: ${errorMessage}`,
    };
  }
}

/**
 * List all worktrees for a project
 *
 * @param projectPath - Main project path
 * @returns Array of WorktreeInfo
 */
export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd: projectPath }
    );

    return parseWorktreeListOutput(stdout);
  } catch (error: unknown) {
    logger.error('Failed to list worktrees', {
      projectPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * List session worktrees for a specific project
 *
 * Filters worktrees to only those in the AlphaAgent worktree directory.
 *
 * @param projectPath - Main project path
 * @param projectId - Project ID to filter by
 * @returns Array of session WorktreeInfo
 */
export async function listSessionWorktrees(
  projectPath: string,
  projectId: number
): Promise<WorktreeInfo[]> {
  const allWorktrees = await listWorktrees(projectPath);
  const projectWorktreeDir = getProjectWorktreeDir(projectId);

  return allWorktrees.filter((wt) => wt.path.startsWith(projectWorktreeDir));
}

/**
 * Parse git worktree list --porcelain output
 *
 * Format:
 * worktree /path/to/worktree
 * HEAD <commit>
 * branch refs/heads/branch-name
 * (blank line)
 */
function parseWorktreeListOutput(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const entries = output.trim().split('\n\n');

  for (const entry of entries) {
    if (!entry.trim()) continue;

    const lines = entry.split('\n');
    const info: Partial<WorktreeInfo> = {
      locked: false,
      prunable: false,
    };

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        info.path = line.substring(9);
      } else if (line.startsWith('HEAD ')) {
        info.head = line.substring(5);
      } else if (line.startsWith('branch ')) {
        info.branch = line.substring(7).replace('refs/heads/', '');
      } else if (line === 'detached') {
        info.branch = null;
      } else if (line.startsWith('locked')) {
        info.locked = true;
        if (line.includes(' ')) {
          info.lockReason = line.substring(7);
        }
      } else if (line === 'prunable') {
        info.prunable = true;
      }
    }

    if (info.path && info.head) {
      worktrees.push(info as WorktreeInfo);
    }
  }

  return worktrees;
}

/**
 * Prune stale worktree metadata
 *
 * Removes git metadata for worktrees whose directories have been manually deleted.
 *
 * @param projectPath - Main project path
 * @param dryRun - If true, only report what would be pruned
 * @returns Array of pruned worktree names
 */
export async function pruneWorktrees(
  projectPath: string,
  dryRun: boolean = false
): Promise<string[]> {
  try {
    const args = ['worktree', 'prune', '--verbose'];
    if (dryRun) {
      args.push('--dry-run');
    }

    const { stdout } = await execFileAsync('git', args, { cwd: projectPath });

    // Parse pruned worktree names from output
    const pruned = stdout
      .split('\n')
      .filter((line) => line.includes('Removing worktrees/'))
      .map((line) => line.match(/worktrees\/([^\s]+)/)?.[1] || '')
      .filter(Boolean);

    if (pruned.length > 0) {
      logger.info('Pruned stale worktrees', { pruned, dryRun });
    }
    return pruned;
  } catch (error: unknown) {
    logger.error('Failed to prune worktrees', {
      projectPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Lock a worktree to prevent accidental pruning
 *
 * Useful for long-running sessions or when network access is unavailable.
 *
 * @param projectPath - Main project path
 * @param worktreePath - Path to worktree to lock
 * @param reason - Reason for locking (displayed in git worktree list)
 */
export async function lockWorktree(
  projectPath: string,
  worktreePath: string,
  reason?: string
): Promise<WorktreeOperationResult> {
  try {
    const args = ['worktree', 'lock'];
    if (reason) {
      args.push('--reason', reason);
    }
    args.push(worktreePath);

    await execFileAsync('git', args, { cwd: projectPath });
    logger.info('Worktree locked', { worktreePath, reason });
    return { success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to lock worktree', { worktreePath, error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/**
 * Unlock a worktree
 *
 * @param projectPath - Main project path
 * @param worktreePath - Path to worktree to unlock
 */
export async function unlockWorktree(
  projectPath: string,
  worktreePath: string
): Promise<WorktreeOperationResult> {
  try {
    await execFileAsync('git', ['worktree', 'unlock', worktreePath], { cwd: projectPath });
    logger.info('Worktree unlocked', { worktreePath });
    return { success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to unlock worktree', { worktreePath, error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/**
 * Get the main branch name (main or master)
 *
 * @param projectPath - Project path
 * @returns Branch name ('main' or 'master')
 */
async function getMainBranch(projectPath: string): Promise<string> {
  try {
    // Try to get the remote default branch
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      { cwd: projectPath }
    );
    return stdout.trim().replace('refs/remotes/origin/', '');
  } catch {
    // Fall back to checking local branches
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--list', 'main'], {
        cwd: projectPath,
      });
      if (stdout.trim()) {
        return 'main';
      }
    } catch {
      // Ignore
    }
    return 'master';
  }
}

/**
 * Check if a worktree exists for a session
 *
 * @param projectId - Project ID
 * @param sessionId - Session ID
 * @param sessionType - Session type
 * @returns True if worktree exists
 */
export async function worktreeExists(
  projectId: number,
  sessionId: number,
  sessionType: string
): Promise<boolean> {
  const worktreePath = getSessionWorktreePath(projectId, sessionId, sessionType);
  return await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
}

/**
 * Get worktree info for a session if it exists
 *
 * @param projectPath - Main project path
 * @param projectId - Project ID
 * @param sessionId - Session ID
 * @param sessionType - Session type
 * @returns WorktreeInfo or null if not found
 */
export async function getSessionWorktreeInfo(
  projectPath: string,
  projectId: number,
  sessionId: number,
  sessionType: string
): Promise<WorktreeInfo | null> {
  const worktreePath = getSessionWorktreePath(projectId, sessionId, sessionType);
  const worktrees = await listWorktrees(projectPath);
  return worktrees.find((wt) => wt.path === worktreePath) || null;
}

/**
 * Clean up all worktrees for a project
 *
 * Used when deleting a project or resetting its state.
 *
 * SAFETY NOTE: Defaults to force=false to prevent data loss.
 * Only set force=true when you are certain no uncommitted changes exist.
 *
 * @param projectPath - Main project path
 * @param projectId - Project ID
 * @param force - Force remove even with uncommitted changes (default: false for safety)
 * @returns Number of worktrees removed
 */
export async function cleanupProjectWorktrees(
  projectPath: string,
  projectId: number,
  force: boolean = false
): Promise<number> {
  const sessionWorktrees = await listSessionWorktrees(projectPath, projectId);
  let removed = 0;
  const skippedWithChanges: string[] = [];

  for (const wt of sessionWorktrees) {
    try {
      const args = ['worktree', 'remove'];
      if (force) {
        args.push('--force');
        logger.warn('Force removing worktree - uncommitted changes will be lost', { path: wt.path });
      }
      args.push(wt.path);

      await execFileAsync('git', args, { cwd: projectPath });
      removed++;
      logger.info('Removed project worktree', { path: wt.path });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Track worktrees skipped due to uncommitted changes
      if (errorMessage.includes('contains modified or untracked files')) {
        skippedWithChanges.push(wt.path);
        logger.warn('Skipped worktree with uncommitted changes (use force=true to override)', {
          path: wt.path,
        });
      } else {
        logger.warn('Failed to remove worktree during cleanup', {
          path: wt.path,
          error: errorMessage,
        });
      }
    }
  }

  // Log summary of skipped worktrees
  if (skippedWithChanges.length > 0) {
    logger.error('DATA PROTECTION: Skipped worktrees with uncommitted changes', {
      count: skippedWithChanges.length,
      paths: skippedWithChanges,
      action: 'Commit changes or use force=true to discard them',
    });
  }

  // Clean up the project directory if empty
  const projectWorktreeDir = getProjectWorktreeDir(projectId);
  const dirExists = await access(projectWorktreeDir, constants.F_OK).then(() => true).catch(() => false);
  if (dirExists) {
    try {
      await rm(projectWorktreeDir, { recursive: true, force: true });
      logger.info('Removed project worktree directory', { path: projectWorktreeDir });
    } catch (error) {
      logger.warn('Failed to remove project worktree directory', {
        path: projectWorktreeDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Prune any stale metadata
  await pruneWorktrees(projectPath);

  return removed;
}

/**
 * Delete a session branch (after worktree is removed)
 *
 * @param projectPath - Main project path
 * @param branchName - Branch name to delete
 * @param deleteRemote - Also delete from remote (default: false)
 */
export async function deleteSessionBranch(
  projectPath: string,
  branchName: string,
  deleteRemote: boolean = false
): Promise<WorktreeOperationResult> {
  try {
    // Delete local branch
    await execFileAsync('git', ['branch', '-D', branchName], { cwd: projectPath });
    logger.info('Deleted local branch', { branchName });

    // Delete remote branch if requested
    if (deleteRemote) {
      try {
        await execFileAsync('git', ['push', 'origin', '--delete', branchName], {
          cwd: projectPath,
        });
        logger.info('Deleted remote branch', { branchName });
      } catch (error) {
        // Remote branch might not exist, that's okay
        logger.warn('Failed to delete remote branch (may not exist)', {
          branchName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to delete branch', { branchName, error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

// ============================================================================
// Task Worktree Functions (Task Lifecycle V2)
// ============================================================================

/**
 * Create a worktree for a task
 *
 * Creates a persistent working directory for a task that spans multiple sessions.
 * Unlike session worktrees, task worktrees are kept until the task is completed.
 *
 * @param projectPath - Main project path (source repository)
 * @param projectId - Project ID from database
 * @param taskId - Task ID
 * @param taskTitle - Task title (will be slugified for path)
 * @param baseBranch - Base branch to create from (default: auto-detect main/master)
 * @returns CreateWorktreeResult with worktree path and branch name
 *
 * @example
 * const result = await createTaskWorktree('/path/to/project', 1, 5, 'Add user authentication');
 * if (result.success) {
 *   // Task worktree at result.worktreePath
 * }
 */
export async function createTaskWorktree(
  projectPath: string,
  projectId: number,
  taskId: number,
  taskTitle: string,
  baseBranch?: string
): Promise<CreateWorktreeResult> {
  const slug = generateTaskSlug(taskTitle);
  const worktreePath = getTaskWorktreePath(projectId, taskId, taskTitle);
  const branchName = `task/${taskId}/${slug}`;

  logger.info('Creating task worktree', {
    projectPath,
    projectId,
    taskId,
    taskTitle,
    worktreePath,
    branchName,
  });

  try {
    // Ensure directories exist
    await ensureWorktreeDirs(projectId);

    // Check if worktree already exists
    const worktreeExists = await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
    if (worktreeExists) {
      logger.warn('Task worktree already exists', { worktreePath });
      return {
        success: true,
        worktreePath,
        branchName,
      };
    }

    // Determine base branch if not provided
    let targetBase = baseBranch;
    if (!targetBase) {
      targetBase = await getMainBranch(projectPath);
    }

    // Create new branch and worktree with retry logic
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
      try {
        await execFileAsync(
          'git',
          ['worktree', 'add', '-b', branchName, worktreePath, targetBase],
          { cwd: projectPath }
        );

        // Copy environment files
        await copyEnvFilesToWorktree(projectPath, worktreePath);

        logger.info('Task worktree created successfully', {
          worktreePath,
          branchName,
          baseBranch: targetBase,
          attempt,
        });

        return {
          success: true,
          worktreePath,
          branchName,
        };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorMessage = lastError.message;

        if (isRetryableError(errorMessage) && attempt < RETRY_CONFIG.maxAttempts) {
          const delayMs = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 1);
          logger.warn('Retrying task worktree creation', {
            attempt,
            maxAttempts: RETRY_CONFIG.maxAttempts,
            delayMs,
            error: errorMessage,
          });
          await sleep(delayMs);
        } else {
          break;
        }
      }
    }

    const errorMessage = lastError?.message || 'Unknown error';
    logger.error('Failed to create task worktree after all attempts', {
      projectPath,
      taskId,
      attempts: RETRY_CONFIG.maxAttempts,
      error: errorMessage,
    });

    return {
      success: false,
      error: `Failed to create task worktree: ${errorMessage}`,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to create task worktree', {
      projectPath,
      taskId,
      error: errorMessage,
    });

    return {
      success: false,
      error: `Failed to create task worktree: ${errorMessage}`,
    };
  }
}

/**
 * Remove a task worktree
 *
 * Cleans up the task worktree directory and associated git metadata.
 * Called when task is completed or deleted.
 *
 * @param projectPath - Main project path (source repository)
 * @param projectId - Project ID
 * @param taskId - Task ID
 * @param taskTitle - Task title
 * @param force - Force remove even with uncommitted changes (default: false)
 * @returns WorktreeOperationResult
 */
export async function removeTaskWorktree(
  projectPath: string,
  projectId: number,
  taskId: number,
  taskTitle: string,
  force: boolean = false
): Promise<WorktreeOperationResult> {
  const worktreePath = getTaskWorktreePath(projectId, taskId, taskTitle);

  logger.info('Removing task worktree', {
    worktreePath,
    taskId,
    force,
  });

  try {
    const worktreeExists = await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
    if (!worktreeExists) {
      logger.info('Task worktree does not exist, nothing to remove', { worktreePath });
      return { success: true };
    }

    const args = ['worktree', 'remove'];
    if (force) {
      args.push('--force');
    }
    args.push(worktreePath);

    await execFileAsync('git', args, { cwd: projectPath });

    logger.info('Task worktree removed', { worktreePath, taskId });
    return { success: true };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (!force && errorMessage.includes('contains modified or untracked files')) {
      logger.error('BLOCKED: Task worktree has uncommitted changes', {
        worktreePath,
        taskId,
      });
      return {
        success: false,
        error: `Task worktree has uncommitted changes. Refusing to delete to prevent data loss.`,
      };
    }

    if (errorMessage.includes('is not a working tree')) {
      logger.warn('Task worktree metadata stale, running prune', { worktreePath });
      await pruneWorktrees(projectPath);
      const dirExists = await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
      if (dirExists) {
        await rm(worktreePath, { recursive: true, force: true });
      }
      return { success: true };
    }

    logger.error('Failed to remove task worktree', {
      worktreePath,
      taskId,
      error: errorMessage,
    });

    return {
      success: false,
      error: `Failed to remove task worktree: ${errorMessage}`,
    };
  }
}

/**
 * Get list of changed files in task worktree
 *
 * Returns files that differ from the base branch with detailed stats.
 *
 * @param worktreePath - Path to task worktree
 * @param baseBranch - Base branch to compare against (default: auto-detect main/master)
 * @returns Array of changed files with stats
 */
export async function getWorktreeChangedFiles(
  worktreePath: string,
  baseBranch?: string
): Promise<ChangedFile[]> {
  try {
    const worktreeExists = await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
    if (!worktreeExists) {
      return [];
    }

    // Determine base branch if not provided
    let targetBase = baseBranch;
    if (!targetBase) {
      targetBase = await getMainBranch(worktreePath);
    }

    const changedFilesMap = new Map<string, ChangedFile>();

    // 1. Get committed changes: git diff --numstat <base>...HEAD
    try {
      const { stdout: diffOutput } = await execFileAsync(
        'git',
        ['diff', '--numstat', `${targetBase}...HEAD`],
        { cwd: worktreePath }
      );

      const { stdout: statusOutput } = await execFileAsync(
        'git',
        ['diff', '--name-status', `${targetBase}...HEAD`],
        { cwd: worktreePath }
      );

      // Parse status output
      const statusMap = new Map<string, string>();
      for (const line of statusOutput.trim().split('\n')) {
        if (!line) continue;
        const [status, ...pathParts] = line.split('\t');
        const path = pathParts.join('\t');
        statusMap.set(path, status);
      }

      // Parse diff output
      for (const line of diffOutput.trim().split('\n')) {
        if (!line) continue;
        const [additionsStr, deletionsStr, ...pathParts] = line.split('\t');
        const path = pathParts.join('\t');

        const additions = additionsStr === '-' ? 0 : parseInt(additionsStr, 10);
        const deletions = deletionsStr === '-' ? 0 : parseInt(deletionsStr, 10);

        const rawStatus = statusMap.get(path) || 'M';
        let status: ChangedFile['status'];
        switch (rawStatus.charAt(0)) {
          case 'A': status = 'added'; break;
          case 'D': status = 'deleted'; break;
          case 'R': status = 'renamed'; break;
          case 'C': status = 'copied'; break;
          default: status = 'modified';
        }

        changedFilesMap.set(path, { path, status, additions, deletions });
      }
    } catch (err) {
      logger.debug('Failed to get committed changes', { error: String(err) });
    }

    // 2. Get uncommitted changes (staged + unstaged): git diff --numstat HEAD
    try {
      const { stdout: uncommittedDiff } = await execFileAsync(
        'git',
        ['diff', '--numstat', 'HEAD'],
        { cwd: worktreePath }
      );

      const { stdout: uncommittedStatus } = await execFileAsync(
        'git',
        ['diff', '--name-status', 'HEAD'],
        { cwd: worktreePath }
      );

      const statusMap = new Map<string, string>();
      for (const line of uncommittedStatus.trim().split('\n')) {
        if (!line) continue;
        const [status, ...pathParts] = line.split('\t');
        statusMap.set(pathParts.join('\t'), status);
      }

      for (const line of uncommittedDiff.trim().split('\n')) {
        if (!line) continue;
        const [additionsStr, deletionsStr, ...pathParts] = line.split('\t');
        const path = pathParts.join('\t');

        // Skip if already tracked from committed changes
        if (changedFilesMap.has(path)) continue;

        const additions = additionsStr === '-' ? 0 : parseInt(additionsStr, 10);
        const deletions = deletionsStr === '-' ? 0 : parseInt(deletionsStr, 10);

        const rawStatus = statusMap.get(path) || 'M';
        let status: ChangedFile['status'];
        switch (rawStatus.charAt(0)) {
          case 'A': status = 'added'; break;
          case 'D': status = 'deleted'; break;
          case 'R': status = 'renamed'; break;
          case 'C': status = 'copied'; break;
          default: status = 'modified';
        }

        changedFilesMap.set(path, { path, status, additions, deletions });
      }
    } catch (err) {
      logger.debug('Failed to get uncommitted changes', { error: String(err) });
    }

    // 3. Get untracked files: git ls-files --others --exclude-standard
    try {
      const { stdout: untrackedOutput } = await execFileAsync(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { cwd: worktreePath }
      );

      for (const line of untrackedOutput.trim().split('\n')) {
        if (!line) continue;
        const path = line;

        // Skip if already tracked
        if (changedFilesMap.has(path)) continue;

        // Count lines for untracked files
        let additions = 0;
        try {
          const filePath = join(worktreePath, path);
          const fileExists = await access(filePath, constants.F_OK).then(() => true).catch(() => false);
          if (fileExists) {
            const content = await readFile(filePath, 'utf-8');
            additions = content.split('\n').length;
          }
        } catch {
          // Binary file or unreadable, use 0
        }

        changedFilesMap.set(path, {
          path,
          status: 'added',
          additions,
          deletions: 0,
        });
      }
    } catch (err) {
      logger.debug('Failed to get untracked files', { error: String(err) });
    }

    const changedFiles = Array.from(changedFilesMap.values());

    logger.info('Found changed files in worktree', {
      worktreePath,
      count: changedFiles.length,
      baseBranch: targetBase,
    });

    return changedFiles;
  } catch (error: unknown) {
    logger.error('Failed to get changed files', {
      worktreePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Check if a task worktree exists
 *
 * @param projectId - Project ID
 * @param taskId - Task ID
 * @param taskTitle - Task title (used to generate path)
 * @returns True if task worktree exists
 */
export async function taskWorktreeExists(
  projectId: number,
  taskId: number,
  taskTitle: string
): Promise<boolean> {
  const worktreePath = getTaskWorktreePath(projectId, taskId, taskTitle);
  return await access(worktreePath, constants.F_OK).then(() => true).catch(() => false);
}

/**
 * Check if working directory has uncommitted changes
 *
 * Used before copying changes to warn user that they need to commit or stash first.
 *
 * @param workingDir - Path to working directory to check
 * @returns True if there are uncommitted changes
 */
export async function hasUncommittedChanges(workingDir: string): Promise<boolean> {
  try {
    // Check if directory exists and is a git repo
    const workingDirExists = await access(workingDir, constants.F_OK).then(() => true).catch(() => false);
    const gitDirExists = await access(join(workingDir, '.git'), constants.F_OK).then(() => true).catch(() => false);

    if (!workingDirExists || !gitDirExists) {
      return false;
    }

    // git status --porcelain returns empty string if working tree is clean
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: workingDir });
    return stdout.trim().length > 0;
  } catch (error) {
    logger.error('Failed to check for uncommitted changes', {
      workingDir,
      error: error instanceof Error ? error.message : String(error),
    });
    // Assume no changes if we can't check (fail safe)
    return false;
  }
}

/**
 * Copy changed files from worktree to user's working directory
 *
 * SAFETY: Must check for uncommitted changes first! Will return error if
 * target directory has uncommitted changes to prevent conflicts.
 *
 * Only copies files that have been changed in the worktree (not entire directory).
 *
 * @param taskWorktreePath - Path to task worktree (source)
 * @param targetPath - Path to user's working directory (destination)
 * @returns CopyChangesResult with list of copied files
 *
 * @example
 * // Check for uncommitted changes first
 * if (await hasUncommittedChanges(targetPath)) {
 *   return { success: false, error: 'Target has uncommitted changes. Please commit or stash first.' };
 * }
 *
 * // Safe to copy
 * const result = await copyChangesToWorkingDir(worktreePath, targetPath);
 */
export async function copyChangesToWorkingDir(
  taskWorktreePath: string,
  targetPath: string
): Promise<CopyChangesResult> {
  logger.info('Copying changes to working directory', {
    taskWorktreePath,
    targetPath,
  });

  try {
    // SAFETY CHECK: Ensure target directory has no uncommitted changes
    if (await hasUncommittedChanges(targetPath)) {
      const errorMsg =
        'Target working directory has uncommitted changes. Please commit or stash your changes first before copying task changes.';
      logger.error('BLOCKED: Cannot copy changes to dirty working directory', {
        targetPath,
        hint: 'Run: git add . && git commit OR git stash',
      });
      return {
        success: false,
        copiedFiles: [],
        targetPath,
        error: errorMsg,
      };
    }

    // Get list of changed files
    const allChangedFiles = await getWorktreeChangedFiles(taskWorktreePath);

    // Filter out excluded files (session locks, etc.)
    const changedFiles = allChangedFiles.filter((file) => {
      const fileName = file.path.split('/').pop() || file.path;
      const isExcluded = COPY_EXCLUDED_FILES.includes(fileName);
      if (isExcluded) {
        logger.debug('Skipping excluded file from copy', { path: file.path });
      }
      return !isExcluded;
    });

    if (changedFiles.length === 0) {
      logger.info('No changed files to copy', { taskWorktreePath });
      return {
        success: true,
        copiedFiles: [],
        targetPath,
      };
    }

    // Copy each changed file
    const copiedFiles: string[] = [];
    for (const file of changedFiles) {
      if (file.status === 'deleted') {
        // Delete the file in target
        const targetFile = join(targetPath, file.path);
        const targetExists = await access(targetFile, constants.F_OK).then(() => true).catch(() => false);
        if (targetExists) {
          await rm(targetFile);
          copiedFiles.push(file.path);
          logger.info('Deleted file in target', { path: file.path });
        }
      } else {
        // Copy the file (added, modified, renamed, copied)
        const sourceFile = join(taskWorktreePath, file.path);
        const targetFile = join(targetPath, file.path);

        // Ensure target directory exists
        const targetDir = join(targetFile, '..');
        const targetDirExists = await access(targetDir, constants.F_OK).then(() => true).catch(() => false);
        if (!targetDirExists) {
          await mkdir(targetDir, { recursive: true });
        }

        // Copy file
        await copyFile(sourceFile, targetFile);
        copiedFiles.push(file.path);
        logger.info('Copied file to target', { path: file.path, status: file.status });
      }
    }

    logger.info('Successfully copied changes to working directory', {
      targetPath,
      copiedCount: copiedFiles.length,
    });

    return {
      success: true,
      copiedFiles,
      targetPath,
    };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to copy changes to working directory', {
      taskWorktreePath,
      targetPath,
      error: errorMessage,
    });

    return {
      success: false,
      copiedFiles: [],
      targetPath,
      error: `Failed to copy changes: ${errorMessage}`,
    };
  }
}

/**
 * Revert changes copied to working directory
 *
 * Uses git checkout to restore files to their state before copying.
 * Only reverts the specific files that were copied, not entire working directory.
 *
 * @param targetPath - Path to working directory
 * @param changedFiles - List of file paths to revert
 * @returns void
 * @throws Error if revert fails
 */
export async function revertWorkingDirChanges(
  targetPath: string,
  changedFiles: ChangedFile[]
): Promise<void> {
  logger.info('Reverting working directory changes', {
    targetPath,
    fileCount: changedFiles.length,
  });

  try {
    if (changedFiles.length === 0) {
      logger.info('No files to revert', { targetPath });
      return;
    }

    // Separate files by status for appropriate handling
    const filesToCheckout: string[] = []; // modified, deleted files - restore from git
    const filesToDelete: string[] = [];   // added files - delete them

    for (const file of changedFiles) {
      if (file.status === 'added') {
        filesToDelete.push(file.path);
      } else {
        // modified, deleted, renamed, copied - use git checkout
        filesToCheckout.push(file.path);
      }
    }

    // Delete added files (they don't exist in the base repo)
    for (const filePath of filesToDelete) {
      const fullPath = join(targetPath, filePath);
      try {
        const fileExists = await access(fullPath, constants.F_OK).then(() => true).catch(() => false);
        if (fileExists) {
          await rm(fullPath);
          logger.debug('Deleted added file', { path: filePath });

          // Try to remove empty parent directories
          let parentDir = join(fullPath, '..');
          while (parentDir !== targetPath && parentDir.startsWith(targetPath)) {
            try {
              const contents = await readdir(parentDir);
              if (contents.length === 0) {
                await rm(parentDir, { recursive: true });
                logger.debug('Removed empty directory', { path: parentDir });
                parentDir = join(parentDir, '..');
              } else {
                break;
              }
            } catch {
              break;
            }
          }
        }
      } catch (deleteErr) {
        logger.warn('Failed to delete added file', { path: filePath, error: String(deleteErr) });
      }
    }

    // Use git checkout -- <files> for modified/deleted files
    if (filesToCheckout.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < filesToCheckout.length; i += batchSize) {
        const batch = filesToCheckout.slice(i, i + batchSize);
        try {
          await execFileAsync('git', ['checkout', '--', ...batch], { cwd: targetPath });
          logger.debug('Reverted file batch via git checkout', {
            batchStart: i,
            batchSize: batch.length,
          });
        } catch (checkoutErr) {
          logger.warn('Failed to checkout some files', {
            batch,
            error: String(checkoutErr)
          });
        }
      }
    }

    logger.info('Successfully reverted working directory changes', {
      targetPath,
      deletedCount: filesToDelete.length,
      checkoutCount: filesToCheckout.length,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to revert working directory changes', {
      targetPath,
      fileCount: changedFiles.length,
      error: errorMessage,
    });
    throw new Error(`Failed to revert changes: ${errorMessage}`);
  }
}
