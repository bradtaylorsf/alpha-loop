/**
 * Templates — shared utilities for locating distribution templates
 * and comparing project skills against them.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Find the distribution templates directory shipped with the alpha-loop npm package.
 * Walks up from the CLI entrypoint, following symlinks for global installs.
 */
export function findDistributionTemplatesDir(): string | null {
  let startDir: string;
  try {
    startDir = dirname(realpathSync(process.argv[1]));
  } catch {
    startDir = process.cwd();
  }

  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'templates');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export type SkillDiff = {
  name: string;
  status: 'new' | 'updated';
  distContent: string;
  projectContent?: string;
};

/**
 * Compare project skills against distribution templates.
 * Returns skills that are new or have changed content.
 */
export function diffSkills(distSkillsDir: string, projectSkillsDir: string): SkillDiff[] {
  if (!existsSync(distSkillsDir)) return [];

  const diffs: SkillDiff[] = [];
  const distSkills = readdirSync(distSkillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const entry of distSkills) {
    const distSkillFile = join(distSkillsDir, entry.name, 'SKILL.md');
    if (!existsSync(distSkillFile)) continue;

    const distContent = readFileSync(distSkillFile, 'utf-8');
    const projectSkillFile = join(projectSkillsDir, entry.name, 'SKILL.md');

    if (!existsSync(projectSkillFile)) {
      diffs.push({ name: entry.name, status: 'new', distContent });
    } else {
      const projectContent = readFileSync(projectSkillFile, 'utf-8');
      if (projectContent !== distContent) {
        diffs.push({ name: entry.name, status: 'updated', distContent, projectContent });
      }
    }
  }

  return diffs;
}
