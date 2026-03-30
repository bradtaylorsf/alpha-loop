import { visionCommand } from '../../src/commands/vision';

describe('vision', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('skips when not running in an interactive terminal', async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await visionCommand();

    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Not running in an interactive terminal');

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });
});
