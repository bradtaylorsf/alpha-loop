import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSafePath,
  parseProposedChanges,
  appendEvolveLog,
  readEvolveLog,
  keepOrDiscard,
  SURFACE_TARGETS,
  EVOLVE_LOG_PATH,
} from '../../src/commands/evolve.js';
import type { EvolveLogEntry, SurfaceLevel } from '../../src/commands/evolve.js';

describe('evolve', () => {
  describe('isSafePath', () => {
    it('default surface (prompts) allows agent templates', () => {
      expect(isSafePath('.alpha-loop/templates/agents/implementer.md')).toBe(true);
    });

    it('default surface (prompts) rejects skills and yaml', () => {
      expect(isSafePath('.alpha-loop/templates/skills/my-skill.md')).toBe(false);
      expect(isSafePath('.alpha-loop.yaml')).toBe(false);
    });

    it('config surface allows skills, agents, and yaml', () => {
      expect(isSafePath('.alpha-loop/templates/skills/my-skill.md', 'config')).toBe(true);
      expect(isSafePath('.alpha-loop/templates/skills/sub/dir/file.md', 'config')).toBe(true);
      expect(isSafePath('.alpha-loop/templates/agents/implementer.md', 'config')).toBe(true);
      expect(isSafePath('.alpha-loop.yaml', 'config')).toBe(true);
    });

    it('rejects .alpha-loop.yaml with suffix (prefix bypass)', () => {
      expect(isSafePath('.alpha-loop.yaml-evil', 'config')).toBe(false);
      expect(isSafePath('.alpha-loop.yaml.bak', 'config')).toBe(false);
      expect(isSafePath('.alpha-loop.yamlFoo', 'config')).toBe(false);
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

  describe('isSafePath with surface levels', () => {
    it('prompts surface only allows agent templates', () => {
      expect(isSafePath('.alpha-loop/templates/agents/implementer.md', 'prompts')).toBe(true);
      expect(isSafePath('.alpha-loop/templates/skills/test.md', 'prompts')).toBe(false);
      expect(isSafePath('.alpha-loop.yaml', 'prompts')).toBe(false);
      expect(isSafePath('src/lib/prompts.ts', 'prompts')).toBe(false);
    });

    it('skills surface allows agents and skills', () => {
      expect(isSafePath('.alpha-loop/templates/agents/implementer.md', 'skills')).toBe(true);
      expect(isSafePath('.alpha-loop/templates/skills/test.md', 'skills')).toBe(true);
      expect(isSafePath('.alpha-loop.yaml', 'skills')).toBe(false);
      expect(isSafePath('src/lib/prompts.ts', 'skills')).toBe(false);
    });

    it('config surface allows agents, skills, and yaml', () => {
      expect(isSafePath('.alpha-loop/templates/agents/implementer.md', 'config')).toBe(true);
      expect(isSafePath('.alpha-loop/templates/skills/test.md', 'config')).toBe(true);
      expect(isSafePath('.alpha-loop.yaml', 'config')).toBe(true);
      expect(isSafePath('src/lib/prompts.ts', 'config')).toBe(false);
    });

    it('all surface allows everything including source code', () => {
      expect(isSafePath('.alpha-loop/templates/agents/implementer.md', 'all')).toBe(true);
      expect(isSafePath('.alpha-loop/templates/skills/test.md', 'all')).toBe(true);
      expect(isSafePath('.alpha-loop.yaml', 'all')).toBe(true);
      expect(isSafePath('src/lib/prompts.ts', 'all')).toBe(true);
      expect(isSafePath('src/lib/pipeline.ts', 'all')).toBe(true);
      // But still rejects other source files
      expect(isSafePath('src/lib/config.ts', 'all')).toBe(false);
      expect(isSafePath('package.json', 'all')).toBe(false);
    });

    it('all surface levels reject path traversal', () => {
      const surfaces: SurfaceLevel[] = ['prompts', 'skills', 'config', 'all'];
      for (const surface of surfaces) {
        expect(isSafePath('../etc/passwd', surface)).toBe(false);
        expect(isSafePath('/etc/passwd', surface)).toBe(false);
      }
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

  describe('appendEvolveLog / readEvolveLog', () => {
    const tmpDir = join(process.cwd(), '.test-evolve-log-' + process.pid);

    beforeEach(() => {
      mkdirSync(join(tmpDir, '.alpha-loop', 'evals'), { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates log file with header on first write', () => {
      const entry: EvolveLogEntry = {
        commit: 'abc1234',
        score: 72.5,
        cost: 4.20,
        status: 'baseline',
        iteration: 0,
        description: 'initial eval',
      };

      appendEvolveLog(entry, tmpDir);

      const logPath = join(tmpDir, EVOLVE_LOG_PATH);
      expect(existsSync(logPath)).toBe(true);

      const content = readFileSync(logPath, 'utf-8');
      expect(content).toContain('commit\tscore\tcost\tstatus\titeration\tdescription');
      expect(content).toContain('abc1234');
    });

    it('round-trips entries correctly', () => {
      const entries: EvolveLogEntry[] = [
        { commit: 'abc1234', score: 72.5, cost: 4.20, status: 'baseline', iteration: 0, description: 'initial eval' },
        { commit: 'bcd2345', score: 74.1, cost: 4.15, status: 'keep', iteration: 1, description: 'add module check' },
        { commit: 'cde3456', score: 71.8, cost: 3.90, status: 'discard', iteration: 2, description: 'regressed' },
        { commit: 'def4567', score: 70.0, cost: 0, status: 'crash', iteration: 3, description: 'compile failed' },
      ];

      for (const entry of entries) {
        appendEvolveLog(entry, tmpDir);
      }

      const result = readEvolveLog(tmpDir);
      expect(result).toHaveLength(4);

      expect(result[0].commit).toBe('abc1234');
      expect(result[0].score).toBeCloseTo(72.5);
      expect(result[0].cost).toBeCloseTo(4.20);
      expect(result[0].status).toBe('baseline');
      expect(result[0].iteration).toBe(0);
      expect(result[0].description).toBe('initial eval');

      expect(result[1].status).toBe('keep');
      expect(result[2].status).toBe('discard');
      expect(result[3].status).toBe('crash');
    });

    it('returns empty array when log does not exist', () => {
      const result = readEvolveLog(join(tmpDir, 'nonexistent'));
      expect(result).toEqual([]);
    });
  });

  describe('keepOrDiscard', () => {
    it('keeps when new score is higher', () => {
      expect(keepOrDiscard(80.0, 75.0)).toBe('keep');
    });

    it('discards when new score equals best', () => {
      expect(keepOrDiscard(75.0, 75.0)).toBe('discard');
    });

    it('discards when new score is lower', () => {
      expect(keepOrDiscard(70.0, 75.0)).toBe('discard');
    });

    it('keeps even for small improvements', () => {
      expect(keepOrDiscard(75.01, 75.0)).toBe('keep');
    });
  });

  describe('SURFACE_TARGETS', () => {
    it('prompts is a subset of skills', () => {
      for (const target of SURFACE_TARGETS.prompts) {
        expect(SURFACE_TARGETS.skills).toContain(target);
      }
    });

    it('skills is a subset of config', () => {
      for (const target of SURFACE_TARGETS.skills) {
        expect(SURFACE_TARGETS.config).toContain(target);
      }
    });

    it('config is a subset of all', () => {
      for (const target of SURFACE_TARGETS.config) {
        expect(SURFACE_TARGETS.all).toContain(target);
      }
    });

    it('all includes source code files', () => {
      expect(SURFACE_TARGETS.all).toContain('src/lib/prompts.ts');
      expect(SURFACE_TARGETS.all).toContain('src/lib/pipeline.ts');
    });
  });
});
