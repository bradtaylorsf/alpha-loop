/**
 * Intersect fetched technique IDs with detected surfaces and the oracle file.
 * An ID with no oracle is no-local-check and is not selectable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type CatalogTechnique,
  type SecurityCatalogStatus,
  type SecurityCheck,
  type SecurityTarget,
} from './security-types.js';

export type OracleRecord = {
  techniqueId: string;
  target: SecurityTarget;
  surface: string;
  command: string;
  passExit: number;
  timeoutSec: number;
};

export type SecurityCatalogRow = {
  status: SecurityCatalogStatus;
  selectable: boolean;
  check: SecurityCheck;
};

export type BuildSecurityCatalogInput = {
  techniques: readonly CatalogTechnique[];
  surfaces: readonly string[];
  oracles: readonly OracleRecord[];
  savedTechniqueIds: readonly string[];
  source: string;
  sourceUrl: string;
  catalogRevision: string;
  target: SecurityTarget;
  surfaceTags?: Readonly<Record<string, readonly string[]>>;
};

/** Tactic and profile tags that place a technique on a detected surface. */
export const DEFAULT_SURFACE_TAGS: Readonly<Record<string, readonly string[]>> = {
  'public-http': ['initial-access', 'public-http'],
  'credentials-at-rest': ['credential-access', 'credentials-at-rest'],
  'command-execution': ['execution', 'command-execution'],
  'cloud-control-plane': ['cloud', 'cloud-control-plane'],
  mcp: ['mcp'],
};

export function distributionOraclesPath(startDir = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'templates', 'security-profiles', 'oracles.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadOracleFile(filePath: string): OracleRecord[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { oracles?: unknown }).oracles)) {
    throw new Error(`Invalid oracle file: ${filePath}`);
  }
  return (raw as { oracles: unknown[] }).oracles.map((entry, index) => parseOracle(entry, index, filePath));
}

export function buildSecurityCatalog(input: BuildSecurityCatalogInput): SecurityCatalogRow[] {
  const surfaceTags = input.surfaceTags ?? DEFAULT_SURFACE_TAGS;
  const saved = new Set(input.savedTechniqueIds);
  const oracles = new Map<string, OracleRecord>();
  for (const oracle of input.oracles) {
    if (oracle.target !== input.target) continue;
    oracles.set(oracleKey(oracle.techniqueId, oracle.surface), oracle);
  }

  const detected = new Set(input.surfaces);
  const rows: SecurityCatalogRow[] = [];
  for (const technique of input.techniques) {
    const tags = new Set([...technique.tactics, ...technique.profiles]);
    const surfaces = [...detected].filter((surface) => surfaceMatches(tags, surface, surfaceTags));
    surfaces.sort();
    for (const surface of surfaces) {
      const oracle = oracles.get(oracleKey(technique.techniqueId, surface));
      const status: SecurityCatalogStatus = oracle
        ? (saved.has(technique.techniqueId) ? 'existing' : 'new')
        : 'no-local-check';
      rows.push({
        status,
        selectable: status !== 'no-local-check',
        check: {
          source: input.source,
          sourceUrl: input.sourceUrl,
          techniqueId: technique.techniqueId,
          catalogRevision: input.catalogRevision,
          surface,
          target: input.target,
          command: oracle?.command ?? '',
          passExit: oracle?.passExit ?? 0,
          timeoutSec: oracle?.timeoutSec ?? 0,
        },
      });
    }
  }

  rows.sort((left, right) => {
    const byId = left.check.techniqueId.localeCompare(right.check.techniqueId);
    if (byId !== 0) return byId;
    return left.check.surface.localeCompare(right.check.surface);
  });
  return rows;
}

export function selectableRows(rows: readonly SecurityCatalogRow[]): SecurityCatalogRow[] {
  return rows.filter((row) => row.selectable);
}

function surfaceMatches(
  tags: ReadonlySet<string>,
  surface: string,
  surfaceTags: Readonly<Record<string, readonly string[]>>,
): boolean {
  const expected = surfaceTags[surface] ?? [surface];
  return expected.some((tag) => tags.has(tag));
}

function oracleKey(techniqueId: string, surface: string): string {
  return `${techniqueId}\0${surface}`;
}

function parseOracle(entry: unknown, index: number, filePath: string): OracleRecord {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`${filePath} oracles[${index}] must be an object`);
  }
  const record = entry as Record<string, unknown>;
  const techniqueId = requiredString(record.techniqueId, filePath, index, 'techniqueId');
  const surface = requiredString(record.surface, filePath, index, 'surface');
  const command = requiredString(record.command, filePath, index, 'command');
  if (record.target !== 'application' && record.target !== 'mcp-agent') {
    throw new Error(`${filePath} oracles[${index}].target must be application or mcp-agent`);
  }
  if (typeof record.passExit !== 'number' || !Number.isInteger(record.passExit)) {
    throw new Error(`${filePath} oracles[${index}].passExit must be an integer`);
  }
  if (typeof record.timeoutSec !== 'number' || !Number.isFinite(record.timeoutSec) || record.timeoutSec <= 0) {
    throw new Error(`${filePath} oracles[${index}].timeoutSec must be a positive number`);
  }
  return {
    techniqueId,
    target: record.target,
    surface,
    command,
    passExit: record.passExit,
    timeoutSec: record.timeoutSec,
  };
}

function requiredString(value: unknown, filePath: string, index: number, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${filePath} oracles[${index}].${field} must be a non-empty string`);
  }
  return value.trim();
}
