import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  worktreePath,
  branchName,
  createWorktree,
  removeWorktree,
} from "../../src/engine/worktree";

describe("worktreePath", () => {
  it("returns sibling directory named issue-{N}", () => {
    expect(worktreePath("/home/user/repo", 42)).toBe("/home/user/issue-42");
  });

  it("handles deeply nested repo root", () => {
    expect(worktreePath("/a/b/c/repo", 7)).toBe("/a/b/c/issue-7");
  });
});

describe("branchName", () => {
  it("returns agent/issue-{N}", () => {
    expect(branchName(4)).toBe("agent/issue-4");
  });

  it("works with large issue numbers", () => {
    expect(branchName(9999)).toBe("agent/issue-9999");
  });
});

describe("Integration: createWorktree / removeWorktree", () => {
  const testDir = resolve(tmpdir(), `worktree-test-${Date.now()}`);
  const repoDir = resolve(testDir, "repo");
  const issueNum = 999;

  beforeAll(() => {
    // Set up a temporary git repo with an initial commit
    mkdirSync(repoDir, { recursive: true });
    execSync("git init", { cwd: repoDir });
    execSync("git checkout -b main", { cwd: repoDir });
    writeFileSync(resolve(repoDir, "README.md"), "# test repo\n");
    execSync("git add .", { cwd: repoDir });
    execSync('git commit -m "init"', { cwd: repoDir });
  });

  afterAll(() => {
    // Clean up everything
    try {
      execSync(`rm -rf ${testDir}`);
    } catch {
      // best effort
    }
  });

  afterEach(() => {
    // Ensure worktree is removed between tests
    try {
      removeWorktree(issueNum, { repoRoot: repoDir });
    } catch {
      // may not exist
    }
  });

  it("creates a worktree at the expected path", () => {
    const result = createWorktree(issueNum, {
      baseBranch: "main",
      installDeps: false,
      repoRoot: repoDir,
    });

    const expectedPath = resolve(testDir, `issue-${issueNum}`);
    expect(result.path).toBe(expectedPath);
    expect(result.branch).toBe(`agent/issue-${issueNum}`);
    expect(result.issueNumber).toBe(issueNum);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("removes a worktree cleanly", () => {
    createWorktree(issueNum, {
      baseBranch: "main",
      installDeps: false,
      repoRoot: repoDir,
    });

    const wtPath = resolve(testDir, `issue-${issueNum}`);
    expect(existsSync(wtPath)).toBe(true);

    removeWorktree(issueNum, { repoRoot: repoDir });
    expect(existsSync(wtPath)).toBe(false);
  });

  it("handles existing worktree by cleaning up before creating", () => {
    // Create once
    createWorktree(issueNum, {
      baseBranch: "main",
      installDeps: false,
      repoRoot: repoDir,
    });

    // Create again — should not throw
    const result = createWorktree(issueNum, {
      baseBranch: "main",
      installDeps: false,
      repoRoot: repoDir,
    });

    expect(existsSync(result.path)).toBe(true);
    expect(result.branch).toBe(`agent/issue-${issueNum}`);
  });

  it("removeWorktree is a no-op if worktree does not exist", () => {
    // Should not throw
    expect(() =>
      removeWorktree(12345, { repoRoot: repoDir }),
    ).not.toThrow();
  });
});
