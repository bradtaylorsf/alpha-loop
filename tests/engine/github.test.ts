import {
  listIssues,
  getIssue,
  updateLabels,
  addComment,
  createPR,
  updatePR,
  getPRStatus,
  GitHubError,
  type GitHubClientConfig,
} from "../../src/engine/github";

// ---------------------------------------------------------------------------
// Mock Octokit
// ---------------------------------------------------------------------------

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

const mockRepos = {
  getCombinedStatusForRef: jest.fn(),
};

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    issues: mockIssues,
    pulls: mockPulls,
    repos: mockRepos,
  })),
}));

jest.mock("node:child_process", () => ({
  execSync: jest.fn().mockReturnValue("ghp_test_token\n"),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config: GitHubClientConfig = {
  owner: "testowner",
  repo: "testrepo",
  token: "ghp_test123",
};

const mockIssueData = {
  number: 1,
  title: "Test issue",
  body: "Issue body",
  state: "open",
  labels: [{ name: "bug" }, { name: "ready" }],
  assignees: [{ login: "alice" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  pull_request: undefined,
};

const mockPRData = {
  number: 10,
  title: "feat: test PR",
  body: "PR body",
  state: "open",
  head: { ref: "feature-branch", sha: "abc123" },
  base: { ref: "master" },
  merged: false,
  draft: false,
  html_url: "https://github.com/testowner/testrepo/pull/10",
  mergeable: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

describe("listIssues", () => {
  it("returns issues matching criteria", async () => {
    mockIssues.listForRepo.mockResolvedValue({
      data: [mockIssueData],
    });

    const issues = await listIssues(config, {
      labels: ["bug"],
      state: "open",
      limit: 10,
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 1,
      title: "Test issue",
      body: "Issue body",
      state: "open",
      labels: ["bug", "ready"],
      assignees: ["alice"],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    });

    expect(mockIssues.listForRepo).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      state: "open",
      labels: "bug",
      per_page: 10,
    });
  });

  it("filters out pull requests from issues response", async () => {
    mockIssues.listForRepo.mockResolvedValue({
      data: [
        mockIssueData,
        { ...mockIssueData, number: 2, pull_request: { url: "..." } },
      ],
    });

    const issues = await listIssues(config);
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(1);
  });

  it("uses default options when none provided", async () => {
    mockIssues.listForRepo.mockResolvedValue({ data: [] });

    await listIssues(config);

    expect(mockIssues.listForRepo).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      state: "open",
      labels: undefined,
      per_page: 30,
    });
  });
});

describe("getIssue", () => {
  it("returns full issue with body", async () => {
    mockIssues.get.mockResolvedValue({ data: mockIssueData });

    const issue = await getIssue(config, 1);

    expect(issue.number).toBe(1);
    expect(issue.body).toBe("Issue body");
    expect(issue.labels).toEqual(["bug", "ready"]);
    expect(mockIssues.get).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      issue_number: 1,
    });
  });

  it("throws GitHubError on 404", async () => {
    mockIssues.get.mockRejectedValue({ status: 404, message: "Not Found" });

    await expect(getIssue(config, 999)).rejects.toThrow(GitHubError);
    await expect(getIssue(config, 999)).rejects.toMatchObject({
      status: 404,
      method: "getIssue",
    });
  });
});

describe("updateLabels", () => {
  it("adds and removes labels", async () => {
    mockIssues.addLabels.mockResolvedValue({ data: [] });
    mockIssues.removeLabel.mockResolvedValue({ data: [] });

    await updateLabels(config, 1, ["in-progress"], ["ready"]);

    expect(mockIssues.addLabels).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      issue_number: 1,
      labels: ["in-progress"],
    });

    expect(mockIssues.removeLabel).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      issue_number: 1,
      name: "ready",
    });
  });

  it("ignores 404 when removing a label not present", async () => {
    mockIssues.removeLabel.mockRejectedValue({ status: 404 });

    await expect(
      updateLabels(config, 1, [], ["nonexistent"]),
    ).resolves.toBeUndefined();
  });

  it("skips addLabels call when add array is empty", async () => {
    mockIssues.removeLabel.mockResolvedValue({ data: [] });

    await updateLabels(config, 1, [], ["ready"]);

    expect(mockIssues.addLabels).not.toHaveBeenCalled();
  });
});

