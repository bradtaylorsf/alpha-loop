import { execSync } from 'node:child_process';
import {
  checkAgents,
  isCommandAvailable,
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
