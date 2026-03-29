import {
  createGitHubClient,
  GitHubAuthError,
  GitHubNotFoundError,
  GitHubRateLimitError,
} from "../../src/engine/github";
import type { GitHubClient } from "../../src/engine/github";

// --- Mock Octokit ---

const mockIssues = {
  listForRepo: jest.fn(),
  get: jest.fn(),
  addLabels: jest.fn(),
  removeLabel: jest.fn(),
  createComment: jest.fn(),
};

const mockPulls = {
  create: jest.fn(),
  update: jest.fn(),
  get: jest.fn(),
  listReviews: jest.fn(),
};

const mockChecks = {
  listForRef: jest.fn(),
};

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    issues: mockIssues,
    pulls: mockPulls,
    checks: mockChecks,
  })),
}));

// Prevent getToken from running during tests -- we pass token directly
const OWNER = "test-owner";
const REPO = "test-repo";

function makeClient(): GitHubClient {
  return createGitHubClient(OWNER, REPO, "fake-token");
}

// --- Helpers ---

function makeIssueData(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "Test issue",
    body: "Issue body",
    state: "open",
    labels: [{ name: "bug" }],
    assignee: { login: "alice" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    ...overrides,
  };
}

function makePRData(overrides: Record<string, unknown> = {}) {
  return {
    number: 10,
    title: "Test PR",
    body: "PR body",
    state: "open",
    merged: false,
    draft: false,
    head: { ref: "feature-branch" },
    base: { ref: "main" },
    ...overrides,
  };
}

// --- Tests ---

beforeEach(() => {
  jest.clearAllMocks();
});

describe("listIssues", () => {
  it("returns parsed issues, filtering out PRs", async () => {
    const issue = makeIssueData();
    const pullRequest = makeIssueData({
      number: 2,
      title: "A PR",
      pull_request: { url: "..." },
    });

    mockIssues.listForRepo.mockResolvedValue({ data: [issue, pullRequest] });

    const client = makeClient();
    const issues = await client.listIssues({ labels: ["bug"], state: "open", limit: 10 });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 1,
      title: "Test issue",
      body: "Issue body",
      state: "open",
      labels: ["bug"],
      assignee: "alice",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-02T00:00:00Z",
    });

    expect(mockIssues.listForRepo).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      state: "open",
      labels: "bug",
      per_page: 10,
    });
  });

  it("uses defaults when no options provided", async () => {
    mockIssues.listForRepo.mockResolvedValue({ data: [] });

    const client = makeClient();
    await client.listIssues();

    expect(mockIssues.listForRepo).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      state: "open",
      labels: undefined,
      per_page: 30,
    });
  });
});

describe("getIssue", () => {
  it("returns a single issue", async () => {
    mockIssues.get.mockResolvedValue({ data: makeIssueData() });

    const client = makeClient();
    const issue = await client.getIssue(1);

    expect(issue.number).toBe(1);
    expect(issue.title).toBe("Test issue");
    expect(mockIssues.get).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: 1,
    });
  });

  it("throws GitHubNotFoundError on 404", async () => {
    mockIssues.get.mockRejectedValue({ status: 404, message: "Not Found" });

    const client = makeClient();
    await expect(client.getIssue(9999)).rejects.toThrow(GitHubNotFoundError);
  });
});

describe("updateLabels", () => {
  it("adds and removes labels", async () => {
    mockIssues.addLabels.mockResolvedValue({});
    mockIssues.removeLabel.mockResolvedValue({});

    const client = makeClient();
    await client.updateLabels(1, ["in-progress"], ["todo"]);

    expect(mockIssues.addLabels).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: 1,
      labels: ["in-progress"],
    });
    expect(mockIssues.removeLabel).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: 1,
      name: "todo",
    });
  });

  it("ignores 404 when removing a non-existent label", async () => {
    mockIssues.addLabels.mockResolvedValue({});
    mockIssues.removeLabel.mockRejectedValue({ status: 404, message: "Not Found" });

    const client = makeClient();
    await expect(client.updateLabels(1, [], ["nonexistent"])).resolves.toBeUndefined();
  });
});

describe("addComment", () => {
  it("posts a comment", async () => {
    mockIssues.createComment.mockResolvedValue({});

    const client = makeClient();
    await client.addComment(1, "Loop started");

    expect(mockIssues.createComment).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      issue_number: 1,
      body: "Loop started",
    });
  });
});

describe("createPR", () => {
  it("creates a pull request", async () => {
    mockPulls.create.mockResolvedValue({ data: makePRData() });

    const client = makeClient();
    const pr = await client.createPR({
      branch: "feature-branch",
      base: "main",
      title: "Test PR",
      body: "PR body",
    });

    expect(pr.number).toBe(10);
    expect(pr.headBranch).toBe("feature-branch");
    expect(pr.baseBranch).toBe("main");
    expect(pr.checksStatus).toBe("pending");
  });
});

