import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decisionAllowed,
  evaluateCommandPolicy,
  evaluateDiffPolicy,
  evaluateIssuePolicy,
  evaluateRuntimePolicy,
  evaluateSessionCapacityPolicy,
  globMatches,
  parseDiffNameOnly,
} from '../../src/lib/automation-policy.js';
import { sessionManifestPath, type DurableSessionManifest } from '../../src/lib/session.js';
import type { Config } from '../../src/lib/config.js';

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
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    sessionRetention: { pausedWorktreeDays: 0, completedWorktreeDays: 30 },
    preferEpics: false,
    automationPolicy: {
      requireLabels: ['ready'],
      blockLabels: ['do-not-automate', 'needs-human-input'],
      allowedPaths: ['src/**', 'content/**', 'public/**'],
      protectedPaths: ['package.json', '.github/workflows/**', 'sanity/schema/**'],
      allowedCommands: ['pnpm install', 'pnpm test', 'pnpm build'],
      requireHumanFor: ['auth', 'billing', 'production-deploy', 'dependency-upgrade', 'secrets'],
      maxActiveSessions: 0,
      maxPausedSessions: 0,
      maxIssuesPerSession: 1,
      maxSessionMinutes: 90,
      maxSessionCostUsd: 0,
      maxIssueCostUsd: 0,
    },
    ...overrides,
  };
}

function makeManifest(overrides: Partial<DurableSessionManifest> = {}): DurableSessionManifest {
  const now = '2026-05-30T12:00:00.000Z';
  return {
    version: 1,
    sessionId: 'session-active',
    name: 'session/active',
    issueNumber: 1,
    issueNumbers: [1],
    parentEpicNumber: null,
    branch: 'session/active',
    baseBranch: 'master',
    prUrl: null,
    sessionPrUrl: null,
    status: 'running',
    stage: 'created',
    labels: [],
    feedback: {
      currentStatus: 'running',
      question: null,
      resumeInstructions: null,
      qaChecklist: [],
      prUrl: null,
      previewUrl: null,
      classification: null,
      followUpIssueNumber: null,
      followUpIssueUrl: null,
      transitionHistory: [],
      events: [],
      updatedAt: now,
    },
    harness: {
      agent: 'claude',
      model: 'opus',
      reviewModel: 'opus',
      command: 'claude',
      testCommand: 'pnpm test',
    },
    command: 'claude',
    worktree: null,
    lastKnownBranch: 'session/active',
    currentIssue: { issueNum: 1, title: 'Active' },
    issues: [],
    prompts: [],
    promptPath: null,
    promptHash: null,
    transcripts: [],
    transcriptPath: null,
    logs: {
      sessionDir: '.alpha-loop/sessions/session/active',
      logsDir: '.alpha-loop/sessions/session/active/logs',
      traceDir: '.alpha-loop/traces/session-active',
      files: [],
    },
    screenshots: [],
    previewUrl: null,
    timestamps: {
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    },
    lastEventId: null,
    policyDecisions: [],
    errors: [],
    ...overrides,
  };
}

describe('automation policy', () => {
  it('allows ready work inside allowed paths', () => {
    const config = makeConfig();
    const issueDecision = evaluateIssuePolicy(config, {
      number: 10,
      title: 'Update hero copy',
      body: 'Change public homepage copy.',
      labels: ['ready'],
    });
    const diffDecision = evaluateDiffPolicy(config, ['src/app.ts', 'content/home.md'], { issueNum: 10 });

    expect(decisionAllowed(issueDecision)).toBe(true);
    expect(decisionAllowed(diffDecision)).toBe(true);
  });

  it('blocks configured labels before work starts', () => {
    const decision = evaluateIssuePolicy(makeConfig(), {
      number: 11,
      title: 'Do not run',
      body: '',
      labels: ['ready', 'do-not-automate'],
    });

    expect(decision.status).toBe('blocked');
    expect(decision.reason).toContain('blocked label');
  });

  it('requires human input for high-risk categories', () => {
    const decision = evaluateIssuePolicy(makeConfig(), {
      number: 12,
      title: 'Add OAuth login',
      body: 'Implement auth session handling.',
      labels: ['ready'],
    });

    expect(decision.status).toBe('needs_human');
    expect(decision.categories).toEqual(['auth']);
  });

  it('detects protected paths and paths outside the allowlist', () => {
    const decision = evaluateDiffPolicy(
      makeConfig(),
      parseDiffNameOnly('package.json\nsrc/app.ts\nscripts/deploy.sh\n'),
      { issueNum: 13 },
    );

    expect(decision.status).toBe('needs_human');
    expect(decision.paths).toEqual(['package.json', 'scripts/deploy.sh']);
  });

  it('blocks configured commands outside the allowlist', () => {
    const allowed = evaluateCommandPolicy(makeConfig(), 'pnpm install --frozen-lockfile');
    const blocked = evaluateCommandPolicy(makeConfig(), 'rm -rf public');
    const chained = evaluateCommandPolicy(makeConfig(), 'pnpm test && rm -rf public');

    expect(decisionAllowed(allowed)).toBe(true);
    expect(blocked.status).toBe('blocked');
    expect(blocked.reason).toContain('allowed_commands');
    expect(chained.status).toBe('blocked');
    expect(chained.reason).toContain('allowed_commands');
  });

  it('blocks when runtime exceeds max_session_minutes', () => {
    const decision = evaluateRuntimePolicy(makeConfig(), 91 * 60_000);

    expect(decision.status).toBe('blocked');
    expect(decision.reason).toContain('Maximum automation runtime');
  });

  it('counts active and paused durable sessions for capacity limits', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-policy-'));
    const sessionsRoot = join(tempDir, '.alpha-loop', 'sessions');
    const activeDir = join(sessionsRoot, 'session', 'active');
    const pausedDir = join(sessionsRoot, 'session', 'paused');
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(pausedDir, { recursive: true });
    writeFileSync(sessionManifestPath(activeDir), JSON.stringify(makeManifest(), null, 2));
    writeFileSync(sessionManifestPath(pausedDir), JSON.stringify(makeManifest({
      sessionId: 'session-paused',
      name: 'session/paused',
      status: 'human_input_requested',
      feedback: {
        ...makeManifest().feedback,
        currentStatus: 'running',
      },
    }), null, 2));

    try {
      const decision = evaluateSessionCapacityPolicy(makeConfig({
        automationPolicy: {
          ...makeConfig().automationPolicy!,
          maxActiveSessions: 1,
          maxPausedSessions: 1,
        },
      }), { sessionsRoot });

      expect(decision.status).toBe('blocked');
      expect(decision.reasons).toEqual(expect.arrayContaining([
        'Maximum active sessions reached (1 / 1).',
        'Maximum paused sessions reached (1 / 1).',
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('matches simple recursive globs', () => {
    expect(globMatches('src/lib/pipeline.ts', 'src/**')).toBe(true);
    expect(globMatches('.github/workflows/ci.yml', '.github/workflows/**')).toBe(true);
    expect(globMatches('package.json', 'package.json')).toBe(true);
    expect(globMatches('scripts/deploy.sh', 'src/**')).toBe(false);
  });
});
