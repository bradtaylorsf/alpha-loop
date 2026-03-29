/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LiveView } from "../../src/client/LiveView";

class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((msg: { data: string }) => void) | null = null;
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
});
