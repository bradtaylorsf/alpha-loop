import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  buildLifecycleEvent,
  emitLifecycleEvent,
  emitFactoryEvent,
  eventMatchesDestination,
  formatEventPayload,
  redactLifecycleEvent,
} from '../../src/lib/events.js';
import { sessionManifestPath, type DurableSessionManifest } from '../../src/lib/session.js';
import type { Config, EventDestinationConfig } from '../../src/lib/config.js';
import { log } from '../../src/lib/logger.js';

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
    jest.useRealTimers();
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

  it('delivers sessionless factory events to exact and wildcard destinations in a separate log', async () => {
    const stateDir = join(tempDir, 'factory');
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, 'events.jsonl'), 'existing audit\n');
    const destination: EventDestinationConfig = {
      type: 'log', events: ['factory.question.asked'], format: 'json', required: false, timeout: 1, retries: 0,
    };
    const result = await emitFactoryEvent({
      config: makeConfig({ events: { includePromptText: false, redact: [], destinations: {
        exact: destination,
        wildcard: { ...destination, events: ['*'] },
        unrelated: { ...destination, events: ['session.started'] },
      } } }),
      type: 'factory.question.asked', stateDir, now: '2026-11-05T10:00:00Z',
      context: { issueNumber: 448, question: 'Which base?', resumeInstructions: 'Answer Q-1', metadata: { questionId: 'Q-1' } },
    });

    expect(result?.deliveries.map((d) => d.destination)).toEqual(['exact', 'wildcard']);
    expect(result?.event).toEqual(expect.objectContaining({
      type: 'factory.question.asked', createdAt: '2026-11-05T10:00:00Z',
      issue: expect.objectContaining({ number: 448 }),
      session: expect.objectContaining({ id: null }),
      humanInput: expect.objectContaining({ question: 'Which base?', resumeInstructions: 'Answer Q-1' }),
      logs: expect.objectContaining({ eventLogPath: join(stateDir, 'lifecycle-events.jsonl') }),
    }));
    const records = readFileSync(join(stateDir, 'lifecycle-events.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((r) => r.kind)).toEqual(['event', 'delivery', 'delivery']);
    expect(readFileSync(join(stateDir, 'events.jsonl'), 'utf-8')).toBe('existing audit\n');
  });

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

  it('logs a factory event even with no matching destinations and supports an explicit sessionless log path', async () => {
    const config = makeConfig({ events: { includePromptText: false, redact: [], destinations: {} } });
    const eventLogPath = join(tempDir, 'custom', 'events.jsonl');
    const result = await emitLifecycleEvent({ config, type: 'factory.stopped', eventLogPath });
    expect(result.event.session.id).toBeNull();
    expect(result.event.logs.eventLogPath).toBe(eventLogPath);
    expect(JSON.parse(readFileSync(eventLogPath, 'utf-8')).event.type).toBe('factory.stopped');
  });

  it('redacts nested factory payloads and echoed diagnostics before logging and delivering to all transports', async () => {
    process.env.FACTORY_SECRET = 'environment-secret';
    process.env.EVENT_URL = 'https://events.example.test/hook';
    const echoed = 'environment-secret literal-secret';
    const fetchMock = jest.fn().mockResolvedValue(new Response(echoed, { status: 500 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => {});
    const stateDir = join(tempDir, 'factory');
    const common = { events: ['factory.question.asked' as const], format: 'json' as const, required: true, timeout: 5, retries: 1 };
    // Echo stdin to prove the command receives the same redacted canonical payload.
    const command = `"${process.execPath}" -e "process.stdin.pipe(process.stdout);process.stderr.write('environment-secret literal-secret');process.exitCode=1"`;
    const result = await emitFactoryEvent({
      config: makeConfig({ events: { includePromptText: false, redact: ['FACTORY_SECRET', 'token', 'literal-secret'], destinations: {
        webhook: { ...common, type: 'webhook', urlEnv: 'EVENT_URL' },
        command: { ...common, retries: 0, type: 'command', command, stdin: 'json' },
        audit: { ...common, type: 'log' },
      } } }),
      type: 'factory.question.asked', stateDir,
      context: { question: `Proceed with ${echoed}?`, metadata: { nested: [{ TOKEN: 'key-secret', safe: echoed }] } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.humanInput.question).toBe('Proceed with [REDACTED] [REDACTED]?');
    expect(body.metadata.nested).toEqual([{ TOKEN: '[REDACTED]', safe: '[REDACTED] [REDACTED]' }]);
    expect(result?.deliveries.map((d) => [d.destination, d.status])).toEqual([
      ['webhook', 'failed'], ['webhook', 'failed'], ['command', 'failed'], ['audit', 'success'],
    ]);
    expect(result?.deliveries[0]).toEqual(expect.objectContaining({ responseBody: '[REDACTED] [REDACTED]' }));
    expect(result?.deliveries[2]).toEqual(expect.objectContaining({ stdout: expect.stringContaining('factory.question.asked'), stderr: '[REDACTED] [REDACTED]' }));
    const recorded = readFileSync(join(stateDir, 'lifecycle-events.jsonl'), 'utf-8');
    for (const output of [JSON.stringify(result), recorded, JSON.stringify(warn.mock.calls), JSON.stringify(fetchMock.mock.calls)]) {
      for (const secret of ['environment-secret', 'literal-secret', 'key-secret']) expect(output).not.toContain(secret);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([200, 500])('redacts secrets crossing the webhook diagnostic cutoff for HTTP %s', async (status) => {
    process.env.FACTORY_SECRET = 'environment-secret';
    process.env.EVENT_URL = 'https://events.example.test/hook';
    const response = 'x'.repeat(1985) + process.env.FACTORY_SECRET + 'y'.repeat(50);
    globalThis.fetch = jest.fn().mockResolvedValue(new Response(response, { status })) as unknown as typeof fetch;
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => {});
    const result = await emitFactoryEvent({
      config: makeConfig({ events: { includePromptText: false, redact: ['FACTORY_SECRET'], destinations: {
        webhook: { type: 'webhook', urlEnv: 'EVENT_URL', events: ['*'], format: 'json', required: true, timeout: 5, retries: 0 },
      } } }),
      type: 'factory.stopped', stateDir: tempDir,
    });

    expect(result?.deliveries[0].status).toBe(status === 200 ? 'success' : 'failed');
    expect(result?.deliveries[0].responseBody).toContain('[REDACTED]');
    expect(result?.deliveries[0].responseBody?.length).toBeLessThanOrEqual(2000);
    for (const output of [JSON.stringify(result), readFileSync(join(tempDir, 'lifecycle-events.jsonl'), 'utf-8'), JSON.stringify(warn.mock.calls)]) {
      expect(output).not.toContain('environment-sec');
    }
  });

  it.each([0, 1])('redacts secrets crossing command stdout/stderr cutoffs for exit code %s', async (exitCode) => {
    process.env.FACTORY_SECRET = 'environment-secret';
    const command = `"${process.execPath}" -e "process.stdin.resume();const output='x'.repeat(1985)+'environment-secret'+'y'.repeat(50);process.stdout.write(output);process.stderr.write(output);process.exitCode=${exitCode}"`;
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => {});
    const result = await emitFactoryEvent({
      config: makeConfig({ events: { includePromptText: false, redact: ['FACTORY_SECRET'], destinations: {
        command: { type: 'command', command, stdin: 'json', events: ['*'], format: 'json', required: true, timeout: 5, retries: 0 },
      } } }),
      type: 'factory.stopped', stateDir: tempDir,
    });

    expect(result?.deliveries[0].status).toBe(exitCode === 0 ? 'success' : 'failed');
    for (const output of [result?.deliveries[0].stdout, result?.deliveries[0].stderr]) {
      expect(output).toContain('[REDACTED]');
      expect(output?.length).toBeLessThanOrEqual(2000);
    }
    for (const output of [JSON.stringify(result), readFileSync(join(tempDir, 'lifecycle-events.jsonl'), 'utf-8'), JSON.stringify(warn.mock.calls)]) {
      expect(output).not.toContain('environment-sec');
    }
  });

  it.each(['slack', 'teams', 'discord'] as const)('includes the question and answer instructions in %s factory notifications', async (format) => {
    process.env.EVENT_URL = 'https://events.example.test/hook';
    const fetchMock = jest.fn().mockResolvedValue(new Response('ok'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await emitFactoryEvent({
      config: makeConfig({ events: { includePromptText: false, redact: ['literal-secret'], destinations: {
        alert: { type: 'webhook', events: ['factory.question.asked'], format, required: false, timeout: 5, retries: 0, urlEnv: 'EVENT_URL' },
      } } }),
      type: 'factory.question.asked', stateDir: tempDir,
      context: { question: 'Use literal-secret?', resumeInstructions: 'alpha-loop factory answer Q-1 "<text>"' },
    });
    const payload = fetchMock.mock.calls[0][1].body as string;
    expect(payload).toContain('Use [REDACTED]?');
    expect(payload).toContain('alpha-loop factory answer Q-1');
    expect(payload).not.toContain('literal-secret');
  });

  it('bounds factory webhook delivery with the configured timeout and continues to a log destination', async () => {
    jest.useFakeTimers();
    process.env.EVENT_URL = 'https://events.example.test/hook';
    globalThis.fetch = jest.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })) as unknown as typeof fetch;
    const pending = emitFactoryEvent({
      config: makeConfig({ events: { includePromptText: false, redact: [], destinations: {
        slow: { type: 'webhook', events: ['*'], format: 'json', required: true, timeout: 1, retries: 0, urlEnv: 'EVENT_URL' },
        audit: { type: 'log', events: ['*'], format: 'json', required: false, timeout: 1, retries: 0 },
      } } }),
      type: 'factory.stopped', stateDir: tempDir,
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect((await pending)?.deliveries.map((d) => d.status)).toEqual(['failed', 'success']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('handles command stdin failures without an unhandled error or skipping later destinations', async () => {
    jest.useFakeTimers();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: jest.fn() });
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>);
    const pending = emitFactoryEvent({
      config: makeConfig({ events: { includePromptText: false, redact: [], destinations: {
        script: { type: 'command', command: 'on-event', stdin: 'json', events: ['*'], format: 'json', required: true, timeout: 1, retries: 0 },
        audit: { type: 'log', events: ['*'], format: 'json', required: false, timeout: 1, retries: 0 },
      } } }),
      type: 'factory.stopped', stateDir: tempDir,
    });
    try {
      stdin.emit('error', new Error('broken pipe'));
      child.emit('close', 1);
      const result = await pending;
      expect(result?.deliveries.map((d) => d.status)).toEqual(['failed', 'success']);
      expect(result?.deliveries[0].error).toBe('broken pipe');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    }
  });

  it.each(['timeout', 'stdin error'] as const)('cleans up command processes and pipes after a %s', async (failure) => {
    jest.useFakeTimers();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { pid: 987654, stdin, stdout, stderr, kill: jest.fn() });
    const spawn = jest.spyOn(childProcess, 'spawn').mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>);
    const killGroup = jest.spyOn(process, 'kill').mockReturnValue(true);
    const pending = emitFactoryEvent({
      config: makeConfig({ events: { includePromptText: false, redact: [], destinations: {
        script: { type: 'command', command: 'on-event', stdin: 'json', events: ['*'], format: 'json', required: true, timeout: 1, retries: 0 },
        audit: { type: 'log', events: ['*'], format: 'json', required: false, timeout: 1, retries: 0 },
      } } }),
      type: 'factory.stopped', stateDir: tempDir,
    });
    try {
      if (failure === 'timeout') await jest.advanceTimersByTimeAsync(1000);
      else stdin.emit('error', new Error('broken pipe'));

      const result = await pending;
      expect(result?.deliveries.map((d) => d.status)).toEqual(['failed', 'success']);
      expect(result?.deliveries[0].error).toBe(failure === 'timeout' ? 'Command timed out after 1s' : 'broken pipe');
      expect(spawn).toHaveBeenCalledWith('on-event', expect.objectContaining({ detached: process.platform !== 'win32' }));
      if (process.platform !== 'win32') expect(killGroup).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
      else expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect([stdin.destroyed, stdout.destroyed, stderr.destroyed]).toEqual([true, true, true]);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    }
  });

  it('catches unexpected factory emission errors and redacts the warning', async () => {
    const warn = jest.spyOn(log, 'warn').mockImplementation(() => {});
    const config = makeConfig();
    Object.defineProperty(config, 'repo', { get: () => { throw new Error('unexpected literal-secret'); } });
    config.events = { includePromptText: false, redact: ['literal-secret'], destinations: {} };
    await expect(emitFactoryEvent({ config, type: 'factory.stopped', stateDir: tempDir })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected [REDACTED]'));
  });

  it('keeps factory dry runs free of file writes and transport sends', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const stateDir = join(tempDir, 'dry-factory');
    const common = { events: ['*' as const], format: 'json' as const, required: true, timeout: 1, retries: 0 };
    const result = await emitFactoryEvent({
      config: makeConfig({ dryRun: true, events: { includePromptText: false, redact: [], destinations: {
        webhook: { ...common, type: 'webhook', urlEnv: 'EVENT_URL' },
        command: { ...common, type: 'command', command: 'exit 1', stdin: 'json' },
        audit: { ...common, type: 'log' },
      } } }),
      type: 'factory.stopped', stateDir,
    });
    expect(result?.deliveries.map((d) => d.status)).toEqual(['dry-run', 'dry-run', 'dry-run']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(stateDir)).toBe(false);
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
