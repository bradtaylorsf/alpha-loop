import { Octokit } from "@octokit/rest";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  assignees: string[];
  created_at: string;
  updated_at: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  head: string;
  base: string;
  merged: boolean;
  draft: boolean;
  url: string;
}

export interface PRStatus {
  number: number;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  reviewDecision: string | null;
  checks: "success" | "failure" | "pending" | "unknown";
}

export interface GitHubClientConfig {
  owner: string;
  repo: string;
  token?: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function resolveToken(token?: string): string {
  if (token) return token;

  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  try {
    const ghToken = execSync("gh auth token", { encoding: "utf-8" }).trim();
    if (ghToken) return ghToken;
  } catch {
    // gh CLI not available or not authenticated
  }

  throw new GitHubError(
    "No GitHub token found. Set GITHUB_TOKEN env var or authenticate with `gh auth login`.",
    401,
    "auth",
  );
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function createClient(token: string): Octokit {
  return new Octokit({ auth: token });
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

function handleApiError(err: unknown, method: string): never {
  if (err instanceof GitHubError) throw err;

  const status = (err as { status?: number }).status ?? 500;
  const message = (err as { message?: string }).message ?? "Unknown error";

  if (status === 403 && message.toLowerCase().includes("rate limit")) {
    throw new GitHubError(
      `GitHub API rate limit exceeded during ${method}`,
      403,
      method,
    );
  }

  if (status === 401) {
    throw new GitHubError(
      `GitHub authentication failed during ${method}`,
      401,
      method,
    );
  }

  throw new GitHubError(`GitHub API error during ${method}: ${message}`, status, method);
}

// ---------------------------------------------------------------------------
// Issue operations
// ---------------------------------------------------------------------------

export async function listIssues(
  config: GitHubClientConfig,
  options: { labels?: string[]; state?: "open" | "closed" | "all"; limit?: number } = {},
): Promise<GitHubIssue[]> {
  const { labels, state = "open", limit = 30 } = options;
  const token = resolveToken(config.token);
  const client = createClient(token);

  try {
    const response = await client.issues.listForRepo({
      owner: config.owner,
      repo: config.repo,
      state,
      labels: labels?.join(","),
      per_page: limit,
    });

    // Filter out pull requests (GitHub API returns PRs in issues endpoint)
    return response.data
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        state: issue.state,
        labels: issue.labels.map((l) =>
          typeof l === "string" ? l : l.name ?? "",
        ),
        assignees: issue.assignees?.map((a) => a.login) ?? [],
        created_at: issue.created_at,
        updated_at: issue.updated_at,
      }));
  } catch (err) {
    handleApiError(err, "listIssues");
  }
}

export async function getIssue(
  config: GitHubClientConfig,
  number: number,
): Promise<GitHubIssue> {
  const token = resolveToken(config.token);
  const client = createClient(token);

  try {
    const { data: issue } = await client.issues.get({
      owner: config.owner,
      repo: config.repo,
      issue_number: number,
    });

    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state,
      labels: issue.labels.map((l) =>
        typeof l === "string" ? l : l.name ?? "",
      ),
      assignees: issue.assignees?.map((a) => a.login) ?? [],
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    };
  } catch (err) {
    handleApiError(err, "getIssue");
  }
}

export async function updateLabels(
  config: GitHubClientConfig,
  number: number,
  add: string[],
  remove: string[],
): Promise<void> {
  const token = resolveToken(config.token);
  const client = createClient(token);

  try {
    // Add labels
    if (add.length > 0) {
      await client.issues.addLabels({
        owner: config.owner,
        repo: config.repo,
        issue_number: number,
        labels: add,
      });
    }

    // Remove labels
    for (const label of remove) {
      try {
        await client.issues.removeLabel({
          owner: config.owner,
          repo: config.repo,
          issue_number: number,
          name: label,
        });
      } catch (err) {
        // Ignore 404 -- label might not be present
        if ((err as { status?: number }).status !== 404) throw err;
      }
    }
  } catch (err) {
    handleApiError(err, "updateLabels");
  }
}

export async function addComment(
  config: GitHubClientConfig,
  number: number,
  body: string,
): Promise<void> {
  const token = resolveToken(config.token);
  const client = createClient(token);

  try {
    await client.issues.createComment({
      owner: config.owner,
      repo: config.repo,
      issue_number: number,
      body,
    });
  } catch (err) {
    handleApiError(err, "addComment");
  }
}

// ---------------------------------------------------------------------------
// PR operations
// ---------------------------------------------------------------------------

export async function createPR(
  config: GitHubClientConfig,
  options: { branch: string; base: string; title: string; body: string },
): Promise<GitHubPR> {
  const token = resolveToken(config.token);
  const client = createClient(token);

  try {
    const { data: pr } = await client.pulls.create({
      owner: config.owner,
      repo: config.repo,
      head: options.branch,
      base: options.base,
      title: options.title,
      body: options.body,
    });

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      head: pr.head.ref,
      base: pr.base.ref,
      merged: pr.merged,
      draft: pr.draft ?? false,
      url: pr.html_url,
    };
  } catch (err) {
    handleApiError(err, "createPR");
  }
}

export async function updatePR(
  config: GitHubClientConfig,
  number: number,
  body: string,
): Promise<void> {
  const token = resolveToken(config.token);
  const client = createClient(token);

  try {
    await client.pulls.update({
      owner: config.owner,
      repo: config.repo,
      pull_number: number,
      body,
    });
  } catch (err) {
    handleApiError(err, "updatePR");
  }
}

export async function getPRStatus(
  config: GitHubClientConfig,
  number: number,
): Promise<PRStatus> {
  const token = resolveToken(config.token);
  const client = createClient(token);

  try {
    const { data: pr } = await client.pulls.get({
      owner: config.owner,
      repo: config.repo,
      pull_number: number,
    });

    // Get combined status for the head commit
    let checks: PRStatus["checks"] = "unknown";
    try {
      const { data: status } = await client.repos.getCombinedStatusForRef({
        owner: config.owner,
        repo: config.repo,
        ref: pr.head.sha,
      });
      checks =
        status.state === "success"
          ? "success"
          : status.state === "failure"
            ? "failure"
            : status.state === "pending"
              ? "pending"
              : "unknown";
    } catch {
      // No status checks configured
    }

    // Get review decision via reviews list
    let reviewDecision: string | null = null;
    try {
      const { data: reviews } = await client.pulls.listReviews({
        owner: config.owner,
        repo: config.repo,
        pull_number: number,
      });
      if (reviews.length > 0) {
        const lastReview = reviews[reviews.length - 1];
        reviewDecision = lastReview.state;
      }
    } catch {
      // No reviews
    }

    return {
      number: pr.number,
      state: pr.state,
      merged: pr.merged,
      mergeable: pr.mergeable,
      reviewDecision,
      checks,
    };
  } catch (err) {
    handleApiError(err, "getPRStatus");
  }
}
