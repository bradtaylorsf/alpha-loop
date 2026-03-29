import { Octokit } from "@octokit/rest";
import { execSync } from "node:child_process";

// --- Types ---

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged: boolean;
  draft: boolean;
  headBranch: string;
  baseBranch: string;
  checksStatus: "pending" | "success" | "failure" | "neutral";
  reviewDecision: string | null;
}

export interface GitHubClient {
  listIssues(options?: {
    labels?: string[];
    state?: "open" | "closed" | "all";
    limit?: number;
  }): Promise<GitHubIssue[]>;

  getIssue(number: number): Promise<GitHubIssue>;

  updateLabels(
    number: number,
    add: string[],
    remove: string[],
  ): Promise<void>;

  addComment(number: number, body: string): Promise<void>;

  createPR(options: {
    branch: string;
    base: string;
    title: string;
    body: string;
  }): Promise<GitHubPR>;

  updatePR(number: number, body: string): Promise<void>;

  getPRStatus(number: number): Promise<GitHubPR>;
}

// --- Error types ---

export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export class GitHubRateLimitError extends Error {
  retryAfter: number;
  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = "GitHubRateLimitError";
    this.retryAfter = retryAfter;
  }
}

export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubNotFoundError";
  }
}

// --- Helpers ---

function getToken(): string {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }

  try {
    const token = execSync("gh auth token", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (token) return token;
  } catch {
    // gh CLI not available or not authenticated
  }

  throw new GitHubAuthError(
    "No GitHub token found. Set GITHUB_TOKEN or authenticate with `gh auth login`.",
  );
}

function parseIssue(data: {
  number: number;
  title: string;
  body?: string | null;
  state?: string;
  labels?: Array<string | { name?: string }>;
  assignee?: { login: string } | null;
  created_at: string;
  updated_at: string;
}): GitHubIssue {
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? null,
    state: data.state ?? "open",
    labels: (data.labels ?? []).map((l) =>
      typeof l === "string" ? l : l.name ?? "",
    ),
    assignee: data.assignee?.login ?? null,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

function handleApiError(err: unknown): never {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status: number }).status;
    const message =
      (err as { message?: string }).message ?? "GitHub API error";

    if (status === 401) {
      throw new GitHubAuthError(message);
    }
    if (status === 404) {
      throw new GitHubNotFoundError(message);
    }

    // 429 is primary rate limit; 403 with retry-after or rate-limit
    // headers is GitHub's secondary rate limit
    const headers = (err as { response?: { headers?: Record<string, string> } })
      .response?.headers;

    if (status === 429) {
      const retryAfter = parseInt(headers?.["retry-after"] ?? "60", 10);
      throw new GitHubRateLimitError(message, retryAfter);
    }
    if (status === 403) {
      const retryAfter = headers?.["retry-after"];
      const rateLimitRemaining = headers?.["x-ratelimit-remaining"];
      if (retryAfter || rateLimitRemaining === "0") {
        throw new GitHubRateLimitError(
          message,
          parseInt(retryAfter ?? "60", 10),
        );
      }
      throw new GitHubAuthError(message);
    }
  }
  throw err;
}

// --- Client factory ---

export function createGitHubClient(
  owner: string,
  repo: string,
  token?: string,
): GitHubClient {
  const authToken = token ?? getToken();
  const octokit = new Octokit({ auth: authToken });

  return {
    async listIssues(options = {}) {
      const { labels, state = "open", limit = 30 } = options;
      try {
        const response = await octokit.issues.listForRepo({
          owner,
          repo,
          state,
          labels: labels?.join(","),
          per_page: limit,
        });

        // Filter out pull requests (GitHub API includes PRs in issues)
        return response.data
          .filter((issue) => !issue.pull_request)
          .map(parseIssue);
      } catch (err) {
        handleApiError(err);
      }
    },

    async getIssue(number) {
      try {
        const response = await octokit.issues.get({ owner, repo, issue_number: number });
        return parseIssue(response.data);
      } catch (err) {
        handleApiError(err);
      }
    },

    async updateLabels(number, add, remove) {
      try {
        const addPromises = add.map((label) =>
          octokit.issues.addLabels({ owner, repo, issue_number: number, labels: [label] }),
        );

        const removePromises = remove.map((label) =>
          octokit.issues.removeLabel({ owner, repo, issue_number: number, name: label }).catch((err) => {
            // Ignore 404 when removing a label that doesn't exist
            if (
              typeof err === "object" &&
              err !== null &&
              "status" in err &&
              (err as { status: number }).status === 404
            ) {
              return;
            }
            throw err;
          }),
        );

        await Promise.all([...addPromises, ...removePromises]);
      } catch (err) {
        handleApiError(err);
      }
    },

    async addComment(number, body) {
      try {
        await octokit.issues.createComment({ owner, repo, issue_number: number, body });
      } catch (err) {
        handleApiError(err);
      }
    },

    async createPR(options) {
      try {
        const response = await octokit.pulls.create({
          owner,
          repo,
          head: options.branch,
          base: options.base,
          title: options.title,
          body: options.body,
        });

        return {
          number: response.data.number,
          title: response.data.title,
          body: response.data.body ?? null,
          state: response.data.state,
          merged: response.data.merged,
          draft: response.data.draft ?? false,
          headBranch: response.data.head.ref,
          baseBranch: response.data.base.ref,
          checksStatus: "pending" as const,
          reviewDecision: null,
        };
      } catch (err) {
        handleApiError(err);
      }
    },

    async updatePR(number, body) {
      try {
        await octokit.pulls.update({ owner, repo, pull_number: number, body });
      } catch (err) {
        handleApiError(err);
      }
    },

    async getPRStatus(number) {
      try {
        const [pr, checks] = await Promise.all([
          octokit.pulls.get({ owner, repo, pull_number: number }),
          octokit.checks
            .listForRef({ owner, repo, ref: `pull/${number}/head` })
            .catch(() => null),
        ]);

        let checksStatus: "pending" | "success" | "failure" | "neutral" = "pending";
        if (checks?.data.check_runs.length) {
          const conclusions = checks.data.check_runs.map((c) => c.conclusion);
          if (conclusions.every((c) => c === "success")) {
            checksStatus = "success";
          } else if (conclusions.some((c) => c === "failure")) {
            checksStatus = "failure";
          } else if (conclusions.every((c) => c !== null)) {
            checksStatus = "neutral";
          }
        }

        // Review decision from the reviews endpoint
        let reviewDecision: string | null = null;
        try {
          const reviews = await octokit.pulls.listReviews({
            owner,
            repo,
            pull_number: number,
          });
          const latestReview = reviews.data[reviews.data.length - 1];
          reviewDecision = latestReview?.state ?? null;
        } catch {
          // Reviews not available
        }

        return {
          number: pr.data.number,
          title: pr.data.title,
          body: pr.data.body ?? null,
          state: pr.data.merged ? "merged" : pr.data.state,
          merged: pr.data.merged,
          draft: pr.data.draft ?? false,
          headBranch: pr.data.head.ref,
          baseBranch: pr.data.base.ref,
          checksStatus,
          reviewDecision,
        };
      } catch (err) {
        handleApiError(err);
      }
    },
  };
}
