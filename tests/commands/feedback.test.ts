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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedbackIngestCommand } from '../../src/commands/feedback.js';
import { ingestFeedback } from '../../src/lib/feedback.js';
import { log } from '../../src/lib/logger.js';

const mockIngestFeedback = ingestFeedback as jest.MockedFunction<typeof ingestFeedback>;

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
      lifecycleEventIds: ['feedback-1'],
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
  });
});
