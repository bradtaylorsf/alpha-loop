/**
 * GitHub API Client Wrapper
 * ==========================
 *
 * Wrapper around Octokit for GitHub PR operations with per-project authentication.
 * Each project has its own GitHub token and repository configuration.
 */

import { Octokit } from '@octokit/rest';
import { GitHubConfig, PRStatus } from './types/database.js';
import { createLogger } from './logger.js';
import { validateBranchName } from './git-manager.js';

const logger = createLogger('github-client');

/**
 * Pull request creation result
 */
export interface CreatePRResult {
  /** Pull request number */
  number: number;

  /** Pull request URL */
  url: string;

  /** Current PR status */
  status: PRStatus;
}

/**
 * Pull request merge result
 */
export interface MergePRResult {
  /** Whether merge was successful */
  merged: boolean;

  /** Merge commit SHA (if merged) */
  sha?: string;
}

/**
 * GitHub API client wrapper for pull request operations
 *
 * Each client instance is bound to a specific project's GitHub configuration.
 * Uses per-project authentication (no global GitHub credentials).
 *
 * @example
 * ```typescript
 * const client = new GitHubClient(githubConfig);
 *
 * const pr = await client.createPullRequest(
 *   'feature/add-auth',
 *   'Add authentication system',
 *   'Implements JWT-based authentication with refresh tokens'
 * );
 *
 * console.log(`Created PR #${pr.number}: ${pr.url}`);
 * ```
 */
export class GitHubClient {
  private octokit: Octokit;
  private config: GitHubConfig;

  /**
   * Create a new GitHub client for a specific project
   *
   * @param config - Project's GitHub configuration (includes token, owner, repo)
   * @throws {Error} If configuration is invalid or incomplete
   */
  constructor(config: GitHubConfig) {
    // Validate required configuration
    if (!config.owner || !config.repo || !config.token) {
      throw new Error('GitHub configuration incomplete: owner, repo, and token are required');
    }

    // Validate token format (should start with 'ghp_' or 'github_pat_')
    if (!config.token.startsWith('ghp_') && !config.token.startsWith('github_pat_')) {
      logger.warn('GitHub token does not match expected format (ghp_* or github_pat_*)', {
        owner: config.owner,
        repo: config.repo
      });
    }

    this.config = config;

    // Create Octokit instance with project's token
    this.octokit = new Octokit({
      auth: config.token,
      userAgent: 'alphacoder-harness/1.0',
      log: {
        debug: (message: string) => logger.debug(message),
        info: (message: string) => logger.info(message),
        warn: (message: string) => logger.warn(message),
        error: (message: string) => logger.error(message)
      }
    });

    logger.info('GitHub client initialized', {
      owner: config.owner,
      repo: config.repo,
      defaultBranch: config.defaultBranch
    });
  }

  /**
   * Create a pull request
   *
   * @param branchName - Source branch name (e.g., 'feature/add-auth')
   * @param title - PR title
   * @param body - PR description/body (markdown supported)
   * @param draft - Whether to create as draft PR (default: false)
   * @returns Pull request details
   *
   * @example
   * ```typescript
   * const pr = await client.createPullRequest(
   *   'feature/session-locking',
   *   'Add session locking mechanism',
   *   'Prevents concurrent sessions from corrupting state.\n\nCloses #123',
   *   false
   * );
   * ```
   */
  async createPullRequest(
    branchName: string,
    title: string,
    body: string,
    draft: boolean = false
  ): Promise<CreatePRResult> {
    const { owner, repo, defaultBranch } = this.config;

    // Validate branch name for security (prevents injection)
    if (!validateBranchName(branchName)) {
      throw new Error(`Invalid branch name: ${branchName}. Branch names must follow Git naming conventions.`);
    }

    logger.info('Creating pull request', {
      owner,
      repo,
      branch: branchName,
      title,
      draft
    });

    try {
      // Verify branch exists before creating PR
      await this.verifyBranchExists(branchName);

      // Create pull request
      const response = await this.octokit.rest.pulls.create({
        owner,
        repo,
        title,
        body,
        head: branchName,
        base: defaultBranch,
        draft
      });

      const pr = response.data;

      logger.info('Pull request created successfully', {
        owner,
        repo,
        number: pr.number,
        url: pr.html_url,
        draft: pr.draft
      });

      return {
        number: pr.number,
        url: pr.html_url,
        status: draft ? 'draft' : 'open'
      };
    } catch (error: unknown) {
      return this.handleError('Failed to create pull request', error, {
        owner,
        repo,
        branch: branchName,
        title
      });
    }
  }

  /**
   * Merge a pull request
   *
   * @param prNumber - Pull request number
   * @param mergeMethod - Merge method ('merge', 'squash', or 'rebase')
   * @returns Merge result
   *
   * @example
   * ```typescript
   * const result = await client.mergePullRequest(42, 'squash');
   * if (result.merged) {
   *   console.log(`Merged with commit ${result.sha}`);
   * }
   * ```
   */
  async mergePullRequest(
    prNumber: number,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'
  ): Promise<MergePRResult> {
    const { owner, repo } = this.config;

    logger.info('Merging pull request', {
      owner,
      repo,
      prNumber,
      mergeMethod
    });

    try {
      // Check if PR is mergeable before attempting merge
      const prStatus = await this.getPRStatus(prNumber);

      if (prStatus === 'merged') {
        logger.warn('Pull request already merged', { owner, repo, prNumber });
        return { merged: true };
      }

      if (prStatus === 'closed') {
        throw new Error('Cannot merge closed pull request');
      }

      if (prStatus === 'draft') {
        throw new Error('Cannot merge draft pull request. Mark as ready for review first.');
      }

      // Merge the pull request
      const response = await this.octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        merge_method: mergeMethod
      });

