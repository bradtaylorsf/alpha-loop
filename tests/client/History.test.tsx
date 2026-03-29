/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { History } from "../../src/client/History";

let mockESInstance: any;

beforeAll(() => {
  (global as any).EventSource = jest.fn().mockImplementation(() => {
    mockESInstance = {
      onopen: null,
      onmessage: null,
      onerror: null,
      close: jest.fn(),
    };
    return mockESInstance;
  });
});

describe("History", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as any;
    render(<History />);
    expect(screen.getByText("Loading runs...")).toBeInTheDocument();
  });

  it("renders runs table when data is fetched", async () => {
    const mockRuns = {
      runs: [
        {
          id: 1,
          issue_number: 42,
          issue_title: "Fix the bug",
          agent: "claude",
          model: "sonnet",
          status: "success",
          stages_json: "[]",
          stage_durations_json: "{}",
          pr_url: "https://github.com/org/repo/pull/1",
          duration_seconds: 120,
          diff_stat: " 2 files changed, 10 insertions(+), 3 deletions(-)",
          created_at: "2025-01-01T00:00:00.000Z",
        },
        {
          id: 2,
          issue_number: 43,
          issue_title: "Add feature",
          agent: "claude",
          model: "opus",
          status: "failure",
          stages_json: "[]",
          stage_durations_json: "{}",
          pr_url: null,
          duration_seconds: null,
          diff_stat: null,
          created_at: "2025-01-02T00:00:00.000Z",
        },
      ],
      total: 2,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRuns),
    }) as any;

    render(<History />);

    await waitFor(() => {
      expect(screen.getByText("#42")).toBeInTheDocument();
    });

    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
    expect(screen.getByText("#43")).toBeInTheDocument();
    expect(screen.getByText("Add feature")).toBeInTheDocument();
    expect(screen.getByText("2 total")).toBeInTheDocument();

    const badges = screen.getAllByTestId("status-badge");
    expect(badges[0]).toHaveTextContent("success");
    expect(badges[1]).toHaveTextContent("failure");

    expect(screen.getByText("2m 0s")).toBeInTheDocument();
    const prLink = screen.getByRole("link", { name: "PR" });
    expect(prLink).toHaveAttribute("href", "https://github.com/org/repo/pull/1");
  });

  it("shows empty state when no runs", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runs: [], total: 0 }),
    }) as any;

    render(<History />);

    await waitFor(() => {
      expect(screen.getByText("No runs yet")).toBeInTheDocument();
    });
  });

  it("does not render javascript: URLs as links", async () => {
    const mockRuns = {
      runs: [
        {
          id: 1,
          issue_number: 99,
          issue_title: "XSS test",
          agent: "claude",
          model: "sonnet",
          status: "success",
          stages_json: "[]",
          stage_durations_json: "{}",
          pr_url: "javascript:alert(1)",
          duration_seconds: 10,
          diff_stat: null,
          created_at: "2025-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRuns),
    }) as any;

    render(<History />);

    await waitFor(() => {
      expect(screen.getByText("#99")).toBeInTheDocument();
    });

    expect(screen.queryByRole("link", { name: "PR" })).not.toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "Server error" }),
    }) as any;

    render(<History />);

    await waitFor(() => {
      expect(screen.getByText("Error: HTTP 500")).toBeInTheDocument();
    });
  });

  it("renders filter controls", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ runs: [], total: 0 }),
    }) as any;

    render(<History />);

    await waitFor(() => {
      expect(screen.getByTestId("filter-row")).toBeInTheDocument();
    });

    expect(screen.getByTestId("search-input")).toBeInTheDocument();
    expect(screen.getByTestId("status-filter")).toBeInTheDocument();
  });

  it("renders Changes column with diff summary", async () => {
    const mockRuns = {
      runs: [
        {
          id: 1,
          issue_number: 42,
          issue_title: "Fix the bug",
          agent: "claude",
          model: "sonnet",
          status: "success",
          stages_json: "[]",
          stage_durations_json: "{}",
          pr_url: "https://github.com/org/repo/pull/1",
          duration_seconds: 120,
          diff_stat: " src/foo.ts | 10 ++++\n 1 file changed, 10 insertions(+)",
          created_at: "2025-01-01T00:00:00.000Z",
        },
      ],
      total: 1,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRuns),
    }) as any;

    render(<History />);

    await waitFor(() => {
      expect(screen.getByText("#42")).toBeInTheDocument();
    });

    expect(screen.getByText("Changes")).toBeInTheDocument();
    expect(screen.getByText("1 file changed, 10 insertions(+)")).toBeInTheDocument();
  });
});
