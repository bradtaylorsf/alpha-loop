/**
 * Read and write .alpha-loop/security-plan.json.
 * The accepted commit SHA is stored per profile URL.
 * This module writes that file only. It does not write .alpha-loop/plan.json.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type SecurityCheck,
  type SecurityPlan,
  type SecurityPlanCheck,
  type SecurityPlanProfilePin,
  type SecurityProfileName,
  type SecurityTarget,
} from './security-types.js';

const SECURITY_PLAN_FILENAME = 'security-plan.json';

export function securityPlanPath(projectDir: string): string {
  return join(projectDir, '.alpha-loop', SECURITY_PLAN_FILENAME);
}

export function emptySecurityPlan(): SecurityPlan {
  return { version: 1, profiles: {}, checks: [] };
}

export function loadSecurityPlan(projectDir: string): SecurityPlan {
  const path = securityPlanPath(projectDir);
  if (!existsSync(path)) return emptySecurityPlan();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid security plan at ${path}: ${message}`);
  }
  return parseSecurityPlan(parsed, path);
}

export function saveSecurityPlan(projectDir: string, plan: SecurityPlan): void {
  const directory = join(projectDir, '.alpha-loop');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, SECURITY_PLAN_FILENAME);
  const temporary = join(directory, `.${SECURITY_PLAN_FILENAME}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify(normalizePlan(plan), null, 2) + '\n');
  renameSync(temporary, target);
}

/** Record the accepted commit SHA for one profile URL. Fetch does not call this. */
export function acceptWatchedSha(
  plan: SecurityPlan,
  profile: SecurityProfileName,
  pin: SecurityPlanProfilePin,
): SecurityPlan {
  return {
    ...plan,
    version: 1,
    profiles: {
      ...plan.profiles,
      [profile]: {
        url: pin.url,
        ref: pin.ref,
        watch: [...pin.watch],
        acceptedSha: pin.acceptedSha,
      },
    },
  };
}

/**
 * Set the selected flag on a saved row.
 * The milestone title stays on the row when selected becomes false.
 */
export function setCheckSelected(
  plan: SecurityPlan,
  techniqueId: string,
  selected: boolean,
  surface?: string,
): SecurityPlan {
  return {
    ...plan,
    checks: plan.checks.map((check) => {
      if (check.techniqueId !== techniqueId) return check;
      if (surface !== undefined && check.surface !== surface) return check;
      const next: SecurityPlanCheck = { ...check, selected };
      if (check.milestone !== undefined) next.milestone = check.milestone;
      return next;
    }),
  };
}

export function savedTechniqueIds(plan: SecurityPlan): string[] {
  return [...new Set(plan.checks.map((check) => check.techniqueId))].sort();
}

function normalizePlan(plan: SecurityPlan): SecurityPlan {
  return {
    version: 1,
    profiles: plan.profiles,
    checks: plan.checks,
  };
}

function parseSecurityPlan(value: unknown, path: string): SecurityPlan {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid security plan at ${path}: expected an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`Invalid security plan at ${path}: expected version 1`);
  }
  if (!record.profiles || typeof record.profiles !== 'object' || Array.isArray(record.profiles)) {
    throw new Error(`Invalid security plan at ${path}: expected profiles object`);
  }
  if (!Array.isArray(record.checks)) {
    throw new Error(`Invalid security plan at ${path}: expected checks array`);
  }

  const profiles: SecurityPlan['profiles'] = {};
  const profileRecord = record.profiles as Record<string, unknown>;
  if (profileRecord.application !== undefined) {
    profiles.application = parsePin(profileRecord.application, path, 'application');
  }
  if (profileRecord.agent !== undefined) {
    profiles.agent = parsePin(profileRecord.agent, path, 'agent');
  }

  return {
    version: 1,
    profiles,
    checks: record.checks.map((entry, index) => parseCheck(entry, path, index)),
  };
}

function parsePin(value: unknown, path: string, profile: SecurityProfileName): SecurityPlanProfilePin {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid security plan at ${path}: profiles.${profile} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const url = requiredString(record.url, `${path} profiles.${profile}.url`);
  const ref = requiredString(record.ref, `${path} profiles.${profile}.ref`);
  const acceptedSha = requiredString(record.acceptedSha, `${path} profiles.${profile}.acceptedSha`);
  if (!Array.isArray(record.watch) || record.watch.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Invalid security plan at ${path}: profiles.${profile}.watch must be a list of strings`);
  }
  return {
    url,
    ref,
    watch: record.watch.map((item) => (item as string).trim()),
    acceptedSha,
  };
}

function parseCheck(value: unknown, path: string, index: number): SecurityPlanCheck {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid security plan at ${path}: checks[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const prefix = `${path} checks[${index}]`;
  const target = record.target;
  if (target !== 'application' && target !== 'mcp-agent') {
    throw new Error(`${prefix}.target must be application or mcp-agent`);
  }
  if (typeof record.selected !== 'boolean') {
    throw new Error(`${prefix}.selected must be a boolean`);
  }
  if (typeof record.passExit !== 'number' || !Number.isInteger(record.passExit)) {
    throw new Error(`${prefix}.passExit must be an integer`);
  }
  if (typeof record.timeoutSec !== 'number' || !Number.isFinite(record.timeoutSec) || record.timeoutSec < 0) {
    throw new Error(`${prefix}.timeoutSec must be a non-negative number`);
  }
  const check: SecurityCheck = {
    source: requiredString(record.source, `${prefix}.source`),
    sourceUrl: requiredString(record.sourceUrl, `${prefix}.sourceUrl`),
    techniqueId: requiredString(record.techniqueId, `${prefix}.techniqueId`),
    catalogRevision: requiredString(record.catalogRevision, `${prefix}.catalogRevision`),
    surface: requiredString(record.surface, `${prefix}.surface`),
    target: target as SecurityTarget,
    command: typeof record.command === 'string' ? record.command : failString(`${prefix}.command`),
    passExit: record.passExit,
    timeoutSec: record.timeoutSec,
  };
  const parsed: SecurityPlanCheck = { ...check, selected: record.selected };
  if (record.milestone !== undefined) {
    parsed.milestone = requiredString(record.milestone, `${prefix}.milestone`);
  }
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function failString(label: string): string {
  throw new Error(`${label} must be a string`);
}
