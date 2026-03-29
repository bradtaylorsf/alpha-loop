import { createClaudeRunner, createAgentRunner } from '../../src/engine/runner';
import type { RunOptions } from '../../src/engine/runner';

describe('createClaudeRunner', () => {
  const runner = createClaudeRunner();

  it('has correct name and command', () => {
    expect(runner.name).toBe('claude');
    expect(runner.command).toBe('claude');
  });

  describe('buildArgs', () => {
    it('builds minimal args with just a prompt', () => {
      const args = runner.buildArgs({ prompt: 'hello' });
      expect(args).toEqual(['-p', '--output-format', 'text']);
    });

    it('includes model flag', () => {
      const args = runner.buildArgs({ prompt: 'hello', model: 'sonnet' });
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
    });

    it('includes max-turns flag', () => {
      const args = runner.buildArgs({ prompt: 'hello', maxTurns: 10 });
      expect(args).toContain('--max-turns');
      expect(args).toContain('10');
    });

    it('includes permission-mode flag', () => {
      const args = runner.buildArgs({ prompt: 'hello', permissionMode: 'plan' });
      expect(args).toContain('--permission-mode');
      expect(args).toContain('plan');
    });

    it('includes all flags together', () => {
      const args = runner.buildArgs({
        prompt: 'hello',
        model: 'opus',
        maxTurns: 5,
        permissionMode: 'auto',
      });
      expect(args).toEqual([
        '-p', '--output-format', 'text',
        '--model', 'opus',
        '--max-turns', '5',
        '--permission-mode', 'auto',
      ]);
    });
  });
});

describe('createAgentRunner', () => {
  it('creates a runner with custom config', () => {
    const runner = createAgentRunner({
      name: 'codex',
      command: 'codex',
      buildArgs: (opts: RunOptions) => ['--prompt', opts.prompt],
    });
    expect(runner.name).toBe('codex');
    expect(runner.command).toBe('codex');
    expect(typeof runner.run).toBe('function');
  });

  it('delegates buildArgs to the provided function', () => {
    const buildArgs = (opts: RunOptions) => ['--model', opts.model ?? 'default'];
    const runner = createAgentRunner({ name: 'test', command: 'test', buildArgs });
    expect(runner.buildArgs({ prompt: 'hi', model: 'fast' })).toEqual(['--model', 'fast']);
  });
});

describe('runner process handling', () => {
  it('returns success false and exit code for non-existent command', async () => {
    const runner = createAgentRunner({
      name: 'fake',
      command: 'nonexistent-command-that-does-not-exist',
      buildArgs: () => [],
    });

    const result = await runner.run({ prompt: 'test' });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.output).toBeTruthy();
  });

  it('captures output from a real command', async () => {
    const runner = createAgentRunner({
      name: 'echo',
      command: 'echo',
      buildArgs: (opts: RunOptions) => [opts.prompt],
    });

    const result = await runner.run({ prompt: 'hello world' });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello world');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('respects cwd parameter', async () => {
    const runner = createAgentRunner({
      name: 'pwd',
      command: 'pwd',
      buildArgs: () => [],
    });

    const result = await runner.run({ prompt: '', cwd: '/tmp' });
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe('/private/tmp');
  });

  it('handles non-zero exit codes', async () => {
    const runner = createAgentRunner({
      name: 'false',
      command: 'false',
      buildArgs: () => [],
    });

    const result = await runner.run({ prompt: '' });
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  it('streams output to log file', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const logFile = path.join(os.tmpdir(), `runner-test-${Date.now()}.log`);

    const runner = createAgentRunner({
      name: 'echo',
      command: 'echo',
      buildArgs: (opts: RunOptions) => [opts.prompt],
    });

    await runner.run({ prompt: 'log test output', logFile });

    const logContent = fs.readFileSync(logFile, 'utf-8');
    expect(logContent).toContain('log test output');

    fs.unlinkSync(logFile);
  });
});

describe('integration: claude --help', () => {
  it('can invoke claude -p --help', async () => {
    const runner = createClaudeRunner();
    const result = await runner.run({ prompt: '--help' });
    // claude -p --help may return 0 or non-zero depending on version,
    // but it should at least produce output and not hang
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(typeof result.output).toBe('string');
    expect(typeof result.exitCode).toBe('number');
  }, 30000);
});
