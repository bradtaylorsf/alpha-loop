#!/usr/bin/env node
// Watch the latest Release workflow run, then verify local == npm == tag.
// Run this after merging a release PR.
//
// Usage:
//   pnpm release:watch                # find latest run, watch it, verify
//   pnpm release:watch --no-pull      # skip "git pull" at the end

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const PULL = !args.has('--no-pull');

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function shOk(cmd, opts = {}) {
  const r = spawnSync('sh', ['-c', cmd], { stdio: opts.silent ? 'pipe' : 'inherit' });
  if (r.status !== 0) {
    if (opts.silent) console.error(r.stderr?.toString() ?? '');
    process.exit(r.status ?? 1);
  }
}

function findLatestRun({ waitForNew = false, sinceIso } = {}) {
  const deadline = Date.now() + 90_000; // 90s window for a new run to appear
  while (true) {
    const out = sh(
      `gh run list --workflow=release.yml --limit=5 --json databaseId,status,conclusion,headSha,createdAt,displayTitle`
    );
    const runs = JSON.parse(out);
    if (runs.length > 0) {
      if (waitForNew && sinceIso) {
        const newer = runs.find((r) => r.createdAt > sinceIso);
        if (newer) return newer;
      } else {
        return runs[0];
      }
    }
    if (!waitForNew || Date.now() > deadline) return runs[0] ?? null;
    process.stdout.write('.');
    execSync('sleep 3');
  }
}

console.log('\n=== alpha-loop release:watch ===\n');

const sinceIso = new Date(Date.now() - 5 * 60_000).toISOString();
console.log('Locating latest release workflow run...');
const run = findLatestRun({ waitForNew: true, sinceIso });
if (!run) {
  console.error('No release workflow runs found. Did you merge a release PR?');
  process.exit(1);
}

console.log(`\nRun #${run.databaseId} — ${run.displayTitle}`);
console.log(`  status: ${run.status}  sha: ${run.headSha.slice(0, 8)}`);
console.log(`  created: ${run.createdAt}`);
console.log('');

if (run.status !== 'completed') {
  console.log('Streaming live status (gh run watch)...\n');
  shOk(`gh run watch ${run.databaseId} --exit-status`);
}

// Re-fetch to get final conclusion
const finalRaw = sh(`gh run view ${run.databaseId} --json conclusion,status`);
const final = JSON.parse(finalRaw);
if (final.conclusion !== 'success') {
  console.error(`\n✗ Release workflow ended with conclusion: ${final.conclusion}`);
  console.error(`  View: gh run view ${run.databaseId} --log-failed`);
  process.exit(1);
}

console.log('\n✓ Release workflow completed successfully.\n');

// Sync local state. Fetch tags explicitly — `git pull` does not pull new
// tags by default, and the release tag is the source of truth we check
// against below.
if (PULL) {
  console.log('Syncing local master + tags...');
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch === 'master') {
    shOk('git pull --ff-only origin master');
  } else {
    console.log(`  (on ${branch}, not pulling branch — pass --no-pull to silence this)`);
  }
  shOk('git fetch --tags origin');
}

// Verify versions
console.log('\nVerifying version sync:');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const localVer = pkg.version;
let tagVer = '';
try { tagVer = sh('git describe --tags --abbrev=0').replace(/^v/, ''); } catch { /* no tags */ }
let npmVer = '';
try { npmVer = sh(`npm view ${pkg.name} version`); } catch { /* unpublished */ }

const ok = localVer && localVer === tagVer && localVer === npmVer;
const mark = (a, b) => (a === b ? '✓' : '✗');
console.log(`  local:  ${localVer}`);
console.log(`  tag:    ${tagVer}  ${mark(localVer, tagVer)}`);
console.log(`  npm:    ${npmVer}  ${mark(localVer, npmVer)}`);
console.log('');

if (!ok) {
  console.error('✗ Versions are out of sync. Investigate before next release.');
  process.exit(1);
}

console.log(`✓ All in sync at v${localVer}.\n`);
