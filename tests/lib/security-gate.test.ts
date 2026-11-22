import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  filterSecurityOnlyMilestones,
  formatSecurityProofTable,
  isSecurityCheckOnlyMilestone,
  resolveProductSuitePassedForSecurity,
  runSessionSecurityGate,
  securityPlanFileExists,
} from '../../src/lib/security-gate.js';
import { saveSecurityPlan, emptySecurityPlan } from '../../src/lib/security-plan.js';
import type { SecurityPlan } from '../../src/lib/security-types.js';
import type { Config } from '../../src/lib/config.js';
import type { SessionContext } from '../../src/lib/session.js';
import { defaultSecurityProfiles } from '../../src/lib/security-types.js';

jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    step: jest.fn(),
    dry: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn().mockReturnValue({ exitCode: 0, stdout: 'abc123deadbeef\n', stderr: '' }),
  shellQuote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
}));

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    securityChecks: true,
    securityProfiles: defaultSecurityProfiles(),
    skipTests: false,
    dryRun: false,
    ...overrides,
  } as Config;
}

function baseSession(logsDir: string): SessionContext {
  return {
    name: 'test-session',
    branch: 'alpha-loop/test',
    resultsDir: join(logsDir, '..'),
    logsDir,
    results: [],
  };
}

function planWithCheck(command = 'true'): SecurityPlan {
  const plan = emptySecurityPlan();
  plan.profiles.application = {
    url: 'https://github.com/mitre/cti',
    ref: 'master',
    watch: ['enterprise-attack/enterprise-attack.json'],
    acceptedSha: 'sha-app',
  };
  plan.checks = [{
    source: 'application',
    sourceUrl: 'https://github.com/mitre/cti',
    techniqueId: 'T1190',
    catalogRevision: 'sha-app',
    surface: 'http',
    target: 'application',
    command,
    passExit: 0,
    timeoutSec: 5,
    selected: true,
    milestone: 'Security: T1190 (http)',
  }];
  return plan;
}

describe('security gate helpers', () => {
  test('isSecurityCheckOnlyMilestone requires open issues all labeled security-check', () => {
    expect(isSecurityCheckOnlyMilestone('Sec', [])).toBe(false);
    expect(isSecurityCheckOnlyMilestone('Sec', [
      { milestone: 'Sec', labels: ['security-check'] },
      { milestone: 'Sec', labels: ['security-check', 'other'] },
    ])).toBe(true);
    expect(isSecurityCheckOnlyMilestone('Sec', [
      { milestone: 'Sec', labels: ['security-check'] },
      { milestone: 'Sec', labels: ['ready'] },
    ])).toBe(false);
    expect(isSecurityCheckOnlyMilestone('Sec', [
      { milestone: 'Other', labels: ['security-check'] },
    ])).toBe(false);
  });

  test('filterSecurityOnlyMilestones hides security-only milestones from the picker list', () => {
    const milestones = [
      { number: 1, title: 'Feature A', description: '', openIssues: 2, closedIssues: 0, dueOn: null, state: 'open' },
      { number: 2, title: 'Security: T1190 (http)', description: '', openIssues: 1, closedIssues: 0, dueOn: null, state: 'open' },
    ];
    const openIssues = [
      { milestone: 'Feature A', labels: ['ready'] },
      { milestone: 'Security: T1190 (http)', labels: ['security-check'] },
    ];
    const filtered = filterSecurityOnlyMilestones(milestones, openIssues);
    expect(filtered.map((m) => m.title)).toEqual(['Feature A']);
  });

  test('resolveProductSuitePassedForSecurity: --skip-tests never marks passed', () => {
    expect(resolveProductSuitePassedForSecurity({ skipTests: true, gateTestsPassing: true })).toBe(false);
    expect(resolveProductSuitePassedForSecurity({ skipTests: false, gateTestsPassing: true })).toBe(true);
    expect(resolveProductSuitePassedForSecurity({ skipTests: false, gateTestsPassing: false })).toBe(false);
    expect(resolveProductSuitePassedForSecurity({ skipTests: false, gateTestsPassing: null })).toBe(true);
  });

  test('formatSecurityProofTable includes SHA and status rows', () => {
    const table = formatSecurityProofTable({
      version: 1,
      gitSha: 'abc123',
      catalogRevisions: { application: 'sha-app' },
      productSuitePassed: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      results: [{
        techniqueId: 'T1190',
        surface: 'http',
        source: 'application',
        target: 'application',
        status: 'PASS',
        reason: 'ok',
        command: 'true',
        exitCode: 0,
        catalogRevision: 'sha-app',
        logFile: '/tmp/x.log.txt',
        timedOut: false,
        blocked: false,
      }],
    });
    expect(table).toContain('abc123');
    expect(table).toContain('T1190');
    expect(table).toContain('PASS');
  });
});

