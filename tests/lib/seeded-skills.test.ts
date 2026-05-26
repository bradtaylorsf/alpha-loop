import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('seeded alpha-loop-runner skill', () => {
  const repoRoot = process.cwd();
  const distSkillPath = join(repoRoot, 'templates', 'skills', 'alpha-loop-runner', 'SKILL.md');
  const projectSkillPath = join(repoRoot, '.alpha-loop', 'templates', 'skills', 'alpha-loop-runner', 'SKILL.md');

  it('exists in distribution and repo-local templates with autoload frontmatter', () => {
    expect(existsSync(distSkillPath)).toBe(true);
    expect(existsSync(projectSkillPath)).toBe(true);

    const distSkill = readFileSync(distSkillPath, 'utf-8');
    const projectSkill = readFileSync(projectSkillPath, 'utf-8');

    expect(projectSkill).toBe(distSkill);
    expect(distSkill).toMatch(/^name: alpha-loop-runner$/m);
    expect(distSkill).toMatch(/^auto_load: true$/m);
    expect(distSkill).toMatch(/^priority: high$/m);
    expect(distSkill).toContain('## Trigger');
    expect(distSkill).toContain('## Command Resolution');
    expect(distSkill).toContain('## Pre-Flight Checks');
    expect(distSkill).toContain('## Skill Sync Source Of Truth');
    expect(distSkill).toContain('## Running An Epic');
    expect(distSkill).toContain('## Stop Conditions');
    expect(distSkill).toContain('## Learning-File Guarantee');
    expect(distSkill).toContain('## Completion Validation');
    expect(distSkill).toContain('## Repo-Specific Posture');
  });
});
