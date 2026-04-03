import { visionCommand } from '../../src/commands/vision';

describe('vision', () => {
  let consoleSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('shows deprecation warning', async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await visionCommand();

    // Logger outputs to console.error
    const output = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('vision is deprecated');
    expect(output).toContain('alpha-loop plan');

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });

  it('still works after deprecation warning (not removed)', async () => {
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await visionCommand();

    const output = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    // Deprecation warning shown first, then skips due to non-TTY
    expect(output).toContain('vision is deprecated');
    expect(output).toContain('Not running in an interactive terminal');

    Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
  });
});
