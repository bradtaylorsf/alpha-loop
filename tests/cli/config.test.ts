// Mock modules with ESM dependencies before any imports
jest.mock("../../src/engine/loop", () => ({
  defaultConfig: jest.fn((o: Record<string, unknown>) => o),
  startLoop: jest.fn(),
}));
jest.mock("../../src/engine/github", () => ({
  createGitHubClient: jest.fn(),
}));
jest.mock("../../src/engine/runners/index", () => ({
  createRunnerFromConfig: jest.fn(),
}));
jest.mock("../../src/server/index", () => ({
  createServer: jest.fn().mockReturnValue({ app: {}, server: {}, db: {} }),
}));

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  formatConfigDisplay,
  formatMergeStrategy,
  formatSessionSummary,
  parseMergeStrategyChoice,
  defaultSessionName,
  saveAlphaLoopYaml,
  loadAlphaLoopYaml,
  buildSessionConfig,
  buildSessionConfigFromFlags,
  hasAllConfigFlags,
} from "../../src/cli/config";
import type { SessionConfig, MergeStrategy, AlphaLoopYaml } from "../../src/cli/config";
import type { LoopConfig } from "../../src/engine/loop";
import type { IssueWithDeps } from "../../src/cli/issues";

// --- Helpers ---

function makeLoopConfig(overrides: Partial<LoopConfig> = {}): LoopConfig {
  return {
    owner: "bradtaylorsf",
    repo: "aging-sidekick",
    baseBranch: "master",
    model: "opus",
    reviewModel: "opus",
    maxTurns: 30,
    maxTestRetries: 3,
    pollInterval: 60,
    label: "ready",
    skipTests: false,
    skipReview: false,
    skipVerify: false,
    verifyTimeout: 120_000,
    dryRun: false,
    autoCleanup: true,
    ...overrides,
  };
}

function makeIssue(number: number, title: string): IssueWithDeps {
  return { number, title, body: null, labels: ["ready"], dependencies: [] };
}

function makeSessionConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    model: "opus",
    reviewModel: "opus",
    maxTurns: 30,
    mergeStrategy: "session-branch",
    skipTests: false,
    skipReview: false,
    sessionName: "session/20260329-143000",
    ...overrides,
  };
}

// --- Tests ---

describe("formatConfigDisplay", () => {
  it("renders all settings correctly", () => {
    const config = makeSessionConfig();
    const output = formatConfigDisplay(config);
    expect(output).toContain("Model:          opus");
    expect(output).toContain("Review Model:   opus");
    expect(output).toContain("Max Turns:      30");
    expect(output).toContain("Merge Strategy: session branch");
    expect(output).toContain("Skip Tests:     no");
    expect(output).toContain("Skip Review:    no");
  });

  it("shows yes for skipped stages", () => {
    const config = makeSessionConfig({ skipTests: true, skipReview: true });
    const output = formatConfigDisplay(config);
    expect(output).toContain("Skip Tests:     yes");
    expect(output).toContain("Skip Review:    yes");
  });

  it("renders different merge strategies", () => {
    const auto = formatConfigDisplay(makeSessionConfig({ mergeStrategy: "auto-merge-master" }));
    expect(auto).toContain("auto-merge to master");

    const none = formatConfigDisplay(makeSessionConfig({ mergeStrategy: "no-merge" }));
    expect(none).toContain("no auto-merge (PRs only)");
  });
});

describe("formatMergeStrategy", () => {
  it("formats session-branch", () => {
    expect(formatMergeStrategy("session-branch")).toBe("session branch");
  });

  it("formats auto-merge-master", () => {
    expect(formatMergeStrategy("auto-merge-master")).toBe("auto-merge to master");
  });

  it("formats no-merge", () => {
    expect(formatMergeStrategy("no-merge")).toBe("no auto-merge (PRs only)");
  });
});

