import { execSync } from 'node:child_process';
import {
  checkAgents,
  checkLocalModel,
  checkStagePrerequisites,
  isCommandAvailable,
  isLocalEndpoint,
  formatCheckResults,
  formatPipelineSummary,
} from '../../src/engine/prerequisites.js';
import type { Config } from '../../src/lib/config.js';

// Mock child_process.execSync for `which` calls
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 0,
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
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    preferEpics: false,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    ...overrides,
  };
}

describe('isCommandAvailable', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('returns true when command is found', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));
    expect(isCommandAvailable('claude')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith('which claude', { stdio: 'ignore' });
  });

  it('returns false when command is not found', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });
    expect(isCommandAvailable('nonexistent')).toBe(false);
  });

  it('rejects command names with shell metacharacters', () => {
    expect(isCommandAvailable('claude; rm -rf /')).toBe(false);
    expect(isCommandAvailable('claude && echo pwned')).toBe(false);
    expect(isCommandAvailable('$(whoami)')).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe('checkAgents', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('checks the configured agent', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));

    const result = checkAgents(makeConfig({ agent: 'claude' }));
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].agent).toBe('claude');
    expect(result.results[0].installed).toBe(true);
  });

  it('returns ok=false when agent is not installed', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const result = checkAgents(makeConfig({ agent: 'codex' }));
    expect(result.ok).toBe(false);
    expect(result.results[0].agent).toBe('codex');
    expect(result.results[0].installed).toBe(false);
  });

  it('checks codex when configured', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/codex'));

    const result = checkAgents(makeConfig({ agent: 'codex' }));
    expect(result.ok).toBe(true);
    expect(result.results[0].agent).toBe('codex');
  });
});

describe('formatCheckResults', () => {
  it('formats installed agents with checkmark', () => {
    const output = formatCheckResults({
      ok: true,
      results: [{ agent: 'claude', installed: true }],
    });
    expect(output).toContain('✓ claude');
  });

  it('formats missing agents with X and error message', () => {
    const output = formatCheckResults({
      ok: false,
      results: [{ agent: 'codex', installed: false }],
    });
    expect(output).toContain('✗ codex');
    expect(output).toContain('Error: "codex" is not installed');
  });
});

describe('formatPipelineSummary', () => {
  it('shows agent and model configuration', () => {
    const output = formatPipelineSummary(makeConfig({ agent: 'claude', model: 'opus' }));
    expect(output).toContain('claude/opus');
  });

  it('reflects codex agent config', () => {
    const output = formatPipelineSummary(makeConfig({ agent: 'codex', model: 'gpt-5-codex' }));
    expect(output).toContain('codex/gpt-5-codex');
  });
});

describe('checkAgents for lmstudio/ollama', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('probes the claude CLI when agent is lmstudio', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));
    const result = checkAgents(makeConfig({ agent: 'lmstudio' }));
    expect(result.ok).toBe(true);
    expect(result.results[0].agent).toBe('lmstudio');
    expect(mockExecSync).toHaveBeenCalledWith('which claude', { stdio: 'ignore' });
  });

  it('probes the codex CLI when agent is ollama', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/codex'));
    const result = checkAgents(makeConfig({ agent: 'ollama' }));
    expect(result.ok).toBe(true);
    expect(result.results[0].agent).toBe('ollama');
    expect(mockExecSync).toHaveBeenCalledWith('which codex', { stdio: 'ignore' });
  });
});

