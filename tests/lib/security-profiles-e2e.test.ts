/**
 * SA4 fixture: selector against a fixture repo, then executor against stub
 * commands. Proof must carry the fixture git SHA and one PASS or FAIL per
 * selected technique.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityCommand, techniqueChoiceId } from '../../src/commands/security.js';
import { DEFAULT_AUTOMATION_POLICY, type Config } from '../../src/lib/config.js';
import { buildSecurityCatalog, type SecurityCatalogRow } from '../../src/lib/security-catalog.js';
import {
  loadSecurityProof,
  runSecurityExecutor,
  securityProofPath,
} from '../../src/lib/security-executor.js';
import { loadSecurityPlan } from '../../src/lib/security-plan.js';
import {
  AGENT_PROFILE_URL,
  APPLICATION_PROFILE_URL,
  defaultSecurityProfiles,
  techniqueSignature,
  type CatalogTechnique,
} from '../../src/lib/security-types.js';

jest.mock('@inquirer/prompts', () => ({
  checkbox: jest.fn(),
  confirm: jest.fn(),
}));

jest.mock('../../src/lib/config.js', () => {
  const actual = jest.requireActual('../../src/lib/config.js') as typeof import('../../src/lib/config');
  const { defaultSecurityProfiles: defaults } = jest.requireActual('../../src/lib/security-types.js') as typeof import('../../src/lib/security-types');
  return {
    ...actual,
    loadConfig: jest.fn(() => ({
      repo: 'owner/repo',
      repoOwner: 'owner',
      project: 0,
      agent: 'claude' as const,
      model: 'sonnet',
      labelReady: 'ready',
      dryRun: false,
      securityChecks: false,
      securityProfiles: defaults(),
    })),
    writeSecurityChecks: jest.fn(),
  };
});

jest.mock('../../src/lib/logger.js', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    step: jest.fn(),
    dry: jest.fn(),
    debug: jest.fn(),
    rate: jest.fn(),
  },
}));

jest.mock('../../src/lib/github.js', () => ({
  createMilestone: jest.fn(() => 1),
  createIssue: jest.fn(() => 42),
  commentIssue: jest.fn(() => true),
  listMilestones: jest.fn(() => []),
  listLabels: jest.fn(() => []),
  createLabel: jest.fn(() => true),
}));

import { confirm, checkbox } from '@inquirer/prompts';

const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;

/** Fixture session SHA written into the proof file. */
const FIXTURE_SHA = 'ffffffffffffffffffffffffffffffffffffffff';
const CATALOG_SHA = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function technique(techniqueId: string, tactics: string[], profiles: string[] = []): CatalogTechnique {
  const name = techniqueId;
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

function fixtureCatalogRows(): SecurityCatalogRow[] {
  const application = buildSecurityCatalog({
    techniques: [technique('T1190', ['initial-access'])],
    surfaces: ['public-http'],
    oracles: [{
      techniqueId: 'T1190',
      target: 'application',
      surface: 'public-http',
      command: 'node -e "process.exit(0)"',
      passExit: 0,
      timeoutSec: 30,
    }],
    savedTechniqueIds: [],
    source: 'application',
    sourceUrl: APPLICATION_PROFILE_URL,
    catalogRevision: CATALOG_SHA,
    target: 'application',
  });

  const agent = buildSecurityCatalog({
    techniques: [technique('SAF-T1001', [], ['mcp'])],
    surfaces: ['mcp'],
    oracles: [{
      techniqueId: 'SAF-T1001',
      target: 'mcp-agent',
      surface: 'mcp',
      // Stub that fails so the proof covers both PASS and FAIL.
      command: 'node -e "process.exit(1)"',
      passExit: 0,
      timeoutSec: 15,
    }],
    savedTechniqueIds: [],
    source: 'agent',
    sourceUrl: AGENT_PROFILE_URL,
    catalogRevision: CATALOG_SHA,
    target: 'mcp-agent',
  });

  return [...application, ...agent];
}

function makeConfig(): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 1,
    agent: 'claude',
    model: 'opus',
    reviewModel: 'opus',
    pollInterval: 60,
    dryRun: false,
    baseBranch: 'master',
    logDir: 'logs',
    labelReady: 'ready',
    maxTestRetries: 3,
    testCommand: 'pnpm test',
    devCommand: 'pnpm dev',
    skipTests: false,
    skipReview: false,
    skipInstall: false,
    skipPreflight: false,
    skipVerify: false,
    skipQa: false,
    skipLearn: false,
    skipE2e: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    autoMerge: true,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    verbose: false,
    harnesses: [],
    setupCommand: '',
    evalDir: '.alpha-loop/evals',
    evalModel: '',
    skipEval: false,
    evalTimeout: 300,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    quick: false,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    sessionRetention: { pausedWorktreeDays: 0, completedWorktreeDays: 30 },
    preferEpics: false,
    securityChecks: true,
    securityProfiles: defaultSecurityProfiles(),
    automationPolicy: {
      ...DEFAULT_AUTOMATION_POLICY,
      allowedCommands: [],
      maxActiveSessions: 0,
      maxPausedSessions: 0,
      maxSessionCostUsd: 0,
      maxIssueCostUsd: 0,
    },
  };
}

