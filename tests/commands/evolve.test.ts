import { isSafePath, parseProposedChanges } from '../../src/commands/evolve.js';

describe('evolve', () => {
  describe('isSafePath', () => {
    it('allows paths under .alpha-loop/templates/skills/', () => {
      expect(isSafePath('.alpha-loop/templates/skills/my-skill.md')).toBe(true);
      expect(isSafePath('.alpha-loop/templates/skills/sub/dir/file.md')).toBe(true);
    });

    it('allows paths under .alpha-loop/templates/agents/', () => {
      expect(isSafePath('.alpha-loop/templates/agents/implementer.md')).toBe(true);
    });

    it('allows exact match for .alpha-loop.yaml', () => {
      expect(isSafePath('.alpha-loop.yaml')).toBe(true);
    });

    it('rejects .alpha-loop.yaml with suffix (prefix bypass)', () => {
      expect(isSafePath('.alpha-loop.yaml-evil')).toBe(false);
      expect(isSafePath('.alpha-loop.yaml.bak')).toBe(false);
      expect(isSafePath('.alpha-loop.yamlFoo')).toBe(false);
    });

    it('rejects absolute paths', () => {
      expect(isSafePath('/etc/passwd')).toBe(false);
      expect(isSafePath('/Users/foo/.alpha-loop/templates/skills/x.md')).toBe(false);
    });

    it('rejects path traversal', () => {
      expect(isSafePath('../secret.txt')).toBe(false);
      expect(isSafePath('.alpha-loop/templates/../../etc/passwd')).toBe(false);
    });

    it('rejects paths outside allowed targets', () => {
      expect(isSafePath('src/index.ts')).toBe(false);
      expect(isSafePath('package.json')).toBe(false);
      expect(isSafePath('.claude/settings.json')).toBe(false);
    });
  });

  describe('parseProposedChanges', () => {
    it('parses valid JSON array', () => {
      const output = `Here are my changes:\n\`\`\`json\n[{"path": "a.md", "content": "hello", "reason": "test"}]\n\`\`\``;
      const result = parseProposedChanges(output);
      expect(result).toEqual([{ path: 'a.md', content: 'hello', reason: 'test' }]);
    });

    it('parses JSON array without fenced code block', () => {
      const output = 'Some text [{"path": "b.md", "content": "world", "reason": "test2"}] more text';
      const result = parseProposedChanges(output);
      expect(result).toEqual([{ path: 'b.md', content: 'world', reason: 'test2' }]);
    });

    it('returns empty array when no JSON found', () => {
      expect(parseProposedChanges('no json here')).toEqual([]);
      expect(parseProposedChanges('')).toEqual([]);
    });

    it('returns empty array for invalid JSON', () => {
      const output = '[not valid json}';
      expect(parseProposedChanges(output)).toEqual([]);
    });

    it('filters out entries missing path or content', () => {
      const output = '[{"path": "a.md"}, {"content": "x"}, {"path": "b.md", "content": "y"}]';
      const result = parseProposedChanges(output);
      expect(result).toEqual([{ path: 'b.md', content: 'y', reason: 'No reason given' }]);
    });

    it('defaults reason to "No reason given"', () => {
      const output = '[{"path": "a.md", "content": "hello"}]';
      const result = parseProposedChanges(output);
      expect(result[0].reason).toBe('No reason given');
    });

    it('prefers fenced code block over random brackets in text', () => {
      const output = 'See [1] for details.\n\n```json\n[{"path": "real.md", "content": "data", "reason": "fix"}]\n```';
      const result = parseProposedChanges(output);
      expect(result).toEqual([{ path: 'real.md', content: 'data', reason: 'fix' }]);
    });
  });
});
