import { buildAgentArgs, buildEndpointEnv, AGENT_CLI_MAP } from '../../src/engine/agents.js';
import type { RoutingEndpoint } from '../../src/lib/config.js';

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

  describe('lmstudio', () => {
    it('delegates to the claude CLI with claude-compatible args', () => {
      const result = buildAgentArgs({ agent: 'lmstudio', model: 'qwen3-coder-30b-a3b' }, prompt);
      expect(result.command).toBe('claude');
      expect(result.args).toEqual([
        '--model', 'qwen3-coder-30b-a3b',
        '--dangerously-skip-permissions',
        '-p', prompt,
      ]);
    });

    it('supports --max-turns because it delegates to claude', () => {
      const result = buildAgentArgs({ agent: 'lmstudio', model: 'qwen', maxTurns: 12 }, prompt);
      expect(result.args).toContain('--max-turns');
      expect(result.args).toContain('12');
    });
  });

  describe('ollama', () => {
    it('delegates to the codex CLI with codex-compatible args', () => {
      const result = buildAgentArgs({ agent: 'ollama', model: 'llama3.1:70b' }, prompt);
      expect(result.command).toBe('codex');
      expect(result.args).toEqual([
        'exec',
        '--model', 'llama3.1:70b',
        '--full-auto',
        prompt,
      ]);
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
  it('has entries for claude, codex, opencode, lmstudio, and ollama', () => {
    expect(AGENT_CLI_MAP).toHaveProperty('claude');
    expect(AGENT_CLI_MAP).toHaveProperty('codex');
    expect(AGENT_CLI_MAP).toHaveProperty('opencode');
    expect(AGENT_CLI_MAP).toHaveProperty('lmstudio');
    expect(AGENT_CLI_MAP).toHaveProperty('ollama');
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

  it('lmstudio uses the claude CLI (Anthropic-compatible)', () => {
    expect(AGENT_CLI_MAP.lmstudio.command).toBe('claude');
    expect(AGENT_CLI_MAP.lmstudio.isSubcommand).toBe(false);
    expect(AGENT_CLI_MAP.lmstudio.supportsMaxTurns).toBe(true);
  });

  it('ollama uses the codex CLI (OpenAI-compatible)', () => {
    expect(AGENT_CLI_MAP.ollama.command).toBe('codex');
    expect(AGENT_CLI_MAP.ollama.isSubcommand).toBe(true);
  });
});

describe('buildEndpointEnv', () => {
  it('sets ANTHROPIC_BASE_URL/ANTHROPIC_MODEL for anthropic endpoints', () => {
    const endpoint: RoutingEndpoint = { type: 'anthropic', base_url: 'https://api.anthropic.com' };
    const env = buildEndpointEnv(endpoint, 'claude-opus-4-7');
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'claude-opus-4-7',
    });
  });

  it('sets ANTHROPIC_BASE_URL/ANTHROPIC_MODEL for anthropic_compat endpoints', () => {
    const endpoint: RoutingEndpoint = { type: 'anthropic_compat', base_url: 'http://localhost:1234' };
    const env = buildEndpointEnv(endpoint, 'qwen3-coder-30b-a3b');
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'http://localhost:1234',
      ANTHROPIC_MODEL: 'qwen3-coder-30b-a3b',
    });
  });

  it('sets OPENAI_BASE_URL/OPENAI_MODEL for openai_compat endpoints', () => {
    const endpoint: RoutingEndpoint = { type: 'openai_compat', base_url: 'http://localhost:11434/v1' };
    const env = buildEndpointEnv(endpoint, 'llama3.1:70b');
    expect(env).toEqual({
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      OPENAI_MODEL: 'llama3.1:70b',
    });
  });

  it('omits *_MODEL when model is empty', () => {
    const endpoint: RoutingEndpoint = { type: 'anthropic_compat', base_url: 'http://localhost:1234' };
    const env = buildEndpointEnv(endpoint, '');
    expect(env).toEqual({ ANTHROPIC_BASE_URL: 'http://localhost:1234' });
  });
});