describe('runSessionSecurityGate', () => {
  let tempDir: string;
  let cwdSpy: jest.SpyInstance;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'security-gate-'));
    mkdirSync(join(tempDir, '.alpha-loop'), { recursive: true });
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('securityPlanFileExists reflects the plan path', () => {
    expect(securityPlanFileExists(tempDir)).toBe(false);
    saveSecurityPlan(tempDir, planWithCheck());
    expect(securityPlanFileExists(tempDir)).toBe(true);
  });

  test('--skip-sec writes NOT_RUN and does not execute the command', async () => {
    saveSecurityPlan(tempDir, planWithCheck('exit 1'));
    const logsDir = join(tempDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const session = baseSession(logsDir);
    const comments: Array<{ issue: number; body: string }> = [];

    const result = await runSessionSecurityGate({
      config: baseConfig(),
      session,
      worktreePath: tempDir,
      productSuitePassed: true,
      skipSec: true,
      gitSha: 'gate-sha',
      listOpenIssuesFn: () => [{
        number: 42,
        title: 'T1190: http',
        body: '',
        labels: ['security-check'],
        milestone: 'Security: T1190 (http)',
      }],
      commentIssueFn: (_repo, issueNum, body) => {
        comments.push({ issue: issueNum, body });
        return true;
      },
    });

    expect(result.ran).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('NOT_RUN');
    expect(result.results[0].reason).toMatch(/skip-sec/i);
    expect(result.failures).toEqual([]);
    expect(session.securityProofMarkdown).toContain('NOT_RUN');
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('NOT_RUN');
  });

  test('FAIL rows are returned as security-gate-failed failures', async () => {
    saveSecurityPlan(tempDir, planWithCheck('exit 1'));
    const logsDir = join(tempDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const session = baseSession(logsDir);

    const result = await runSessionSecurityGate({
      config: baseConfig(),
      session,
      worktreePath: tempDir,
      productSuitePassed: true,
      gitSha: 'gate-sha',
      listOpenIssuesFn: () => [],
      commentIssueFn: () => true,
    });

    expect(result.results[0].status).toBe('FAIL');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].code).toBe('security-gate-failed');
  });

  test('skip-tests path via productSuitePassed false records NOT_RUN', async () => {
    saveSecurityPlan(tempDir, planWithCheck('true'));
    const logsDir = join(tempDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const session = baseSession(logsDir);

    const result = await runSessionSecurityGate({
      config: baseConfig({ skipTests: true }),
      session,
      worktreePath: tempDir,
      productSuitePassed: false,
      gitSha: 'gate-sha',
      listOpenIssuesFn: () => [],
      commentIssueFn: () => true,
    });

    expect(result.results[0].status).toBe('NOT_RUN');
    expect(result.results[0].reason).toMatch(/Product suite failed/i);
  });

  test('security_checks false skips the gate', async () => {
    saveSecurityPlan(tempDir, planWithCheck());
    const logsDir = join(tempDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const result = await runSessionSecurityGate({
      config: baseConfig({ securityChecks: false }),
      session: baseSession(logsDir),
      worktreePath: tempDir,
      productSuitePassed: true,
    });
    expect(result.ran).toBe(false);
  });
});
