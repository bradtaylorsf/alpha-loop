import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSecurityCatalog } from '../../src/lib/security-catalog.js';
import {
  acceptWatchedSha,
  emptySecurityPlan,
  loadSecurityPlan,
  saveSecurityPlan,
  savedTechniqueIds,
  securityPlanPath,
  setCheckSelected,
} from '../../src/lib/security-plan.js';
import {
  AGENT_PROFILE_REF,
  AGENT_PROFILE_URL,
  AGENT_PROFILE_WATCH,
  APPLICATION_PROFILE_REF,
  APPLICATION_PROFILE_URL,
  APPLICATION_PROFILE_WATCH,
  type CatalogTechnique,
  type SecurityPlanCheck,
  techniqueSignature,
} from '../../src/lib/security-types.js';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_AGENT = 'dddddddddddddddddddddddddddddddddddddddd';

function technique(techniqueId: string, tactics: string[]): CatalogTechnique {
  const name = techniqueId;
  const profiles: string[] = [];
  const summary = '';
  return {
    techniqueId,
    name,
    tactics,
    profiles,
    summary,
    signature: techniqueSignature({ techniqueId, name, tactics, profiles, summary }),
  };
}

function check(techniqueId: string, surface: string, milestone: string): SecurityPlanCheck {
  return {
    source: 'application',
    sourceUrl: APPLICATION_PROFILE_URL,
    techniqueId,
    catalogRevision: SHA_A,
    surface,
    target: 'application',
    command: `node -e "process.exit(0)" # ${techniqueId}`,
    passExit: 0,
    timeoutSec: 30,
    selected: true,
    milestone,
  };
}

describe('security plan', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-sec-plan-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('a missing plan loads empty and does not create .alpha-loop', () => {
    expect(loadSecurityPlan(tempDir)).toEqual({ version: 1, profiles: {}, checks: [] });
    expect(existsSync(join(tempDir, '.alpha-loop'))).toBe(false);
    expect(existsSync(join(tempDir, '.alpha-loop', 'plan.json'))).toBe(false);
  });

  test('stores the accepted commit SHA per profile URL', () => {
    let plan = emptySecurityPlan();
    plan = acceptWatchedSha(plan, 'application', {
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watch: [APPLICATION_PROFILE_WATCH],
      acceptedSha: SHA_A,
    });
    plan = acceptWatchedSha(plan, 'agent', {
      url: AGENT_PROFILE_URL,
      ref: AGENT_PROFILE_REF,
      watch: [AGENT_PROFILE_WATCH],
      acceptedSha: SHA_AGENT,
    });
    plan = {
      ...plan,
      checks: [check('T1190', 'public-http', 'T1190 public-http')],
    };

    saveSecurityPlan(tempDir, plan);
    expect(existsSync(join(tempDir, '.alpha-loop', 'plan.json'))).toBe(false);
    expect(existsSync(securityPlanPath(tempDir))).toBe(true);

    const loaded = loadSecurityPlan(tempDir);
    expect(loaded.profiles.application).toEqual({
      url: 'https://github.com/mitre/cti',
      ref: 'master',
      watch: ['enterprise-attack/enterprise-attack.json'],
      acceptedSha: SHA_A,
    });
    expect(loaded.profiles.agent).toEqual({
      url: 'https://github.com/secure-agentic-framework/saf-mcp',
      ref: 'main',
      watch: ['research/framework-model.yml'],
      acceptedSha: SHA_AGENT,
    });
    expect(loaded.checks[0]?.catalogRevision).toBe(SHA_A);
  });

  test('a second load marks saved technique IDs existing', () => {
    const plan = {
      ...acceptWatchedSha(emptySecurityPlan(), 'application', {
        url: APPLICATION_PROFILE_URL,
        ref: APPLICATION_PROFILE_REF,
        watch: [APPLICATION_PROFILE_WATCH],
        acceptedSha: SHA_A,
      }),
      checks: [check('T1190', 'public-http', 'T1190 public-http')],
    };
    saveSecurityPlan(tempDir, plan);

    const first = loadSecurityPlan(tempDir);
    const second = loadSecurityPlan(tempDir);
    expect(savedTechniqueIds(second)).toEqual(savedTechniqueIds(first));
    expect(savedTechniqueIds(second)).toEqual(['T1190']);

    const rows = buildSecurityCatalog({
      techniques: [
        technique('T1190', ['initial-access']),
        technique('T1059', ['execution']),
      ],
      surfaces: ['public-http', 'command-execution'],
      oracles: [
        {
          techniqueId: 'T1190',
          target: 'application',
          surface: 'public-http',
          command: 'node -e "process.exit(0)"',
          passExit: 0,
          timeoutSec: 30,
        },
        {
          techniqueId: 'T1059',
          target: 'application',
          surface: 'command-execution',
          command: 'node -e "process.exit(0)"',
          passExit: 0,
          timeoutSec: 30,
        },
      ],
      savedTechniqueIds: savedTechniqueIds(second),
      source: 'application',
      sourceUrl: APPLICATION_PROFILE_URL,
      catalogRevision: SHA_A,
      target: 'application',
    });

    expect(rows.find((row) => row.check.techniqueId === 'T1190')?.status).toBe('existing');
    expect(rows.find((row) => row.check.techniqueId === 'T1059')?.status).toBe('new');
  });

  test('unchecking a row keeps its milestone and does not write plan.json', () => {
    const productPlan = join(tempDir, '.alpha-loop', 'plan.json');
    const milestone = 'T1190 public-http';
    const plan = {
      ...acceptWatchedSha(emptySecurityPlan(), 'application', {
        url: APPLICATION_PROFILE_URL,
        ref: APPLICATION_PROFILE_REF,
        watch: [APPLICATION_PROFILE_WATCH],
        acceptedSha: SHA_A,
      }),
      checks: [check('T1190', 'public-http', milestone)],
    };
    saveSecurityPlan(tempDir, plan);
    expect(existsSync(productPlan)).toBe(false);

    const sentinel = '{"sentinel":true}\n';
    writeFileSync(productPlan, sentinel);

    const unchecked = setCheckSelected(loadSecurityPlan(tempDir), 'T1190', false, 'public-http');
    expect(unchecked.checks[0]?.selected).toBe(false);
    expect(unchecked.checks[0]?.milestone).toBe(milestone);
    saveSecurityPlan(tempDir, unchecked);

    const loaded = loadSecurityPlan(tempDir);
    expect(loaded.checks).toHaveLength(1);
    expect(loaded.checks[0]?.selected).toBe(false);
    expect(loaded.checks[0]?.milestone).toBe(milestone);
    expect(loaded.checks[0]?.techniqueId).toBe('T1190');
    expect(readFileSync(productPlan, 'utf8')).toBe(sentinel);
    expect(savedTechniqueIds(loaded)).toEqual(['T1190']);
  });
});
