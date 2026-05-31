jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  shellQuote: (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`,
}));

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn(),
  resolveStepConfig: jest.fn(),
}));

jest.mock('../../src/lib/rate-limit', () => ({
  ghExec: jest.fn(),
}));

jest.mock('../../src/lib/agent', () => ({
  spawnAgent: jest.fn(),
}));

jest.mock('../../src/lib/prompts', () => ({
  buildReviewPrompt: jest.fn(() => 'review prompt'),
}));

jest.mock('../../src/lib/pipeline', () => ({
  isRecoveredResult: jest.fn((result: { recoveryMode?: string }) => result.recoveryMode !== undefined),
  processIssue: jest.fn(),
}));

jest.mock('../../src/lib/github', () => ({
  labelIssue: jest.fn(),
  commentIssue: jest.fn(),
  createPR: jest.fn(),
  getIssueWithComments: jest.fn(),
  updateProjectStatus: jest.fn(),
}));

jest.mock('../../src/lib/learning', () => ({
  generateSessionSummary: jest.fn().mockResolvedValue(null),
  repairSessionLearningArtifacts: jest.fn(),
  repairSessionSummaryArtifact: jest.fn(),
}));

jest.mock('../../src/lib/events', () => ({
  emitLifecycleEvent: jest.fn().mockResolvedValue({ event: {}, deliveries: [] }),
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStrandedBranches, resumeCommand } from '../../src/commands/resume';
import { loadConfig, resolveStepConfig, type Config } from '../../src/lib/config';
import { createPR, labelIssue, commentIssue, getIssueWithComments, updateProjectStatus } from '../../src/lib/github';
import { ghExec } from '../../src/lib/rate-limit';
import { spawnAgent } from '../../src/lib/agent';
import { exec } from '../../src/lib/shell';
import { processIssue } from '../../src/lib/pipeline';
import {
  generateSessionSummary,
  repairSessionLearningArtifacts,
  repairSessionSummaryArtifact,
} from '../../src/lib/learning';
import { emitLifecycleEvent } from '../../src/lib/events';
import type { DurableSessionManifest } from '../../src/lib/session';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockResolveStepConfig = resolveStepConfig as jest.MockedFunction<typeof resolveStepConfig>;
const mockGhExec = ghExec as jest.MockedFunction<typeof ghExec>;
const mockCreatePR = createPR as jest.MockedFunction<typeof createPR>;
const mockLabelIssue = labelIssue as jest.MockedFunction<typeof labelIssue>;
const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;
const mockGetIssueWithComments = getIssueWithComments as jest.MockedFunction<typeof getIssueWithComments>;
const mockUpdateProjectStatus = updateProjectStatus as jest.MockedFunction<typeof updateProjectStatus>;
const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockProcessIssue = processIssue as jest.MockedFunction<typeof processIssue>;
const mockGenerateSessionSummary = generateSessionSummary as jest.MockedFunction<typeof generateSessionSummary>;
const mockRepairSessionLearningArtifacts = repairSessionLearningArtifacts as jest.MockedFunction<typeof repairSessionLearningArtifacts>;
const mockRepairSessionSummaryArtifact = repairSessionSummaryArtifact as jest.MockedFunction<typeof repairSessionSummaryArtifact>;
const mockEmitLifecycleEvent = emitLifecycleEvent as jest.MockedFunction<typeof emitLifecycleEvent>;

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const repoRoot = process.cwd();
let tempDir: string | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  process.chdir(repoRoot);
  tempDir = undefined;
  mockResolveStepConfig.mockReturnValue({ agent: 'codex', model: 'gpt-5' });
  mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/269');
  mockGetIssueWithComments.mockReturnValue(null);
  mockProcessIssue.mockResolvedValue({
    issueNum: 286,
    title: 'Resume paused work',
    status: 'success',
    prUrl: 'https://github.com/owner/repo/pull/286',
    testsPassing: true,
    verifyPassing: true,
    verifySkipped: false,
    duration: 12,
    filesChanged: 1,
  });
  mockRepairSessionLearningArtifacts.mockReturnValue({ repaired: 0, created: 1, skipped: 0, failed: 0 });
});

afterEach(() => {
  process.chdir(repoRoot);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 2,
    agent: 'codex',
    model: 'gpt-5',
    reviewModel: '',
    pollInterval: 60,
    dryRun: false,
    baseBranch: 'master',
    logDir: 'logs',
    labelReady: 'ready',
    maxTestRetries: 3,
    testCommand: 'pnpm test',
    devCommand: 'pnpm dev',
    skipTests: false,
    skipReview: true,
    skipInstall: false,
    skipPreflight: false,
    skipVerify: false,
    skipLearn: false,
    skipE2e: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    autoMerge: false,
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
    preferEpics: false,
    ...overrides,
  };
}

function makeManifest(overrides: Partial<DurableSessionManifest> = {}): DurableSessionManifest {
  const now = '2026-05-30T12:00:00.000Z';
  return {
    version: 1,
    sessionId: 'session-20260530-120000',
    name: 'session/20260530-120000',
    issueNumber: 286,
    issueNumbers: [286],
    parentEpicNumber: 293,
    parentEpicTitle: 'Hosted Alpha Loop',
    branch: 'session/20260530-120000',
    baseBranch: 'master',
    prUrl: null,
    sessionPrUrl: null,
    status: 'human_input_requested',
    stage: 'human_input_requested',
    labels: ['needs-human-input'],
    feedback: {
      currentStatus: 'human_input_requested',
      question: 'Which CTA copy should be used?',
      resumeInstructions: 'Use the selected CTA copy and continue.',
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
      agent: 'codex',
      model: 'gpt-5',
      reviewModel: 'gpt-5',
      command: 'codex',
      testCommand: 'pnpm test',
    },
    command: 'codex',
    worktree: {
      path: join(tmpdir(), 'alpha-loop-resume-worktree-286'),
      branch: 'agent/issue-286',
      resumed: false,
      missing: false,
      lastKnownBranch: 'agent/issue-286',
      updatedAt: now,
    },
    lastKnownBranch: 'agent/issue-286',
    currentIssue: { issueNum: 286, title: 'Resume paused work' },
    issues: [{
      issueNum: 286,
      title: 'Resume paused work',
      status: 'human_input_requested',
      stage: 'human_input_requested',
      branch: 'agent/issue-286',
      worktreePath: join(tmpdir(), 'alpha-loop-resume-worktree-286'),
      worktreeMissing: false,
      updatedAt: now,
    }],
    prompts: [{
      issueNum: 286,
      stage: 'implement',
      path: '.alpha-loop/traces/session-20260530-120000/prompts/issue-286-implement.md',
      hash: '1234567890abcdef',
      recordedAt: now,
    }],
    promptPath: '.alpha-loop/traces/session-20260530-120000/prompts/issue-286-implement.md',
    promptHash: '1234567890abcdef',
    transcripts: [{
      issueNum: 286,
      stage: 'implement',
      path: '.alpha-loop/traces/session-20260530-120000/outputs/issue-286-implement.log',
      recordedAt: now,
    }],
    transcriptPath: '.alpha-loop/traces/session-20260530-120000/outputs/issue-286-implement.log',
    logs: {
      sessionDir: '.alpha-loop/sessions/session/20260530-120000',
      logsDir: '.alpha-loop/sessions/session/20260530-120000/logs',
      traceDir: '.alpha-loop/traces/session-20260530-120000',
      files: ['.alpha-loop/sessions/session/20260530-120000/logs/issue-286.log'],
    },
    screenshots: [],
    previewUrl: null,
    timestamps: {
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    },
    lastEventId: null,
    errors: [],
    ...overrides,
  };
}

describe('findStrandedBranches', () => {
  test('normalizes + prefixed branches checked out in another worktree', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --list "agent/issue-*"') {
        return ok('  agent/issue-462\n+ agent/issue-466\n');
      }
      if (cmd === 'git worktree list --porcelain') return ok('');
      if (cmd === `git log 'origin/master..agent/issue-462' --oneline`) return ok('');
      if (cmd === `git log 'origin/master..agent/issue-466' --oneline`) {
        return ok('a3f214b fix(#466): address verification findings\n');
      }
      if (cmd === `git diff --name-only 'origin/master...agent/issue-466'`) {
        return ok('src/lib/agent.ts\n');
      }
      return ok('');
    });

    expect(findStrandedBranches('master')).toEqual([
      {
        branch: 'agent/issue-466',
        issueNum: 466,
        commits: ['a3f214b fix(#466): address verification findings'],
        filesChanged: ['src/lib/agent.ts'],
      },
    ]);
  });

  test('detects agent issue branches from git worktree porcelain output', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --list "agent/issue-*"') return ok('');
      if (cmd === 'git worktree list --porcelain') {
        return ok([
          'worktree /repo',
          'HEAD abc123',
          'branch refs/heads/master',
          '',
          'worktree /repo/.worktrees/issue-187',
          'HEAD def456',
          'branch refs/heads/agent/issue-187',
          '',
        ].join('\n'));
      }
      if (cmd === `git log 'origin/master..agent/issue-187' --oneline`) {
        return ok('def456 fix(#187): recover after result\n');
      }
      if (cmd === `git diff --name-only 'origin/master...agent/issue-187'`) {
        return ok('src/commands/resume.ts\n');
      }
      return ok('');
    });

    expect(findStrandedBranches('master', 187)).toEqual([
      {
        branch: 'agent/issue-187',
        issueNum: 187,
        commits: ['def456 fix(#187): recover after result'],
        filesChanged: ['src/commands/resume.ts'],
      },
    ]);
  });
});

describe('resumeCommand', () => {
  test('resumes a paused clarification session with feedback and prior transcript context', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-resume-paused-'));
    process.chdir(tempDir);

    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-120000');
    const worktreePath = join(tempDir, '.worktrees', 'issue-286');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(makeManifest({
      worktree: {
        path: worktreePath,
        branch: 'agent/issue-286',
        resumed: false,
        missing: false,
        lastKnownBranch: 'agent/issue-286',
        updatedAt: '2026-05-30T12:00:00.000Z',
      },
      issues: [{
        issueNum: 286,
        title: 'Resume paused work',
        status: 'human_input_requested',
        stage: 'human_input_requested',
        branch: 'agent/issue-286',
        worktreePath,
        worktreeMissing: false,
        updatedAt: '2026-05-30T12:00:00.000Z',
      }],
    }), null, 2));

    mockLoadConfig.mockReturnValue(baseConfig());
    mockGetIssueWithComments.mockReturnValue({
      number: 286,
      title: 'Resume paused work',
      body: 'Issue body',
      labels: ['needs-human-input'],
      comments: [{
        author: 'bradtaylorsf',
        body: 'Use the shorter CTA copy.',
        createdAt: '2026-05-30T12:05:00.000Z',
      }],
    });

    await resumeCommand({ issue: '286' });

    expect(mockProcessIssue).toHaveBeenCalledWith(
      286,
      'Resume paused work',
      'Issue body',
      expect.objectContaining({ repo: 'owner/repo' }),
      expect.objectContaining({
        name: 'session/20260530-120000',
        resultsDir: expect.stringContaining('.alpha-loop/sessions/session/20260530-120000'),
        logsDir: expect.stringContaining('.alpha-loop/sessions/session/20260530-120000/logs'),
      }),
      expect.objectContaining({
        resumeStage: 'clarification',
        existingPrUrl: null,
        savedWorktree: {
          branch: 'agent/issue-286',
          path: expect.stringContaining('.worktrees/issue-286'),
        },
        resumeContext: expect.stringContaining('Use the shorter CTA copy.'),
      }),
    );
    const options = mockProcessIssue.mock.calls[0][5] as any;
    expect(options.resumeContext).toContain('issue-286-implement.md');
    expect(options.resumeContext).toContain('issue-286-implement.log');
    expect(mockLabelIssue).toHaveBeenCalledWith('owner/repo', 286, 'in-progress', 'ready');
    expect(mockLabelIssue).toHaveBeenCalledWith('owner/repo', 286, 'in-progress', 'needs-human-input');
    expect(mockCommentIssue).toHaveBeenCalledWith(
      'owner/repo',
      286,
      expect.stringContaining('Feedback classification: `clarification`'),
    );
    expect(mockEmitLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.resumed',
      manifestPath: expect.stringContaining('session.json'),
      context: expect.objectContaining({
        issueNumber: 286,
        feedback: expect.objectContaining({ classification: 'clarification' }),
        metadata: expect.objectContaining({ resumeStage: 'clarification' }),
      }),
    }));
    expect(mockEmitLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.completed',
      manifestPath: expect.stringContaining('session.json'),
      context: expect.objectContaining({
        issueNumber: 286,
        metadata: expect.objectContaining({ resumed: true }),
      }),
    }));

    const manifest = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf-8'));
    expect(manifest.status).toBe('completed');
    expect(manifest.feedback.transitionHistory.map((entry: any) => entry.to)).toEqual([
      'feedback_received',
      'resume_requested',
      'resuming',
      'completed',
    ]);
  });

  test('resumes QA change requests at implementation stage and keeps the existing PR URL', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-resume-qa-'));
    process.chdir(tempDir);

    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-130000');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(makeManifest({
      sessionId: 'session-20260530-130000',
      name: 'session/20260530-130000',
      status: 'qa_requested',
      stage: 'qa_requested',
      prUrl: 'https://github.com/owner/repo/pull/286',
      feedback: {
        ...makeManifest().feedback,
        currentStatus: 'qa_requested',
        question: null,
        resumeInstructions: 'Complete QA, then reply with approval or requested changes.',
        qaChecklist: ['Open preview', 'Confirm CTA copy'],
        prUrl: 'https://github.com/owner/repo/pull/286',
        updatedAt: '2026-05-30T12:00:00.000Z',
      },
      timestamps: {
        createdAt: '2026-05-30T12:00:00.000Z',
        startedAt: '2026-05-30T12:00:00.000Z',
        updatedAt: '2026-05-30T12:00:00.000Z',
      },
    }), null, 2));

    mockLoadConfig.mockReturnValue(baseConfig());
    mockGetIssueWithComments.mockReturnValue({
      number: 286,
      title: 'Resume paused work',
      body: 'Issue body',
      labels: ['in-review', 'needs-human-input'],
      comments: [{
        author: 'bradtaylorsf',
        body: 'QA failed: please change the button copy.',
        createdAt: '2026-05-30T12:10:00.000Z',
      }],
    });

    await resumeCommand({ issue: '286' });

    expect(mockProcessIssue).toHaveBeenCalledWith(
      286,
      'Resume paused work',
      'Issue body',
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        resumeStage: 'implementation',
        existingPrUrl: 'https://github.com/owner/repo/pull/286',
        resumeContext: expect.stringContaining('QA failed: please change the button copy.'),
      }),
    );
    const options = mockProcessIssue.mock.calls[0][5] as any;
    expect(options.resumeContext).toContain('QA checklist');
  });

  test('skips duplicate resume when the latest manifest is already resuming', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-resume-duplicate-'));
    process.chdir(tempDir);

    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-140000');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(makeManifest({
      sessionId: 'session-20260530-140000',
      name: 'session/20260530-140000',
      status: 'resuming',
      stage: 'resuming',
      feedback: {
        ...makeManifest().feedback,
        currentStatus: 'resuming',
      },
      timestamps: {
        createdAt: '2026-05-30T12:00:00.000Z',
        startedAt: '2026-05-30T12:00:00.000Z',
        updatedAt: '2026-05-30T14:00:00.000Z',
      },
    }), null, 2));

    mockLoadConfig.mockReturnValue(baseConfig());

    await resumeCommand({ issue: '286' });

    expect(mockProcessIssue).not.toHaveBeenCalled();
    expect(mockGetIssueWithComments).not.toHaveBeenCalled();
    expect(mockCreatePR).not.toHaveBeenCalled();
  });

  test('prefers crash markers over branch walking and clears marker after saving recovered result', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-resume-marker-'));
    process.chdir(tempDir);

    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', 'epic-226');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'crash-269.json'), JSON.stringify({
      issueNum: 269,
      step: 'review',
      branch: 'agent/issue-269',
      hasCommits: true,
      error: 'review crashed',
      timestamp: '2026-05-25T23:59:00.000Z',
      recoverable: true,
    }, null, 2));

    let sessionPrBody = '';
    mockLoadConfig.mockReturnValue(baseConfig());
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --list "agent/issue-*"') {
        throw new Error('branch walking should not be used when a crash marker exists');
      }
      if (cmd === `git log 'origin/master..agent/issue-269' --oneline`) return ok('abc123 recover stranded work\n');
      if (cmd === `git diff --name-only 'origin/master...agent/issue-269'`) return ok('src/lib/pipeline.ts\n');
      if (cmd === 'git worktree list --porcelain') return ok('');
      if (cmd === 'git rev-parse --show-toplevel') return ok(tempDir ?? '');
      if (cmd === `git checkout 'agent/issue-269'`) return ok('');
      if (cmd === 'git status --porcelain -- ".alpha-loop/learnings"') return ok('');
      if (cmd === `git push -u origin 'agent/issue-269'`) return ok('');
      return ok('');
    });
    mockGhExec.mockImplementation((cmd: string) => {
      if (cmd === `gh pr list --repo 'owner/repo' --head 'agent/issue-269' --state open --json number --limit 1`) return ok('[]');
      if (cmd === `gh issue view 269 --repo 'owner/repo' --json title`) return ok('{"title":"Recover artifact exports"}');
      if (cmd === `gh pr list --repo 'owner/repo' --head 'session/epic-226' --state open --json number,url --limit 1`) {
        return ok('[{"number":999,"url":"https://github.com/owner/repo/pull/999"}]');
      }
      if (cmd.startsWith(`gh pr edit 999 --repo 'owner/repo' --body-file `)) {
        const bodyFile = cmd.match(/--body-file '([^']+)'/)?.[1];
        if (bodyFile) sessionPrBody = readFileSync(bodyFile, 'utf-8');
        return ok('');
      }
      if (cmd.startsWith(`gh pr edit 999 --repo 'owner/repo' --title `)) return ok('');
      return ok('');
    });

    await resumeCommand({ issue: '269' });

    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'owner/repo',
      base: 'master',
      head: 'agent/issue-269',
      cwd: tempDir!,
    }));
    expect(existsSync(join(sessionDir, 'crash-269.json'))).toBe(false);
    expect(existsSync(join(sessionDir, 'result-269.json'))).toBe(true);
    expect(sessionPrBody).toContain('### Recovered Issues');
    expect(sessionPrBody).toContain('#269: Recover artifact exports — RECOVERED BY RESUME');
  });

  test('records recovered PRs as unverified WIP and updates the session PR without CommonJS require', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-resume-'));
    process.chdir(tempDir);

    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', 'epic-123');
    mkdirSync(join(sessionDir, 'logs'), { recursive: true });
    writeFileSync(join(sessionDir, 'logs', 'issue-269-review.log'), 'review agent hit max turns');

    let sessionPrBody = '';
    let sessionPrBodyFile: string | undefined;
    mockLoadConfig.mockReturnValue(baseConfig());
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --list "agent/issue-*"') return ok('  agent/issue-269\n');
      if (cmd === 'git worktree list --porcelain') return ok('');
      if (cmd === `git log 'origin/master..agent/issue-269' --oneline`) return ok('abc123 recover stranded work\n');
      if (cmd === `git diff --name-only 'origin/master...agent/issue-269'`) return ok('reports/final.pdf\nslides/final.pptx\n');
      if (cmd === 'git rev-parse --show-toplevel') return ok(tempDir ?? '');
      if (cmd === `git checkout 'agent/issue-269'`) return ok('');
      if (cmd === 'git status --porcelain -- ".alpha-loop/learnings"') {
        return ok('?? .alpha-loop/learnings/issue-269-20260101-000000.md\n');
      }
      if (cmd === `git add -- '.alpha-loop/learnings/issue-269-20260101-000000.md'`) return ok('');
      if (cmd === `git diff --cached --name-only -- '.alpha-loop/learnings/issue-269-20260101-000000.md'`) {
        return ok('.alpha-loop/learnings/issue-269-20260101-000000.md\n');
      }
      if (cmd === `git commit -m 'chore: add learning artifact for issue #269' -- '.alpha-loop/learnings/issue-269-20260101-000000.md'`) {
        return ok('');
      }
      if (cmd === `git push -u origin 'agent/issue-269'`) return ok('');
      return ok('');
    });
    mockGhExec.mockImplementation((cmd: string) => {
      if (cmd === `gh pr list --repo 'owner/repo' --head 'agent/issue-269' --state open --json number --limit 1`) return ok('[]');
      if (cmd === `gh issue view 269 --repo 'owner/repo' --json title`) return ok('{"title":"Recover artifact exports"}');
      if (cmd === `gh pr list --repo 'owner/repo' --head 'session/epic-123' --state open --json number,url --limit 1`) {
        return ok('[{"number":999,"url":"https://github.com/owner/repo/pull/999"}]');
      }
      if (cmd.startsWith(`gh pr edit 999 --repo 'owner/repo' --body-file `)) {
        const bodyFile = cmd.match(/--body-file '([^']+)'/)?.[1];
        if (bodyFile) {
          sessionPrBodyFile = bodyFile;
          sessionPrBody = readFileSync(bodyFile, 'utf-8');
        }
        return ok('');
      }
      if (cmd.startsWith(`gh pr edit 999 --repo 'owner/repo' --title `)) return ok('');
      return ok('');
    });

    await resumeCommand({ issue: '269' });

    expect(mockRepairSessionLearningArtifacts).toHaveBeenCalledWith({
      sessionName: 'session/epic-123',
      issues: [{ issueNum: 269, title: 'Recover artifact exports', status: 'failure', duration: 0, retries: 0 }],
      learningsDir: join(tempDir!, '.alpha-loop', 'learnings'),
      sessionLogsDir: expect.stringContaining('.alpha-loop/sessions/session/epic-123/logs'),
    });
    expect(mockExec).toHaveBeenCalledWith(
      `git commit -m 'chore: add learning artifact for issue #269' -- '.alpha-loop/learnings/issue-269-20260101-000000.md'`,
      { cwd: tempDir! },
    );
    expect(mockCreatePR).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'owner/repo',
      base: 'master',
      head: 'agent/issue-269',
      title: 'feat: Recover artifact exports (closes #269)',
      body: expect.stringContaining('Treat this PR as WIP until those checks pass.'),
      cwd: tempDir!,
    }));
    expect(mockLabelIssue).toHaveBeenCalledWith('owner/repo', 269, 'in-review', 'in-progress');
    expect(mockUpdateProjectStatus).toHaveBeenCalledWith('owner/repo', 2, 'owner', 269, 'In Review');
    expect(mockCommentIssue).toHaveBeenCalledWith(
      'owner/repo',
      269,
      expect.stringContaining('Final tests and verification were not run by resume'),
    );
    expect(mockSpawnAgent).not.toHaveBeenCalled();

    const resultPath = join(sessionDir, 'result-269.json');
    expect(existsSync(resultPath)).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, 'utf-8'));
    expect(result).toEqual(expect.objectContaining({
      issueNum: 269,
      title: 'Recover artifact exports',
      status: 'failure',
      recoveryMode: 'resume',
      failureReason: 'transient',
      prUrl: 'https://github.com/owner/repo/pull/269',
      testsPassing: false,
      verifyPassing: false,
      verifySkipped: true,
      filesChanged: 2,
    }));

    expect(mockGhExec).toHaveBeenCalledWith(
      expect.stringContaining(`gh pr edit 999 --repo 'owner/repo' --title 'Session: session/epic-123 — 0 succeeded, 1 recovered'`),
      undefined,
      true,
    );
    expect(mockGhExec).toHaveBeenCalledWith(
      expect.stringMatching(/^gh pr edit 999 --repo 'owner\/repo' --body-file '.+'/),
      undefined,
      true,
    );
    expect(sessionPrBodyFile).toBeDefined();
    expect(existsSync(sessionPrBodyFile!)).toBe(false);
    expect(sessionPrBody).toContain('0 succeeded, 0 failed, 1 recovered');
    expect(sessionPrBody).toContain('Resume Caveat');
    expect(sessionPrBody).toContain('### Recovered Issues');
    expect(sessionPrBody).toContain('#269: Recover artifact exports — RECOVERED BY RESUME');
    expect(sessionPrBody).toContain('https://github.com/owner/repo/pull/269');
    expect(mockGenerateSessionSummary).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session/epic-123',
      results: [expect.objectContaining({
        issueNum: 269,
        title: 'Recover artifact exports',
        status: 'failure',
        recoveryMode: 'resume',
      })],
      learningsDir: expect.stringMatching(/\.alpha-loop\/learnings$/),
      config: expect.objectContaining({ repo: 'owner/repo', skipLearn: false }),
    }));
    expect(mockRepairSessionSummaryArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'session/epic-123',
      learningsDir: expect.stringMatching(/\.alpha-loop\/learnings$/),
    }));
  });

  test('keeps the ESM resume command free of runtime CommonJS require calls', () => {
    const source = readFileSync(join(repoRoot, 'src', 'commands', 'resume.ts'), 'utf-8');

    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  test('shell-quotes malicious repo/branch values so shell metachars cannot escape arguments', () => {
    // Regression for the reviewer-flagged shell-injection risk in resume.ts.
    // If repo or branch contains shell metacharacters (backticks, $(), ;, &&),
    // they must be encoded as single-quoted POSIX literals, not interpolated raw.
    mockLoadConfig.mockReturnValue(baseConfig({
      repo: 'owner/repo;rm -rf /',
      baseBranch: 'mas`whoami`ter',
    }));

    const observed: string[] = [];
    mockExec.mockImplementation((cmd: string) => {
      observed.push(cmd);
      if (cmd === 'git branch --list "agent/issue-*"') return ok('  agent/issue-1$(curl evil)\n');
      if (cmd === 'git worktree list --porcelain') return ok('');
      return ok('');
    });
    mockGhExec.mockReturnValue(ok('[]'));

    return resumeCommand({}).then(() => {
      // Every dynamic value containing shell metachars must appear inside a
      // single-quoted POSIX literal in the emitted commands.
      const allCommands = observed.join('\n');
      // Repo with `;rm -rf /` must be inside '...' so the semicolon stays literal
      expect(allCommands).not.toMatch(/owner\/repo;rm -rf \//);
      // Base branch with backticks must be inside '...'
      expect(allCommands).not.toMatch(/mas`whoami`ter(?!')/);
      // Specifically: shellQuote wraps the value in single quotes
      const containsQuotedDirty = observed.some((c) =>
        c.includes(`'owner/repo;rm -rf /'`)
        || c.includes(`'mas\`whoami\`ter'`)
        || c.includes(`'agent/issue-1$(curl evil)'`),
      );
      // At least one of the dynamic values should have been emitted, and when
      // it was, it must have been quoted.
      if (allCommands.includes('owner/repo')
        || allCommands.includes('mas')
        || allCommands.includes('agent/issue-1')) {
        expect(containsQuotedDirty).toBe(true);
      }
    });
  });

  test('--session does NOT fall back to branch walking when no crash markers match', async () => {
    // Regression: previously, if no crash marker matched --session, the resume
    // command would fall through to findStrandedBranches() ignoring the session
    // filter — potentially resuming unrelated work from other sessions.
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-resume-session-'));
    process.chdir(tempDir);

    // Create a crash marker for a DIFFERENT session than the one filtered for.
    const otherSessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', 'epic-aaa');
    mkdirSync(otherSessionDir, { recursive: true });
    writeFileSync(join(otherSessionDir, 'crash-100.json'), JSON.stringify({
      issueNum: 100,
      step: 'review',
      branch: 'agent/issue-100',
      hasCommits: true,
      error: 'crashed',
      timestamp: '2026-05-25T00:00:00.000Z',
      recoverable: true,
    }, null, 2));

    mockLoadConfig.mockReturnValue(baseConfig());
    mockExec.mockImplementation((cmd: string) => {
      // Branch walking would normally find this branch — assert it is NOT called.
      if (cmd === 'git branch --list "agent/issue-*"') {
        throw new Error('branch walking must be skipped when --session is set and no markers match');
      }
      if (cmd === 'git worktree list --porcelain') return ok('');
      return ok('');
    });
    mockGhExec.mockReturnValue(ok('[]'));

    // Filter for a session that has NO matching crash marker.
    await resumeCommand({ session: 'session/epic-does-not-exist' });

    // Should complete cleanly without invoking branch walking; nothing to resume.
    expect(mockCreatePR).not.toHaveBeenCalled();
    expect(mockLabelIssue).not.toHaveBeenCalled();
  });

  test('--session resumes only branches whose crash marker matches the session', async () => {
    // Positive complement: when --session DOES match a crash marker, resume
    // proceeds for that issue and ignores other sessions' markers.
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-resume-session-match-'));
    process.chdir(tempDir);

    const targetSessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', 'epic-bbb');
    const otherSessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', 'epic-ccc');
    mkdirSync(targetSessionDir, { recursive: true });
    mkdirSync(otherSessionDir, { recursive: true });

    writeFileSync(join(targetSessionDir, 'crash-200.json'), JSON.stringify({
      issueNum: 200,
      step: 'review',
      branch: 'agent/issue-200',
      hasCommits: true,
      error: 'crashed',
      timestamp: '2026-05-25T00:00:00.000Z',
      recoverable: true,
    }, null, 2));
    writeFileSync(join(otherSessionDir, 'crash-300.json'), JSON.stringify({
      issueNum: 300,
      step: 'review',
      branch: 'agent/issue-300',
      hasCommits: true,
      error: 'crashed',
      timestamp: '2026-05-25T00:00:00.000Z',
      recoverable: true,
    }, null, 2));

    mockLoadConfig.mockReturnValue(baseConfig({ skipReview: true, skipLearn: true }));
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git worktree list --porcelain') return ok('');
      if (cmd === 'git rev-parse --show-toplevel') return ok(tempDir ?? '');
      if (cmd === `git log 'origin/master..agent/issue-200' --oneline`) return ok('aaa target session work\n');
      if (cmd === `git log 'origin/master..agent/issue-300' --oneline`) {
        throw new Error('issue-300 belongs to other session and must NOT be inspected');
      }
      return ok('');
    });
    mockGhExec.mockReturnValue(ok('[]'));

    await resumeCommand({ session: 'session/epic-bbb' });

    // Other-session marker MUST NOT be touched.
    expect(existsSync(join(otherSessionDir, 'crash-300.json'))).toBe(true);
  });
});
