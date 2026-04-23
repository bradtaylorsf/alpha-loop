import {
  buildAgentArgs,
  buildEndpointEnv,
  buildOneShotCommand,
  spawnAgent,
  DEFAULT_LMSTUDIO_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  type AgentOptions,
} from '../../src/lib/agent';
import type { RoutingEndpoint } from '../../src/lib/config';

// Mock child_process.spawn
const mockStdin = { write: jest.fn(), end: jest.fn() };
const mockStdout = { on: jest.fn() };
const mockStderr = { on: jest.fn() };
const mockChild = {
  stdin: mockStdin,
  stdout: mockStdout,
  stderr: mockStderr,
  on: jest.fn(),
};

jest.mock('node:child_process', () => ({
  spawn: jest.fn(() => mockChild),
}));

jest.mock('node:fs', () => ({
  createWriteStream: jest.fn(() => ({
    write: jest.fn(),
    end: jest.fn((cb?: () => void) => { if (cb) cb(); }),
  })),
}));

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

beforeEach(() => {
  jest.clearAllMocks();
  // Reset mock implementations
  mockStdout.on.mockReset();
  mockStderr.on.mockReset();
  mockChild.on.mockReset();
});

describe('buildAgentArgs', () => {
  test('constructs correct args for claude agent', () => {
    const result = buildAgentArgs({
      agent: 'claude',
      model: 'opus',
      prompt: 'test prompt',
      cwd: '/tmp',
    });

    expect(result.command).toBe('claude');
    expect(result.args).toEqual([
      '-p',
      '--model', 'opus',
      '--dangerously-skip-permissions',
      '--verbose',
      '--output-format', 'stream-json',
    ]);
  });

  test('claude agent does not include --max-turns (agents finish naturally)', () => {
    const result = buildAgentArgs({
      agent: 'claude',
      model: 'sonnet',
      prompt: 'test',
      cwd: '/tmp',
    });

    expect(result.args).not.toContain('--max-turns');
  });

  test('constructs correct args for codex agent', () => {
    const result = buildAgentArgs({
      agent: 'codex',
      model: 'gpt-4',
      prompt: 'test prompt',
      cwd: '/tmp',
    });

    expect(result.command).toBe('codex');
    expect(result.args).toEqual(['exec', '--model', 'gpt-4', '--full-auto']);
  });

  test('constructs correct args for opencode agent', () => {
    const result = buildAgentArgs({
      agent: 'opencode',
      model: 'deepseek',
      prompt: 'test prompt',
      cwd: '/tmp',
    });

    expect(result.command).toBe('opencode');
    expect(result.args).toEqual(['run', '--model', 'deepseek']);
  });

  test('omits --model when model is empty', () => {
    const claude = buildAgentArgs({ agent: 'claude', model: '', prompt: 'test', cwd: '/tmp' });
    expect(claude.args).not.toContain('--model');

    const codex = buildAgentArgs({ agent: 'codex', model: '', prompt: 'test', cwd: '/tmp' });
    expect(codex.args).not.toContain('--model');

    const opencode = buildAgentArgs({ agent: 'opencode', model: '', prompt: 'test', cwd: '/tmp' });
    expect(opencode.args).not.toContain('--model');
  });

  test('throws for unknown agent type', () => {
    expect(() =>
      buildAgentArgs({ agent: 'unknown' as any, model: 'x', prompt: 'y', cwd: '/tmp' }),
    ).toThrow('Unknown agent type: unknown');
  });

  test('claude resume adds --continue flag before -p', () => {
    const result = buildAgentArgs({
      agent: 'claude',
      model: 'opus',
      prompt: 'fix tests',
      cwd: '/tmp',
      resume: true,
    });

    expect(result.command).toBe('claude');
    expect(result.args[0]).toBe('--continue');
    expect(result.args[1]).toBe('-p');
    expect(result.args).toContain('--model');
  });

  test('codex resume uses exec resume --last', () => {
    const result = buildAgentArgs({
      agent: 'codex',
      model: 'gpt-4',
      prompt: 'fix tests',
      cwd: '/tmp',
      resume: true,
    });

    expect(result.command).toBe('codex');
    expect(result.args[0]).toBe('exec');
    expect(result.args[1]).toBe('resume');
    expect(result.args[2]).toBe('--last');
    expect(result.args).toContain('--full-auto');
  });

  test('opencode ignores resume flag (no resume support)', () => {
    const result = buildAgentArgs({
      agent: 'opencode',
      model: 'deepseek',
      prompt: 'fix tests',
      cwd: '/tmp',
      resume: true,
    });

    expect(result.command).toBe('opencode');
    expect(result.args).toEqual(['run', '--model', 'deepseek']);
  });

  test('resume false does not add --continue for claude', () => {
    const result = buildAgentArgs({
      agent: 'claude',
      model: 'opus',
      prompt: 'test',
      cwd: '/tmp',
      resume: false,
    });

    expect(result.args).not.toContain('--continue');
    expect(result.args[0]).toBe('-p');
  });
});

