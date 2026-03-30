import { checkPrerequisites, PrerequisiteError } from '../src/lib/prerequisites.js';
import * as shell from '../src/lib/shell.js';

jest.mock('../src/lib/shell.js');

const mockCommandExists = shell.commandExists as jest.MockedFunction<typeof shell.commandExists>;
const mockExec = shell.exec as jest.MockedFunction<typeof shell.exec>;

const ok = { stdout: '', stderr: '', exitCode: 0 };
const fail = { stdout: '', stderr: 'error', exitCode: 1 };

beforeEach(() => {
  jest.resetAllMocks();
  // Default: all tools present and checks pass
  mockCommandExists.mockReturnValue(true);
  mockExec.mockResolvedValue(ok);
});

describe('checkPrerequisites', () => {
  it('passes when all tools are installed and authenticated', async () => {
    await expect(checkPrerequisites({ agent: 'claude' })).resolves.toBeUndefined();
  });

  it('fails when git is missing', async () => {
    mockCommandExists.mockImplementation((cmd) => cmd !== 'git');

    await expect(checkPrerequisites({ agent: 'claude' })).rejects.toThrow(PrerequisiteError);
    await expect(checkPrerequisites({ agent: 'claude' })).rejects.toThrow('git not found');
  });

  it('fails when not in a git repo', async () => {
    mockExec.mockImplementation(async (cmd) => {
      if (cmd.includes('rev-parse')) return fail;
      return ok;
    });

    await expect(checkPrerequisites({ agent: 'claude' })).rejects.toThrow('Not in a git repository');
  });

  it('fails when gh is missing', async () => {
    mockCommandExists.mockImplementation((cmd) => cmd !== 'gh');

    await expect(checkPrerequisites({ agent: 'claude' })).rejects.toThrow('gh CLI not found');
    await expect(checkPrerequisites({ agent: 'claude' })).rejects.toThrow('https://cli.github.com/');
  });

  it('fails when gh is not authenticated', async () => {
    mockExec.mockImplementation(async (cmd) => {
      if (cmd.includes('gh auth')) return fail;
      return ok;
    });

    await expect(checkPrerequisites({ agent: 'claude' })).rejects.toThrow('gh auth login');
  });

  it('fails when the agent CLI is missing', async () => {
    mockCommandExists.mockImplementation((cmd) => cmd !== 'codex');

    await expect(checkPrerequisites({ agent: 'codex' })).rejects.toThrow('codex CLI not found');
    await expect(checkPrerequisites({ agent: 'codex' })).rejects.toThrow('https://github.com/openai/codex');
  });

  it('includes install URL for known agents', async () => {
    mockCommandExists.mockImplementation((cmd) => cmd !== 'opencode');

    await expect(checkPrerequisites({ agent: 'opencode' })).rejects.toThrow('https://github.com/sst/opencode');
  });

  it('handles unknown agent without install URL', async () => {
    mockCommandExists.mockImplementation((cmd) => cmd !== 'myagent');

    const err = await checkPrerequisites({ agent: 'myagent' }).catch((e) => e);
    expect(err).toBeInstanceOf(PrerequisiteError);
    expect(err.message).toContain('myagent CLI not found');
    expect(err.message).not.toContain('Install:');
  });

  it('collects multiple errors', async () => {
    mockCommandExists.mockReturnValue(false);

    const err = await checkPrerequisites({ agent: 'claude' }).catch((e) => e);
    expect(err).toBeInstanceOf(PrerequisiteError);
    expect(err.errors.length).toBeGreaterThanOrEqual(3);
    expect(err.message).toContain('git not found');
    expect(err.message).toContain('gh CLI not found');
    expect(err.message).toContain('claude CLI not found');
  });
});