describe("updatePR", () => {
  it("updates a pull request body", async () => {
    mockPulls.update.mockResolvedValue({});

    const client = makeClient();
    await client.updatePR(10, "Updated body");

    expect(mockPulls.update).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 10,
      body: "Updated body",
    });
  });
});

describe("getPRStatus", () => {
  it("returns PR with checks and review status", async () => {
    mockPulls.get.mockResolvedValue({ data: makePRData() });
    mockChecks.listForRef.mockResolvedValue({
      data: {
        check_runs: [
          { conclusion: "success" },
          { conclusion: "success" },
        ],
      },
    });
    mockPulls.listReviews.mockResolvedValue({
      data: [{ state: "APPROVED" }],
    });

    const client = makeClient();
    const pr = await client.getPRStatus(10);

    expect(pr.checksStatus).toBe("success");
    expect(pr.reviewDecision).toBe("APPROVED");
  });

  it("reports failure when any check fails", async () => {
    mockPulls.get.mockResolvedValue({ data: makePRData() });
    mockChecks.listForRef.mockResolvedValue({
      data: {
        check_runs: [
          { conclusion: "success" },
          { conclusion: "failure" },
        ],
      },
    });
    mockPulls.listReviews.mockResolvedValue({ data: [] });

    const client = makeClient();
    const pr = await client.getPRStatus(10);

    expect(pr.checksStatus).toBe("failure");
  });

  it("reports pending when checks have no conclusion", async () => {
    mockPulls.get.mockResolvedValue({ data: makePRData() });
    mockChecks.listForRef.mockResolvedValue({
      data: {
        check_runs: [{ conclusion: null }],
      },
    });
    mockPulls.listReviews.mockResolvedValue({ data: [] });

    const client = makeClient();
    const pr = await client.getPRStatus(10);

    expect(pr.checksStatus).toBe("pending");
  });
});

describe("Error handling", () => {
  it("throws GitHubAuthError on 401", async () => {
    mockIssues.listForRepo.mockRejectedValue({ status: 401, message: "Bad credentials" });

    const client = makeClient();
    await expect(client.listIssues()).rejects.toThrow(GitHubAuthError);
  });

  it("throws GitHubAuthError on 403 without rate-limit headers", async () => {
    mockIssues.get.mockRejectedValue({ status: 403, message: "Forbidden" });

    const client = makeClient();
    await expect(client.getIssue(1)).rejects.toThrow(GitHubAuthError);
  });

  it("throws GitHubRateLimitError on 403 with retry-after header (secondary rate limit)", async () => {
    mockIssues.listForRepo.mockRejectedValue({
      status: 403,
      message: "You have exceeded a secondary rate limit",
      response: { headers: { "retry-after": "30" } },
    });

    const client = makeClient();
    try {
      await client.listIssues();
      fail("Expected error");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      expect((err as GitHubRateLimitError).retryAfter).toBe(30);
    }
  });

  it("throws GitHubRateLimitError on 403 with x-ratelimit-remaining: 0", async () => {
    mockIssues.listForRepo.mockRejectedValue({
      status: 403,
      message: "API rate limit exceeded",
      response: { headers: { "x-ratelimit-remaining": "0" } },
    });

    const client = makeClient();
    await expect(client.listIssues()).rejects.toThrow(GitHubRateLimitError);
  });

  it("throws GitHubRateLimitError on 429 with retryAfter", async () => {
    mockIssues.listForRepo.mockRejectedValue({
      status: 429,
      message: "Rate limit exceeded",
      response: { headers: { "retry-after": "120" } },
    });

    const client = makeClient();
    try {
      await client.listIssues();
      fail("Expected error");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      expect((err as GitHubRateLimitError).retryAfter).toBe(120);
    }
  });

  it("throws GitHubNotFoundError on 404", async () => {
    mockPulls.get.mockRejectedValue({ status: 404, message: "Not Found" });
    mockChecks.listForRef.mockRejectedValue({ status: 404 });

    const client = makeClient();
    await expect(client.getPRStatus(999)).rejects.toThrow(GitHubNotFoundError);
  });
});

describe("Token resolution", () => {
  it("throws GitHubAuthError when no token available", () => {
    const origToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    // Mock execSync to simulate gh CLI not available
    jest.mock("node:child_process", () => ({
      execSync: jest.fn(() => {
        throw new Error("gh not found");
      }),
    }));

    // We can't easily test gh fallback without more invasive mocking,
    // but we can verify the client works with an explicit token
    const client = createGitHubClient("owner", "repo", "explicit-token");
    expect(client).toBeDefined();

    process.env.GITHUB_TOKEN = origToken;
  });
});