describe("parseMergeStrategyChoice", () => {
  it("parses choice 1 as session-branch", () => {
    expect(parseMergeStrategyChoice("1")).toBe("session-branch");
  });

  it("parses choice 2 as auto-merge-master", () => {
    expect(parseMergeStrategyChoice("2")).toBe("auto-merge-master");
  });

  it("parses choice 3 as no-merge", () => {
    expect(parseMergeStrategyChoice("3")).toBe("no-merge");
  });

  it("returns null for invalid input", () => {
    expect(parseMergeStrategyChoice("4")).toBeNull();
    expect(parseMergeStrategyChoice("")).toBeNull();
    expect(parseMergeStrategyChoice("abc")).toBeNull();
  });
});

describe("defaultSessionName", () => {
  it("generates a name with session/ prefix and timestamp", () => {
    const name = defaultSessionName();
    expect(name).toMatch(/^session\/\d{8}-\d{6}$/);
  });
});

describe("formatSessionSummary", () => {
  it("shows session, repo, issues, model, and merge strategy", () => {
    const issues = [makeIssue(96, "Create event"), makeIssue(97, "View event"), makeIssue(98, "Edit event")];
    const config = makeSessionConfig({ sessionName: "bug-fixes-round-1" });
    const output = formatSessionSummary("bug-fixes-round-1", "bradtaylorsf/aging-sidekick", issues, config);
    expect(output).toContain("Session: bug-fixes-round-1");
    expect(output).toContain("Repo:    bradtaylorsf/aging-sidekick");
    expect(output).toContain("Issues:  3 (#96, #97, #98)");
    expect(output).toContain("Model:   opus");
    expect(output).toContain("Merge:   session branch");
  });

  it("includes separator lines", () => {
    const config = makeSessionConfig();
    const output = formatSessionSummary("test", "o/r", [makeIssue(1, "A")], config);
    expect(output).toContain("\u2550".repeat(39));
  });
});

describe("saveAlphaLoopYaml / loadAlphaLoopYaml", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "alpha-loop-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves config to .alpha-loop.yaml", () => {
    const config = makeSessionConfig({
      model: "sonnet",
      reviewModel: "haiku",
      maxTurns: 15,
      mergeStrategy: "no-merge",
      skipTests: true,
      skipReview: false,
    });
    saveAlphaLoopYaml(config, tmpDir);

    const raw = readFileSync(join(tmpDir, ".alpha-loop.yaml"), "utf-8");
    const parsed = parse(raw) as AlphaLoopYaml;
    expect(parsed.agent?.model).toBe("sonnet");
    expect(parsed.agent?.reviewModel).toBe("haiku");
    expect(parsed.agent?.maxTurns).toBe(15);
    expect(parsed.merge?.strategy).toBe("no-merge");
    expect(parsed.tests?.skipTests).toBe(true);
    expect(parsed.tests?.skipReview).toBe(false);
  });

  it("does NOT save session name", () => {
    const config = makeSessionConfig({ sessionName: "my-session" });
    saveAlphaLoopYaml(config, tmpDir);

    const raw = readFileSync(join(tmpDir, ".alpha-loop.yaml"), "utf-8");
    expect(raw).not.toContain("my-session");
    expect(raw).not.toContain("sessionName");
  });

  it("loads config from .alpha-loop.yaml", () => {
    const config = makeSessionConfig({ model: "haiku", mergeStrategy: "auto-merge-master" });
    saveAlphaLoopYaml(config, tmpDir);

    const loaded = loadAlphaLoopYaml(tmpDir);
    expect(loaded.agent?.model).toBe("haiku");
    expect(loaded.merge?.strategy).toBe("auto-merge-master");
  });

  it("returns empty object when file does not exist", () => {
    const loaded = loadAlphaLoopYaml(tmpDir);
    expect(loaded).toEqual({});
  });
});

