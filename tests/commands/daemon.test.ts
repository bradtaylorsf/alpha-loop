jest.mock('../../src/commands/triage', () => ({
  triageCommand: jest.fn(),
}));

jest.mock('../../src/lib/shell', () => ({
  ...jest.requireActual('../../src/lib/shell'),
  exec: jest.fn(),
}));

jest.mock('../../src/lib/feedback', () => ({
  ...jest.requireActual('../../src/lib/feedback'),
  ingestFeedback: jest.fn(),
}));

jest.mock('../../src/lib/events', () => ({
  ...jest.requireActual('../../src/lib/events'),
  emitLifecycleEvent: jest.fn().mockResolvedValue({ event: {}, deliveries: [] }),
}));

import { parseFeedbackPollOutput, pollFeedback } from '../../src/commands/daemon.js';
import type { Config, DaemonConfig } from '../../src/lib/config.js';
import { exec } from '../../src/lib/shell.js';
import { ingestFeedback } from '../../src/lib/feedback.js';

const mockExec = exec as jest.Mock;
const mockIngest = ingestFeedback as jest.Mock;

function processedResult(issueNumber: number) {
  return {
    status: 'processed',
    resumeCommand: null,
    idempotencyHash: `hash-${issueNumber}`,
    classification: 'approval',
    lifecycleEventIds: [],
    session: { manifestPath: '/tmp/manifest.json', found: true, lookup: 'issue' },
    githubComment: {
      issueNumber,
      prNumber: null,
      targetNumber: issueNumber,
      marker: { source: 'slack', externalEventId: null, externalThreadId: null, externalMessageId: null },
    },
  };
}

function makeConfig(): Config {
  return {
    repo: 'owner/repo',
    labelReady: 'ready',
    dryRun: false,
    automationPolicy: { allowedCommands: [] },
  } as unknown as Config;
}

function makeDaemon(): DaemonConfig {
  return { feedbackPollCommand: './poll.sh' } as unknown as DaemonConfig;
}

describe('daemon command feedback polling', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockIngest.mockReset();
  });

  it('parses NDJSON feedback poll output', () => {
    const payloads = parseFeedbackPollOutput([
      '{"repo":"owner/repo","issue":1,"source":"slack","body":"Approved"}',
      '{"repo":"owner/repo","issue":2,"source":"teams","body":"Please change the copy"}',
    ].join('\n'));

    expect(payloads).toEqual([
      expect.objectContaining({ issue: 1, body: 'Approved' }),
      expect.objectContaining({ issue: 2, body: 'Please change the copy' }),
    ]);
  });

  it('isolates a malformed payload so valid payloads still process', async () => {
    mockExec.mockReturnValue({
      exitCode: 0,
      stdout: JSON.stringify([
        { issue: 1, source: 'slack', body: 'Approved' },
        { issue: 2, source: 'slack', body: '' },
        { issue: 3, source: 'slack', body: 'Change copy' },
      ]),
      stderr: '',
    });
    mockIngest
      .mockReturnValueOnce(processedResult(1))
      .mockImplementationOnce(() => { throw new Error('empty body'); })
      .mockReturnValueOnce(processedResult(3));

    const result = await pollFeedback(makeConfig(), makeDaemon());

    expect(result.status).toBe('processed');
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(mockIngest).toHaveBeenCalledTimes(3);
  });

  it('counts already-processed payloads without treating them as failures', async () => {
    mockExec.mockReturnValue({
      exitCode: 0,
      stdout: JSON.stringify([{ issue: 1, source: 'slack', body: 'Approved' }]),
      stderr: '',
    });
    mockIngest.mockReturnValue({ status: 'already_processed', record: { idempotencyHash: 'x' } });

    const result = await pollFeedback(makeConfig(), makeDaemon());

    expect(result.processed).toBe(0);
    expect(result.alreadyProcessed).toBe(1);
    expect(result.failed).toBe(0);
  });
});
