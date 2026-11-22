/**
 * Fetch one watched profile file at a saved ref.
 * The body is cached under .alpha-loop/security-cache/ by commit SHA.
 * The accepted pin is an input. This module does not write it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  AGENT_PROFILE_URL,
  APPLICATION_PROFILE_URL,
  type CatalogTechnique,
  type TechniqueDelta,
  techniqueSignature,
} from './security-types.js';

export type SourceResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

/** Tests pass a fixture implementation. The default uses the GitHub API. */
export type SourceFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<SourceResponse>;

export type WatchedSourceResult = {
  url: string;
  ref: string;
  watchPath: string;
  latestSha: string;
  acceptedSha: string | null;
  shaChanged: boolean;
  /** The accepted pin is not updated by a fetch. */
  pinMoved: false;
  cachePath: string;
  techniques: CatalogTechnique[];
  techniqueIds: string[];
  /** Set when the latest watched-file SHA differs from the accepted pin and both bodies are available. */
  delta: TechniqueDelta | null;
};

export type FetchWatchedPathInput = {
  projectDir: string;
  url: string;
  ref: string;
  watchPath: string;
  acceptedSha?: string | null;
  fetchImpl?: SourceFetch;
};

const GITHUB_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'alpha-loop',
  'X-GitHub-Api-Version': '2022-11-28',
};

const CLOUD_PLATFORMS = new Set([
  'iaas',
  'saas',
  'office 365',
  'office365',
  'azure ad',
  'google workspace',
  'identity provider',
]);

type ContentPayload = {
  content?: unknown;
  encoding?: unknown;
  sha?: unknown;
};

export function parseGitHubRepoUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?\s]+?)(?:\.git)?\/?$/);
  if (!match) {
    throw new Error(`Invalid GitHub repository URL: ${url}`);
  }
  return { owner: match[1]!, repo: match[2]! };
}

export function githubCommitsUrl(repoUrl: string, ref: string, watchPath: string): string {
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  const params = new URLSearchParams({
    path: watchPath,
    sha: ref,
    per_page: '1',
  });
  return `https://api.github.com/repos/${owner}/${repo}/commits?${params.toString()}`;
}

export function githubContentsUrl(repoUrl: string, commitSha: string, watchPath: string): string {
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  const encodedPath = watchPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(commitSha)}`;
}

export function githubBlobUrl(repoUrl: string, blobSha: string): string {
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  return `https://api.github.com/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(blobSha)}`;
}

export function cacheBodyPath(projectDir: string, commitSha: string, watchPath: string): string {
  const sha = assertCommitSha(commitSha);
  const slug = watchPath.replace(/[^A-Za-z0-9._-]+/g, '_');
  return join(projectDir, '.alpha-loop', 'security-cache', sha, slug);
}

