/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { Config } from "../../src/client/Config";

const mockConfig = {
  loop: { repo: "test/repo", baseBranch: "main", pollInterval: 60 },
  agent: { name: "claude", model: "sonnet" },
};

beforeAll(() => {
  (global as any).EventSource = jest.fn().mockImplementation(() => ({
    onopen: null,
    onmessage: null,
    onerror: null,
    close: jest.fn(),
  }));
});

describe("Config", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("shows loading state initially", () => {
    global.fetch = jest.fn(() => new Promise(() => {})) as any;
    render(<Config />);
    expect(screen.getByText("Loading config...")).toBeInTheDocument();
  });

  it("renders config as JSON when loaded", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockConfig),
    }) as any;

    render(<Config />);

    await waitFor(() => {
      expect(screen.getByTestId("config-view")).toBeInTheDocument();
    });

    expect(screen.getByTestId("config-view")).toHaveTextContent("test/repo");
  });

  it("enters edit mode and shows textarea", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockConfig),
    }) as any;

    render(<Config />);

    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByTestId("config-editor")).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("cancels edit mode and restores view", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockConfig),
    }) as any;

    render(<Config />);

    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Edit"));
    expect(screen.getByTestId("config-editor")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByTestId("config-view")).toBeInTheDocument();
  });

  it("saves config and exits edit mode", async () => {
    const updatedConfig = { ...mockConfig, agent: { name: "claude", model: "opus" } };

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockConfig),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(updatedConfig),
      }) as any;

    render(<Config />);

    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByTestId("config-view")).toBeInTheDocument();
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    const secondCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(secondCall[0]).toBe("/api/config");
    expect(secondCall[1].method).toBe("PUT");
  });
});
