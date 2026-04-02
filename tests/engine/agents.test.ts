import { buildAgentArgs, AGENT_CLI_MAP } from '../../src/engine/agents.js';

describe('buildAgentArgs', () => {
  const prompt = 'Implement feature X';

  describe('claude', () => {
    it('constructs correct CLI args', () => {
      const result = buildAgentArgs({ agent: 'claude', model: 'opus' }, prompt);
      expect(result.command).toBe('claude');
      expect(result.args).toEqual([
        '--model', 'opus',
        '--dangerously-skip-permissions',
        '-p', prompt,
      ]);
    });

    it('includes --max-turns when maxTurns is provided', () => {
      const result = buildAgentArgs({ agent: 'claude', model: 'opus', maxTurns: 30 }, prompt);
      expect(result.args).toContain('--max-turns');
      expect(result.args).toContain('30');
    });

    it('omits --max-turns when maxTurns is not provided', () => {
      const result = buildAgentArgs({ agent: 'claude', model: 'opus' }, prompt);
      expect(result.args).not.toContain('--max-turns');
    });
  });

  describe('codex', () => {
    it('constructs correct CLI args', () => {
      const result = buildAgentArgs({ agent: 'codex', model: 'codex' }, prompt);
      expect(result.command).toBe('codex');
      expect(result.args).toEqual([
        'exec',
        '--model', 'codex',
        '--full-auto',
        prompt,
      ]);
    });

    it('does not include --max-turns even when maxTurns is provided', () => {
      const result = buildAgentArgs({ agent: 'codex', model: 'codex', maxTurns: 20 }, prompt);
      expect(result.args).not.toContain('--max-turns');
    });
  });

  describe('opencode', () => {
    it('constructs correct CLI args', () => {
      const result = buildAgentArgs({ agent: 'opencode', model: 'gpt-4' }, prompt);
      expect(result.command).toBe('opencode');
      expect(result.args).toEqual([
        'run',
        '--model', 'gpt-4',
        prompt,
      ]);
    });

    it('does not include permission flags', () => {
      const result = buildAgentArgs({ agent: 'opencode', model: 'gpt-4' }, prompt);
      expect(result.args).not.toContain('--dangerously-skip-permissions');
      expect(result.args).not.toContain('--auto-edit');
    });

    it('does not include --max-turns even when provided', () => {
      const result = buildAgentArgs({ agent: 'opencode', model: 'gpt-4', maxTurns: 10 }, prompt);
      expect(result.args).not.toContain('--max-turns');
    });
  });

  describe('model omission', () => {
    it('omits --model when model is empty', () => {
      const result = buildAgentArgs({ agent: 'claude', model: '' }, prompt);
      expect(result.args).not.toContain('--model');
    });
  });

  describe('unknown agent', () => {
    it('throws a descriptive error for unknown agent types', () => {
      expect(() => buildAgentArgs({ agent: 'unknown-agent', model: 'foo' }, prompt))
        .toThrow(/Unknown agent type: "unknown-agent"/);
    });

    it('lists supported agents in error message', () => {
      expect(() => buildAgentArgs({ agent: 'bad', model: 'foo' }, prompt))
        .toThrow(/claude, codex, opencode/);
    });
  });
});

describe('AGENT_CLI_MAP', () => {
  it('has entries for claude, codex, and opencode', () => {
    expect(AGENT_CLI_MAP).toHaveProperty('claude');
    expect(AGENT_CLI_MAP).toHaveProperty('codex');
    expect(AGENT_CLI_MAP).toHaveProperty('opencode');
  });

  it('claude supports maxTurns', () => {
    expect(AGENT_CLI_MAP.claude.supportsMaxTurns).toBe(true);
  });

  it('codex does not support maxTurns', () => {
    expect(AGENT_CLI_MAP.codex.supportsMaxTurns).toBe(false);
  });

  it('opencode does not support maxTurns', () => {
    expect(AGENT_CLI_MAP.opencode.supportsMaxTurns).toBe(false);
  });
});