describe('security profiles fixture proof', () => {
  let tempDir: string;
  let logsDir: string;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-sec-e2e-'));
    logsDir = join(tempDir, 'session-logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'security-fixture',
      dependencies: { express: '4.0.0' },
    }));
    mkdirSync(join(tempDir, '.alpha-loop'), { recursive: true });
    writeFileSync(
      join(tempDir, '.alpha-loop', 'context.md'),
      '## Architecture\n- Express HTTP entry\n',
    );
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({
      mcpServers: { docs: { type: 'http', url: 'https://example.com/mcp' } },
    }));
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), 'repo: owner/repo\nagent: claude\n');

    mockConfirm.mockReset();
    mockCheckbox.mockReset();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalIsTTY });
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('selector then executor writes proof with fixture SHA and PASS/FAIL per technique', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    mockCheckbox.mockResolvedValueOnce([
      techniqueChoiceId('T1190', 'public-http'),
      techniqueChoiceId('SAF-T1001', 'mcp'),
    ]);

    const rows = fixtureCatalogRows();
    const selector = await securityCommand({
      projectDir: tempDir,
      dryRun: true,
      catalogRows: rows,
      profileResults: {
        application: {
          url: APPLICATION_PROFILE_URL,
          ref: 'master',
          watchPath: 'enterprise-attack/enterprise-attack.json',
          latestSha: CATALOG_SHA,
          acceptedSha: null,
          shaChanged: false,
          pinMoved: false,
          cachePath: join(tempDir, 'cache-app'),
          techniques: [technique('T1190', ['initial-access'])],
          techniqueIds: ['T1190'],
          delta: null,
        },
        agent: {
          url: AGENT_PROFILE_URL,
          ref: 'main',
          watchPath: 'research/framework-model.yml',
          latestSha: CATALOG_SHA,
          acceptedSha: null,
          shaChanged: false,
          pinMoved: false,
          cachePath: join(tempDir, 'cache-agent'),
          techniques: [technique('SAF-T1001', [], ['mcp'])],
          techniqueIds: ['SAF-T1001'],
          delta: null,
        },
      },
    });

    expect(selector.selected.map((choice) => choice.techniqueId).sort()).toEqual([
      'SAF-T1001',
      'T1190',
    ]);
    expect(existsSync(join(tempDir, '.alpha-loop', 'security-plan.json'))).toBe(true);

    const plan = loadSecurityPlan(tempDir);
    const selected = plan.checks.filter((check) => check.selected);
    expect(selected).toHaveLength(2);

    const execResult = await runSecurityExecutor({
      plan,
      worktree: tempDir,
      gitSha: FIXTURE_SHA,
      logsDir,
      config: makeConfig(),
      productSuitePassed: true,
    });

    expect(execResult.proofPath).toBe(securityProofPath(logsDir));
    expect(existsSync(execResult.proofPath)).toBe(true);

    const proof = loadSecurityProof(logsDir);
    expect(proof).not.toBeNull();
    expect(proof!.gitSha).toBe(FIXTURE_SHA);

    const byId = new Map(proof!.results.map((row) => [row.techniqueId, row.status]));
    expect(byId.size).toBe(selected.length);
    for (const check of selected) {
      const status = byId.get(check.techniqueId);
      expect(['PASS', 'FAIL']).toContain(status);
    }
    expect(byId.get('T1190')).toBe('PASS');
    expect(byId.get('SAF-T1001')).toBe('FAIL');

    const raw = JSON.parse(readFileSync(execResult.proofPath, 'utf8')) as { gitSha: string };
    expect(raw.gitSha).toBe(FIXTURE_SHA);
  });
});
