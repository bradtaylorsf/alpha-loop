/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RunDetail } from "../../src/client/RunDetail";

beforeAll(() => {
  (global as any).EventSource = jest.fn().mockImplementation(() => ({
    onopen: null,
    onmessage: null,
    onerror: null,
    close: jest.fn(),
  }));
});

const mockRun = {
  id: 1,
  issue_number: 42,
  issue_title: "Fix the critical bug",
  agent: "claude",
  model: "sonnet",
  status: "success",
  stages_json: JSON.stringify(["setup", "implement", "test", "review", "pr", "done"]),
  stage_durations_json: JSON.stringify({ setup: 3, implement: 45, test: 12, review: 20, pr: 5 }),
  pr_url: "https://github.com/org/repo/pull/10",
  duration_seconds: 120,
  test_output: "Tests passed: 42\nFailed: 0",
  review_output: "No issues found. Code is clean.",
  diff_stat: " src/foo.ts | 10 ++++\n 1 file changed, 10 insertions(+)",
  created_at: "2026-03-20T10:00:00.000Z",
  learnings: [
    { id: 1, type: "pattern", content: "Good test coverage pattern", confidence: 0.8 },
    { id: 2, type: "anti_pattern", content: "Avoid large files", confidence: 0.6 },
  ],
};

describe("RunDetail", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as any;
    render(<RunDetail runId={1} onBack={jest.fn()} />);
    expect(screen.getByText("Loading run details...")).toBeInTheDocument();
  });

  it("renders run details when data is fetched", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("#42")).toBeInTheDocument();
    });

    expect(screen.getByText("Fix the critical bug")).toBeInTheDocument();
    expect(screen.getByTestId("run-status")).toHaveTextContent("success");
    expect(screen.getByText("Agent: claude/sonnet")).toBeInTheDocument();
    expect(screen.getByText("Duration: 2m 0s")).toBeInTheDocument();
  });

  it("shows timeline with stage durations", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("timeline-tab")).toBeInTheDocument();
    });

    // Stages should be visible
    expect(screen.getByText("setup")).toBeInTheDocument();
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();

    // Durations should be visible
    expect(screen.getByText("3s")).toBeInTheDocument();
    expect(screen.getByText("45s")).toBeInTheDocument();
    expect(screen.getByText("12s")).toBeInTheDocument();
  });

  it("shows learnings in timeline tab", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Learnings (2)")).toBeInTheDocument();
    });

    expect(screen.getByText("Good test coverage pattern")).toBeInTheDocument();
    expect(screen.getByText("Avoid large files")).toBeInTheDocument();
  });

  it("shows test output tab", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Fix the critical bug")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Test Output"));
    expect(screen.getByTestId("tests-tab")).toBeInTheDocument();
    expect(screen.getByText(/Tests passed: 42/)).toBeInTheDocument();
  });

  it("shows review output tab", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Fix the critical bug")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Review"));
    expect(screen.getByTestId("review-tab")).toBeInTheDocument();
    expect(screen.getByText(/No issues found/)).toBeInTheDocument();
  });

  it("shows diff summary tab", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Fix the critical bug")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Diff Summary"));
    expect(screen.getByTestId("diff-tab")).toBeInTheDocument();
    expect(screen.getByText(/src\/foo.ts/)).toBeInTheDocument();
  });

  it("links to GitHub issue and PR", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Pull Request")).toBeInTheDocument();
    });

    const prLink = screen.getByText("Pull Request");
    expect(prLink).toHaveAttribute("href", "https://github.com/org/repo/pull/10");
  });

  it("calls onBack when back button is clicked", async () => {
    const onBack = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockRun),
    }) as any;

    render(<RunDetail runId={1} onBack={onBack} />);

    await waitFor(() => {
      expect(screen.getByTestId("back-button")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("back-button"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("shows error state on fetch failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Error: HTTP 500")).toBeInTheDocument();
    });
  });

  it("shows empty state for missing test/review/diff", async () => {
    const emptyRun = {
      ...mockRun,
      test_output: null,
      review_output: null,
      diff_stat: null,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(emptyRun),
    }) as any;

    render(<RunDetail runId={1} onBack={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Fix the critical bug")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Test Output"));
    expect(screen.getByText("No test output recorded")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Review"));
    expect(screen.getByText("No review output recorded")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Diff Summary"));
    expect(screen.getByText("No diff summary recorded")).toBeInTheDocument();
  });
});
