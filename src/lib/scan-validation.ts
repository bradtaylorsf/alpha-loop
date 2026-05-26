import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANAGED_INSTRUCTIONS_MARKER = '<!-- managed by alpha-loop -->';

type ValidationResult = {
  valid: boolean;
  reason?: string;
};

type GeneratedFileValidation = {
  valid: boolean;
  errors: string[];
};

const CONTEXT_HEADINGS = [
  '## Architecture',
  '## Conventions',
  '## Critical Rules',
  '## Active State',
];

const INSTRUCTIONS_HEADINGS = [
  '## Overview',
  '## Tech Stack',
  '## Directory Structure',
  '## Code Style',
  '## Non-Negotiables',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasHeading(content: string, heading: string): boolean {
  return new RegExp(`^${escapeRegExp(heading)}\\s*$`, 'm').test(content);
}

function firstNonEmptyLine(content: string): string {
  return content.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
}

function looksLikeAgentStatusSummary(content: string): boolean {
  const firstLine = firstNonEmptyLine(content).toLowerCase();
  return [
    /^i (wrote|updated|created|generated)\b/,
    /^(wrote|updated|created|generated)\s+[`'"]?[^`'"]*\.md\b/,
    /^(updated|created)\s+(claude|agents|project|context|instructions)\b/,
  ].some((pattern) => pattern.test(firstLine));
}

function validateRequiredHeadings(content: string, headings: string[]): string | null {
  const missing = headings.filter((heading) => !hasHeading(content, heading));
  if (missing.length > 0) {
    return `missing required heading(s): ${missing.join(', ')}`;
  }
  return null;
}

export function validateProjectContextMarkdown(content: string): ValidationResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return { valid: false, reason: 'empty output' };
  }
  if (looksLikeAgentStatusSummary(trimmed)) {
    return { valid: false, reason: 'output looks like an agent status summary, not markdown content' };
  }

  const headingError = validateRequiredHeadings(trimmed, CONTEXT_HEADINGS);
  if (headingError) {
    return { valid: false, reason: headingError };
  }

  return { valid: true };
}

export function validateInstructionsMarkdown(content: string): ValidationResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return { valid: false, reason: 'empty output' };
  }
  if (looksLikeAgentStatusSummary(trimmed)) {
    return { valid: false, reason: 'output looks like an agent status summary, not markdown content' };
  }
  if (!content.replace(/^\uFEFF/, '').startsWith(MANAGED_INSTRUCTIONS_MARKER)) {
    return { valid: false, reason: 'missing managed marker on first line' };
  }

  const headingError = validateRequiredHeadings(trimmed, INSTRUCTIONS_HEADINGS);
  if (headingError) {
    return { valid: false, reason: headingError };
  }

  return { valid: true };
}

export function excerptForLog(content: string, maxLength = 220): string {
  const excerpt = content.trim().replace(/\s+/g, ' ');
  if (!excerpt) return '(empty output)';
  return excerpt.length > maxLength ? `${excerpt.slice(0, maxLength)}...` : excerpt;
}

function statusIncludesPath(statusOutput: string, relPath: string): boolean {
  return statusOutput.split(/\r?\n/).some((line) => {
    if (line.trim().length === 0) return false;
    const pathPart = line.slice(3).trim().replace(/\/$/, '');
    return pathPart === relPath || pathPart.startsWith(`${relPath}/`) || relPath.startsWith(`${pathPart}/`);
  });
}

function shouldValidateGeneratedFile(statusOutput: string, relPath: string): boolean {
  return !statusOutput.trim() || statusIncludesPath(statusOutput, relPath);
}

export function validateGeneratedMarkdownForCommit(
  projectDir: string,
  statusOutput = '',
): GeneratedFileValidation {
  const errors: string[] = [];

  const contextRelPath = '.alpha-loop/context.md';
  const contextPath = join(projectDir, contextRelPath);
  if (shouldValidateGeneratedFile(statusOutput, contextRelPath) && existsSync(contextPath)) {
    const contextValidation = validateProjectContextMarkdown(readFileSync(contextPath, 'utf-8'));
    if (!contextValidation.valid) {
      errors.push(`${contextRelPath}: ${contextValidation.reason ?? 'invalid generated context'}`);
    }
  }

  const instructionsRelPaths = [
    '.alpha-loop/templates/instructions.md',
    'CLAUDE.md',
    'AGENTS.md',
  ];

  for (const relPath of instructionsRelPaths) {
    const filePath = join(projectDir, relPath);
    if (!shouldValidateGeneratedFile(statusOutput, relPath) || !existsSync(filePath)) {
      continue;
    }

    const content = readFileSync(filePath, 'utf-8');
    if (relPath !== '.alpha-loop/templates/instructions.md' && !content.startsWith(MANAGED_INSTRUCTIONS_MARKER)) {
      continue;
    }

    const validation = validateInstructionsMarkdown(content);
    if (!validation.valid) {
      errors.push(`${relPath}: ${validation.reason ?? 'invalid generated instructions'}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
