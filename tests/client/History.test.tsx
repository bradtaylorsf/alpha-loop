/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { History } from "../../src/client/History";

beforeAll(() => {
  (global as any).EventSource = jest.fn().mockImplementation(() => ({
    onopen: null,
    onmessage: null,
    onerror: null,
    close: jest.fn(),
  }));
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
          pr_url: "https://github.com/org/repo/pull/1",
          duration_seconds: 120,
          created_at: "2025-01-01T00:00:00.000Z",
        },
        {
          id: 2,
          issue_number: 43,
          issue_title: "Add feature",
          agent: "claude",
          model: "opus",
          status: "failure",
          pr_url: null,
          duration_seconds: null,
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
});
