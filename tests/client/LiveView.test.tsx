/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LiveView } from "../../src/client/LiveView";

class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = jest.fn();

  constructor(public url: string) {
    MockEventSource.instance = this;
  }

  static instance: MockEventSource;
}

beforeAll(() => {
  (global as any).EventSource = MockEventSource;
});

describe("LiveView", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders waiting state initially", () => {
    render(<LiveView />);
    expect(screen.getByText("Waiting for events...")).toBeInTheDocument();
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("connects to SSE and shows connected status", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
    });

    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("displays output events in the log", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({ type: "output", data: { line: "Building project...", timestamp: new Date().toISOString() } }),
      });
    });

    expect(screen.getByText("Building project...")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for events...")).not.toBeInTheDocument();
  });

  it("displays stage events with issue number", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "stage",
          data: { issue: 42, stage: "implement", timestamp: new Date().toISOString() },
        }),
      });
    });

    expect(screen.getByText("#42")).toBeInTheDocument();
    expect(screen.getByText("implement")).toBeInTheDocument();
    expect(screen.getByText("[stage] #42 → implement")).toBeInTheDocument();
  });

  it("displays test events", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "test",
          data: { passed: 10, failed: 2, timestamp: new Date().toISOString() },
        }),
      });
    });

    expect(screen.getByText("[test] passed: 10, failed: 2")).toBeInTheDocument();
  });

  it("displays error events", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "error",
          data: { message: "Something broke", stage: "test", timestamp: new Date().toISOString() },
        }),
      });
    });

    expect(screen.getByText("[error] test: Something broke")).toBeInTheDocument();
  });

  it("displays complete events", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "complete",
          data: { issue: 42, prUrl: "https://github.com/pr/1", duration: 120 },
        }),
      });
    });

    expect(screen.getByText("[complete] #42 → https://github.com/pr/1 (120s)")).toBeInTheDocument();
  });

  it("shows disconnected on SSE error", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
    });
    expect(screen.getByText("Connected")).toBeInTheDocument();

    act(() => {
      es.onerror?.();
    });
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("connects to the correct SSE endpoint", () => {
    render(<LiveView />);
    expect(MockEventSource.instance.url).toBe("/api/stream");
  });

  it("shows pipeline progress when stage is active", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "stage",
          data: { issue: 10, stage: "implement", timestamp: new Date().toISOString() },
        }),
      });
    });

    expect(screen.getByTestId("pipeline-progress")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-dot-setup")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-dot-implement")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-dot-done")).toBeInTheDocument();
  });

  it("does not show pipeline progress in idle state", () => {
    render(<LiveView />);
    expect(screen.queryByTestId("pipeline-progress")).not.toBeInTheDocument();
  });

  it("displays stage_complete events with duration", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "stage_complete",
          data: { issue: 10, stage: "setup", duration: 5, timestamp: new Date().toISOString() },
        }),
      });
    });

    expect(screen.getByText("[stage_complete] setup (5s)")).toBeInTheDocument();
  });

  it("displays test_result events with attempt info", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "test_result",
          data: { passed: 1, failed: 0, attempt: 2, maxAttempts: 3, timestamp: new Date().toISOString() },
        }),
      });
    });

    expect(screen.getByText("[test] attempt 2/3 — passed: 1, failed: 0")).toBeInTheDocument();
  });

  it("shows toast on complete event", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "complete",
          data: { issue: 42, prUrl: "https://github.com/pr/1", duration: 120 },
        }),
      });
    });

    expect(screen.getByTestId("toast-container")).toBeInTheDocument();
    const toasts = screen.getAllByTestId("toast");
    expect(toasts.length).toBeGreaterThanOrEqual(1);
    expect(toasts[0]).toHaveTextContent("Issue #42 completed");
  });

  it("shows toast on error event", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      es.onmessage?.({
        data: JSON.stringify({
          type: "error",
          data: { message: "Build failed", stage: "implement", timestamp: new Date().toISOString() },
        }),
      });
    });

    const toasts = screen.getAllByTestId("toast");
    expect(toasts.length).toBeGreaterThanOrEqual(1);
    expect(toasts[0]).toHaveTextContent("Failed at implement");
  });

  it("displays per-stage duration in pipeline when stage_start and stage_complete are received", () => {
    render(<LiveView />);
    const es = MockEventSource.instance;

    act(() => {
      es.onopen?.();
      // First show a stage so pipeline renders
      es.onmessage?.({
        data: JSON.stringify({
          type: "stage",
          data: { issue: 10, stage: "test", timestamp: new Date().toISOString() },
        }),
      });
      // Then complete setup
      es.onmessage?.({
        data: JSON.stringify({
          type: "stage_start",
          data: { issue: 10, stage: "setup", timestamp: new Date().toISOString() },
        }),
      });
      es.onmessage?.({
        data: JSON.stringify({
          type: "stage_complete",
          data: { issue: 10, stage: "setup", duration: 3, timestamp: new Date().toISOString() },
        }),
      });
    });

    // The pipeline should show the 3s duration for setup
    expect(screen.getByText("3s")).toBeInTheDocument();
  });
});
