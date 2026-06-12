import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLifecycleEvent,
  emitLifecycleEvent,
  eventMatchesDestination,
  formatEventPayload,
  redactLifecycleEvent,
} from '../../src/lib/events.js';
import { sessionManifestPath, type DurableSessionManifest } from '../../src/lib/session.js';
import type { Config, EventDestinationConfig } from '../../src/lib/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 1,
    agent: 'codex',
    model: 'gpt-5',
    reviewModel: 'gpt-5',
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
    events: { includePromptText: false, redact: [], destinations: {} },
    ...overrides,
  };
}

function makeManifest(overrides: Partial<DurableSessionManifest> = {}): DurableSessionManifest {
  const now = '2026-05-30T12:00:00.000Z';
  return {
    version: 1,
    sessionId: 'session-20260530-120000',
    name: 'session/20260530-120000',
    issueNumber: 269,
    issueNumbers: [269],
    parentEpicNumber: 293,
    parentEpicTitle: 'Hosted Alpha Loop',
    branch: 'session/20260530-120000',
    baseBranch: 'master',
    prUrl: 'https://github.com/owner/repo/pull/269',
    sessionPrUrl: 'https://github.com/owner/repo/pull/500',
    status: 'qa_requested',
    stage: 'qa_requested',
    labels: ['needs-human-input'],
    feedback: {
      currentStatus: 'qa_requested',
      question: null,
      resumeInstructions: 'Reply with QA notes.',
      qaChecklist: ['Open the preview', 'Confirm the copy'],
      prUrl: 'https://github.com/owner/repo/pull/269',
      previewUrl: 'https://preview.example.test',
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
      command: 'codex exec --model gpt-5',
      testCommand: 'pnpm test',
    },
    command: 'codex',
    worktree: {
      path: '/tmp/worktree',
      branch: 'agent/issue-269',
      resumed: false,
      missing: false,
      lastKnownBranch: 'agent/issue-269',
      updatedAt: now,
    },
    lastKnownBranch: 'agent/issue-269',
    currentIssue: { issueNum: 269, title: 'Emit lifecycle events' },
    issues: [{
      issueNum: 269,
      title: 'Emit lifecycle events',
      status: 'qa_requested',
      stage: 'qa_requested',
      branch: 'agent/issue-269',
      worktreePath: '/tmp/worktree',
      worktreeMissing: false,
      prUrl: 'https://github.com/owner/repo/pull/269',
      updatedAt: now,
    }],
    prompts: [{
      issueNum: 269,
      stage: 'implement',
      path: '.alpha-loop/traces/session-20260530-120000/prompts/issue-269-implement.md',
      hash: 'prompt-hash',
      recordedAt: now,
    }],
    promptPath: '.alpha-loop/traces/session-20260530-120000/prompts/issue-269-implement.md',
    promptHash: 'prompt-hash',
    transcripts: [{
      issueNum: 269,
      stage: 'implement',
      path: '.alpha-loop/traces/session-20260530-120000/outputs/issue-269-implement.log',
      recordedAt: now,
    }],
    transcriptPath: '.alpha-loop/traces/session-20260530-120000/outputs/issue-269-implement.log',
    logs: {
      sessionDir: '.alpha-loop/sessions/session/20260530-120000',
      logsDir: '.alpha-loop/sessions/session/20260530-120000/logs',
      traceDir: '.alpha-loop/traces/session-20260530-120000',
      files: ['.alpha-loop/sessions/session/20260530-120000/logs/issue-269.log'],
    },
    screenshots: ['.alpha-loop/sessions/session/20260530-120000/screenshots/preview.png'],
    previewUrl: 'https://preview.example.test',
    webApp: {
      previewUrl: 'https://preview.example.test',
      devUrl: 'http://localhost:4321',
      screenshots: ['.alpha-loop/sessions/session/20260530-120000/screenshots/preview.png'],
      browserResultPath: '.alpha-loop/sessions/session/20260530-120000/web-app-verification/issue-269.json',
      artifactPath: '.alpha-loop/sessions/session/20260530-120000/web-app-verification/issue-269.json',
      consoleErrors: [],
      networkErrors: [],
      qaChecklist: ['Open the preview', 'Confirm the copy'],
      updatedAt: now,
    },
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

describe('lifecycle events', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalFetch: typeof globalThis.fetch | undefined;
  const originalEnv = process.env;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-events-'));
    process.chdir(tempDir);
    originalFetch = globalThis.fetch;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    globalThis.fetch = originalFetch!;
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function writeManifest(manifest = makeManifest()): string {
    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', '20260530-120000');
    const promptPath = join(tempDir, '.alpha-loop', 'traces', 'session-20260530-120000', 'prompts');
    mkdirSync(join(sessionDir, 'logs'), { recursive: true });
    mkdirSync(promptPath, { recursive: true });
    writeFileSync(join(promptPath, 'issue-269-implement.md'), 'Implement event delivery with secret-value.');
    writeFileSync(sessionManifestPath(sessionDir), JSON.stringify(manifest, null, 2));
    return sessionDir;
  }

  it('builds canonical payloads with session, issue, logs, QA, and harness metadata', () => {
    const sessionDir = writeManifest();

    const event = buildLifecycleEvent({
      config: makeConfig({ events: { includePromptText: true, redact: [], destinations: {} } }),
      type: 'qa.requested',
      session: {
        name: 'session/20260530-120000',
        branch: 'session/20260530-120000',
        resultsDir: sessionDir,
        logsDir: join(sessionDir, 'logs'),
      },
    });

    expect(event.issue).toEqual(expect.objectContaining({ number: 269, title: 'Emit lifecycle events' }));
    expect(event.pr.url).toBe('https://github.com/owner/repo/pull/269');
    expect(event.worktree.path).toBe('/tmp/worktree');
    expect(event.logs.eventLogPath).toContain('events.jsonl');
    expect(event.screenshots).toHaveLength(1);
    expect(event.previewUrl).toBe('https://preview.example.test');
    expect(event.qaChecklist).toEqual(['Open the preview', 'Confirm the copy']);
    expect(event.webApp).toEqual(expect.objectContaining({
      devUrl: 'http://localhost:4321',
      browserResultPath: expect.stringContaining('web-app-verification/issue-269.json'),
      qaChecklist: ['Open the preview', 'Confirm the copy'],
    }));
    expect(event.harness).toEqual(expect.objectContaining({
      agent: 'codex',
      model: 'gpt-5',
      command: 'codex exec --model gpt-5',
      promptPath: expect.stringContaining('issue-269-implement.md'),
      promptHash: 'prompt-hash',
      promptText: 'Implement event delivery with secret-value.',
      transcriptPath: expect.stringContaining('issue-269-implement.log'),
      sessionLogPath: expect.stringContaining('logs'),
    }));
  });

  it('redacts configured secret values and matching keys while retaining prompt references', () => {
    process.env.OPENAI_API_KEY = 'secret-value';
    const sessionDir = writeManifest();
    const event = buildLifecycleEvent({
      config: makeConfig({ events: { includePromptText: true, redact: [], destinations: {} } }),
      type: 'session.started',
      manifestPath: sessionManifestPath(sessionDir),
      context: { metadata: { OPENAI_API_KEY: 'secret-value', safe: 'visible' } },
    });

    const redacted = redactLifecycleEvent(event, makeConfig({
      events: { includePromptText: true, redact: ['OPENAI_API_KEY'], destinations: {} },
    }));
    const json = JSON.stringify(redacted);

    expect(json).not.toContain('secret-value');
    expect(redacted.metadata.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(redacted.harness.promptText).toContain('[REDACTED]');
    expect(redacted.harness.promptPath).toContain('issue-269-implement.md');
    expect(redacted.harness.promptHash).toBe('prompt-hash');
  });

  it('omits prompt text when include_prompt_text is disabled', () => {
    const sessionDir = writeManifest();
    const event = buildLifecycleEvent({
      config: makeConfig({ events: { includePromptText: false, redact: [], destinations: {} } }),
      type: 'session.started',
      manifestPath: sessionManifestPath(sessionDir),
    });

    expect(event.harness.promptText).toBeUndefined();
    expect(event.harness.promptPath).toContain('issue-269-implement.md');
    expect(event.harness.promptHash).toBe('prompt-hash');
  });

  it('matches destination filters including wildcard', () => {
    const exact: EventDestinationConfig = {
      type: 'log',
      events: ['qa.requested'],
      format: 'json',
      required: false,
      timeout: 10,
      retries: 0,
    };
    const wildcard: EventDestinationConfig = { ...exact, events: ['*'] };

    expect(eventMatchesDestination('qa.requested', exact)).toBe(true);
    expect(eventMatchesDestination('session.completed', exact)).toBe(false);
    expect(eventMatchesDestination('session.completed', wildcard)).toBe(true);
  });

  it('formats Slack, Teams, and Discord messages from the canonical event', () => {
    const event = buildLifecycleEvent({
      config: makeConfig(),
      type: 'qa.requested',
      manifest: makeManifest(),
    });

    expect(formatEventPayload(event, 'slack')).toEqual(expect.objectContaining({
      text: expect.stringContaining('qa.requested #269'),
      blocks: expect.any(Array),
    }));
    expect(formatEventPayload(event, 'teams')).toEqual(expect.objectContaining({
      type: 'message',
      attachments: expect.any(Array),
    }));
    expect(formatEventPayload(event, 'discord')).toEqual(expect.objectContaining({
      content: expect.stringContaining('qa.requested #269'),
      embeds: expect.any(Array),
    }));
  });

  it('logs canonical events and delivery attempts to the session event log', async () => {
    const sessionDir = writeManifest();
    const config = makeConfig({
      events: {
        includePromptText: false,
        redact: [],
        destinations: {
          audit: { type: 'log', events: ['*'], format: 'json', required: false, timeout: 10, retries: 0 },
        },
      },
    });

    const result = await emitLifecycleEvent({
      config,
      type: 'session.completed',
      manifestPath: sessionManifestPath(sessionDir),
      session: {
        name: 'session/20260530-120000',
        branch: 'session/20260530-120000',
        resultsDir: sessionDir,
        logsDir: join(sessionDir, 'logs'),
      },
    });

    expect(result.deliveries).toEqual([expect.objectContaining({ destination: 'audit', status: 'success' })]);
    const lines = readFileSync(join(sessionDir, 'logs', 'events.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toEqual(expect.objectContaining({ kind: 'event', eventType: 'session.completed' }));
    expect(lines[1]).toEqual(expect.objectContaining({ kind: 'delivery', destination: 'audit', status: 'success' }));
    const manifest = JSON.parse(readFileSync(sessionManifestPath(sessionDir), 'utf-8')) as DurableSessionManifest;
    expect(manifest.logs.files).toEqual(expect.arrayContaining([expect.stringContaining('events.jsonl')]));
  });

  it('retries webhook delivery and signs payloads when a secret is configured', async () => {
    process.env.EVENT_URL = 'https://events.example.test/hook';
    process.env.EVENT_SECRET = 'signing-secret';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response('try again', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await emitLifecycleEvent({
      config: makeConfig({
        events: {
          includePromptText: false,
          redact: [],
          destinations: {
            service: {
              type: 'webhook',
              events: ['session.started'],
              format: 'json',
              required: false,
              timeout: 5,
              retries: 1,
              urlEnv: 'EVENT_URL',
              secretEnv: 'EVENT_SECRET',
            },
          },
        },
      }),
      type: 'session.started',
      manifest: makeManifest(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers['x-alpha-loop-signature']).toMatch(/^sha256=/);
    expect(result.deliveries.map((delivery) => delivery.status)).toEqual(['failed', 'success']);
    expect(result.deliveries[0]).toEqual(expect.objectContaining({ responseStatus: 500, responseBody: 'try again' }));
    expect(result.deliveries[1]).toEqual(expect.objectContaining({ responseStatus: 200, responseBody: 'ok' }));
  });

  it('throws when a required webhook destination cannot be delivered', async () => {
    await expect(emitLifecycleEvent({
      config: makeConfig({
        events: {
          includePromptText: false,
          redact: [],
          destinations: {
            service: {
              type: 'webhook',
              events: ['session.started'],
              format: 'json',
              required: true,
              timeout: 5,
              retries: 0,
              urlEnv: 'MISSING_EVENT_URL',
            },
          },
        },
      }),
      type: 'session.started',
      manifest: makeManifest(),
    })).rejects.toThrow(/required|failed|MISSING_EVENT_URL/);
  });

  it('runs command destinations with canonical JSON on stdin', async () => {
    const command = `${process.execPath} -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const e=JSON.parse(d);process.stdout.write(e.type+':'+e.issue.number)})"`;

    const result = await emitLifecycleEvent({
      config: makeConfig({
        events: {
          includePromptText: false,
          redact: [],
          destinations: {
            script: {
              type: 'command',
              events: ['qa.requested'],
              format: 'discord',
              required: true,
              timeout: 5,
              retries: 0,
              command,
              stdin: 'json',
            },
          },
        },
      }),
      type: 'qa.requested',
      manifest: makeManifest(),
    });

    expect(result.deliveries[0]).toEqual(expect.objectContaining({
      destination: 'script',
      status: 'success',
      stdout: 'qa.requested:269',
      exitCode: 0,
    }));
  });

  it('prints dry-run delivery targets without sending webhooks', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const result = await emitLifecycleEvent({
      config: makeConfig({
        dryRun: true,
        events: {
          includePromptText: false,
          redact: [],
          destinations: {
            service: {
              type: 'webhook',
              events: ['session.started'],
              format: 'slack',
              required: false,
              timeout: 5,
              retries: 0,
              urlEnv: 'EVENT_URL',
            },
          },
        },
      }),
      type: 'session.started',
      manifest: makeManifest(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.deliveries).toEqual([expect.objectContaining({ status: 'dry-run', destination: 'service' })]);
  });
});
