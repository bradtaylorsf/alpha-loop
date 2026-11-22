/**
 * Security check record and the default profile sources.
 * Upstream files supply technique identity. This module does not fetch them.
 */

export type SecurityTarget = 'application' | 'mcp-agent';

export type SecurityProfileName = 'application' | 'agent';

/** Row mark after the catalog intersects fetched IDs, surfaces, and oracles. */
export type SecurityCatalogStatus = 'new' | 'existing' | 'no-local-check';

/**
 * One local security check.
 * `catalogRevision` is the accepted commit SHA of the watched profile file.
 * `source` is the profile name. `sourceUrl` is that profile's GitHub repository URL.
 */
export type SecurityCheck = {
  source: string;
  sourceUrl: string;
  techniqueId: string;
  catalogRevision: string;
  surface: string;
  target: SecurityTarget;
  command: string;
  passExit: number;
  timeoutSec: number;
};

/** Technique identity parsed from a watched upstream file. */
export type CatalogTechnique = {
  techniqueId: string;
  name: string;
  tactics: string[];
  profiles: string[];
  summary: string;
  /** Stable identity hash. A difference between two pins marks the technique changed. */
  signature: string;
};

export type TechniqueDelta = {
  added: string[];
  removed: string[];
  changed: string[];
};

export type SecurityProfileConfig = {
  enabled: boolean;
  url: string;
  ref: string;
  watch: string[];
};

export type SecurityProfilesConfig = {
  application: SecurityProfileConfig;
  agent: SecurityProfileConfig;
};

export type SecurityPlanProfilePin = {
  url: string;
  ref: string;
  watch: string[];
  /** Commit SHA of the watched file. Stays put until the caller accepts a new SHA. */
  acceptedSha: string;
};

export type SecurityPlanCheck = SecurityCheck & {
  selected: boolean;
  /** Milestone title recorded for this row. Unchecking the row keeps this value. */
  milestone?: string;
};

export type SecurityPlan = {
  version: 1;
  profiles: Partial<Record<SecurityProfileName, SecurityPlanProfilePin>>;
  checks: SecurityPlanCheck[];
};

export const APPLICATION_PROFILE_URL = 'https://github.com/mitre/cti';
export const APPLICATION_PROFILE_REF = 'master';
export const APPLICATION_PROFILE_WATCH = 'enterprise-attack/enterprise-attack.json';

export const AGENT_PROFILE_URL = 'https://github.com/secure-agentic-framework/saf-mcp';
export const AGENT_PROFILE_REF = 'main';
export const AGENT_PROFILE_WATCH = 'research/framework-model.yml';

/** Missing `security_checks` stays off. The selector turns it on. */
export const DEFAULT_SECURITY_CHECKS = false;

export function defaultSecurityProfiles(): SecurityProfilesConfig {
  return {
    application: {
      enabled: true,
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watch: [APPLICATION_PROFILE_WATCH],
    },
    agent: {
      enabled: true,
      url: AGENT_PROFILE_URL,
      ref: AGENT_PROFILE_REF,
      watch: [AGENT_PROFILE_WATCH],
    },
  };
}

export function techniqueSignature(parts: {
  techniqueId: string;
  name: string;
  tactics: readonly string[];
  profiles: readonly string[];
  summary: string;
}): string {
  return JSON.stringify({
    techniqueId: parts.techniqueId,
    name: parts.name,
    tactics: [...parts.tactics].sort(),
    profiles: [...parts.profiles].sort(),
    summary: parts.summary,
  });
}
