/**
 * Eval Export — export eval cases for contribution to the alpha-loop project.
 *
 * Supports anonymizing project-specific details, generating prompt change diffs,
 * and preparing contribution-ready directories.
 */
import { existsSync, readFileSync, realpathSync, mkdirSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { log } from './logger.js';
import { detectRepo } from './config.js';
import { findDistributionTemplatesDir } from './templates.js';

export type ExportOptions = {
  anonymize?: boolean;
  outputDir?: string;
  pr?: boolean;
};

export type ExportResult = {
  outputDir: string;
  caseId: string;
  anonymized: boolean;
  promptChangesPath?: string;
};

/**
 * Anonymize project-specific details from eval case content.
 * Replaces repo-specific paths and identifiers with generic equivalents.
 */
export function anonymizeContent(content: string, projectDir: string): string {
  let result = content;

  // Replace absolute paths FIRST (before repo name replacement which could corrupt paths)
  const projectDirEscaped = escapeRegex(projectDir);
  result = result.replace(new RegExp(projectDirEscaped, 'g'), '/project');
  try {
    const resolved = realpathSync(projectDir);
    if (resolved !== projectDir) {
      result = result.replace(new RegExp(escapeRegex(resolved), 'g'), '/project');
    }
  } catch { /* non-fatal — if path doesn't exist, skip resolved variant */ }

  // Replace git remote repo references (e.g., owner/repo-name)
  const repo = detectRepo();
  if (repo) {
    const [owner, repoName] = repo.split('/');
    if (owner && repoName) {
      result = result.replace(new RegExp(escapeRegex(repo), 'g'), 'example-org/example-project');
      result = result.replace(new RegExp(escapeRegex(owner), 'g'), 'example-org');
      result = result.replace(new RegExp(escapeRegex(repoName), 'g'), 'example-project');
    }
  }

  // Replace common project-specific path prefixes
  result = result.replace(/\/Users\/[a-zA-Z0-9_.-]+\//g, '/home/user/');
  result = result.replace(/\/home\/[a-zA-Z0-9_.-]+\//g, '/home/user/');
  result = result.replace(/C:\\Users\\[a-zA-Z0-9_.-]+\\/g, 'C:\\Users\\user\\');

  return result;
}

/** Escape a string for use in a RegExp. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Export an eval case from the project in a format ready for contributing.
 * Copies case files to the output directory, optionally anonymizing content.
 */
export function exportEvalCase(
  caseId: string,
  projectDir: string,
  options: ExportOptions = {},
): ExportResult {
  const anonymize = options.anonymize !== false;
  const outputDir = options.outputDir ?? join(projectDir, '.alpha-loop-contrib');

  // Find the case directory
  const evalsDir = join(projectDir, '.alpha-loop', 'evals', 'cases');
  const casePath = findCasePath(evalsDir, caseId);
  if (!casePath) {
    throw new Error(`Eval case not found: ${caseId}. Check .alpha-loop/evals/cases/`);
  }

  // Create output directory structure
  const relPath = relative(join(projectDir, '.alpha-loop', 'evals', 'cases'), casePath);
  const destDir = join(outputDir, 'evals', 'cases', relPath);
  mkdirSync(destDir, { recursive: true });

  // Copy and optionally anonymize case files
  const files = readdirSync(casePath).filter((f) => !f.startsWith('.'));
  for (const file of files) {
    const srcFile = join(casePath, file);
    const destFile = join(destDir, file);
    const content = readFileSync(srcFile, 'utf-8');
    const processed = anonymize ? anonymizeContent(content, projectDir) : content;
    writeFileSync(destFile, processed);
  }

  // Generate prompt changes if local prompts differ from distribution
  let promptChangesPath: string | undefined;
  const promptChanges = generatePromptChanges(projectDir);
  if (promptChanges) {
    const pcPath = join(outputDir, 'PROMPT_CHANGES.md');
    writeFileSync(pcPath, promptChanges);
    promptChangesPath = pcPath;
  }

  return {
    outputDir: destDir,
    caseId,
    anonymized: anonymize,
    promptChangesPath,
  };
}

/**
 * Find a case directory by ID, searching through step/ and e2e/ subdirectories.
 */
function findCasePath(evalsDir: string, caseId: string): string | null {
  if (!existsSync(evalsDir)) return null;

  // Check step cases
  const stepDir = join(evalsDir, 'step');
  if (existsSync(stepDir)) {
    const stepTypes = readdirSync(stepDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const stepType of stepTypes) {
      const candidate = join(stepDir, stepType.name, caseId);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Check e2e cases
  const e2eDir = join(evalsDir, 'e2e');
  if (existsSync(e2eDir)) {
    const candidate = join(e2eDir, caseId);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Generate a PROMPT_CHANGES.md documenting differences between project prompts
 * and distribution templates.
 */
export function generatePromptChanges(projectDir: string): string | null {
  const distDir = findDistributionTemplatesDir();
  if (!distDir) return null;

  const sections: string[] = [];

  // Compare agent prompts
  const distAgentsDir = join(distDir, 'agents');
  const projectAgentsDir = join(projectDir, '.alpha-loop', 'templates', 'agents');

  if (existsSync(projectAgentsDir) && existsSync(distAgentsDir)) {
    const agentFiles = readdirSync(projectAgentsDir).filter((f) => f.endsWith('.md'));
    for (const file of agentFiles) {
      const distFile = join(distAgentsDir, file);
      const projectFile = join(projectAgentsDir, file);
      if (existsSync(distFile)) {
        const distContent = readFileSync(distFile, 'utf-8');
        const projectContent = readFileSync(projectFile, 'utf-8');
        if (distContent !== projectContent) {
          sections.push(
            `## Agent: ${file}`,
            '',
            'Project version differs from distribution. Key changes:',
            '',
            '```diff',
            simpleDiff(distContent, projectContent),
            '```',
            '',
          );
        }
      }
    }
  }

  // Compare skills
  const distSkillsDir = join(distDir, 'skills');
  const projectSkillsDir = join(projectDir, '.alpha-loop', 'templates', 'skills');

  if (existsSync(projectSkillsDir) && existsSync(distSkillsDir)) {
    const skillDirs = readdirSync(projectSkillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const dir of skillDirs) {
      const distSkill = join(distSkillsDir, dir.name, 'SKILL.md');
      const projectSkill = join(projectSkillsDir, dir.name, 'SKILL.md');
      if (existsSync(distSkill) && existsSync(projectSkill)) {
        const distContent = readFileSync(distSkill, 'utf-8');
        const projectContent = readFileSync(projectSkill, 'utf-8');
        if (distContent !== projectContent) {
          sections.push(
            `## Skill: ${dir.name}`,
            '',
            'Project version differs from distribution.',
            '',
          );
        }
      } else if (!existsSync(distSkill) && existsSync(projectSkill)) {
        sections.push(
          `## Skill: ${dir.name} (NEW)`,
          '',
          'This skill exists only in the project, not in distribution.',
          '',
        );
      }
    }
  }

  if (sections.length === 0) return null;

  return [
    '# Prompt Changes',
    '',
    'This file documents differences between the project\'s local prompts/skills',
    'and the distribution versions shipped with alpha-loop.',
    '',
    ...sections,
  ].join('\n');
}

/**
 * Simple line-by-line diff (not a full unified diff, but good enough for review).
 */
function simpleDiff(distContent: string, projectContent: string): string {
  const distLines = distContent.split('\n');
  const projectLines = projectContent.split('\n');
  const result: string[] = [];

  // Show lines unique to project (additions) and dist (removals)
  const distSet = new Set(distLines);
  const projectSet = new Set(projectLines);

  for (const line of distLines) {
    if (!projectSet.has(line)) {
      result.push(`- ${line}`);
    }
  }
  for (const line of projectLines) {
    if (!distSet.has(line)) {
      result.push(`+ ${line}`);
    }
  }

  // Limit output
  if (result.length > 50) {
    return result.slice(0, 50).join('\n') + `\n... (${result.length - 50} more lines)`;
  }

  return result.join('\n');
}
