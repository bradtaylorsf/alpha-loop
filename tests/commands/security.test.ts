import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPlanFromSelection,
  buildTechniqueChoices,
  formatSurfaceReport,
  issueBodyFor,
  milestoneTitleFor,
  securityCommand,
  techniqueChoiceId,
  type TechniqueChoice,
} from '../../src/commands/security.js';
import { buildSecurityCatalog, type SecurityCatalogRow } from '../../src/lib/security-catalog.js';
import { emptySecurityPlan, loadSecurityPlan } from '../../src/lib/security-plan.js';
import {
  APPLICATION_PROFILE_URL,
  AGENT_PROFILE_URL,
  type CatalogTechnique,
  type SecurityPlanCheck,
  techniqueSignature,
} from '../../src/lib/security-types.js';
import { defaultSecurityProfiles } from '../../src/lib/security-types.js';
import type { SurfaceDetectionResult } from '../../src/lib/security-surfaces.js';

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
import { writeSecurityChecks } from '../../src/lib/config.js';
import { createIssue, createMilestone, commentIssue } from '../../src/lib/github.js';

const mockConfirm = confirm as jest.MockedFunction<typeof confirm>;
const mockCheckbox = checkbox as jest.MockedFunction<typeof checkbox>;
const mockWriteSecurityChecks = writeSecurityChecks as jest.MockedFunction<typeof writeSecurityChecks>;
const mockCreateIssue = createIssue as jest.MockedFunction<typeof createIssue>;
const mockCreateMilestone = createMilestone as jest.MockedFunction<typeof createMilestone>;
const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

function catalogRows(): SecurityCatalogRow[] {
  const application = buildSecurityCatalog({
    techniques: [
      technique('T1190', ['initial-access']),
      technique('T1552', ['credential-access']),
      technique('T1578', ['cloud']),
      technique('T1040', ['credential-access']),
    ],
    surfaces: ['public-http', 'credentials-at-rest'],
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
        techniqueId: 'T1552',
        target: 'application',
        surface: 'credentials-at-rest',
        command: 'node -e "process.exit(0)"',
        passExit: 0,
        timeoutSec: 30,
      },
    ],
    savedTechniqueIds: [],
    source: 'application',
    sourceUrl: APPLICATION_PROFILE_URL,
    catalogRevision: SHA,
    target: 'application',
  });

  const agent = buildSecurityCatalog({
    techniques: [technique('SAF-T1001', [], ['mcp'])],
    surfaces: ['mcp'],
    oracles: [{
      techniqueId: 'SAF-T1001',
      target: 'mcp-agent',
      surface: 'mcp',
      command: 'node -e "process.exit(0)"',
      passExit: 0,
      timeoutSec: 15,
    }],
    savedTechniqueIds: [],
    source: 'agent',
    sourceUrl: AGENT_PROFILE_URL,
    catalogRevision: SHA,
    target: 'mcp-agent',
  });

  return [...application, ...agent];
}

describe('security selector logic', () => {
  test('technique choices include oracle rows only for offered surfaces', () => {
    const choices = buildTechniqueChoices(
      catalogRows(),
      ['public-http', 'mcp'],
      [],
    );
    const ids = choices.map((choice) => choice.techniqueId).sort();
    expect(ids).toEqual(['SAF-T1001', 'T1190']);
    expect(choices.every((choice) => choice.row.selectable)).toBe(true);
  });

  test('buildPlanFromSelection keeps unchecked milestones and pins accepted SHAs', () => {
    const previous = emptySecurityPlan();
    previous.checks.push({
      source: 'application',
      sourceUrl: APPLICATION_PROFILE_URL,
      techniqueId: 'T1552',
      catalogRevision: SHA,
      surface: 'credentials-at-rest',
      target: 'application',
      command: 'old',
      passExit: 0,
      timeoutSec: 30,
      selected: true,
      milestone: 'Security: T1552 (credentials-at-rest)',
    } satisfies SecurityPlanCheck);

    const rows = catalogRows();
    const selectedRow = rows.find((row) => row.check.techniqueId === 'T1190')!;
    const selected: TechniqueChoice[] = [{
      id: techniqueChoiceId('T1190', 'public-http'),
      name: 'T1190',
      techniqueId: 'T1190',
      surface: 'public-http',
      target: 'application',
      source: 'application',
      row: selectedRow,
      checked: true,
    }];

    const plan = buildPlanFromSelection(previous, selected, {
      application: {
        url: APPLICATION_PROFILE_URL,
        ref: 'master',
        watch: ['enterprise-attack/enterprise-attack.json'],
        acceptedSha: SHA,
      },
    });

    expect(plan.profiles.application?.acceptedSha).toBe(SHA);
    expect(plan.checks.find((check) => check.techniqueId === 'T1190')?.selected).toBe(true);
    const retained = plan.checks.find((check) => check.techniqueId === 'T1552');
    expect(retained?.selected).toBe(false);
    expect(retained?.milestone).toBe('Security: T1552 (credentials-at-rest)');
  });

  test('issue body names security-check and states ready is omitted', () => {
    const body = issueBodyFor({
      source: 'application',
      sourceUrl: APPLICATION_PROFILE_URL,
      techniqueId: 'T1190',
      catalogRevision: SHA,
      surface: 'public-http',
      target: 'application',
      command: 'node -e "process.exit(0)"',
      passExit: 0,
      timeoutSec: 30,
      selected: true,
      milestone: milestoneTitleFor('T1190', 'public-http'),
    });
    expect(body).toContain('`security-check`');
    expect(body).toContain('does not receive `ready`');
  });

  test('formatSurfaceReport prints detected signals', () => {
    const detection: SurfaceDetectionResult = {
      detected: ['public-http', 'mcp'],
      application: ['public-http'],
      mcpServers: ['docs'],
      agentSurface: true,
      signals: [
        { surface: 'public-http', detected: true, signals: ['dependency:express'] },
        { surface: 'credentials-at-rest', detected: false, signals: [] },
        { surface: 'command-execution', detected: false, signals: [] },
        { surface: 'cloud-control-plane', detected: false, signals: [] },
        { surface: 'mcp', detected: true, signals: ['mcp:docs'] },
      ],
    };
    const report = formatSurfaceReport(detection);
    expect(report).toContain('[x] public-http: dependency:express');
    expect(report).toContain('[ ] cloud-control-plane');
    expect(report).toContain('[x] mcp: mcp:docs');
  });
});

