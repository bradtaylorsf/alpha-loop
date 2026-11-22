import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/lib/config.js';
import {
  AGENT_PROFILE_REF,
  AGENT_PROFILE_URL,
  AGENT_PROFILE_WATCH,
  APPLICATION_PROFILE_REF,
  APPLICATION_PROFILE_URL,
  APPLICATION_PROFILE_WATCH,
} from '../../src/lib/security-types.js';
import {
  cacheBodyPath,
  fetchWatchedPath,
  githubBlobUrl,
  githubCommitsUrl,
  githubContentsUrl,
  type SourceFetch,
} from '../../src/lib/security-sources.js';
import { emptySecurityPlan, acceptWatchedSha, saveSecurityPlan, securityPlanPath } from '../../src/lib/security-plan.js';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BLOB_SHA = 'cccccccccccccccccccccccccccccccccccccccc';

function wrappedBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n');
}

function attackBody(techniques: Array<{ id: string; name: string; tactic: string }>): string {
  return JSON.stringify({
    type: 'bundle',
    objects: [
      { type: 'relationship', id: 'relationship--1' },
      ...techniques.map((technique) => ({
        type: 'attack-pattern',
        name: technique.name,
        description: technique.name,
        external_references: [{ source_name: 'mitre-attack', external_id: technique.id }],
        kill_chain_phases: [{ kill_chain_name: 'mitre-attack', phase_name: technique.tactic }],
      })),
      {
        type: 'attack-pattern',
        name: 'Revoked technique',
        revoked: true,
        external_references: [{ source_name: 'mitre-attack', external_id: 'T0000' }],
        kill_chain_phases: [{ kill_chain_name: 'mitre-attack', phase_name: 'execution' }],
      },
    ],
  });
}

function fixtureFetch(bodies: Record<string, unknown>): SourceFetch {
  return async (url) => {
    if (!(url in bodies)) {
      throw new Error(`unexpected URL ${url}`);
    }
    const body = bodies[url];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}

function commitsBody(sha: string): unknown {
  return [{ sha }];
}

function contentsBody(text: string): unknown {
  return { encoding: 'base64', content: wrappedBase64(text) };
}

describe('security source defaults', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-sec-src-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('missing keys use the mitre/cti and saf-mcp defaults', () => {
    const config = loadConfig();
    expect(config.securityChecks).toBe(false);
    expect(config.securityProfiles.application).toEqual({
      enabled: true,
      url: 'https://github.com/mitre/cti',
      ref: 'master',
      watch: ['enterprise-attack/enterprise-attack.json'],
    });
    expect(config.securityProfiles.agent).toEqual({
      enabled: true,
      url: 'https://github.com/secure-agentic-framework/saf-mcp',
      ref: 'main',
      watch: ['research/framework-model.yml'],
    });
    expect(config.securityProfiles.application.url).toBe(APPLICATION_PROFILE_URL);
    expect(config.securityProfiles.agent.url).toBe(AGENT_PROFILE_URL);
    expect(APPLICATION_PROFILE_URL).not.toContain('atomic-red-team');
    expect(AGENT_PROFILE_URL).not.toContain('atomic-red-team');
  });

  test('an override replaces one profile and leaves the other on its default', () => {
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), `security_checks: true
security_profiles:
  application:
    enabled: false
  agent:
    url: https://github.com/example/agent-fork
    ref: develop
    watch:
      - custom/model.yml
`);
    const config = loadConfig();
    expect(config.securityChecks).toBe(true);
    expect(config.securityProfiles.application.enabled).toBe(false);
    expect(config.securityProfiles.application.url).toBe(APPLICATION_PROFILE_URL);
    expect(config.securityProfiles.application.ref).toBe(APPLICATION_PROFILE_REF);
    expect(config.securityProfiles.application.watch).toEqual([APPLICATION_PROFILE_WATCH]);
    expect(config.securityProfiles.agent).toEqual({
      enabled: true,
      url: 'https://github.com/example/agent-fork',
      ref: 'develop',
      watch: ['custom/model.yml'],
    });
  });

  test('the init template records both default profile blocks', () => {
    const initSource = readFileSync(join(__dirname, '..', '..', 'src', 'commands', 'init.ts'), 'utf8');
    expect(initSource).toContain('url: https://github.com/mitre/cti');
    expect(initSource).toContain('ref: master');
    expect(initSource).toContain('enterprise-attack/enterprise-attack.json');
    expect(initSource).toContain('url: https://github.com/secure-agentic-framework/saf-mcp');
    expect(initSource).toContain('ref: main');
    expect(initSource).toContain('research/framework-model.yml');
  });
});

