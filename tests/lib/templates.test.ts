import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diffSkills, diffAgents } from '../../src/lib/templates';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `templates-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('diffSkills', () => {
  it('returns empty when dist dir does not exist', () => {
    const result = diffSkills('/nonexistent', '/also-nonexistent');
    expect(result).toEqual([]);
  });

  it('detects new skills not in project', () => {
    const dir = makeTmpDir();
    const dist = join(dir, 'dist-skills');
    const project = join(dir, 'project-skills');

    mkdirSync(join(dist, 'new-skill'), { recursive: true });
    writeFileSync(join(dist, 'new-skill', 'SKILL.md'), '# New Skill');
    mkdirSync(project, { recursive: true });

    const result = diffSkills(dist, project);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('new-skill');
    expect(result[0].status).toBe('new');
    expect(result[0].distContent).toBe('# New Skill');

    rmSync(dir, { recursive: true, force: true });
  });

  it('detects updated skills with different content', () => {
    const dir = makeTmpDir();
    const dist = join(dir, 'dist-skills');
    const project = join(dir, 'project-skills');

    mkdirSync(join(dist, 'my-skill'), { recursive: true });
    writeFileSync(join(dist, 'my-skill', 'SKILL.md'), '# Version 2');

    mkdirSync(join(project, 'my-skill'), { recursive: true });
    writeFileSync(join(project, 'my-skill', 'SKILL.md'), '# Version 1');

    const result = diffSkills(dist, project);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-skill');
    expect(result[0].status).toBe('updated');
    expect(result[0].projectContent).toBe('# Version 1');

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when skills are identical', () => {
    const dir = makeTmpDir();
    const dist = join(dir, 'dist-skills');
    const project = join(dir, 'project-skills');

    mkdirSync(join(dist, 'same-skill'), { recursive: true });
    writeFileSync(join(dist, 'same-skill', 'SKILL.md'), '# Same');

    mkdirSync(join(project, 'same-skill'), { recursive: true });
    writeFileSync(join(project, 'same-skill', 'SKILL.md'), '# Same');

    const result = diffSkills(dist, project);
    expect(result).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('skips directories without SKILL.md', () => {
    const dir = makeTmpDir();
    const dist = join(dir, 'dist-skills');
    const project = join(dir, 'project-skills');

    mkdirSync(join(dist, 'no-skill-file'), { recursive: true });
    // No SKILL.md written
    mkdirSync(project, { recursive: true });

    const result = diffSkills(dist, project);
    expect(result).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('diffAgents', () => {
  it('returns empty when dist dir does not exist', () => {
    const result = diffAgents('/nonexistent', '/also-nonexistent');
    expect(result).toEqual([]);
  });

  it('detects new agent prompts not in project', () => {
    const dir = makeTmpDir();
    const dist = join(dir, 'dist-agents');
    const project = join(dir, 'project-agents');

    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'reviewer.md'), '# Reviewer v2');
    mkdirSync(project, { recursive: true });

    const result = diffAgents(dist, project);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('reviewer');
    expect(result[0].status).toBe('new');
    expect(result[0].distContent).toBe('# Reviewer v2');

    rmSync(dir, { recursive: true, force: true });
  });

  it('detects updated agent prompts with different content', () => {
    const dir = makeTmpDir();
    const dist = join(dir, 'dist-agents');
    const project = join(dir, 'project-agents');

    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'implementer.md'), '# Implementer v2');

    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'implementer.md'), '# Implementer v1');

    const result = diffAgents(dist, project);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('implementer');
    expect(result[0].status).toBe('updated');
    expect(result[0].distContent).toBe('# Implementer v2');
    expect(result[0].projectContent).toBe('# Implementer v1');

    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty when agents are identical', () => {
    const dir = makeTmpDir();
    const dist = join(dir, 'dist-agents');
    const project = join(dir, 'project-agents');

    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'reviewer.md'), '# Same content');

    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'reviewer.md'), '# Same content');

    const result = diffAgents(dist, project);
    expect(result).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('skips non-markdown files', () => {
    const dir = makeTmpDir();
    const dist = join(dir, 'dist-agents');
    const project = join(dir, 'project-agents');

    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'config.yaml'), 'key: value');
    mkdirSync(project, { recursive: true });

    const result = diffAgents(dist, project);
    expect(result).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });
});
