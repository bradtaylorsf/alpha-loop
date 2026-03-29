/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { App } from "../../src/client/App";

// Mock child components to isolate App tab navigation
jest.mock("../../src/client/LiveView", () => ({
  LiveView: () => <div data-testid="live-view">LiveView</div>,
}));
jest.mock("../../src/client/History", () => ({
  History: () => <div data-testid="history">History</div>,
}));
jest.mock("../../src/client/Config", () => ({
  Config: () => <div data-testid="config">Config</div>,
}));

// Stub EventSource for LiveView (even though mocked, jsdom doesn't have it)
beforeAll(() => {
  (global as any).EventSource = jest.fn().mockImplementation(() => ({
    onopen: null,
    onmessage: null,
    onerror: null,
    close: jest.fn(),
  }));
});

describe("App", () => {
  it("renders the title", () => {
    render(<App />);
    expect(screen.getByText("Alpha Loop")).toBeInTheDocument();
  });

  it("shows Live View tab by default", () => {
    render(<App />);
    expect(screen.getByTestId("live-view")).toBeInTheDocument();
    expect(screen.queryByTestId("history")).not.toBeInTheDocument();
    expect(screen.queryByTestId("config")).not.toBeInTheDocument();
  });

  it("switches to Run History tab", () => {
    render(<App />);
    fireEvent.click(screen.getByText("Run History"));
    expect(screen.getByTestId("history")).toBeInTheDocument();
    expect(screen.queryByTestId("live-view")).not.toBeInTheDocument();
  });

  it("switches to Config tab", () => {
    render(<App />);
    fireEvent.click(screen.getByText("Config"));
    expect(screen.getByTestId("config")).toBeInTheDocument();
    expect(screen.queryByTestId("live-view")).not.toBeInTheDocument();
  });

  it("renders all three navigation buttons", () => {
    render(<App />);
    expect(screen.getByText("Live View")).toBeInTheDocument();
    expect(screen.getByText("Run History")).toBeInTheDocument();
    expect(screen.getByText("Config")).toBeInTheDocument();
  });
});
