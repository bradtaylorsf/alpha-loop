import { buildAgentArgs, buildOneShotCommand, spawnAgent, type AgentOptions } from '../../src/lib/agent';

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
      '--output-format', 'text',
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
});
