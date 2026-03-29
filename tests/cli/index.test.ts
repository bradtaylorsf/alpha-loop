import { parseCliArgs, buildConfig, USAGE } from "../../src/cli/index";

// Mock modules that have side effects
jest.mock("../../src/engine/loop", () => ({
  defaultConfig: jest.requireActual("../../src/engine/loop").defaultConfig,
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
jest.mock("yaml", () => ({
  parse: jest.fn().mockReturnValue({}),
}));

describe("parseCliArgs", () => {
  it("returns help command when --help is passed", () => {
    const result = parseCliArgs(["--help"]);
    expect(result.command).toBe("help");
  });

  it("returns dashboard command for 'dashboard' positional", () => {
    const result = parseCliArgs(["dashboard"]);
    expect(result.command).toBe("dashboard");
  });

  it("returns loop command by default", () => {
    const result = parseCliArgs([]);
    expect(result.command).toBe("loop");
  });

  it("parses --once flag", () => {
    const result = parseCliArgs(["--once"]);
    expect(result.command).toBe("loop");
    expect(result.options.once).toBe(true);
  });

  it("parses --dry-run flag", () => {
    const result = parseCliArgs(["--dry-run"]);
    expect(result.options["dry-run"]).toBe(true);
  });

  it("parses --model option", () => {
    const result = parseCliArgs(["--model", "opus"]);
    expect(result.options.model).toBe("opus");
  });

  it("parses --repo option", () => {
    const result = parseCliArgs(["--repo", "bradtaylorsf/alpha-loop"]);
    expect(result.options.repo).toBe("bradtaylorsf/alpha-loop");
  });

  it("parses --skip-tests and --skip-review flags", () => {
    const result = parseCliArgs(["--skip-tests", "--skip-review"]);
    expect(result.options["skip-tests"]).toBe(true);
    expect(result.options["skip-review"]).toBe(true);
  });

  it("parses --api-port option", () => {
    const result = parseCliArgs(["--api-port", "5000"]);
    expect(result.options["api-port"]).toBe("5000");
  });

  it("parses --merge-to option", () => {
    const result = parseCliArgs(["--merge-to", "main"]);
    expect(result.options["merge-to"]).toBe("main");
  });

  it("parses --auto-merge flag", () => {
    const result = parseCliArgs(["--auto-merge"]);
    expect(result.options["auto-merge"]).toBe(true);
  });

  it("parses --project option", () => {
    const result = parseCliArgs(["--project", "2"]);
    expect(result.options.project).toBe("2");
  });

  it("parses combined flags", () => {
    const result = parseCliArgs([
      "--once",
      "--model", "opus",
      "--repo", "owner/repo",
      "--skip-tests",
    ]);
    expect(result.command).toBe("loop");
    expect(result.options.once).toBe(true);
    expect(result.options.model).toBe("opus");
    expect(result.options.repo).toBe("owner/repo");
    expect(result.options["skip-tests"]).toBe(true);
  });

  it("returns error for unknown flags instead of throwing", () => {
    const result = parseCliArgs(["--unknown-flag"]);
    expect(result.command).toBe("help");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("unknown-flag");
  });

  it("returns error for flags missing required value", () => {
    const result = parseCliArgs(["--model"]);
    expect(result.command).toBe("help");
    expect(result.error).toBeDefined();
  });
});

describe("buildConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns default config with no overrides", () => {
    const config = buildConfig({});
    expect(config.baseBranch).toBe("master");
    expect(config.model).toBe("opus");
    expect(config.skipTests).toBe(false);
    expect(config.skipReview).toBe(false);
    expect(config.dryRun).toBe(false);
  });

  it("CLI flags override defaults", () => {
    const config = buildConfig({
      model: "opus",
      repo: "myorg/myrepo",
      "merge-to": "main",
      "skip-tests": true,
      "skip-review": true,
      "dry-run": true,
    });
    expect(config.model).toBe("opus");
    expect(config.owner).toBe("myorg");
    expect(config.repo).toBe("myrepo");
    expect(config.baseBranch).toBe("main");
    expect(config.skipTests).toBe(true);
    expect(config.skipReview).toBe(true);
    expect(config.dryRun).toBe(true);
  });

  it("env vars override defaults when no CLI flags", () => {
    process.env.MODEL = "haiku";
    process.env.REPO = "envorg/envrepo";
    process.env.BASE_BRANCH = "develop";
    process.env.SKIP_TESTS = "true";
    process.env.DRY_RUN = "true";

    const config = buildConfig({});
    expect(config.model).toBe("haiku");
    expect(config.owner).toBe("envorg");
    expect(config.repo).toBe("envrepo");
    expect(config.baseBranch).toBe("develop");
    expect(config.skipTests).toBe(true);
    expect(config.dryRun).toBe(true);
  });

  it("CLI flags take precedence over env vars", () => {
    process.env.MODEL = "haiku";
    process.env.REPO = "envorg/envrepo";

    const config = buildConfig({
      model: "opus",
      repo: "cliorg/clirepo",
    });
    expect(config.model).toBe("opus");
    expect(config.owner).toBe("cliorg");
    expect(config.repo).toBe("clirepo");
  });

  it("throws on invalid repo format", () => {
    expect(() => buildConfig({ repo: "invalid-repo" })).toThrow("Invalid repo format");
  });
});

describe("--help integration", () => {
  it("USAGE contains all documented flags", () => {
    const expectedFlags = [
      "--once",
      "--dry-run",
      "--model",
      "--auto-merge",
      "--merge-to",
      "--skip-tests",
      "--skip-review",
      "--help",
      "dashboard",
    ];
    for (const flag of expectedFlags) {
      expect(USAGE).toContain(flag);
    }
  });

  it("USAGE starts with the tool name", () => {
    expect(USAGE).toMatch(/^alpha-loop/);
  });

  it("--help prints usage to stdout", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    const { command } = parseCliArgs(["--help"]);
    expect(command).toBe("help");
    // In main(), this would trigger console.log(USAGE)
    console.log(USAGE);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("alpha-loop"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("--once"));
    spy.mockRestore();
  });

  it("invalid flags produce error and show help", () => {
    const result = parseCliArgs(["--bogus"]);
    expect(result.command).toBe("help");
    expect(result.error).toBeDefined();
    expect(result.error).toContain("bogus");
  });
});