describe('buildOneShotCommand', () => {
  test('builds claude command with model', () => {
    const cmd = buildOneShotCommand('claude', 'opus');
    expect(cmd).toBe('claude -p --model opus --dangerously-skip-permissions --output-format text');
  });

  test('builds claude command without model', () => {
    const cmd = buildOneShotCommand('claude', '');
    expect(cmd).toBe('claude -p --dangerously-skip-permissions --output-format text');
  });

  test('builds codex command with model', () => {
    const cmd = buildOneShotCommand('codex', 'gpt-5.4');
    expect(cmd).toBe('codex exec --model gpt-5.4 --full-auto');
  });

  test('builds codex command without model', () => {
    const cmd = buildOneShotCommand('codex', '');
    expect(cmd).toBe('codex exec --full-auto');
  });

  test('builds opencode command', () => {
    const cmd = buildOneShotCommand('opencode', 'deepseek');
    expect(cmd).toBe('opencode run --model deepseek');
  });

  test('throws for unknown agent', () => {
    expect(() => buildOneShotCommand('unknown' as any, '')).toThrow('Unknown agent type: unknown');
  });
});

describe('spawnAgent', () => {
  const baseOptions: AgentOptions = {
    agent: 'claude',
    model: 'opus',
    prompt: 'implement the feature',
    cwd: '/project',
  };

  test('pipes prompt to stdin and resolves with result on close', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        // Simulate close after a tick
        setTimeout(() => cb(0), 10);
      }
    });

    const resultPromise = spawnAgent(baseOptions);
    const result = await resultPromise;

    // Verify spawn was called with correct args
    expect(spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', '--model', 'opus']),
      expect.objectContaining({ cwd: '/project' }),
    );

    // Verify prompt was written to stdin
    expect(mockStdin.write).toHaveBeenCalledWith('implement the feature');
    expect(mockStdin.end).toHaveBeenCalled();

    expect(result.exitCode).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test('captures output from stdout and stderr', async () => {
    // Capture the data handlers
    let stdoutHandler: Function;
    let stderrHandler: Function;
    mockStdout.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'data') stdoutHandler = cb;
    });
    mockStderr.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'data') stderrHandler = cb;
    });
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => {
          // Emit some data before close
          stdoutHandler(Buffer.from('hello '));
          stderrHandler(Buffer.from('world'));
          cb(0);
        }, 10);
      }
    });

    const result = await spawnAgent(baseOptions);
    expect(result.output).toBe('hello world');
  });

  test('returns non-zero exit code without throwing', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(1), 10);
      }
    });

    const result = await spawnAgent(baseOptions);
    expect(result.exitCode).toBe(1);
  });

  test('handles spawn error gracefully', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'error') {
        setTimeout(() => cb(new Error('command not found')), 10);
      }
    });

    const result = await spawnAgent(baseOptions);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Failed to spawn claude');
  });

  test('creates log file write stream when logFile is specified', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });

    await spawnAgent({ ...baseOptions, logFile: '/tmp/agent.log' });
    expect(createWriteStream).toHaveBeenCalledWith('/tmp/agent.log', { flags: 'w' });
  });

  test('tracks duration accurately', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 50);
      }
    });

    const result = await spawnAgent(baseOptions);
    expect(result.duration).toBeGreaterThanOrEqual(40);
  });

  test('includes model in result', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });

    const result = await spawnAgent(baseOptions);
    expect(result.model).toBe('opus');
  });

  test('parses cost and tokens from Claude stream-json result', async () => {
    let stdoutHandler: Function;
    mockStdout.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'data') stdoutHandler = cb;
    });
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => {
          // Simulate a Claude stream-json result with cost and usage
          const resultLine = JSON.stringify({
            type: 'result',
            result: 'Done.',
            total_cost_usd: 1.234,
            usage: { input_tokens: 50000, output_tokens: 12000 },
          }) + '\n';
          stdoutHandler(Buffer.from(resultLine));
          cb(0);
        }, 10);
      }
    });

    const result = await spawnAgent(baseOptions);
    expect(result.costUsd).toBe(1.234);
    expect(result.inputTokens).toBe(50000);
    expect(result.outputTokens).toBe(12000);
  });

  test('cost fields are undefined when not provided', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(0), 10);
      }
    });

    const result = await spawnAgent(baseOptions);
    expect(result.costUsd).toBeUndefined();
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  test('forwards env option merged over process.env', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') setTimeout(() => cb(0), 10);
    });

    await spawnAgent({
      ...baseOptions,
      env: { ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_MODEL: 'qwen' },
    });

    const call = (spawn as jest.Mock).mock.calls.at(-1);
    const spawnOpts = call?.[2];
    expect(spawnOpts.env).toBeDefined();
    expect(spawnOpts.env.ANTHROPIC_BASE_URL).toBe('http://localhost:1234');
    expect(spawnOpts.env.ANTHROPIC_MODEL).toBe('qwen');
    // process.env keys should still be present (e.g. PATH usually set).
    // Use a portable fingerprint: PATH or HOME is set in every CI and dev env.
    const fingerprint = spawnOpts.env.PATH ?? spawnOpts.env.HOME;
    expect(fingerprint).toBeDefined();
  });

  test('does not leak env vars between sequential spawn calls', async () => {
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') setTimeout(() => cb(0), 10);
    });

    // First call sets a local-endpoint env
    await spawnAgent({
      ...baseOptions,
      env: { ANTHROPIC_BASE_URL: 'http://localhost:1234', ANTHROPIC_MODEL: 'qwen' },
    });

    // Second call has no env option — must not inherit the first call's env
    await spawnAgent(baseOptions);

    const calls = (spawn as jest.Mock).mock.calls;
    const firstEnv = calls[0][2].env;
    const secondEnv = calls[1][2].env;
    expect(firstEnv.ANTHROPIC_BASE_URL).toBe('http://localhost:1234');
    // Unless the ambient process.env already has ANTHROPIC_BASE_URL, it must
    // not appear in the second call's env.
    if (process.env.ANTHROPIC_BASE_URL === undefined) {
      expect(secondEnv.ANTHROPIC_BASE_URL).toBeUndefined();
    }
    if (process.env.ANTHROPIC_MODEL === undefined) {
      expect(secondEnv.ANTHROPIC_MODEL).toBeUndefined();
    }
  });
});

