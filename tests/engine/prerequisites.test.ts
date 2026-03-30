import { execSync } from 'node:child_process';
import {
  checkAgents,
  isCommandAvailable,
  formatCheckResults,
  formatPipelineSummary,
} from '../../src/engine/prerequisites.js';
import { ConfigSchema } from '../../src/engine/config.js';

// Mock child_process.execSync for `which` calls
jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

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

  it('groups stages by agent and checks each', () => {
    // claude is installed, codex is not
    mockExecSync.mockImplementation((cmd) => {
      const cmdStr = String(cmd);
      if (cmdStr.includes('claude')) return Buffer.from('/usr/local/bin/claude');
      throw new Error('not found');
    });

    const config = ConfigSchema.parse({
      repo: 'owner/repo',
      stages: {
        implement: { agent: 'claude', model: 'opus' },
        review: { agent: 'codex', model: 'codex' },
        verify: { agent: 'codex', model: 'codex' },
      },
    });

    const result = checkAgents(config);
    expect(result.ok).toBe(false);

    const claudeResult = result.results.find(r => r.agent === 'claude');
    expect(claudeResult?.installed).toBe(true);
    // claude should be used for implement, fix, learn, aggregate (defaults) plus explicit implement
    expect(claudeResult?.stages).toContain('implement');

    const codexResult = result.results.find(r => r.agent === 'codex');
    expect(codexResult?.installed).toBe(false);
    expect(codexResult?.stages).toContain('review');
    expect(codexResult?.stages).toContain('verify');
  });

  it('returns ok=true when all agents are installed', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/agent'));

    const config = ConfigSchema.parse({ repo: 'owner/repo' });
    const result = checkAgents(config);
    expect(result.ok).toBe(true);
  });

  it('defaults all stages to claude when no stages config', () => {
    mockExecSync.mockReturnValue(Buffer.from('/usr/local/bin/claude'));

    const config = ConfigSchema.parse({ repo: 'owner/repo' });
    const result = checkAgents(config);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].agent).toBe('claude');
    expect(result.results[0].stages).toHaveLength(6); // all stages
  });

  it('reports affected stages when agent is missing', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not found'); });

    const config = ConfigSchema.parse({
      repo: 'owner/repo',
      stages: {
        review: { agent: 'codex' },
        verify: { agent: 'codex' },
      },
    });

    const result = checkAgents(config);
    const codexResult = result.results.find(r => r.agent === 'codex');
    expect(codexResult?.installed).toBe(false);
    expect(codexResult?.stages).toEqual(['review', 'verify']);
  });
});

describe('formatCheckResults', () => {
  it('formats installed agents with checkmark', () => {
    const output = formatCheckResults({
      ok: true,
      results: [
        { agent: 'claude', installed: true, stages: ['implement', 'fix', 'learn', 'aggregate'] },
      ],
    });
    expect(output).toContain('✓ claude');
    expect(output).toContain('implement, fix, learn, aggregate');
  });

  it('formats missing agents with X and error message', () => {
    const output = formatCheckResults({
      ok: false,
      results: [
        { agent: 'codex', installed: false, stages: ['review', 'verify'] },
      ],
    });
    expect(output).toContain('✗ codex');
    expect(output).toContain('Error: "codex" is not installed');
    expect(output).toContain('review, verify');
  });
});

describe('formatPipelineSummary', () => {
  it('shows per-stage configuration', () => {
    const config = ConfigSchema.parse({
      repo: 'owner/repo',
      model: 'opus',
      max_turns: 30,
      stages: {
        review: { agent: 'codex', model: 'codex' },
        verify: { agent: 'codex', model: 'codex' },
        learn: { agent: 'claude', model: 'opus', maxTurns: 5 },
      },
    });

    const output = formatPipelineSummary(config);
    expect(output).toContain('Pipeline:');
    expect(output).toContain('implement:');
    expect(output).toContain('claude/opus');
    expect(output).toContain('review:');
    expect(output).toContain('codex/codex');
    expect(output).toContain('learn:');
    expect(output).toContain('(5 turns)');
  });

  it('shows turns from global max_turns for stages without overrides', () => {
    const config = ConfigSchema.parse({
      repo: 'owner/repo',
      max_turns: 25,
    });

    const output = formatPipelineSummary(config);
    expect(output).toContain('(25 turns)');
  });
});