describe('isLocalEndpoint', () => {
  it('recognizes localhost, loopback and *.local', () => {
    expect(isLocalEndpoint('http://localhost:1234')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:8080')).toBe(true);
    expect(isLocalEndpoint('http://[::1]:1234')).toBe(true);
    expect(isLocalEndpoint('http://mac.local:1234')).toBe(true);
  });

  it('returns false for remote URLs', () => {
    expect(isLocalEndpoint('https://api.anthropic.com')).toBe(false);
    expect(isLocalEndpoint('https://example.com')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isLocalEndpoint('not-a-url')).toBe(false);
    expect(isLocalEndpoint('')).toBe(false);
  });
});

describe('checkLocalModel', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResponse(body: unknown, init?: { status?: number; ok?: boolean }): jest.Mock {
    const status = init?.status ?? 200;
    const ok = init?.ok ?? status < 400;
    const fn = jest.fn(async (_url: RequestInfo | URL) => {
      return {
        ok,
        status,
        json: async () => body,
      } as unknown as Response;
    });
    (globalThis as { fetch: unknown }).fetch = fn;
    return fn;
  }

  it('returns ok=true when the model appears in /v1/models', async () => {
    const fetchMock = mockFetchResponse({
      data: [{ id: 'qwen3-coder-30b-a3b' }, { id: 'gemma-4-31b' }],
    });
    const result = await checkLocalModel('http://localhost:1234', 'qwen3-coder-30b-a3b');
    expect(result.ok).toBe(true);
    expect(result.loaded).toContain('qwen3-coder-30b-a3b');
    // Accept both forms: we append /v1/models if the base URL doesn't already end in /v1.
    const calledUrl = fetchMock.mock.calls[0][0];
    expect(String(calledUrl)).toBe('http://localhost:1234/v1/models');
  });

  it('handles base URLs that already include /v1', async () => {
    const fetchMock = mockFetchResponse({ data: [{ id: 'llama3.1:70b' }] });
    const result = await checkLocalModel('http://localhost:11434/v1', 'llama3.1:70b');
    expect(result.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:11434/v1/models');
  });

  it('returns a descriptive error when the model is not loaded', async () => {
    mockFetchResponse({ data: [{ id: 'other-model' }] });
    const result = await checkLocalModel('http://localhost:1234', 'qwen3-coder-30b-a3b');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('qwen3-coder-30b-a3b');
    expect(result.error).toContain('not loaded');
    expect(result.loaded).toContain('other-model');
  });

  it('returns an error when fetch rejects (server down)', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await checkLocalModel('http://localhost:1234', 'qwen');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Could not reach');
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns an error on non-2xx HTTP response', async () => {
    mockFetchResponse({}, { status: 503, ok: false });
    const result = await checkLocalModel('http://localhost:1234', 'qwen');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 503');
  });
});

describe('checkStagePrerequisites', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('is a no-op when the stage has no routing override', async () => {
    const cfg = makeConfig();
    const result = await checkStagePrerequisites(cfg, 'build');
    expect(result.ok).toBe(true);
    expect(result.checked).toBeUndefined();
  });

  it('is a no-op when the stage endpoint is remote', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn();
    const cfg = makeConfig({
      routing: {
        endpoints: { anthropic: { type: 'anthropic', base_url: 'https://api.anthropic.com' } },
        stages: { build: { model: 'claude-opus-4-7', endpoint: 'anthropic' } },
      },
    });
    const result = await checkStagePrerequisites(cfg, 'build');
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns ok=true when the local model is loaded', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'qwen3-coder-30b-a3b' }] }),
    } as unknown as Response));
    const cfg = makeConfig({
      routing: {
        endpoints: { local: { type: 'anthropic_compat', base_url: 'http://localhost:1234' } },
        stages: { build: { model: 'qwen3-coder-30b-a3b', endpoint: 'local' } },
      },
    });
    const result = await checkStagePrerequisites(cfg, 'build');
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(true);
  });

  it('returns an actionable error when the local model is not loaded', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'some-other-model' }] }),
    } as unknown as Response));
    const cfg = makeConfig({
      routing: {
        endpoints: { local: { type: 'anthropic_compat', base_url: 'http://localhost:1234' } },
        stages: { build: { model: 'qwen3-coder-30b-a3b', endpoint: 'local' } },
      },
    });
    const result = await checkStagePrerequisites(cfg, 'build');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Start LM Studio and load model qwen3-coder-30b-a3b');
  });

  it('labels the 11434 port as Ollama in the error message', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    } as unknown as Response));
    const cfg = makeConfig({
      routing: {
        endpoints: { local: { type: 'openai_compat', base_url: 'http://localhost:11434/v1' } },
        stages: { build: { model: 'llama3.1:70b', endpoint: 'local' } },
      },
    });
    const result = await checkStagePrerequisites(cfg, 'build');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Start Ollama and load model llama3.1:70b');
  });
});
