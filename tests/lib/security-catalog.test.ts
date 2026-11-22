import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSecurityCatalog,
  distributionOraclesPath,
  loadOracleFile,
  selectableRows,
} from '../../src/lib/security-catalog.js';
import {
  AGENT_PROFILE_URL,
  APPLICATION_PROFILE_URL,
  type CatalogTechnique,
  techniqueSignature,
} from '../../src/lib/security-types.js';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function technique(input: {
  techniqueId: string;
  name?: string;
  tactics?: string[];
  profiles?: string[];
  summary?: string;
}): CatalogTechnique {
  const name = input.name ?? input.techniqueId;
  const tactics = input.tactics ?? [];
  const profiles = input.profiles ?? [];
  const summary = input.summary ?? '';
  return {
    techniqueId: input.techniqueId,
    name,
    tactics,
    profiles,
    summary,
    signature: techniqueSignature({
      techniqueId: input.techniqueId,
      name,
      tactics,
      profiles,
      summary,
    }),
  };
}

describe('security catalog', () => {
  const oraclesPath = distributionOraclesPath(join(__dirname, '..', '..'));

  test('loads the shipped oracle file and does not use Atomic Red Team', () => {
    expect(oraclesPath).toBeTruthy();
    const text = readFileSync(oraclesPath!, 'utf8');
    expect(text.toLowerCase()).not.toContain('atomic-red-team');
    expect(text.toLowerCase()).not.toContain('redcanaryco');
    const oracles = loadOracleFile(oraclesPath!);
    expect(oracles.map((oracle) => oracle.techniqueId)).toEqual([
      'T1190',
      'T1552',
      'T1059',
      'T1578',
      'SAF-T1001',
    ]);
    expect(oracles.every((oracle) => oracle.command.length > 0)).toBe(true);
  });

  test('excludes a command-less ATT&CK ID from the selectable list', () => {
    const oracles = loadOracleFile(oraclesPath!);
    const rows = buildSecurityCatalog({
      techniques: [
        technique({ techniqueId: 'T1190', tactics: ['initial-access'] }),
        technique({ techniqueId: 'T1040', name: 'Network Sniffing', tactics: ['credential-access'] }),
        technique({ techniqueId: 'T1059', tactics: ['execution'] }),
      ],
      surfaces: ['public-http', 'credentials-at-rest'],
      oracles,
      savedTechniqueIds: [],
      source: 'application',
      sourceUrl: APPLICATION_PROFILE_URL,
      catalogRevision: SHA,
      target: 'application',
    });

    const sniffing = rows.find((row) => row.check.techniqueId === 'T1040');
    const exploit = rows.find((row) => row.check.techniqueId === 'T1190');
    expect(sniffing).toMatchObject({
      status: 'no-local-check',
      selectable: false,
      check: {
        techniqueId: 'T1040',
        surface: 'credentials-at-rest',
        command: '',
        sourceUrl: 'https://github.com/mitre/cti',
        target: 'application',
        catalogRevision: SHA,
      },
    });
    expect(exploit?.status).toBe('new');
    expect(exploit?.selectable).toBe(true);
    expect(exploit?.check.command).toContain('ALPHA_LOOP_SECURITY_BASE_URL');
    expect(exploit?.check.passExit).toBe(0);
    expect(exploit?.check.timeoutSec).toBe(30);
    expect(selectableRows(rows).map((row) => row.check.techniqueId)).toEqual(['T1190']);
    expect(rows.map((row) => row.check.techniqueId)).not.toContain('T1059');
  });

  test('marks a saved technique ID existing on a later catalog build', () => {
    const oracles = loadOracleFile(oraclesPath!);
    const rows = buildSecurityCatalog({
      techniques: [
        technique({ techniqueId: 'T1190', tactics: ['initial-access'] }),
        technique({ techniqueId: 'T1552', tactics: ['credential-access'] }),
      ],
      surfaces: ['public-http', 'credentials-at-rest'],
      oracles,
      savedTechniqueIds: ['T1190'],
      source: 'application',
      sourceUrl: APPLICATION_PROFILE_URL,
      catalogRevision: SHA,
      target: 'application',
    });

    expect(rows.find((row) => row.check.techniqueId === 'T1190')?.status).toBe('existing');
    expect(rows.find((row) => row.check.techniqueId === 'T1552')?.status).toBe('new');
    expect(selectableRows(rows)).toHaveLength(2);
  });

  test('keeps an MCP technique with no oracle off the selectable list', () => {
    const oracles = loadOracleFile(oraclesPath!);
    const rows = buildSecurityCatalog({
      techniques: [
        technique({ techniqueId: 'SAF-T1001', profiles: ['core', 'mcp'] }),
        technique({ techniqueId: 'SAF-T1102', profiles: ['mcp'] }),
        technique({ techniqueId: 'SAF-T9000', profiles: ['code-agent'] }),
      ],
      surfaces: ['mcp'],
      oracles,
      savedTechniqueIds: [],
      source: 'agent',
      sourceUrl: AGENT_PROFILE_URL,
      catalogRevision: SHA,
      target: 'mcp-agent',
    });

    expect(rows.map((row) => row.check.techniqueId)).toEqual(['SAF-T1001', 'SAF-T1102']);
    expect(rows.find((row) => row.check.techniqueId === 'SAF-T1001')).toMatchObject({
      status: 'new',
      selectable: true,
      check: {
        source: 'agent',
        sourceUrl: AGENT_PROFILE_URL,
        target: 'mcp-agent',
        surface: 'mcp',
      },
    });
    expect(rows.find((row) => row.check.techniqueId === 'SAF-T1102')?.status).toBe('no-local-check');
    expect(selectableRows(rows).map((row) => row.check.techniqueId)).toEqual(['SAF-T1001']);
  });
});
