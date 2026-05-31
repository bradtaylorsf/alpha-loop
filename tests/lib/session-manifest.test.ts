import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatestResumableSessionForIssue,
  hashPromptText,
  recordSessionPrompt,
  sessionManifestPath,
  transitionSessionStatus,
  type DurableSessionManifest,
} from '../../src/lib/session.js';

function makeManifest(overrides: Partial<DurableSessionManifest> = {}): DurableSessionManifest {
  const now = '2026-05-30T12:00:00.000Z';
  return {
    version: 1,
    sessionId: 'session-20260530-120000',
    name: 'session/20260530-120000',
    issueNumber: 284,
    issueNumbers: [284],
    parentEpicNumber: 293,
    branch: 'session/20260530-120000',
    baseBranch: 'master',
    prUrl: null,
    sessionPrUrl: null,
    status: 'paused',
    stage: 'implement',
    labels: ['in-progress'],
    harness: {
      agent: 'claude',
      model: 'sonnet',
      reviewModel: 'opus',
      command: 'claude',
      testCommand: 'pnpm test',
    },
    command: 'claude',
    worktree: {
      path: join(tmpdir(), 'missing-worktree'),
      branch: 'agent/issue-284',
      resumed: false,
      missing: true,
      lastKnownBranch: 'agent/issue-284',
      updatedAt: now,
    },
    lastKnownBranch: 'agent/issue-284',
    currentIssue: { issueNum: 284, title: 'Persist resumable session state' },
    issues: [{
      issueNum: 284,
      title: 'Persist resumable session state',
      status: 'paused',
      stage: 'implement',
      branch: 'agent/issue-284',
      worktreePath: join(tmpdir(), 'missing-worktree'),
      worktreeMissing: true,
      updatedAt: now,
    }],
    prompts: [],
    promptPath: null,
    promptHash: null,
    transcripts: [],
    transcriptPath: null,
    logs: {
      sessionDir: '.alpha-loop/sessions/session/20260530-120000',
      logsDir: '.alpha-loop/sessions/session/20260530-120000/logs',
      traceDir: '.alpha-loop/traces/session-20260530-120000',
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
    errors: [],
    ...overrides,
  };
}

describe('durable session manifests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-session-manifest-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('records status transitions and prompt hashes without storing prompt text', () => {
    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-120000');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(sessionManifestPath(sessionDir), JSON.stringify(makeManifest({ status: 'active', stage: 'plan' }), null, 2));

    transitionSessionStatus(sessionDir, 'waiting-for-feedback', 'waiting-for-feedback');
    recordSessionPrompt(
      { resultsDir: sessionDir },
      {
        issueNum: 284,
        stage: 'implement',
        path: '.alpha-loop/traces/session-20260530-120000/prompts/issue-284-implement.md',
        prompt: 'Implement durable manifests',
      },
    );

    const manifest = JSON.parse(readFileSync(sessionManifestPath(sessionDir), 'utf-8')) as DurableSessionManifest;
    expect(manifest.status).toBe('waiting-for-feedback');
    expect(manifest.stage).toBe('waiting-for-feedback');
    expect(manifest.promptPath).toContain('issue-284-implement.md');
    expect(manifest.promptHash).toBe(hashPromptText('Implement durable manifests'));
    expect(JSON.stringify(manifest)).not.toContain('Implement durable manifests');
  });

  it('finds the latest resumable session and reports missing-worktree recovery branch', () => {
    const sessionsRoot = join(tempDir, '.alpha-loop', 'sessions');
    const oldDir = join(sessionsRoot, 'session', '20260529-120000');
    const latestDir = join(sessionsRoot, 'session', '20260530-120000');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(latestDir, { recursive: true });
    writeFileSync(sessionManifestPath(oldDir), JSON.stringify(makeManifest({
      sessionId: 'old',
      name: 'session/20260529-120000',
      status: 'completed',
      timestamps: {
        createdAt: '2026-05-29T12:00:00.000Z',
        startedAt: '2026-05-29T12:00:00.000Z',
        updatedAt: '2026-05-29T12:00:00.000Z',
      },
    }), null, 2));
    writeFileSync(sessionManifestPath(latestDir), JSON.stringify(makeManifest(), null, 2));

    const found = findLatestResumableSessionForIssue(284, sessionsRoot);

    expect(found?.manifest.name).toBe('session/20260530-120000');
    expect(found?.worktreeExists).toBe(false);
    expect(found?.recoveryBranch).toBe('agent/issue-284');
  });
});
