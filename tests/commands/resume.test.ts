jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
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

jest.mock('../../src/lib/github', () => ({
  labelIssue: jest.fn(),
  commentIssue: jest.fn(),
  createPR: jest.fn(),
  updateProjectStatus: jest.fn(),
}));

jest.mock('../../src/lib/learning', () => ({
  generateSessionSummary: jest.fn().mockResolvedValue(null),
  repairSessionLearningArtifacts: jest.fn(),
  repairSessionSummaryArtifact: jest.fn(),
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStrandedBranches, resumeCommand } from '../../src/commands/resume';
import { loadConfig, resolveStepConfig, type Config } from '../../src/lib/config';
import { createPR, labelIssue, commentIssue, updateProjectStatus } from '../../src/lib/github';
import { ghExec } from '../../src/lib/rate-limit';
import { spawnAgent } from '../../src/lib/agent';
import { exec } from '../../src/lib/shell';
import {
  generateSessionSummary,
  repairSessionLearningArtifacts,
  repairSessionSummaryArtifact,
} from '../../src/lib/learning';

const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockResolveStepConfig = resolveStepConfig as jest.MockedFunction<typeof resolveStepConfig>;
const mockGhExec = ghExec as jest.MockedFunction<typeof ghExec>;
const mockCreatePR = createPR as jest.MockedFunction<typeof createPR>;
const mockLabelIssue = labelIssue as jest.MockedFunction<typeof labelIssue>;
const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;
const mockUpdateProjectStatus = updateProjectStatus as jest.MockedFunction<typeof updateProjectStatus>;
const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockGenerateSessionSummary = generateSessionSummary as jest.MockedFunction<typeof generateSessionSummary>;
const mockRepairSessionLearningArtifacts = repairSessionLearningArtifacts as jest.MockedFunction<typeof repairSessionLearningArtifacts>;
const mockRepairSessionSummaryArtifact = repairSessionSummaryArtifact as jest.MockedFunction<typeof repairSessionSummaryArtifact>;

const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
const repoRoot = process.cwd();
let tempDir: string | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  process.chdir(repoRoot);
  tempDir = undefined;
  mockResolveStepConfig.mockReturnValue({ agent: 'codex', model: 'gpt-5' });
  mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/269');
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

describe('findStrandedBranches', () => {
  test('normalizes + prefixed branches checked out in another worktree', () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'git branch --list "agent/issue-*"') {
        return ok('  agent/issue-462\n+ agent/issue-466\n');
      }
      if (cmd === 'git worktree list --porcelain') return ok('');
      if (cmd === 'git log "origin/master..agent/issue-462" --oneline') return ok('');
      if (cmd === 'git log "origin/master..agent/issue-466" --oneline') {
        return ok('a3f214b fix(#466): address verification findings\n');
      }
      if (cmd === 'git diff --name-only "origin/master...agent/issue-466"') {
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
      if (cmd === 'git log "origin/master..agent/issue-187" --oneline') {
        return ok('def456 fix(#187): recover after result\n');
      }
      if (cmd === 'git diff --name-only "origin/master...agent/issue-187"') {
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
      if (cmd === 'git log "origin/master..agent/issue-269" --oneline') return ok('abc123 recover stranded work\n');
      if (cmd === 'git diff --name-only "origin/master...agent/issue-269"') return ok('src/lib/pipeline.ts\n');
      if (cmd === 'git worktree list --porcelain') return ok('');
      if (cmd === 'git rev-parse --show-toplevel') return ok(tempDir ?? '');
      if (cmd === 'git checkout "agent/issue-269"') return ok('');
      if (cmd === 'git status --porcelain -- ".alpha-loop/learnings"') return ok('');
      if (cmd === 'git push -u origin "agent/issue-269"') return ok('');
      return ok('');
    });
    mockGhExec.mockImplementation((cmd: string) => {
      if (cmd === 'gh pr list --repo "owner/repo" --head "agent/issue-269" --state open --json number --limit 1') return ok('[]');
      if (cmd === 'gh issue view 269 --repo "owner/repo" --json title') return ok('{"title":"Recover artifact exports"}');
      if (cmd === 'gh pr list --repo "owner/repo" --head "session/epic-226" --state open --json number,url --limit 1') {
        return ok('[{"number":999,"url":"https://github.com/owner/repo/pull/999"}]');
      }
      if (cmd.startsWith('gh pr edit 999 --repo "owner/repo" --body-file ')) {
        const bodyFile = cmd.match(/--body-file "([^"]+)"/)?.[1];
        if (bodyFile) sessionPrBody = readFileSync(bodyFile, 'utf-8');
        return ok('');
      }
      if (cmd.startsWith('gh pr edit 999 --repo "owner/repo" --title ')) return ok('');
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
      if (cmd === 'git log "origin/master..agent/issue-269" --oneline') return ok('abc123 recover stranded work\n');
      if (cmd === 'git diff --name-only "origin/master...agent/issue-269"') return ok('reports/final.pdf\nslides/final.pptx\n');
      if (cmd === 'git rev-parse --show-toplevel') return ok(tempDir ?? '');
      if (cmd === 'git checkout "agent/issue-269"') return ok('');
      if (cmd === 'git status --porcelain -- ".alpha-loop/learnings"') {
        return ok('?? .alpha-loop/learnings/issue-269-20260101-000000.md\n');
      }
      if (cmd === 'git add -- ".alpha-loop/learnings/issue-269-20260101-000000.md"') return ok('');
      if (cmd === 'git diff --cached --name-only -- ".alpha-loop/learnings/issue-269-20260101-000000.md"') {
        return ok('.alpha-loop/learnings/issue-269-20260101-000000.md\n');
      }
      if (cmd === 'git commit -m "chore: add learning artifact for issue #269" -- ".alpha-loop/learnings/issue-269-20260101-000000.md"') {
        return ok('');
      }
      if (cmd === 'git push -u origin "agent/issue-269"') return ok('');
      return ok('');
    });
    mockGhExec.mockImplementation((cmd: string) => {
      if (cmd === 'gh pr list --repo "owner/repo" --head "agent/issue-269" --state open --json number --limit 1') return ok('[]');
      if (cmd === 'gh issue view 269 --repo "owner/repo" --json title') return ok('{"title":"Recover artifact exports"}');
      if (cmd === 'gh pr list --repo "owner/repo" --head "session/epic-123" --state open --json number,url --limit 1') {
        return ok('[{"number":999,"url":"https://github.com/owner/repo/pull/999"}]');
      }
      if (cmd.startsWith('gh pr edit 999 --repo "owner/repo" --body-file ')) {
        const bodyFile = cmd.match(/--body-file "([^"]+)"/)?.[1];
        if (bodyFile) {
          sessionPrBodyFile = bodyFile;
          sessionPrBody = readFileSync(bodyFile, 'utf-8');
        }
        return ok('');
      }
      if (cmd.startsWith('gh pr edit 999 --repo "owner/repo" --title ')) return ok('');
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
      'git commit -m "chore: add learning artifact for issue #269" -- ".alpha-loop/learnings/issue-269-20260101-000000.md"',
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
      expect.stringContaining('gh pr edit 999 --repo "owner/repo" --title "Session: session/epic-123 — 0 succeeded, 1 recovered"'),
      undefined,
      true,
    );
    expect(mockGhExec).toHaveBeenCalledWith(
      expect.stringMatching(/^gh pr edit 999 --repo "owner\/repo" --body-file ".+"/),
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
});
