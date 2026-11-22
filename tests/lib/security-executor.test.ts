import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AUTOMATION_POLICY, type Config } from '../../src/lib/config.js';
import {
  isProofValidForSha,
  loadSecurityProof,
  runSecurityExecutor,
  securityProofPath,
} from '../../src/lib/security-executor.js';
import {
  APPLICATION_PROFILE_URL,
  type SecurityPlan,
  type SecurityPlanCheck,
} from '../../src/lib/security-types.js';

const SHA_CURRENT = 'cccccccccccccccccccccccccccccccccccccccc';
const SHA_OLD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CATALOG_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeConfig(overrides: Partial<Config> = {}): Config {
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
    securityProfiles: {
      application: {
        enabled: true,
        url: APPLICATION_PROFILE_URL,
        ref: 'master',
        watch: ['enterprise-attack/enterprise-attack.json'],
      },
      agent: {
        enabled: true,
        url: 'https://github.com/secure-agentic-framework/saf-mcp',
        ref: 'main',
        watch: ['research/framework-model.yml'],
      },
    },
    automationPolicy: {
      ...DEFAULT_AUTOMATION_POLICY,
      allowedCommands: [],
      maxActiveSessions: 0,
      maxPausedSessions: 0,
      maxSessionCostUsd: 0,
      maxIssueCostUsd: 0,
    },
    ...overrides,
  };
}

function makeCheck(overrides: Partial<SecurityPlanCheck> = {}): SecurityPlanCheck {
  return {
    source: 'application',
    sourceUrl: APPLICATION_PROFILE_URL,
    techniqueId: 'T1190',
    catalogRevision: CATALOG_SHA,
    surface: 'public-http',
    target: 'application',
    command: 'node -e "process.exit(0)"',
    passExit: 0,
    timeoutSec: 30,
    selected: true,
    milestone: 'T1190 public-http',
    ...overrides,
  };
}

function makePlan(checks: SecurityPlanCheck[]): SecurityPlan {
  return {
    version: 1,
    profiles: {
      application: {
        url: APPLICATION_PROFILE_URL,
        ref: 'master',
        watch: ['enterprise-attack/enterprise-attack.json'],
        acceptedSha: CATALOG_SHA,
      },
    },
    checks,
  };
}