describe('buildEndpointEnv', () => {
  test('sets ANTHROPIC_* for anthropic endpoints', () => {
    const endpoint: RoutingEndpoint = { type: 'anthropic', base_url: 'https://api.anthropic.com' };
    expect(buildEndpointEnv(endpoint, 'claude-opus-4-7')).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'claude-opus-4-7',
    });
  });

  test('sets ANTHROPIC_* for anthropic_compat endpoints (LM Studio)', () => {
    const endpoint: RoutingEndpoint = { type: 'anthropic_compat', base_url: 'http://localhost:1234' };
    expect(buildEndpointEnv(endpoint, 'qwen3-coder-30b-a3b')).toEqual({
      ANTHROPIC_BASE_URL: 'http://localhost:1234',
      ANTHROPIC_MODEL: 'qwen3-coder-30b-a3b',
    });
  });

  test('sets OPENAI_* for openai_compat endpoints (Ollama)', () => {
    const endpoint: RoutingEndpoint = { type: 'openai_compat', base_url: 'http://localhost:11434/v1' };
    expect(buildEndpointEnv(endpoint, 'llama3.1:70b')).toEqual({
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_MODEL: 'llama3.1:70b',
    });
  });

  test('omits *_MODEL when model is empty', () => {
    const endpoint: RoutingEndpoint = { type: 'openai_compat', base_url: 'http://localhost:11434/v1' };
    expect(buildEndpointEnv(endpoint, '')).toEqual({
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
    });
  });
});