export function diffTechniques(previous: readonly CatalogTechnique[], next: readonly CatalogTechnique[]): TechniqueDelta {
  const previousById = new Map(previous.map((technique) => [technique.techniqueId, technique]));
  const nextById = new Map(next.map((technique) => [technique.techniqueId, technique]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [id, technique] of nextById) {
    const prior = previousById.get(id);
    if (!prior) {
      added.push(id);
    } else if (prior.signature !== technique.signature) {
      changed.push(id);
    }
  }
  for (const id of previousById.keys()) {
    if (!nextById.has(id)) removed.push(id);
  }

  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

export function parseAttackCatalog(body: string): CatalogTechnique[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`ATT&CK catalog is not JSON: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { objects?: unknown }).objects)) {
    throw new Error('ATT&CK catalog is missing an objects array');
  }

  const techniques: CatalogTechnique[] = [];
  const seen = new Set<string>();
  for (const entry of (parsed as { objects: unknown[] }).objects) {
    if (!entry || typeof entry !== 'object') continue;
    const object = entry as Record<string, unknown>;
    if (object.type !== 'attack-pattern') continue;
    if (object.revoked === true || object.x_mitre_deprecated === true) continue;

    const techniqueId = attackExternalId(object.external_references);
    if (!techniqueId || seen.has(techniqueId)) continue;
    seen.add(techniqueId);

    const tactics = attackTactics(object.kill_chain_phases);
    if (hasCloudPlatform(object.x_mitre_platforms)) tactics.push('cloud');
    const name = typeof object.name === 'string' ? object.name.trim() : '';
    const summary = typeof object.description === 'string' ? object.description.trim() : '';
    techniques.push({
      techniqueId,
      name,
      tactics,
      profiles: [],
      summary,
      signature: techniqueSignature({ techniqueId, name, tactics, profiles: [], summary }),
    });
  }

  techniques.sort((left, right) => left.techniqueId.localeCompare(right.techniqueId));
  return techniques;
}

export function parseSafMcpCatalog(body: string): CatalogTechnique[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SAFE-MCP catalog is not YAML: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { techniques?: unknown }).techniques)) {
    throw new Error('SAFE-MCP catalog is missing a techniques array');
  }

  const techniques: CatalogTechnique[] = [];
  const seen = new Set<string>();
  for (const entry of (parsed as { techniques: unknown[] }).techniques) {
    if (!entry || typeof entry !== 'object') continue;
    const object = entry as Record<string, unknown>;
    if (object.lifecycle_status === 'deprecated') continue;
    const profiles = stringList(object.profiles);
    if (!profiles.includes('mcp')) continue;
    const techniqueId = typeof object.technique_id === 'string' ? object.technique_id.trim() : '';
    if (!techniqueId || seen.has(techniqueId)) continue;
    seen.add(techniqueId);

    const name = typeof object.name === 'string' ? object.name.trim() : '';
    const summary = typeof object.summary === 'string' ? object.summary.trim() : '';
    const tactics = stringList(object.tactics);
    techniques.push({
      techniqueId,
      name,
      tactics,
      profiles,
      summary,
      signature: techniqueSignature({ techniqueId, name, tactics, profiles, summary }),
    });
  }

  techniques.sort((left, right) => left.techniqueId.localeCompare(right.techniqueId));
  return techniques;
}

export function parseWatchedCatalog(watchPath: string, body: string): CatalogTechnique[] {
  if (watchPath.endsWith('.yml') || watchPath.endsWith('.yaml')) {
    return parseSafMcpCatalog(body);
  }
  return parseAttackCatalog(body);
}

/**
 * Read the watched path at `ref` through the GitHub API.
 * A SHA difference is returned as added, removed, and changed technique IDs.
 * `acceptedSha` is returned unchanged.
 */
export async function fetchWatchedPath(input: FetchWatchedPathInput): Promise<WatchedSourceResult> {
  const fetchImpl = input.fetchImpl ?? defaultFetch;
  const acceptedSha = input.acceptedSha ? assertCommitSha(input.acceptedSha) : null;
  const commitsUrl = githubCommitsUrl(input.url, input.ref, input.watchPath);
  const latestSha = assertCommitSha(commitShaFromResponse(await readJson(fetchImpl, commitsUrl)));
  const cachePath = cacheBodyPath(input.projectDir, latestSha, input.watchPath);
  const body = readCachedBody(cachePath) ?? await downloadWatchedBody(fetchImpl, input.url, latestSha, input.watchPath);
  const techniques = parseWatchedCatalog(input.watchPath, body);
  if (!existsSync(cachePath)) writeCachedBody(cachePath, body);

  const shaChanged = acceptedSha !== null && acceptedSha !== latestSha;
  let delta: TechniqueDelta | null = null;
  if (shaChanged && acceptedSha) {
    const acceptedPath = cacheBodyPath(input.projectDir, acceptedSha, input.watchPath);
    const acceptedBody = readCachedBody(acceptedPath);
    if (acceptedBody !== null) {
      delta = diffTechniques(parseWatchedCatalog(input.watchPath, acceptedBody), techniques);
    }
  }

  return {
    url: input.url,
    ref: input.ref,
    watchPath: input.watchPath,
    latestSha,
    acceptedSha,
    shaChanged,
    pinMoved: false,
    cachePath,
    techniques,
    techniqueIds: techniques.map((technique) => technique.techniqueId),
    delta,
  };
}

export function defaultProfileUrls(): { application: string; agent: string } {
  return {
    application: APPLICATION_PROFILE_URL,
    agent: AGENT_PROFILE_URL,
  };
}

async function defaultFetch(url: string, init?: { headers?: Record<string, string> }): Promise<SourceResponse> {
  const response = await fetch(url, { headers: init?.headers });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json() as Promise<unknown>,
    text: () => response.text(),
  };
}

async function readJson(fetchImpl: SourceFetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url, { headers: GITHUB_HEADERS });
  if (!response.ok) {
    throw new Error(`GitHub request failed with status ${response.status} for ${url}`);
  }
  return response.json();
}

async function downloadWatchedBody(
  fetchImpl: SourceFetch,
  repoUrl: string,
  commitSha: string,
  watchPath: string,
): Promise<string> {
  const payload = asContentPayload(await readJson(fetchImpl, githubContentsUrl(repoUrl, commitSha, watchPath)));
  const direct = decodeContent(payload);
  if (direct !== null) return direct;

  const blobSha = typeof payload.sha === 'string' ? payload.sha : '';
  if (!blobSha) {
    throw new Error(`GitHub contents response for ${watchPath} at ${commitSha} did not include a body`);
  }
  const blob = asContentPayload(await readJson(fetchImpl, githubBlobUrl(repoUrl, blobSha)));
  const decoded = decodeContent(blob);
  if (decoded === null) {
    throw new Error(`GitHub blob response for ${watchPath} at ${commitSha} did not include a body`);
  }
  return decoded;
}

function asContentPayload(value: unknown): ContentPayload {
  if (!value || typeof value !== 'object') return {};
  return value as ContentPayload;
}

function decodeContent(payload: ContentPayload): string | null {
  if (typeof payload.content !== 'string' || payload.content.trim() === '') return null;
  if (payload.encoding === 'none') return null;
  if (payload.encoding === 'base64' || payload.encoding === undefined) {
    return Buffer.from(payload.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  return payload.content;
}

function commitShaFromResponse(body: unknown): string {
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error('GitHub commits response did not include a commit for the watched path');
  }
  const first = body[0];
  if (!first || typeof first !== 'object' || typeof (first as { sha?: unknown }).sha !== 'string') {
    throw new Error('GitHub commits response did not include a commit SHA');
  }
  return (first as { sha: string }).sha;
}

function assertCommitSha(sha: string): string {
  if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) {
    throw new Error(`Invalid commit SHA: ${sha}`);
  }
  return sha.toLowerCase();
}

function readCachedBody(cachePath: string): string | null {
  if (!existsSync(cachePath)) return null;
  return readFileSync(cachePath, 'utf8');
}

function writeCachedBody(cachePath: string, body: string): void {
  mkdirSync(join(cachePath, '..'), { recursive: true });
  writeFileSync(cachePath, body);
}

function attackExternalId(value: unknown): string {
  if (!Array.isArray(value)) return '';
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const reference = entry as Record<string, unknown>;
    if (reference.source_name === 'mitre-attack' && typeof reference.external_id === 'string') {
      return reference.external_id.trim();
    }
  }
  return '';
}

function attackTactics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tactics: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const phase = entry as Record<string, unknown>;
    if (phase.kill_chain_name !== 'mitre-attack') continue;
    if (typeof phase.phase_name === 'string' && phase.phase_name.trim()) {
      tactics.push(phase.phase_name.trim());
    }
  }
  return tactics;
}

function hasCloudPlatform(value: unknown): boolean {
  return stringList(value).some((platform) => CLOUD_PLATFORMS.has(platform.toLowerCase()));
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