describe('security executor', () => {
  let tempDir: string;
  let worktree: string;
  let logsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-sec-exec-'));
    worktree = join(tempDir, 'worktree');
    logsDir = join(tempDir, 'logs');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('marks every selected row NOT_RUN when the product suite failed', async () => {
    const plan = makePlan([
      makeCheck({ techniqueId: 'T1190' }),
      makeCheck({ techniqueId: 'T1078', surface: 'credentials-at-rest' }),
    ]);

    const result = await runSecurityExecutor({
      plan,
      worktree,
      gitSha: SHA_CURRENT,
      logsDir,
      config: makeConfig(),
      productSuitePassed: false,
    });

    expect(result.results).toHaveLength(2);
    expect(result.results.every((row) => row.status === 'NOT_RUN')).toBe(true);
    expect(result.results.every((row) => row.reason.includes('Product suite failed'))).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.proof.gitSha).toBe(SHA_CURRENT);
    expect(result.proof.productSuitePassed).toBe(false);
    expect(existsSync(securityProofPath(logsDir))).toBe(true);
    expect(existsSync(result.results[0].logFile)).toBe(true);
  });

  test('skipReason forces NOT_RUN even when productSuitePassed is true', async () => {
    const plan = makePlan([
      makeCheck({ techniqueId: 'T1190', command: 'exit 1' }),
    ]);

    const result = await runSecurityExecutor({
      plan,
      worktree,
      gitSha: SHA_CURRENT,
      logsDir,
      config: makeConfig(),
      productSuitePassed: true,
      skipReason: 'Skipped via --skip-sec; security checks not run.',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('NOT_RUN');
    expect(result.results[0].reason).toMatch(/skip-sec/i);
    expect(result.passed).toBe(false);
  });

  test('FAIL for a blocked command with a production host even when allowed_commands is empty', async () => {
    const plan = makePlan([
      makeCheck({
        techniqueId: 'T1190',
        command: 'curl -sf https://api.production.example.com/health',
      }),
    ]);

    const result = await runSecurityExecutor({
      plan,
      worktree,
      gitSha: SHA_CURRENT,
      logsDir,
      config: makeConfig(),
      productSuitePassed: true,
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('FAIL');
    expect(result.results[0].blocked).toBe(true);
    expect(result.results[0].reason).toMatch(/production host/i);
    expect(result.passed).toBe(false);
    expect(result.proof.gitSha).toBe(SHA_CURRENT);
    expect(result.proof.catalogRevisions.application).toBe(CATALOG_SHA);
  });

  test('FAIL when command is outside allowed_commands', async () => {
    const plan = makePlan([
      makeCheck({
        command: 'node -e "process.exit(0)"',
      }),
    ]);
    const config = makeConfig({
      automationPolicy: {
        ...DEFAULT_AUTOMATION_POLICY,
        allowedCommands: ['pnpm test'],
        maxActiveSessions: 0,
        maxPausedSessions: 0,
        maxSessionCostUsd: 0,
        maxIssueCostUsd: 0,
      },
    });

    const result = await runSecurityExecutor({
      plan,
      worktree,
      gitSha: SHA_CURRENT,
      logsDir,
      config,
      productSuitePassed: true,
    });

    expect(result.results[0].status).toBe('FAIL');
    expect(result.results[0].blocked).toBe(true);
    expect(result.results[0].reason).toContain('allowed_commands');
  });

  test('PASS only when the proof is bound to the current session SHA', async () => {
    const plan = makePlan([
      makeCheck({
        command: 'node -e "process.exit(0)"',
        passExit: 0,
      }),
    ]);

    // Older proof for a different SHA must not count as PASS for this session.
    writeFileSync(
      securityProofPath(logsDir),
      `${JSON.stringify({
        version: 1,
        gitSha: SHA_OLD,
        catalogRevisions: { application: CATALOG_SHA },
        productSuitePassed: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        results: [{
          techniqueId: 'T1190',
          surface: 'public-http',
          source: 'application',
          target: 'application',
          status: 'PASS',
          reason: 'stale',
          command: 'node -e "process.exit(0)"',
          exitCode: 0,
          catalogRevision: CATALOG_SHA,
          logFile: 'old.log.txt',
          timedOut: false,
          blocked: false,
        }],
      }, null, 2)}\n`,
    );

    const stale = loadSecurityProof(logsDir);
    expect(stale).not.toBeNull();
    expect(isProofValidForSha(stale!, SHA_CURRENT)).toBe(false);
    expect(isProofValidForSha(stale!, SHA_OLD)).toBe(true);

    const result = await runSecurityExecutor({
      plan,
      worktree,
      gitSha: SHA_CURRENT,
      logsDir,
      config: makeConfig(),
      productSuitePassed: true,
    });

    expect(result.results[0].status).toBe('PASS');
    expect(result.proof.gitSha).toBe(SHA_CURRENT);
    expect(result.passed).toBe(true);
    expect(isProofValidForSha(result.proof, SHA_CURRENT)).toBe(true);
    expect(isProofValidForSha(result.proof, SHA_OLD)).toBe(false);

    const written = JSON.parse(readFileSync(securityProofPath(logsDir), 'utf8'));
    expect(written.gitSha).toBe(SHA_CURRENT);
    expect(written.results[0].status).toBe('PASS');
    expect(written.catalogRevisions.application).toBe(CATALOG_SHA);
  });

  test('FAIL on timeout and on non-matching exit code', async () => {
    const plan = makePlan([
      makeCheck({
        techniqueId: 'T1059',
        surface: 'command-execution',
        command: 'node -e "setTimeout(() => {}, 5000)"',
        timeoutSec: 0.2,
        passExit: 0,
      }),
      makeCheck({
        techniqueId: 'T1078',
        surface: 'credentials-at-rest',
        command: 'node -e "process.exit(2)"',
        passExit: 0,
        timeoutSec: 10,
      }),
    ]);

    const result = await runSecurityExecutor({
      plan,
      worktree,
      gitSha: SHA_CURRENT,
      logsDir,
      config: makeConfig(),
      productSuitePassed: true,
    });

    const timeoutRow = result.results.find((row) => row.techniqueId === 'T1059');
    const exitRow = result.results.find((row) => row.techniqueId === 'T1078');
    expect(timeoutRow?.status).toBe('FAIL');
    expect(timeoutRow?.timedOut).toBe(true);
    expect(exitRow?.status).toBe('FAIL');
    expect(exitRow?.reason).toMatch(/Exit code 2/);
    expect(result.passed).toBe(false);
  });

  test('FAIL when catalogRevision does not match the accepted profile SHA', async () => {
    const plan = makePlan([
      makeCheck({
        catalogRevision: 'ffffffffffffffffffffffffffffffffffffffff',
      }),
    ]);

    const result = await runSecurityExecutor({
      plan,
      worktree,
      gitSha: SHA_CURRENT,
      logsDir,
      config: makeConfig(),
      productSuitePassed: true,
    });

    expect(result.results[0].status).toBe('FAIL');
    expect(result.results[0].blocked).toBe(true);
    expect(result.results[0].reason).toMatch(/does not match accepted SHA/);
  });

  test('FAIL when captured output contains credential-shaped text', async () => {
    const plan = makePlan([
      makeCheck({
        command: 'node -e "console.log(\'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\')"',
      }),
    ]);

    const result = await runSecurityExecutor({
      plan,
      worktree,
      gitSha: SHA_CURRENT,
      logsDir,
      config: makeConfig(),
      productSuitePassed: true,
    });

    expect(result.results[0].status).toBe('FAIL');
    expect(result.results[0].blocked).toBe(true);
    expect(result.results[0].reason).toMatch(/credential-shaped/i);
  });
});