describe('buildAgentArgs (lmstudio/ollama)', () => {
  test('lmstudio delegates to the claude CLI', () => {
    const result = buildAgentArgs({
      agent: 'lmstudio',
      model: 'qwen3-coder-30b-a3b',
      prompt: 'test',
      cwd: '/tmp',
    });
    expect(result.command).toBe('claude');
    expect(result.args).toContain('-p');
    expect(result.args).toContain('--dangerously-skip-permissions');
    expect(result.args).toContain('--model');
    expect(result.args).toContain('qwen3-coder-30b-a3b');
  });

  test('ollama delegates to the codex CLI', () => {
    const result = buildAgentArgs({
      agent: 'ollama',
      model: 'llama3.1:70b',
      prompt: 'test',
      cwd: '/tmp',
    });
    expect(result.command).toBe('codex');
    expect(result.args).toContain('exec');
    expect(result.args).toContain('--full-auto');
    expect(result.args).toContain('--model');
    expect(result.args).toContain('llama3.1:70b');
  });
});

describe('spawnAgent default local env injection', () => {
  // Save/restore ambient env so we control what process.env contains.
  const savedAnthropicBase = process.env.ANTHROPIC_BASE_URL;
  const savedAnthropicModel = process.env.ANTHROPIC_MODEL;
  const savedOpenaiBase = process.env.OPENAI_BASE_URL;
  const savedOpenaiModel = process.env.OPENAI_MODEL;

  beforeEach(() => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_MODEL;
    mockChild.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') setTimeout(() => cb(0), 10);
    });
  });

  afterAll(() => {
    if (savedAnthropicBase !== undefined) process.env.ANTHROPIC_BASE_URL = savedAnthropicBase;
    if (savedAnthropicModel !== undefined) process.env.ANTHROPIC_MODEL = savedAnthropicModel;
    if (savedOpenaiBase !== undefined) process.env.OPENAI_BASE_URL = savedOpenaiBase;
    if (savedOpenaiModel !== undefined) process.env.OPENAI_MODEL = savedOpenaiModel;
  });

  test('agent: lmstudio auto-injects ANTHROPIC_BASE_URL and ANTHROPIC_MODEL', async () => {
    await spawnAgent({
      agent: 'lmstudio',
      model: 'qwen3-coder-30b-a3b',
      prompt: 'go',
      cwd: '/project',
    });
    const spawnOpts = (spawn as jest.Mock).mock.calls.at(-1)?.[2];
    expect(spawnOpts.env.ANTHROPIC_BASE_URL).toBe(DEFAULT_LMSTUDIO_BASE_URL);
    expect(spawnOpts.env.ANTHROPIC_MODEL).toBe('qwen3-coder-30b-a3b');
  });

  test('agent: ollama auto-injects OPENAI_BASE_URL and OPENAI_MODEL', async () => {
    await spawnAgent({
      agent: 'ollama',
      model: 'llama3.1:70b',
      prompt: 'go',
      cwd: '/project',
    });
    const spawnOpts = (spawn as jest.Mock).mock.calls.at(-1)?.[2];
    expect(spawnOpts.env.OPENAI_BASE_URL).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(spawnOpts.env.OPENAI_MODEL).toBe('llama3.1:70b');
  });

  test('agent: claude does not auto-inject local env vars', async () => {
    await spawnAgent({
      agent: 'claude',
      model: 'opus',
      prompt: 'go',
      cwd: '/project',
    });
    const spawnOpts = (spawn as jest.Mock).mock.calls.at(-1)?.[2];
    expect(spawnOpts.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(spawnOpts.env.ANTHROPIC_MODEL).toBeUndefined();
  });

  test('respects pre-set ANTHROPIC_BASE_URL (user override wins)', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:5555';
    await spawnAgent({
      agent: 'lmstudio',
      model: 'qwen3-coder-30b-a3b',
      prompt: 'go',
      cwd: '/project',
    });
    const spawnOpts = (spawn as jest.Mock).mock.calls.at(-1)?.[2];
    expect(spawnOpts.env.ANTHROPIC_BASE_URL).toBe('http://localhost:5555');
  });

  test('options.env overrides take precedence over local defaults', async () => {
    await spawnAgent({
      agent: 'lmstudio',
      model: 'qwen3-coder-30b-a3b',
      prompt: 'go',
      cwd: '/project',
      env: { ANTHROPIC_BASE_URL: 'http://localhost:9999' },
    });
    const spawnOpts = (spawn as jest.Mock).mock.calls.at(-1)?.[2];
    expect(spawnOpts.env.ANTHROPIC_BASE_URL).toBe('http://localhost:9999');
  });
});