      logger.info('Pull request merged successfully', {
        owner,
        repo,
        prNumber,
        sha: response.data.sha
      });

      return {
        merged: response.data.merged,
        sha: response.data.sha
      };
    } catch (error: unknown) {
      return this.handleError('Failed to merge pull request', error, {
        owner,
        repo,
        prNumber,
        mergeMethod
      });
    }
  }

  /**
   * Add a comment to a pull request
   *
   * @param prNumber - Pull request number
   * @param comment - Comment text (markdown supported)
   *
   * @example
   * ```typescript
   * await client.addPRComment(42, 'LGTM! ✅ All tests passing.');
   * ```
   */
  async addPRComment(prNumber: number, comment: string): Promise<void> {
    const { owner, repo } = this.config;

    logger.info('Adding comment to pull request', {
      owner,
      repo,
      prNumber,
      commentLength: comment.length
    });

    try {
      await this.octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: comment
      });

      logger.info('Comment added successfully', { owner, repo, prNumber });
    } catch (error: unknown) {
      return this.handleError('Failed to add PR comment', error, {
        owner,
        repo,
        prNumber
      });
    }
  }

  /**
   * Get current pull request status
   *
   * @param prNumber - Pull request number
   * @returns Current PR status
   *
   * @example
   * ```typescript
   * const status = await client.getPRStatus(42);
   * console.log(`PR #42 status: ${status}`);
   * ```
   */
  async getPRStatus(prNumber: number): Promise<PRStatus> {
    const { owner, repo } = this.config;

    logger.debug('Fetching pull request status', {
      owner,
      repo,
      prNumber
    });

    try {
      const response = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber
      });

      const pr = response.data;

      // Determine status based on PR state and metadata
      let status: PRStatus;

      if (pr.merged) {
        status = 'merged';
      } else if (pr.state === 'closed') {
        status = 'closed';
      } else if (pr.draft) {
        status = 'draft';
      } else {
        // Check for approvals
        const reviews = await this.octokit.rest.pulls.listReviews({
          owner,
          repo,
          pull_number: prNumber
        });

        const hasApproval = reviews.data.some(review => review.state === 'APPROVED');
        status = hasApproval ? 'approved' : 'open';
      }

      logger.debug('Pull request status retrieved', {
        owner,
        repo,
        prNumber,
        status
      });

      return status;
    } catch (error: unknown) {
      return this.handleError('Failed to get PR status', error, {
        owner,
        repo,
        prNumber
      });
    }
  }

  /**
   * Verify that a branch exists in the repository
   *
   * @param branchName - Branch name to verify
   * @throws {Error} If branch does not exist
   */
  private async verifyBranchExists(branchName: string): Promise<void> {
    const { owner, repo } = this.config;

    try {
      await this.octokit.rest.repos.getBranch({
        owner,
        repo,
        branch: branchName
      });

      logger.debug('Branch verified', { owner, repo, branch: branchName });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (errorMessage.includes('404')) {
        throw new Error(
          `Branch '${branchName}' does not exist in ${owner}/${repo}. ` +
          'Push your changes before creating a pull request.'
        );
      }

      throw error;
    }
  }

  /**
   * Handle and format API errors with context
   *
   * @param message - Error message prefix
   * @param error - Original error
   * @param context - Additional context for logging
   * @throws {Error} Always throws with formatted message
   */
  private handleError(message: string, error: unknown, context: Record<string, unknown>): never {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Check for common GitHub API errors
    if (errorMessage.includes('401') || errorMessage.includes('Bad credentials')) {
      logger.error('GitHub authentication failed', {
        ...context,
        error: 'Invalid or expired token'
      });

      throw new Error(
        'GitHub authentication failed. Please verify your GitHub token:\n' +
        '1. Token must have "repo" scope for PR operations\n' +
        '2. Token must not be expired\n' +
        '3. Generate new token at: https://github.com/settings/tokens'
      );
    }

    if (errorMessage.includes('403') || errorMessage.includes('rate limit')) {
      logger.error('GitHub rate limit exceeded', { ...context, error: errorMessage });

      throw new Error(
        'GitHub API rate limit exceeded. Please wait before retrying.\n' +
        'Authenticated requests have a limit of 5,000 requests per hour.'
      );
    }

    if (errorMessage.includes('404')) {
      logger.error('GitHub resource not found', { ...context, error: errorMessage });

      throw new Error(
        `GitHub resource not found: ${context.owner}/${context.repo}\n` +
        'Verify that:\n' +
        '1. Repository exists and is accessible\n' +
        '2. Token has permission to access this repository\n' +
        '3. Owner/repo names are correct'
      );
    }

    if (errorMessage.includes('422')) {
      logger.error('GitHub validation error', { ...context, error: errorMessage });

      throw new Error(
        'GitHub validation error. This usually means:\n' +
        '1. Pull request already exists for this branch\n' +
        '2. Branch has no new commits\n' +
        '3. Invalid merge method or PR state'
      );
    }

    // Network errors
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ETIMEDOUT')) {
      logger.error('GitHub network error', { ...context, error: errorMessage });

      throw new Error(
        'Network error connecting to GitHub API. Please check:\n' +
        '1. Internet connection\n' +
        '2. Firewall settings\n' +
        '3. GitHub API status: https://www.githubstatus.com/'
      );
    }

    // Generic error
    logger.error(message, { ...context, error: errorMessage });
    throw new Error(`${message}: ${errorMessage}`);
  }
}