describe("addComment", () => {
  it("posts a comment on an issue", async () => {
    mockIssues.createComment.mockResolvedValue({ data: {} });

    await addComment(config, 1, "Build started");

    expect(mockIssues.createComment).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      issue_number: 1,
      body: "Build started",
    });
  });
});

describe("createPR", () => {
  it("creates a pull request", async () => {
    mockPulls.create.mockResolvedValue({ data: mockPRData });

    const pr = await createPR(config, {
      branch: "feature-branch",
      base: "master",
      title: "feat: test PR",
      body: "PR body",
    });

    expect(pr.number).toBe(10);
    expect(pr.url).toBe("https://github.com/testowner/testrepo/pull/10");
    expect(pr.head).toBe("feature-branch");
    expect(pr.base).toBe("master");

    expect(mockPulls.create).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      head: "feature-branch",
      base: "master",
      title: "feat: test PR",
      body: "PR body",
    });
  });
});

describe("updatePR", () => {
  it("updates an existing PR body", async () => {
    mockPulls.update.mockResolvedValue({ data: {} });

    await updatePR(config, 10, "Updated body");

    expect(mockPulls.update).toHaveBeenCalledWith({
      owner: "testowner",
      repo: "testrepo",
      pull_number: 10,
      body: "Updated body",
    });
  });
});

describe("getPRStatus", () => {
  it("returns PR status with checks and review decision", async () => {
    mockPulls.get.mockResolvedValue({ data: mockPRData });
    mockRepos.getCombinedStatusForRef.mockResolvedValue({
      data: { state: "success" },
    });
    mockPulls.listReviews.mockResolvedValue({
      data: [{ state: "APPROVED" }],
    });

    const status = await getPRStatus(config, 10);

    expect(status).toEqual({
      number: 10,
      state: "open",
      merged: false,
      mergeable: true,
      reviewDecision: "APPROVED",
      checks: "success",
    });
  });

  it("handles missing status checks gracefully", async () => {
    mockPulls.get.mockResolvedValue({ data: mockPRData });
    mockRepos.getCombinedStatusForRef.mockRejectedValue(new Error("Not found"));
    mockPulls.listReviews.mockResolvedValue({ data: [] });

    const status = await getPRStatus(config, 10);

    expect(status.checks).toBe("unknown");
    expect(status.reviewDecision).toBeNull();
  });
});

describe("error handling", () => {
  it("throws GitHubError on rate limit", async () => {
    mockIssues.listForRepo.mockRejectedValue({
      status: 403,
      message: "API rate limit exceeded",
    });

    await expect(listIssues(config)).rejects.toThrow(GitHubError);
    await expect(listIssues(config)).rejects.toMatchObject({
      status: 403,
      method: "listIssues",
    });
  });

  it("throws GitHubError on auth failure", async () => {
    mockIssues.listForRepo.mockRejectedValue({
      status: 401,
      message: "Bad credentials",
    });

    await expect(listIssues(config)).rejects.toThrow(GitHubError);
    await expect(listIssues(config)).rejects.toMatchObject({
      status: 401,
      method: "listIssues",
    });
  });

  it("wraps unknown errors in GitHubError", async () => {
    mockPulls.create.mockRejectedValue({
      status: 422,
      message: "Validation failed",
    });

    await expect(
      createPR(config, {
        branch: "x",
        base: "master",
        title: "t",
        body: "b",
      }),
    ).rejects.toThrow(GitHubError);
  });
});

describe("auth resolution", () => {
  it("throws when no token is available", async () => {
    const { execSync } = jest.requireMock("node:child_process");
    execSync.mockImplementation(() => {
      throw new Error("gh not found");
    });

    const noTokenConfig: GitHubClientConfig = {
      owner: "testowner",
      repo: "testrepo",
    };
    const originalEnv = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;

    await expect(listIssues(noTokenConfig)).rejects.toThrow(GitHubError);
    await expect(listIssues(noTokenConfig)).rejects.toMatchObject({
      status: 401,
    });

    process.env.GITHUB_TOKEN = originalEnv;
    execSync.mockReturnValue("ghp_test_token\n");
  });
});
