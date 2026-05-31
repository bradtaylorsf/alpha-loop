jest.mock('../../src/lib/github', () => ({
  commentIssue: jest.fn(() => true),
  labelIssue: jest.fn(),
}));

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatFeedbackComment,
  formatFeedbackMarker,
  ingestFeedback,
  normalizeFeedbackIngestPayload,
  parseFeedbackCommentMarkers,
  type FeedbackCommentMarker,
} from '../../src/lib/feedback.js';
import { commentIssue, labelIssue } from '../../src/lib/github.js';
import type { DurableSessionManifest } from '../../src/lib/session.js';

const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;
const mockLabelIssue = labelIssue as jest.MockedFunction<typeof labelIssue>;

function makeManifest(overrides: Partial<DurableSessionManifest> = {}): DurableSessionManifest {
  const now = '2026-05-30T12:00:00.000Z';
  return {
    version: 1,
    sessionId: 'session-20260530-120000',
    name: 'session/20260530-120000',
    issueNumber: 287,
    issueNumbers: [287],
    parentEpicNumber: 293,
    parentEpicTitle: 'Hosted Alpha Loop',
    branch: 'session/20260530-120000',
    baseBranch: 'master',
    prUrl: 'https://github.com/owner/repo/pull/287',
    sessionPrUrl: null,
    status: 'human_input_requested',
    stage: 'human_input_requested',
    labels: ['needs-human-input'],
    feedback: {
      currentStatus: 'human_input_requested',
      question: 'Which copy should be used?',
      resumeInstructions: 'Resume after the copy is selected.',
      qaChecklist: [],
      prUrl: 'https://github.com/owner/repo/pull/287',
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
      path: join(tmpdir(), 'alpha-loop-feedback-worktree-287'),
      branch: 'agent/issue-287',
      resumed: false,
      missing: false,
      lastKnownBranch: 'agent/issue-287',
      updatedAt: now,
    },
    lastKnownBranch: 'agent/issue-287',
    currentIssue: { issueNum: 287, title: 'Add feedback ingestion' },
    issues: [{
      issueNum: 287,
      title: 'Add feedback ingestion',
      status: 'human_input_requested',
      stage: 'human_input_requested',
      branch: 'agent/issue-287',
      worktreePath: join(tmpdir(), 'alpha-loop-feedback-worktree-287'),
      worktreeMissing: false,
      prUrl: 'https://github.com/owner/repo/pull/287',
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

describe('feedback ingestion', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-feedback-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes valid feedback to GitHub, persists classification, and requests resume idempotently', () => {
    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-120000');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(makeManifest(), null, 2));

    const result = ingestFeedback({
      projectDir: tempDir,
      receivedAt: '2026-05-30T12:10:00.000Z',
      readyLabel: 'ready',
      requestResume: true,
      payload: {
        repo: 'owner/repo',
        issueNumber: 287,
        sessionId: 'session-20260530-120000',
        source: 'slack',
        externalEventId: 'evt-287',
        externalThreadId: 'thread-1',
        externalMessageId: 'msg-1',
        author: 'brad',
        body: 'Please change the button copy.',
      },
    });

    expect(result.status).toBe('processed');
    if (result.status !== 'processed') throw new Error('expected processed feedback');
    expect(result.classification).toBe('change_request');
    expect(result.resumeCommand).toBe('alpha-loop resume --issue 287');
    expect(result.lifecycleEventIds).toHaveLength(3);
    expect(mockCommentIssue).toHaveBeenCalledWith(
      'owner/repo',
      287,
      expect.stringContaining('## Alpha Loop Feedback Received'),
    );

    const commentBody = mockCommentIssue.mock.calls[0][2];
    const markers = parseFeedbackCommentMarkers(commentBody);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toEqual(expect.objectContaining({
      type: 'alpha-loop-feedback',
      source: 'slack',
      issueNumber: 287,
      sessionId: 'session-20260530-120000',
      classification: 'change_request',
    }));

    const manifest = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf-8')) as DurableSessionManifest;
    expect(manifest.status).toBe('resume_requested');
    expect(manifest.feedback.classification).toBe('change_request');
    expect(manifest.feedback.latestFeedback?.source).toBe('slack');
    expect(manifest.feedback.latestFeedback?.resumeCommand).toBe('alpha-loop resume --issue 287');
    expect(manifest.feedback.events.map((event) => event.type)).toEqual([
      'feedback.received',
      'feedback.classified',
      'session.resume_requested',
    ]);

    expect(mockLabelIssue).toHaveBeenCalledWith('owner/repo', 287, 'ready', 'needs-human-input');
    expect(existsSync(result.recordPath)).toBe(true);
  });

  it('returns already_processed without duplicate comments for repeated external event ids', () => {
    const payload = {
      repo: 'owner/repo',
      issueNumber: 287,
      source: 'teams',
      externalEventId: 'evt-duplicate',
      body: 'LGTM, approved.',
    };

    const first = ingestFeedback({ projectDir: tempDir, payload });
    const second = ingestFeedback({ projectDir: tempDir, payload });

    expect(first.status).toBe('processed');
    expect(second.status).toBe('already_processed');
    expect(mockCommentIssue).toHaveBeenCalledTimes(1);
  });

  it('continues when an explicit session id cannot be found but an issue target is provided', () => {
    const result = ingestFeedback({
      projectDir: tempDir,
      receivedAt: '2026-05-30T12:15:00.000Z',
      payload: {
        repo: 'owner/repo',
        issueNumber: 287,
        sessionId: 'missing-session',
        source: 'web-form',
        externalEventId: 'web-1',
        author: 'Avery',
        body: 'Use the concise version.',
      },
    });

    expect(result.status).toBe('processed');
    if (result.status !== 'processed') throw new Error('expected processed feedback');
    expect(result.session).toEqual(expect.objectContaining({
      found: false,
      sessionId: 'missing-session',
      manifestPath: null,
      lookup: 'session_id',
    }));
    expect(result.lifecycleEventIds).toEqual([]);
    expect(mockCommentIssue).toHaveBeenCalledWith('owner/repo', 287, expect.any(String));
  });

  it('comments on an explicitly supplied PR when feedback is PR-only', () => {
    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-120000');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(makeManifest({
      prUrl: 'https://github.com/owner/repo/pull/500',
      feedback: {
        ...makeManifest().feedback,
        prUrl: 'https://github.com/owner/repo/pull/500',
      },
      issues: [{
        ...makeManifest().issues[0],
        prUrl: 'https://github.com/owner/repo/pull/500',
      }],
    }), null, 2));

    const result = ingestFeedback({
      projectDir: tempDir,
      payload: {
        repo: 'owner/repo',
        prNumber: 500,
        source: 'slack',
        externalEventId: 'pr-only-500',
        body: 'LGTM, approved.',
      },
    });

    expect(result.status).toBe('processed');
    if (result.status !== 'processed') throw new Error('expected processed feedback');
    expect(result.githubComment.targetNumber).toBe(500);
    expect(result.githubComment.issueNumber).toBe(287);
    expect(result.githubComment.prNumber).toBe(500);
    expect(mockCommentIssue).toHaveBeenCalledWith('owner/repo', 500, expect.any(String));
  });

  it('formats and parses GitHub comments with attachments and machine-readable markers', () => {
    const payload = normalizeFeedbackIngestPayload({
      repo: 'owner/repo',
      issue: 287,
      source: 'discord',
      author: 'designer',
      body: 'Approved',
      attachments: [{ url: 'https://example.test/screenshot.png', filename: 'screenshot.png' }],
    });
    const marker: FeedbackCommentMarker = {
      version: 1,
      type: 'alpha-loop-feedback',
      repo: 'owner/repo',
      issueNumber: 287,
      prNumber: null,
      commentTarget: 287,
      sessionId: null,
      sessionName: null,
      source: 'discord',
      externalEventId: null,
      externalThreadId: null,
      externalMessageId: null,
      idempotencyKey: 'key',
      idempotencyHash: 'hash',
      classification: 'approval',
      eventTimestamp: '2026-05-30T12:00:00.000Z',
      receivedAt: '2026-05-30T12:00:00.000Z',
      resumeRequested: false,
    };

    const comment = formatFeedbackComment({
      payload,
      classification: 'approval',
      marker,
      markerText: formatFeedbackMarker(marker),
    });

    expect(comment).toContain('[screenshot.png](https://example.test/screenshot.png)');
    expect(parseFeedbackCommentMarkers(comment)).toEqual([marker]);
  });

  it('preserves explicit classification overrides and supports unknown outcomes', () => {
    const explicit = normalizeFeedbackIngestPayload({
      source: 'slack',
      body: 'Thanks for the update.',
      classification: 'approval',
    });
    const unknown = ingestFeedback({
      projectDir: tempDir,
      payload: {
        repo: 'owner/repo',
        issueNumber: 287,
        source: 'slack',
        externalEventId: 'unknown-1',
        body: 'Thanks for the update.',
      },
    });

    expect(explicit.classification).toBe('approval');
    expect(unknown.status).toBe('processed');
    if (unknown.status !== 'processed') throw new Error('expected processed feedback');
    expect(unknown.classification).toBe('unknown');
  });
});
