export type ReleaseBump = 'major' | 'minor' | 'patch';
export type ReleasePlan = { version: string; bump: ReleaseBump; branch: string };

export const STABLE_VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Keep these two pure helpers in sync with scripts/deploy.mjs (parity tested).
/** Each entry is one complete commit message, including its body. */
export function computeBump(commits: readonly string[]): ReleaseBump {
  if (commits.some(message => /BREAKING CHANGE|^[a-z]+(\([^)]+\))?!:/m.test(message))) return 'major';
  if (commits.some(message => /^feat(\([^)]+\))?:/m.test(message))) return 'minor';
  return 'patch';
}

export function bumpVersion(version: string, bump: ReleaseBump): string {
  if (version.trim() !== version || !STABLE_VERSION.test(version)) throw new Error(`Invalid stable version: ${version}`);
  const parts = version.replace(/^v/, '').split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error(`Invalid stable version: ${version}`);
  const index = ['major', 'minor', 'patch'].indexOf(bump);
  if (index < 0) throw new Error(`Invalid release bump: ${bump}`);
  parts[index] += 1;
  if (!Number.isSafeInteger(parts[index])) throw new Error(`Version overflow: ${version}`);
  return parts.map((part, i) => i > index ? 0 : part).join('.');
}

export function isReleaseCommit(message: string): boolean {
  // Only version-stamping commits from the deploy/factory path await CI tags.
  // GitHub may append the PR number when squash-merging the release.
  const title = message.trim().split('\n')[0];
  const version = /^chore\(release\): release (v\S+?)(?: \(#\d+\))?$/i.exec(title)?.[1];
  return version !== undefined && STABLE_VERSION.test(version);
}

export function releasableCommits(commits: readonly string[]): string[] {
  return commits.map(message => message.trim()).filter(message =>
    message !== '' && !/^Merge\s/i.test(message) && !isReleaseCommit(message));
}

export function planRelease({ lastTag, commits, releaseEvery }: {
  lastTag: string | null;
  commits: readonly string[];
  releaseEvery: number;
}): ReleasePlan | null {
  if (!Number.isSafeInteger(releaseEvery) || releaseEvery < 0) {
    throw new Error('releaseEvery must be a non-negative safe integer');
  }
  const version = lastTag ?? '0.0.0';
  const releasable = releasableCommits(commits);
  const bump = computeBump(releasable);
  const next = bumpVersion(version, bump);
  if (releaseEvery === 0 || releasable.length === 0 || releasable.length < releaseEvery) return null;
  return { version: next, bump, branch: `chore/release-v${next}` };
}
