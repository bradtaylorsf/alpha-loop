import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRepoPromptContext } from '../../src/lib/eval-runner.js';
import type { Config } from '../../src/lib/config.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-repo-prompt-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const makeConfig = (overrides?: Partial<Config>): Config => ({
  agent: 'claude',
  model: 'claude-sonnet-4-6',
  reviewModel: '',
  maxTestRetries: 2,
  testCommand: 'npm test',
  baseBranch: 'main',
  repo: 'test/repo',
  project: 'test',
  logDir: '.alpha-loop/logs',
  autoMerge: false,
  verbose: false,
  skipTests: false,
  skipReview: false,
  skipVerify: true,
  evalDir: '.alpha-loop/evals',
  evalModel: '',
  skipEval: false,
  evalTimeout: 300,
  autoCapture: true,
  skipPostSessionReview: false,
  skipPostSessionSecurity: false,
  batch: false,
  batchSize: 5,
  smokeTest: '',
    agentTimeout: 1800,
  pricing: {},
  pipeline: {},
  evalIncludeAgentPrompts: true,
  evalIncludeSkills: true,
    preferEpics: false,
  ...overrides,
} as Config);

describe('loadRepoPromptContext', () => {
  it('returns null context when no agent files exist', () => {
    const result = loadRepoPromptContext('review', tempDir, makeConfig());
    expect(result.agentPrompt).toBeNull();
    expect(result.skillsContext).toBeNull();
    expect(result.usingRepoPrompts).toBe(false);
  });

  it('loads agent prompt when reviewer.md exists', () => {
    const agentsDir = join(tempDir, '.alpha-loop', 'templates', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'reviewer.md'), '# Custom Reviewer\nCheck wiring.');

    const result = loadRepoPromptContext('review', tempDir, makeConfig());
    expect(result.agentPrompt).toBe('# Custom Reviewer\nCheck wiring.');
    expect(result.usingRepoPrompts).toBe(true);
  });

  it('loads implementer.md for implement step', () => {
    const agentsDir = join(tempDir, '.alpha-loop', 'templates', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'implementer.md'), '# Custom Implementer');

    const result = loadRepoPromptContext('implement', tempDir, makeConfig());
    expect(result.agentPrompt).toBe('# Custom Implementer');
    expect(result.usingRepoPrompts).toBe(true);
  });

  it('loads skills from skills directory', () => {
    const skillsDir = join(tempDir, '.alpha-loop', 'templates', 'skills');
    mkdirSync(join(skillsDir, 'test-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'test-skill', 'SKILL.md'), '# Test Skill\nDo testing.');

    const result = loadRepoPromptContext('review', tempDir, makeConfig());
    expect(result.skillsContext).toContain('## Skill: test-skill');
    expect(result.skillsContext).toContain('# Test Skill');
    expect(result.usingRepoPrompts).toBe(true);
  });

  it('loads multiple skills', () => {
    const skillsDir = join(tempDir, '.alpha-loop', 'templates', 'skills');
    mkdirSync(join(skillsDir, 'skill-a'), { recursive: true });
    writeFileSync(join(skillsDir, 'skill-a', 'SKILL.md'), '# Skill A');
    mkdirSync(join(skillsDir, 'skill-b'), { recursive: true });
    writeFileSync(join(skillsDir, 'skill-b', 'SKILL.md'), '# Skill B');

    const result = loadRepoPromptContext('review', tempDir, makeConfig());
    expect(result.skillsContext).toContain('## Skill: skill-a');
    expect(result.skillsContext).toContain('## Skill: skill-b');
  });

  it('respects evalIncludeAgentPrompts=false', () => {
    const agentsDir = join(tempDir, '.alpha-loop', 'templates', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'reviewer.md'), '# Custom Reviewer');

    const config = makeConfig({ evalIncludeAgentPrompts: false });
    const result = loadRepoPromptContext('review', tempDir, config);
    expect(result.agentPrompt).toBeNull();
  });

  it('respects evalIncludeSkills=false', () => {
    const skillsDir = join(tempDir, '.alpha-loop', 'templates', 'skills');
    mkdirSync(join(skillsDir, 'test-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'test-skill', 'SKILL.md'), '# Test Skill');

    const config = makeConfig({ evalIncludeSkills: false });
    const result = loadRepoPromptContext('review', tempDir, config);
    expect(result.skillsContext).toBeNull();
  });

  it('returns usingRepoPrompts=false when both disabled', () => {
    const agentsDir = join(tempDir, '.alpha-loop', 'templates', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'reviewer.md'), '# Custom Reviewer');

    const config = makeConfig({ evalIncludeAgentPrompts: false, evalIncludeSkills: false });
    const result = loadRepoPromptContext('review', tempDir, config);
    expect(result.agentPrompt).toBeNull();
    expect(result.skillsContext).toBeNull();
    expect(result.usingRepoPrompts).toBe(false);
  });

  it('maps test-fix step to implementer agent file', () => {
    const agentsDir = join(tempDir, '.alpha-loop', 'templates', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, 'implementer.md'), '# Implementer');

    const result = loadRepoPromptContext('test-fix', tempDir, makeConfig());
    expect(result.agentPrompt).toBe('# Implementer');
  });
});
