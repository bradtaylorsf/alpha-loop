/** Release side effects are synchronous and isolated from the coordinator checkout. */
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitLockPath, withFileLockSync } from './lease.js';
import { ghExec } from './rate-limit.js';
import { isReleaseCommit, planRelease, releasableCommits, STABLE_VERSION, type ReleasePlan } from './release.js';
import { exec, shellQuote, type ExecResult } from './shell.js';

export type FactoryReleaseOptions = { projectDir: string; repo: string; baseBranch: string; releaseEvery: number };
type SkippedRelease = { status: 'skipped'; reason: string };
export type DueRelease = {
  status: 'due';
  plan: ReleasePlan;
  baseSha: string;
  lastTag: string | null;
  commits: string[];
};
export type ReleaseInspection = SkippedRelease | DueRelease;
export type ReleaseOutcome = SkippedRelease | { status: 'created'; plan: ReleasePlan; url: string };

function checked(result: ExecResult, operation: string): string {
  if (result.exitCode !== 0) throw new Error(`${operation}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  return result.stdout;
}

function git(cwd: string, ...args: string[]): string {
  return checked(exec(`git ${args.map(shellQuote).join(' ')}`, { cwd }), `git ${args[0]}`);
}

/** Repository-wide duplicate guard, deliberately independent of ship head prefixes and base. */
function hasOpenRelease(options: FactoryReleaseOptions): boolean {
  const output = checked(ghExec(
    `gh api ${shellQuote(`repos/${options.repo}/pulls?state=open&per_page=100`)} --paginate --slurp`,
    { cwd: options.projectDir },
  ), 'list open release PRs');
  const pages: unknown = JSON.parse(output);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Invalid open PR response');
  let found = false;
  for (const pr of pages.flat()) {
    if (!pr || typeof pr.head?.ref !== 'string') throw new Error('Invalid open PR head');
    if (pr.head.ref.startsWith('chore/release-')) found = true;
  }
  return found;
}

function historyAt(projectDir: string, baseSha: string): { lastTag: string | null; commits: string[] } {
  const tags = git(projectDir, 'tag', '--merged', baseSha).split('\n').filter(tag => STABLE_VERSION.test(tag));
  const lastTag = tags.length === 0 ? null : git(projectDir, 'describe', '--tags', '--abbrev=0',
    ...tags.flatMap(tag => ['--match', tag]), baseSha);
  const range = lastTag ? `${lastTag}..${baseSha}` : baseSha;
  // NUL-delimited full messages: body lines never increase the cadence count.
  const commits = git(projectDir, 'log', '--no-merges', '--format=%B%x00', range, '--')
    .split('\0').map(message => message.trim()).filter(Boolean);
  return { lastTag, commits };
}

/** Dry inspection uses only locally available origin/base and tags, with no locks or fetches. */
export function inspectFactoryRelease(options: FactoryReleaseOptions, dryRun = false): ReleaseInspection {
  if (options.releaseEvery === 0) return { status: 'skipped', reason: 'release cadence disabled' };
  if (hasOpenRelease(options)) return { status: 'skipped', reason: 'an open release PR already exists' };
  const { projectDir, baseBranch } = options;
  git(projectDir, 'check-ref-format', `refs/heads/${baseBranch}`);
  const readSnapshot = (): DueRelease | SkippedRelease => {
    const baseSha = git(projectDir, 'rev-parse', '--verify', `refs/remotes/origin/${baseBranch}^{commit}`);
    const history = historyAt(projectDir, baseSha);
    // A release on base without a tag is still being published. Do not bump it again.
    if (history.commits.some(isReleaseCommit)) return { status: 'skipped', reason: 'waiting for CI to tag the merged release' };
    const plan = planRelease({ ...history, releaseEvery: options.releaseEvery });
    return plan ? { status: 'due', plan, baseSha, ...history } : { status: 'skipped', reason: 'release cadence not reached' };
  };
  if (dryRun) return readSnapshot();
  return withFileLockSync(gitLockPath(projectDir), () => {
    git(projectDir, 'fetch', '--tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`);
    return readSnapshot();
  });
}

function stampPackage(content: string, version: string): string {
  const pkg = JSON.parse(content) as Record<string, unknown>;
  if (!pkg || Array.isArray(pkg) || typeof pkg !== 'object') throw new Error('package.json must be an object');
  return JSON.stringify({ ...pkg, version }, null, 2) + '\n';
}

function releaseTitle(plan: ReleasePlan): string {
  return `chore(release): release v${plan.version}`;
}