describe("buildSessionConfig", () => {
  it("builds from LoopConfig defaults", () => {
    // Mock loadAlphaLoopYaml to return empty (no .alpha-loop.yaml)
    jest.spyOn(require("../../src/cli/config"), "loadAlphaLoopYaml").mockReturnValue({});

    const loopConfig = makeLoopConfig({ model: "sonnet", reviewModel: "haiku", maxTurns: 20 });
    const session = buildSessionConfig(loopConfig);
    expect(session.model).toBe("sonnet");
    expect(session.reviewModel).toBe("haiku");
    expect(session.maxTurns).toBe(20);
    expect(session.mergeStrategy).toBe("session-branch");
    expect(session.skipTests).toBe(false);
    expect(session.skipReview).toBe(false);
    expect(session.sessionName).toMatch(/^session\/\d{8}-\d{6}$/);

    jest.restoreAllMocks();
  });

  it("uses reviewModel from loopConfig.model when reviewModel is undefined", () => {
    jest.spyOn(require("../../src/cli/config"), "loadAlphaLoopYaml").mockReturnValue({});

    const loopConfig = makeLoopConfig({ model: "opus", reviewModel: undefined });
    const session = buildSessionConfig(loopConfig);
    expect(session.reviewModel).toBe("opus");

    jest.restoreAllMocks();
  });
});

describe("hasAllConfigFlags", () => {
  it("returns true when model, session-name, and merge-strategy are set", () => {
    expect(
      hasAllConfigFlags({
        model: "opus",
        "session-name": "test-session",
        "merge-strategy": "session-branch",
      }),
    ).toBe(true);
  });

  it("returns false when model is missing", () => {
    expect(
      hasAllConfigFlags({
        "session-name": "test-session",
        "merge-strategy": "session-branch",
      }),
    ).toBe(false);
  });

  it("returns false when session-name is missing", () => {
    expect(
      hasAllConfigFlags({
        model: "opus",
        "merge-strategy": "session-branch",
      }),
    ).toBe(false);
  });

  it("returns false when merge-strategy is missing", () => {
    expect(
      hasAllConfigFlags({
        model: "opus",
        "session-name": "test-session",
      }),
    ).toBe(false);
  });
});

describe("buildSessionConfigFromFlags", () => {
  beforeEach(() => {
    jest.spyOn(require("../../src/cli/config"), "loadAlphaLoopYaml").mockReturnValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("overrides all settings from flags", () => {
    const loopConfig = makeLoopConfig();
    const session = buildSessionConfigFromFlags(loopConfig, {
      model: "sonnet",
      "review-model": "haiku",
      "max-turns": "15",
      "merge-strategy": "no-merge",
      "session-name": "my-session",
      "skip-tests": true,
      "skip-review": true,
    });
    expect(session.model).toBe("sonnet");
    expect(session.reviewModel).toBe("haiku");
    expect(session.maxTurns).toBe(15);
    expect(session.mergeStrategy).toBe("no-merge");
    expect(session.sessionName).toBe("my-session");
    expect(session.skipTests).toBe(true);
    expect(session.skipReview).toBe(true);
  });

  it("keeps defaults for unset flags", () => {
    const loopConfig = makeLoopConfig({ model: "opus" });
    const session = buildSessionConfigFromFlags(loopConfig, {});
    expect(session.model).toBe("opus");
    expect(session.mergeStrategy).toBe("session-branch");
  });

  it("ignores invalid merge-strategy values", () => {
    const loopConfig = makeLoopConfig();
    const session = buildSessionConfigFromFlags(loopConfig, {
      "merge-strategy": "invalid-value",
    });
    expect(session.mergeStrategy).toBe("session-branch");
  });

  it("ignores invalid max-turns values", () => {
    const loopConfig = makeLoopConfig({ maxTurns: 30 });
    const session = buildSessionConfigFromFlags(loopConfig, {
      "max-turns": "abc",
    });
    expect(session.maxTurns).toBe(30);
  });
});

describe("parseCliArgs with new flags", () => {
  // Import inline to test flag parsing
  const { parseCliArgs } = require("../../src/cli/index");

  it("parses --session-name flag", () => {
    const result = parseCliArgs(["--session-name", "my-session"]);
    expect(result.options["session-name"]).toBe("my-session");
  });

  it("parses --merge-strategy flag", () => {
    const result = parseCliArgs(["--merge-strategy", "no-merge"]);
    expect(result.options["merge-strategy"]).toBe("no-merge");
  });

  it("parses --review-model flag", () => {
    const result = parseCliArgs(["--review-model", "haiku"]);
    expect(result.options["review-model"]).toBe("haiku");
  });

  it("parses --max-turns flag", () => {
    const result = parseCliArgs(["--max-turns", "15"]);
    expect(result.options["max-turns"]).toBe("15");
  });
});
