import { exec, run } from '../../src/lib/shell';

describe('shell', () => {
  describe('exec', () => {
    it('runs a command and returns structured result', () => {
      const result = exec('echo hello');
      expect(result.stdout).toBe('hello');
      expect(result.exitCode).toBe(0);
    });

    it('returns non-zero exit code on failure (does not throw)', () => {
      const result = exec('exit 1');
      expect(result.exitCode).not.toBe(0);
    });

    it('captures stderr on failure', () => {
      const result = exec('echo "bad thing" >&2 && exit 1');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('bad thing');
    });

    it('respects cwd option', () => {
      const result = exec('pwd', { cwd: '/tmp' });
      // /tmp may resolve to /private/tmp on macOS
      expect(result.stdout).toMatch(/\/tmp$/);
    });
  });

  describe('run', () => {
    it('resolves with exit code 0 for successful command', async () => {
      const code = await run('echo', ['hello']);
      expect(code).toBe(0);
    });

    it('calls onStdout with output lines', async () => {
      const lines: string[] = [];
      await run('echo', ['hello'], { onStdout: (line) => lines.push(line) });
      expect(lines).toEqual(['hello']);
    });

    it('returns non-zero exit code on failure', async () => {
      const code = await run('sh', ['-c', 'exit 42']);
      expect(code).toBe(42);
    });

    it('calls onStderr with error output', async () => {
      const lines: string[] = [];
      await run('sh', ['-c', 'echo oops >&2'], { onStderr: (line) => lines.push(line) });
      expect(lines).toEqual(['oops']);
    });

    it('respects cwd option', async () => {
      const lines: string[] = [];
      await run('pwd', [], { cwd: '/tmp', onStdout: (line) => lines.push(line) });
      expect(lines[0]).toMatch(/\/tmp$/);
    });
  });
});