describe('securityCommand dry run', () => {
  let tempDir: string;
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-sec-cmd-'));
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      dependencies: { express: '4.0.0' },
    }));
    mkdirSync(join(tempDir, '.alpha-loop'), { recursive: true });
    writeFileSync(
      join(tempDir, '.alpha-loop', 'context.md'),
      '## Architecture\n- Express HTTP entry\n- Auth credentials at rest\n',
    );
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({
      mcpServers: { docs: { type: 'http', url: 'https://example.com/mcp' } },
    }));
    mkdirSync(join(tempDir, 'auth'), { recursive: true });
    writeFileSync(join(tempDir, 'auth', 'store.ts'), 'export {};\n');
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), 'repo: owner/repo\nagent: claude\n');

    mockConfirm.mockReset();
    mockCheckbox.mockReset();
    mockWriteSecurityChecks.mockClear();
    mockCreateIssue.mockClear();
    mockCreateMilestone.mockClear();
    mockCommentIssue.mockClear();
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: originalIsTTY });
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('dry run writes security-plan.json only and skips GitHub plus config writer', async () => {
    mockConfirm.mockResolvedValueOnce(false); // show undetected stays unchecked
    mockCheckbox.mockResolvedValueOnce([
      techniqueChoiceId('T1190', 'public-http'),
      techniqueChoiceId('SAF-T1001', 'mcp'),
    ]);

    const rows = catalogRows();
    const result = await securityCommand({
      projectDir: tempDir,
      dryRun: true,
      catalogRows: rows,
      profileResults: {
        application: {
          url: APPLICATION_PROFILE_URL,
          ref: 'master',
          watchPath: 'enterprise-attack/enterprise-attack.json',
          latestSha: SHA,
          acceptedSha: null,
          shaChanged: false,
          pinMoved: false,
          cachePath: join(tempDir, 'cache-app'),
          techniques: [technique('T1190', ['initial-access']), technique('T1552', ['credential-access'])],
          techniqueIds: ['T1190', 'T1552'],
          delta: null,
        },
        agent: {
          url: AGENT_PROFILE_URL,
          ref: 'main',
          watchPath: 'research/framework-model.yml',
          latestSha: SHA,
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

    expect(result.dryRun).toBe(true);
    expect(result.detection.detected).toEqual(
      expect.arrayContaining(['public-http', 'credentials-at-rest', 'mcp']),
    );
    expect(result.detection.detected).not.toContain('cloud-control-plane');
    expect(existsSync(join(tempDir, '.alpha-loop', 'security-plan.json'))).toBe(true);
    expect(existsSync(join(tempDir, '.alpha-loop', 'plan.json'))).toBe(false);
    expect(mockWriteSecurityChecks).not.toHaveBeenCalled();
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCommentIssue).not.toHaveBeenCalled();

    const plan = loadSecurityPlan(tempDir);
    expect(plan.checks.some((check) => check.techniqueId === 'T1190' && check.selected)).toBe(true);
    expect(plan.checks.some((check) => check.techniqueId === 'SAF-T1001' && check.selected)).toBe(true);
    const raw = readFileSync(join(tempDir, '.alpha-loop', 'security-plan.json'), 'utf8');
    expect(raw).toContain('T1190');
  });

  test('--yes path creates issues with security-check and not ready', async () => {
    const rows = catalogRows();
    await securityCommand({
      projectDir: tempDir,
      yes: true,
      catalogRows: rows,
      profileResults: {
        application: {
          url: APPLICATION_PROFILE_URL,
          ref: 'master',
          watchPath: 'enterprise-attack/enterprise-attack.json',
          latestSha: SHA,
          acceptedSha: SHA,
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
          latestSha: SHA,
          acceptedSha: SHA,
          shaChanged: false,
          pinMoved: false,
          cachePath: join(tempDir, 'cache-agent'),
          techniques: [technique('SAF-T1001', [], ['mcp'])],
          techniqueIds: ['SAF-T1001'],
          delta: null,
        },
      },
    });

    expect(mockWriteSecurityChecks).toHaveBeenCalledWith(tempDir, true);
    expect(mockCreateMilestone).toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalled();
    for (const call of mockCreateIssue.mock.calls) {
      const labels = call[3] as string[];
      expect(labels).toContain('security-check');
      expect(labels).not.toContain('ready');
    }
    expect(mockCommentIssue).toHaveBeenCalled();
    // defaultSecurityProfiles is used by the mock; keep a compile reference.
    expect(defaultSecurityProfiles().application.url).toBe(APPLICATION_PROFILE_URL);
  });
});