/** Only recover our own single-package bump, whose original base is still on the current base. */
function validateReleaseCommit(options: FactoryReleaseOptions, due: DueRelease, sha: string): string {
  const { projectDir } = options;
  const parents = git(projectDir, 'show', '-s', '--format=%P', sha).split(' ');
  const parent = parents[0];
  const message = git(projectDir, 'show', '-s', '--format=%B', sha);
  if (parents.length !== 1 || message.split('\n')[0] !== releaseTitle(due.plan)
    || !message.split('\n').includes(`Factory-Release-Base: ${parent}`)
    || git(projectDir, 'diff-tree', '--no-commit-id', '--name-only', '-r', sha) !== 'package.json') {
    throw new Error(`Refusing to reuse unrelated release branch ${due.plan.branch}`);
  }
  git(projectDir, 'merge-base', '--is-ancestor', parent, due.baseSha);
  const originalPlan = planRelease({ ...historyAt(projectDir, parent), releaseEvery: options.releaseEvery });
  const expected = stampPackage(git(projectDir, 'show', `${parent}:package.json`), due.plan.version).trim();
  if (originalPlan?.version !== due.plan.version || git(projectDir, 'show', `${sha}:package.json`) !== expected) {
    throw new Error(`Release branch ${due.plan.branch} does not match the planned package bump`);
  }
  return parent;
}

export function createFactoryRelease(options: FactoryReleaseOptions, due: DueRelease): ReleaseOutcome {
  if (options.releaseEvery === 0) return { status: 'skipped', reason: 'release cadence disabled' };
  if (hasOpenRelease(options)) return { status: 'skipped', reason: 'an open release PR already exists' };
  const { projectDir } = options;
  const lock = gitLockPath(projectDir);
  const root = mkdtempSync(join(tmpdir(), 'alpha-loop-release-'));
  const worktree = join(root, 'worktree');
  let added = false;
  try {
    let notesBase = due.baseSha;
    const remote = git(projectDir, 'ls-remote', '--heads', 'origin', `refs/heads/${due.plan.branch}`);
    let existingSha: string | undefined;
    if (remote) {
      existingSha = withFileLockSync(lock, () => {
        git(projectDir, 'fetch', 'origin', `refs/heads/${due.plan.branch}`);
        return git(projectDir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}');
      });
      notesBase = validateReleaseCommit(options, due, existingSha);
    }
    const notes = releasableCommits(historyAt(projectDir, notesBase).commits)
      .map(message => `- ${message.split('\n')[0]}`).join('\n');
    withFileLockSync(lock, () => {
      // Detached HEAD avoids creating or resetting any local release branch, including on retries.
      git(projectDir, 'worktree', 'add', '--detach', worktree, existingSha ?? due.baseSha);
      added = true;
    });
    if (!existingSha) {
      const packagePath = join(worktree, 'package.json');
      if (!lstatSync(packagePath).isFile()) throw new Error('package.json must be a regular file');
      writeFileSync(packagePath, stampPackage(readFileSync(packagePath, 'utf8'), due.plan.version));
      git(worktree, 'add', '--', 'package.json');
      const message = `${releaseTitle(due.plan)}\n\n${notes}\n\nFactory-Release-Base: ${due.baseSha}`;
      git(worktree, 'commit', '-m', message);
      validateReleaseCommit(options, due, git(worktree, 'rev-parse', 'HEAD'));
      withFileLockSync(lock, () => git(worktree, 'push', 'origin', `HEAD:refs/heads/${due.plan.branch}`));
    }
    // A different shipper or human may have opened a release while we prepared ours.
    if (hasOpenRelease(options)) return { status: 'skipped', reason: 'an open release PR already exists' };
    const bodyPath = join(root, 'release-body.md');
    writeFileSync(bodyPath, `Releases v${due.plan.version} (${due.plan.bump} bump).\n\n## Changes\n\n${notes}\n\n`
      + 'Created by the factory shipper. CI publishes after merge to its configured release branch.\n');
    const url = checked(ghExec(
      `gh pr create --repo ${shellQuote(options.repo)} --base ${shellQuote(options.baseBranch)}`
      + ` --head ${shellQuote(due.plan.branch)} --title ${shellQuote(releaseTitle(due.plan))} --body-file ${shellQuote(bodyPath)}`,
      { cwd: worktree }, true,
    ), 'create release PR').trim();
    return { status: 'created', plan: due.plan, url };
  } finally {
    // Never remove another worktree or delete the pushed branch: a later pass can recover it.
    try {
      if (added) withFileLockSync(lock, () => git(projectDir, 'worktree', 'remove', '--force', worktree));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
