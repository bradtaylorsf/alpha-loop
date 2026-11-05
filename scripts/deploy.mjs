#!/usr/bin/env node
// Local deploy helper. Computes the next semver from conventional commits
// since the last git tag, stamps package.json, commits + pushes a release
// branch, and opens a PR. CI then publishes the exact version in package.json
// after the PR is merged — no bump-back PR, no rewrites, no loop guard.
//
// Usage:
//   pnpm release                # auto-detect bump from commits
//   pnpm release --patch        # force patch
//   pnpm release --minor        # force minor
//   pnpm release --major        # force major
//   pnpm release --dry-run      # print plan without touching anything

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function shOk(cmd) {
  const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n✗ command failed: ${cmd}`);
    process.exit(r.status ?? 1);
  }
}

function check(label, fn) {
  process.stdout.write(`  • ${label}... `);
  try {
    fn();
    process.stdout.write('ok\n');
  } catch (err) {
    process.stdout.write('FAIL\n');
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}

const STABLE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Keep these two pure helpers in sync with src/lib/release.ts (parity tested).
export function computeBump(commits) {
  if (commits.some(message => /BREAKING CHANGE|^[a-z]+(\([^)]+\))?!:/m.test(message))) return 'major';
  if (commits.some(message => /^feat(\([^)]+\))?:/m.test(message))) return 'minor';
  return 'patch';
}

export function bumpVersion(version, bump) {
  if (version.trim() !== version || !STABLE_VERSION.test(version)) throw new Error(`Invalid stable version: ${version}`);
  const parts = version.replace(/^v/, '').split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Invalid stable version: ${version}`);
  const index = ['major', 'minor', 'patch'].indexOf(bump);
  if (index < 0) throw new Error(`Invalid release bump: ${bump}`);
  parts[index] += 1;
  if (!Number.isSafeInteger(parts[index])) throw new Error(`Version overflow: ${version}`);
  return parts.map((part, i) => i > index ? 0 : part).join('.');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const DRY = args.has('--dry-run');
  const FORCE_BUMP = ['--major', '--minor', '--patch'].find((f) => args.has(f))?.slice(2);

  console.log('\n=== alpha-loop deploy ===\n');

  // Preflight
  console.log('Preflight:');
  check('git repo', () => sh('git rev-parse --is-inside-work-tree'));
  check('gh authenticated', () => sh('gh auth status', { stdio: ['pipe', 'pipe', 'pipe'] }));
  check('no uncommitted tracked changes', () => {
    // Only block on modified/staged tracked files. Untracked files are fine —
    // they won't end up in the release commit unless explicitly added.
    const dirty = sh('git status --porcelain --untracked-files=no');
    if (dirty) throw new Error(`Uncommitted changes to tracked files:\n${dirty}\n\nCommit your work first, then run pnpm release.`);
  });

  const branch = sh('git rev-parse --abbrev-ref HEAD');
  check(`branch (${branch})`, () => {
    if (branch === 'HEAD') throw new Error('Detached HEAD. Check out a branch first.');
  });

  // Version computation
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const currentLocal = pkg.version;

  let lastTag = '';
  try { lastTag = sh('git describe --tags --abbrev=0'); } catch { /* first release */ }
  const currentTagged = lastTag ? lastTag.replace(/^v/, '') : '0.0.0';

  const range = lastTag ? `refs/tags/${lastTag}..HEAD` : 'HEAD';
  // Tag names may contain shell metacharacters. Pass the revision as an argument.
  const commits = execFileSync('git', ['log', '--format=%B%x00', range, '--'], { encoding: 'utf8' })
    .split('\0').filter(message => message.trim());
  if (commits.length === 0) {
    console.log('\nNothing to release — no commits since ' + (lastTag || 'repo init') + '.');
    process.exit(0);
  }

  const bump = FORCE_BUMP ?? computeBump(commits);
  const nextVersion = bumpVersion(currentTagged, bump);

  console.log(`\nVersion plan:`);
  console.log(`  current tag:    ${lastTag || '(none)'}`);
  console.log(`  current local:  v${currentLocal}`);
  console.log(`  bump type:      ${bump}${FORCE_BUMP ? ' (forced)' : ' (from commits)'}`);
  console.log(`  next version:   v${nextVersion}`);

  const releaseBranch = /^chore\/release-v\d+\.\d+\.\d+$/.test(branch)
    ? branch
    : `chore/release-v${nextVersion}`;
  console.log(`  release branch: ${releaseBranch}${releaseBranch === branch ? ' (current)' : ' (will create)'}`);

  const oneline = execFileSync('git', ['log', '--format=%h %s', range, '--'], { encoding: 'utf8' }).trim();
  const notes = oneline.split('\n').map((l) => `- ${l}`).join('\n');
  console.log(`\nCommits since ${lastTag || 'repo init'}:`);
  console.log(oneline.split('\n').map((l) => `  ${l}`).join('\n'));

  if (DRY) {
    console.log('\n[dry-run] No changes made.');
    process.exit(0);
  }

  // Execute
  console.log('\nExecuting:');
  if (branch !== releaseBranch) {
    shOk(`git checkout -b "${releaseBranch}"`);
  }

  // Stamp package.json
  pkg.version = nextVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  shOk(`git add package.json`);

  const commitMsg = `chore(release): release v${nextVersion}\n\n${notes}`;
  const escapedMsg = commitMsg.replace(/'/g, `'\\''`);
  shOk(`git commit -m '${escapedMsg}'`);
  shOk(`git push -u origin "${releaseBranch}"`);

  // Open PR
  const prBody = `Releases v${nextVersion} (${bump} bump).\n\n## Changes\n\n${notes}\n\n---\nThis PR was created by \`pnpm release\`. After merge, run \`pnpm release:watch\` to follow the publish.`;
  const prBodyEsc = prBody.replace(/'/g, `'\\''`);
  const prResult = sh(
    `gh pr create --base master --head "${releaseBranch}" --title "chore(release): release v${nextVersion}" --body '${prBodyEsc}'`
  );
  const prUrl = prResult.trim().split('\n').pop();

  console.log(`\n✓ PR opened: ${prUrl}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review and merge the PR`);
  console.log(`  2. Run: pnpm release:watch`);
  console.log(`     (tails CI, verifies local==npm==tag once published)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