describe('fetchWatchedPath', () => {
  let tempDir: string;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-sec-fetch-'));
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('live network');
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('reads a fixture ATT&CK file, caches it by commit SHA, and skips revoked IDs', async () => {
    const body = attackBody([
      { id: 'T1190', name: 'Exploit Public-Facing Application', tactic: 'initial-access' },
      { id: 'T1059', name: 'Command and Scripting Interpreter', tactic: 'execution' },
    ]);
    const result = await fetchWatchedPath({
      projectDir: tempDir,
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watchPath: APPLICATION_PROFILE_WATCH,
      fetchImpl: fixtureFetch({
        [githubCommitsUrl(APPLICATION_PROFILE_URL, APPLICATION_PROFILE_REF, APPLICATION_PROFILE_WATCH)]: commitsBody(SHA_A),
        [githubContentsUrl(APPLICATION_PROFILE_URL, SHA_A, APPLICATION_PROFILE_WATCH)]: contentsBody(body),
      }),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.latestSha).toBe(SHA_A);
    expect(result.acceptedSha).toBeNull();
    expect(result.shaChanged).toBe(false);
    expect(result.pinMoved).toBe(false);
    expect(result.delta).toBeNull();
    expect(result.techniqueIds).toEqual(['T1059', 'T1190']);
    expect(result.cachePath).toBe(cacheBodyPath(tempDir, SHA_A, APPLICATION_PROFILE_WATCH));
    expect(result.cachePath).toContain(join('.alpha-loop', 'security-cache', SHA_A));
    expect(readFileSync(result.cachePath, 'utf8')).toContain('T1190');
  });

  test('uses the cached body for the same SHA', async () => {
    const body = attackBody([
      { id: 'T1190', name: 'Exploit Public-Facing Application', tactic: 'initial-access' },
    ]);
    const calls: string[] = [];
    const fetchImpl: SourceFetch = async (url) => {
      calls.push(url);
      if (url === githubCommitsUrl(APPLICATION_PROFILE_URL, APPLICATION_PROFILE_REF, APPLICATION_PROFILE_WATCH)) {
        return { ok: true, status: 200, json: async () => commitsBody(SHA_A), text: async () => '' };
      }
      if (url === githubContentsUrl(APPLICATION_PROFILE_URL, SHA_A, APPLICATION_PROFILE_WATCH)) {
        return { ok: true, status: 200, json: async () => contentsBody(body), text: async () => '' };
      }
      throw new Error(`unexpected URL ${url}`);
    };

    await fetchWatchedPath({
      projectDir: tempDir,
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watchPath: APPLICATION_PROFILE_WATCH,
      fetchImpl,
    });
    await fetchWatchedPath({
      projectDir: tempDir,
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watchPath: APPLICATION_PROFILE_WATCH,
      acceptedSha: SHA_A,
      fetchImpl,
    });

    const contentCalls = calls.filter((url) => url.includes('/contents/'));
    expect(contentCalls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('loads a file above the contents inline limit through the blob API', async () => {
    const body = attackBody([
      { id: 'T1190', name: 'Exploit Public-Facing Application', tactic: 'initial-access' },
    ]);
    const result = await fetchWatchedPath({
      projectDir: tempDir,
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watchPath: APPLICATION_PROFILE_WATCH,
      fetchImpl: fixtureFetch({
        [githubCommitsUrl(APPLICATION_PROFILE_URL, APPLICATION_PROFILE_REF, APPLICATION_PROFILE_WATCH)]: commitsBody(SHA_A),
        [githubContentsUrl(APPLICATION_PROFILE_URL, SHA_A, APPLICATION_PROFILE_WATCH)]: {
          sha: BLOB_SHA,
          encoding: 'none',
          size: 2_000_000,
        },
        [githubBlobUrl(APPLICATION_PROFILE_URL, BLOB_SHA)]: contentsBody(body),
      }),
    });

    expect(result.techniqueIds).toEqual(['T1190']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('filters the SAFE-MCP file to the mcp profile', async () => {
    const yaml = `techniques:
  - technique_id: SAF-T1001
    name: Tool Poisoning Attack
    lifecycle_status: active
    profiles:
      - core
      - mcp
    tactics:
      - ATK-TA0001
    summary: tool definition
  - technique_id: SAF-T9000
    name: Code agent only
    lifecycle_status: active
    profiles:
      - code-agent
    tactics:
      - ATK-TA0002
    summary: other
  - technique_id: SAF-T1002
    name: Old MCP technique
    lifecycle_status: deprecated
    profiles:
      - mcp
    tactics:
      - ATK-TA0001
    summary: retired
`;
    const result = await fetchWatchedPath({
      projectDir: tempDir,
      url: AGENT_PROFILE_URL,
      ref: AGENT_PROFILE_REF,
      watchPath: AGENT_PROFILE_WATCH,
      fetchImpl: fixtureFetch({
        [githubCommitsUrl(AGENT_PROFILE_URL, AGENT_PROFILE_REF, AGENT_PROFILE_WATCH)]: commitsBody(SHA_A),
        [githubContentsUrl(AGENT_PROFILE_URL, SHA_A, AGENT_PROFILE_WATCH)]: contentsBody(yaml),
      }),
    });

    expect(result.url).toBe('https://github.com/secure-agentic-framework/saf-mcp');
    expect(result.techniqueIds).toEqual(['SAF-T1001']);
    expect(result.techniques[0]?.profiles).toEqual(['core', 'mcp']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('reports a watched-file SHA change as a delta and leaves the saved pin in place', async () => {
    const previous = attackBody([
      { id: 'T1190', name: 'Exploit Public-Facing Application', tactic: 'initial-access' },
      { id: 'T1059', name: 'Command and Scripting Interpreter', tactic: 'execution' },
    ]);
    const next = attackBody([
      { id: 'T1190', name: 'Exploit Public-Facing Application revised', tactic: 'initial-access' },
      { id: 'T1040', name: 'Network Sniffing', tactic: 'credential-access' },
    ]);

    await fetchWatchedPath({
      projectDir: tempDir,
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watchPath: APPLICATION_PROFILE_WATCH,
      fetchImpl: fixtureFetch({
        [githubCommitsUrl(APPLICATION_PROFILE_URL, APPLICATION_PROFILE_REF, APPLICATION_PROFILE_WATCH)]: commitsBody(SHA_A),
        [githubContentsUrl(APPLICATION_PROFILE_URL, SHA_A, APPLICATION_PROFILE_WATCH)]: contentsBody(previous),
      }),
    });

    const plan = acceptWatchedSha(emptySecurityPlan(), 'application', {
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watch: [APPLICATION_PROFILE_WATCH],
      acceptedSha: SHA_A,
    });
    saveSecurityPlan(tempDir, plan);
    const saved = readFileSync(securityPlanPath(tempDir), 'utf8');
    const productPlan = join(tempDir, '.alpha-loop', 'plan.json');
    expect(existsSync(productPlan)).toBe(false);

    const result = await fetchWatchedPath({
      projectDir: tempDir,
      url: APPLICATION_PROFILE_URL,
      ref: APPLICATION_PROFILE_REF,
      watchPath: APPLICATION_PROFILE_WATCH,
      acceptedSha: SHA_A,
      fetchImpl: fixtureFetch({
        [githubCommitsUrl(APPLICATION_PROFILE_URL, APPLICATION_PROFILE_REF, APPLICATION_PROFILE_WATCH)]: commitsBody(SHA_B),
        [githubContentsUrl(APPLICATION_PROFILE_URL, SHA_B, APPLICATION_PROFILE_WATCH)]: contentsBody(next),
      }),
    });

    expect(result.latestSha).toBe(SHA_B);
    expect(result.acceptedSha).toBe(SHA_A);
    expect(result.shaChanged).toBe(true);
    expect(result.pinMoved).toBe(false);
    expect(result.delta).toEqual({
      added: ['T1040'],
      removed: ['T1059'],
      changed: ['T1190'],
    });
    expect(readFileSync(securityPlanPath(tempDir), 'utf8')).toBe(saved);
    expect(existsSync(productPlan)).toBe(false);
    expect(existsSync(cacheBodyPath(tempDir, SHA_B, APPLICATION_PROFILE_WATCH))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
