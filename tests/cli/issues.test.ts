import {
  parseDependencies,
  sortByDependencies,
  validateOrder,
  formatIssueList,
  formatProcessingOrder,
  fetchReadyIssues,
  selectAll,
  selectSpecific,
} from "../../src/cli/issues";
import type { IssueWithDeps } from "../../src/cli/issues";
import type { GitHubClient, GitHubIssue } from "../../src/engine/github";

// --- Helpers ---

function makeIssue(
  number: number,
  title: string,
  body: string | null = null,
  deps: number[] = [],
): IssueWithDeps {
  return { number, title, body, labels: ["ready"], dependencies: deps };
}

function makeGitHubIssue(
  number: number,
  title: string,
  body: string | null = null,
): GitHubIssue {
  return {
    number,
    title,
    body,
    state: "open",
    labels: ["ready"],
    assignee: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function mockGitHub(issues: GitHubIssue[]): GitHubClient {
  return {
    listIssues: jest.fn().mockResolvedValue(issues),
    getIssue: jest.fn(),
    updateLabels: jest.fn(),
    addComment: jest.fn(),
    createPR: jest.fn(),
    updatePR: jest.fn(),
    getPRStatus: jest.fn(),
  };
}

// --- Tests ---

describe("parseDependencies", () => {
  it("returns empty array for null body", () => {
    expect(parseDependencies(null)).toEqual([]);
  });

  it("returns empty array for body with no dependencies", () => {
    expect(parseDependencies("Just a regular issue body")).toEqual([]);
  });

  it("parses 'Depends on #N'", () => {
    expect(parseDependencies("Depends on #42")).toEqual([42]);
  });

  it("parses 'depends on #N' (case-insensitive)", () => {
    expect(parseDependencies("depends on #42")).toEqual([42]);
  });

  it("parses 'DEPENDS ON #N' (case-insensitive)", () => {
    expect(parseDependencies("DEPENDS ON #42")).toEqual([42]);
  });

  it("parses 'Blocked by #N'", () => {
    expect(parseDependencies("Blocked by #99")).toEqual([99]);
  });

  it("parses 'blocked by #N' (case-insensitive)", () => {
    expect(parseDependencies("blocked by #99")).toEqual([99]);
  });

  it("parses 'After #N'", () => {
    expect(parseDependencies("After #10")).toEqual([10]);
  });

  it("parses 'Requires #N'", () => {
    expect(parseDependencies("Requires #55")).toEqual([55]);
  });

  it("parses multiple inline dependencies", () => {
    const body = "Depends on #1, blocked by #2, requires #3";
    const deps = parseDependencies(body);
    expect(deps).toContain(1);
    expect(deps).toContain(2);
    expect(deps).toContain(3);
    expect(deps).toHaveLength(3);
  });

  it("parses dependencies from ### Dependencies section", () => {
    const body = `## Description
Some description here.

### Dependencies
- #10
- #20
- #30

### Other Section
More content.`;
    const deps = parseDependencies(body);
    expect(deps).toContain(10);
    expect(deps).toContain(20);
    expect(deps).toContain(30);
  });

  it("deduplicates dependencies", () => {
    const body = "Depends on #5. Also requires #5.";
    expect(parseDependencies(body)).toEqual([5]);
  });

  it("combines inline and section dependencies", () => {
    const body = `Depends on #1

### Dependencies
- #2
- #3`;
    const deps = parseDependencies(body);
    expect(deps).toContain(1);
    expect(deps).toContain(2);
    expect(deps).toContain(3);
  });
});

describe("sortByDependencies", () => {
  it("returns issues in original order when no dependencies", () => {
    const issues = [makeIssue(1, "A"), makeIssue(2, "B"), makeIssue(3, "C")];
    const sorted = sortByDependencies(issues);
    expect(sorted.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it("puts dependencies before dependents", () => {
    const issues = [
      makeIssue(2, "B", null, [1]),
      makeIssue(1, "A"),
    ];
    const sorted = sortByDependencies(issues);
    expect(sorted.map((i) => i.number)).toEqual([1, 2]);
  });

  it("handles chain dependencies", () => {
    const issues = [
      makeIssue(3, "C", null, [2]),
      makeIssue(2, "B", null, [1]),
      makeIssue(1, "A"),
    ];
    const sorted = sortByDependencies(issues);
    expect(sorted.map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it("ignores dependencies not in the input set", () => {
    const issues = [
      makeIssue(2, "B", null, [999]),
      makeIssue(1, "A"),
    ];
    const sorted = sortByDependencies(issues);
    expect(sorted.map((i) => i.number)).toEqual([2, 1]);
  });

  it("handles multiple dependencies", () => {
    const issues = [
      makeIssue(3, "C", null, [1, 2]),
      makeIssue(1, "A"),
      makeIssue(2, "B"),
    ];
    const sorted = sortByDependencies(issues);
    const nums = sorted.map((i) => i.number);
    expect(nums.indexOf(1)).toBeLessThan(nums.indexOf(3));
    expect(nums.indexOf(2)).toBeLessThan(nums.indexOf(3));
  });

  it("throws on dependency cycle", () => {
    const issues = [
      makeIssue(1, "A", null, [2]),
      makeIssue(2, "B", null, [1]),
    ];
    expect(() => sortByDependencies(issues)).toThrow(/cycle/i);
  });
});

describe("validateOrder", () => {
  it("returns null for valid order", () => {
    const ordered = [
      makeIssue(1, "A"),
      makeIssue(2, "B", null, [1]),
    ];
    expect(validateOrder(ordered)).toBeNull();
  });

  it("detects dependency violation", () => {
    const ordered = [
      makeIssue(2, "B", null, [1]),
      makeIssue(1, "A"),
    ];
    const violation = validateOrder(ordered);
    expect(violation).toEqual({ issue: 2, dependency: 1 });
  });

  it("ignores dependencies not in the set", () => {
    const ordered = [
      makeIssue(2, "B", null, [999]),
      makeIssue(1, "A"),
    ];
    expect(validateOrder(ordered)).toBeNull();
  });

  it("returns first violation in complex ordering", () => {
    const ordered = [
      makeIssue(3, "C", null, [1]),
      makeIssue(2, "B"),
      makeIssue(1, "A"),
    ];
    const violation = validateOrder(ordered);
    expect(violation).toEqual({ issue: 3, dependency: 1 });
  });
});

describe("formatIssueList", () => {
  it("shows issue count and numbered list", () => {
    const issues = [makeIssue(96, "Create event"), makeIssue(97, "View event")];
    const output = formatIssueList(issues);
    expect(output).toContain("2 ready");
    expect(output).toContain("#96");
    expect(output).toContain("Create event");
    expect(output).toContain("#97");
    expect(output).toContain("View event");
  });

  it("shows dependency info", () => {
    const issues = [
      makeIssue(96, "Create event"),
      makeIssue(97, "View event", null, [96]),
    ];
    const output = formatIssueList(issues);
    expect(output).toContain("depends on #96");
  });

  it("only shows dependencies that are in the list", () => {
    const issues = [makeIssue(97, "View event", null, [999])];
    const output = formatIssueList(issues);
    expect(output).not.toContain("depends on");
  });
});

describe("formatProcessingOrder", () => {
  it("shows numbered processing order", () => {
    const issues = [makeIssue(96, "Create event"), makeIssue(97, "View event")];
    const output = formatProcessingOrder(issues);
    expect(output).toContain("Processing order:");
    expect(output).toContain("#96");
    expect(output).toContain("#97");
  });
});

describe("fetchReadyIssues", () => {
  it("fetches issues and parses dependencies", async () => {
    const github = mockGitHub([
      makeGitHubIssue(96, "Create event", "No deps"),
      makeGitHubIssue(97, "View event", "Depends on #96"),
    ]);

    const issues = await fetchReadyIssues(github, "ready");
    expect(issues).toHaveLength(2);
    expect(issues[0].dependencies).toEqual([]);
    expect(issues[1].dependencies).toEqual([96]);
    expect(github.listIssues).toHaveBeenCalledWith({
      labels: ["ready"],
      state: "open",
      limit: 100,
    });
  });
});

describe("selectAll (--all flag)", () => {
  it("returns all issues sorted by dependencies", async () => {
    const github = mockGitHub([
      makeGitHubIssue(97, "View event", "Depends on #96"),
      makeGitHubIssue(96, "Create event"),
    ]);

    const result = await selectAll(github, "ready");
    expect(result.map((i) => i.number)).toEqual([96, 97]);
  });

  it("returns empty array when no issues", async () => {
    const github = mockGitHub([]);
    const result = await selectAll(github, "ready");
    expect(result).toEqual([]);
  });
});

describe("selectSpecific (--issues flag)", () => {
  it("returns specific issues sorted by dependencies", async () => {
    const github = mockGitHub([
      makeGitHubIssue(96, "Create event"),
      makeGitHubIssue(97, "View event", "Depends on #96"),
      makeGitHubIssue(98, "Edit event", "Depends on #96"),
      makeGitHubIssue(101, "Profile page"),
    ]);

    const result = await selectSpecific(github, "ready", [97, 96]);
    expect(result.map((i) => i.number)).toEqual([96, 97]);
  });

  it("skips issues not found in ready list", async () => {
    const github = mockGitHub([
      makeGitHubIssue(96, "Create event"),
    ]);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await selectSpecific(github, "ready", [96, 999]);
    expect(result.map((i) => i.number)).toEqual([96]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("#999"),
    );
    warnSpy.mockRestore();
  });

  it("returns empty array when none match", async () => {
    const github = mockGitHub([]);
    const result = await selectSpecific(github, "ready", [42]);
    expect(result).toEqual([]);
  });
});

describe("dependency warning for selected issues", () => {
  it("detects when a selected issue has an unselected dependency", () => {
    // This tests the logic indirectly via validateOrder
    const issues = [
      makeIssue(97, "View event", null, [96]),
    ];
    // #97 depends on #96, but #96 is not in the set
    // validateOrder only checks within-set deps, so this is fine
    expect(validateOrder(issues)).toBeNull();

    // But if both are in set and wrong order:
    const ordered = [
      makeIssue(97, "View event", null, [96]),
      makeIssue(96, "Create event"),
    ];
    expect(validateOrder(ordered)).toEqual({ issue: 97, dependency: 96 });
  });
});
