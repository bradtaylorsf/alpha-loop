jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn(() => ({
    repo: 'owner/repo',
    labelReady: 'ready',
  })),
}));

jest.mock('../../src/lib/logger', () => ({
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

jest.mock('../../src/lib/feedback', () => {
  const actual = jest.requireActual('../../src/lib/feedback');
  return {
    ...actual,
    ingestFeedback: jest.fn(),
  };
});

jest.mock('../../src/lib/events', () => ({
  emitLifecycleEvent: jest.fn().mockResolvedValue({ event: {}, deliveries: [] }),
}));

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedbackIngestCommand } from '../../src/commands/feedback.js';
import { ingestFeedback } from '../../src/lib/feedback.js';
import { log } from '../../src/lib/logger.js';
import { emitLifecycleEvent } from '../../src/lib/events.js';

const mockIngestFeedback = ingestFeedback as jest.MockedFunction<typeof ingestFeedback>;
const mockEmitLifecycleEvent = emitLifecycleEvent as jest.MockedFunction<typeof emitLifecycleEvent>;

describe('feedback ingest command', () => {
  let tempDir: string;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-feedback-command-'));
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    process.exitCode = undefined;
    mockIngestFeedback.mockReturnValue({
      status: 'processed',
      idempotencyKey: 'owner/repo:slack:event:evt-1',
      idempotencyHash: 'hash',
      recordPath: join(tempDir, '.alpha-loop', 'feedback', 'ingested-events', 'hash.json'),
      classification: 'approval',
      githubComment: {
        repo: 'owner/repo',
        targetNumber: 287,
        issueNumber: 287,
        prNumber: null,
        marker: {
          version: 1,
          type: 'alpha-loop-feedback',
          repo: 'owner/repo',
          issueNumber: 287,
          prNumber: null,
          commentTarget: 287,
          sessionId: 'session-1',
          sessionName: 'session/20260530-120000',
          source: 'slack',
          externalEventId: 'evt-1',
          externalThreadId: null,
          externalMessageId: null,
          idempotencyKey: 'owner/repo:slack:event:evt-1',
          idempotencyHash: 'hash',
          classification: 'approval',
          eventTimestamp: '2026-05-30T12:00:00.000Z',
          receivedAt: '2026-05-30T12:00:00.000Z',
          resumeRequested: false,
        },
      },
      session: {
        found: true,
        sessionId: 'session-1',
        name: 'session/20260530-120000',
        manifestPath: join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-120000', 'session.json'),
        lookup: 'issue',
      },
      lifecycleEventIds: ['feedback-1', 'classified-1'],
      resumeCommand: null,
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('reads structured feedback from --body-file and emits JSON when requested', async () => {
    const bodyFile = join(tempDir, 'feedback.json');
    writeFileSync(bodyFile, JSON.stringify({
      issue: 287,
      source: 'slack',
      external_event_id: 'evt-1',
      body: 'LGTM, approved.',
    }));

    await feedbackIngestCommand({ bodyFile, json: true });

    expect(mockIngestFeedback).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        repo: 'owner/repo',
        issueNumber: 287,
        source: 'slack',
        externalEventId: 'evt-1',
        body: 'LGTM, approved.',
      }),
      readyLabel: 'ready',
    }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"status": "processed"'));
    expect(mockEmitLifecycleEvent).toHaveBeenCalledTimes(2);
    expect(mockEmitLifecycleEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'feedback.received',
      manifestPath: expect.stringContaining('session.json'),
      context: expect.objectContaining({
        issueNumber: 287,
        feedback: expect.objectContaining({
          idempotencyHash: 'hash',
          source: 'slack',
          classification: 'approval',
        }),
      }),
    }));
    expect(mockEmitLifecycleEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'feedback.classified',
      manifestPath: expect.stringContaining('session.json'),
      context: expect.objectContaining({
        issueNumber: 287,
        feedback: expect.objectContaining({
          idempotencyHash: 'hash',
          source: 'slack',
          classification: 'approval',
        }),
        metadata: expect.objectContaining({
          sessionFeedbackEventIds: ['feedback-1', 'classified-1'],
        }),
      }),
    }));
  });

  it('emits a resume-requested lifecycle event when feedback queues resume', async () => {
    mockIngestFeedback.mockReturnValueOnce({
      status: 'processed',
      idempotencyKey: 'owner/repo:slack:event:evt-resume',
      idempotencyHash: 'hash-resume',
      recordPath: join(tempDir, 'hash-resume.json'),
      classification: 'change_request',
      githubComment: {
        repo: 'owner/repo',
        targetNumber: 287,
        issueNumber: 287,
        prNumber: null,
        marker: {
          version: 1,
          type: 'alpha-loop-feedback',
          repo: 'owner/repo',
          issueNumber: 287,
          prNumber: null,
          commentTarget: 287,
          sessionId: 'session-1',
          sessionName: 'session/20260530-120000',
          source: 'slack',
          externalEventId: 'evt-resume',
          externalThreadId: null,
          externalMessageId: null,
          idempotencyKey: 'owner/repo:slack:event:evt-resume',
          idempotencyHash: 'hash-resume',
          classification: 'change_request',
          eventTimestamp: '2026-05-30T12:00:00.000Z',
          receivedAt: '2026-05-30T12:00:00.000Z',
          resumeRequested: true,
        },
      },
      session: {
        found: true,
        sessionId: 'session-1',
        name: 'session/20260530-120000',
        manifestPath: join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-120000', 'session.json'),
        lookup: 'issue',
      },
      lifecycleEventIds: ['feedback-1', 'classified-1', 'resume-1'],
      resumeCommand: 'alpha-loop resume --issue 287',
    });

    await feedbackIngestCommand({ issue: '287', requestResume: true }, 'Please update the footer copy.');

    expect(mockEmitLifecycleEvent.mock.calls.map(([input]) => input.type)).toEqual([
      'feedback.received',
      'feedback.classified',
      'session.resume_requested',
    ]);
    expect(mockEmitLifecycleEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'session.resume_requested',
      context: expect.objectContaining({
        feedback: expect.objectContaining({
          classification: 'change_request',
          resumeCommand: 'alpha-loop resume --issue 287',
        }),
      }),
    }));
  });

  it('reads plain stdin body text and applies adapter field options', async () => {
    mockIngestFeedback.mockReturnValueOnce({
      status: 'already_processed',
      idempotencyKey: 'owner/repo:discord:event:evt-2',
      idempotencyHash: 'hash-2',
      recordPath: join(tempDir, 'hash-2.json'),
      record: null,
    });

    await feedbackIngestCommand({
      issue: '287',
      source: 'discord',
      externalEventId: 'evt-2',
      requestResume: true,
    }, 'Please update the footer copy.');

    expect(mockIngestFeedback).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        issueNumber: 287,
        source: 'discord',
        externalEventId: 'evt-2',
        body: 'Please update the footer copy.',
        resumeRequested: true,
      }),
      requestResume: true,
    }));
    expect(log.info).toHaveBeenCalledWith('Feedback already processed: hash-2');
    expect(mockEmitLifecycleEvent).not.toHaveBeenCalled();
  });
});
