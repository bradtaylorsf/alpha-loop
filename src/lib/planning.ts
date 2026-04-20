/**
 * Shared planning library — types, JSON extraction, and formatting utilities
 * used by plan, triage, and roadmap commands.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getVisionContext } from './vision.js';
import { getProjectContext } from './context.js';
import { pollIssues, type Issue } from './github.js';
import type { Config } from './config.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type Priority = 'p0' | 'p1' | 'p2' | 'p3';
export type Complexity = 'trivial' | 'small' | 'medium' | 'large';
export type TriageCategory = 'stale' | 'unclear' | 'too_large' | 'duplicate' | 'enrich';
export type TriageAction = 'close' | 'rewrite' | 'split' | 'merge' | 'enrich';

export type PlannedIssue = {
  id: number;
  title: string;
  body: string;
  labels: string[];
  milestone: string;
  priority: Priority;
  complexity: Complexity;
  dependsOn: number[];
  selected: boolean;
};

export type PlannedMilestone = {
  title: string;
  description: string;
  dueOn: string | null;
  order: number;
};

export type PlanDraft = {
  vision: string | null;
  milestones: PlannedMilestone[];
  issues: PlannedIssue[];
  projectBoard: string | null;
};

export type TriageFinding = {
  issueNum: number;
  title: string;
  category: TriageCategory;
  reason: string;
  action: TriageAction;
  rewrittenBody?: string;
  enrichedBody?: string;
  splitInto?: string[];
  duplicateOf?: number;
  selected: boolean;
};

export type RoadmapAssignment = {
  issueNum: number;
  title: string;
  milestone: string;
  currentMilestone: string;
  selected: boolean;
};

// ── ANSI Colors ──────────────────────────────────────────────────────────────

const RED = '\x1b[0;31m';
const YELLOW = '\x1b[1;33m';
const BLUE = '\x1b[0;34m';
const CYAN = '\x1b[0;36m';
const GRAY = '\x1b[0;90m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

const PRIORITY_COLORS: Record<Priority, string> = {
  p0: RED,
  p1: YELLOW,
  p2: BLUE,
  p3: GRAY,
};

const COMPLEXITY_COLORS: Record<Complexity, string> = {
  trivial: GRAY,
  small: BLUE,
  medium: YELLOW,
  large: RED,
};

// ── Functions ────────────────────────────────────────────────────────────────

/**
 * Ensure milestone titles are prefixed with a zero-padded 3-digit order number.
 * e.g. "MVP" with order 1 → "001 - MVP", "Core Features" with order 10 → "010 - Core Features".
 * If the title already has a valid prefix, it is left as-is.
 */
export function normalizeMilestoneTitles(milestones: PlannedMilestone[]): PlannedMilestone[] {
  const prefixPattern = /^\d{3} - /;
  return milestones.map((ms) => {
    if (prefixPattern.test(ms.title)) return ms;
    const prefix = String(ms.order).padStart(3, '0');
    return { ...ms, title: `${prefix} - ${ms.title}` };
  });
}

/**
 * Normalize a full plan draft: prefix milestone titles and update issue references.
 */
export function normalizePlanMilestones(draft: PlanDraft): PlanDraft {
  const originalTitles = draft.milestones.map((ms) => ms.title);
  const normalized = normalizeMilestoneTitles(draft.milestones);
  const titleMap = new Map<string, string>();
  for (let i = 0; i < originalTitles.length; i++) {
    if (originalTitles[i] !== normalized[i].title) {
      titleMap.set(originalTitles[i], normalized[i].title);
    }
  }
  const issues = titleMap.size > 0
    ? draft.issues.map((issue) => {
        const mapped = titleMap.get(issue.milestone);
        return mapped ? { ...issue, milestone: mapped } : issue;
      })
    : draft.issues;
  return { ...draft, milestones: normalized, issues };
}

/**
 * Normalize roadmap milestones and update assignment references.
 */
export function normalizeRoadmapMilestones(
  milestones: PlannedMilestone[],
  assignments: RoadmapAssignment[],
): { milestones: PlannedMilestone[]; assignments: RoadmapAssignment[] } {
  const originalTitles = milestones.map((ms) => ms.title);
  const normalized = normalizeMilestoneTitles(milestones);
  const titleMap = new Map<string, string>();
  for (let i = 0; i < originalTitles.length; i++) {
    if (originalTitles[i] !== normalized[i].title) {
      titleMap.set(originalTitles[i], normalized[i].title);
    }
  }
  const updatedAssignments = titleMap.size > 0
    ? assignments.map((a) => {
        const mapped = titleMap.get(a.milestone);
        return mapped ? { ...a, milestone: mapped } : a;
      })
    : assignments;
  return { milestones: normalized, assignments: updatedAssignments };
}

/**
 * Extract JSON from an AI agent response that may include markdown fences,
 * explanatory text, or other noise around the JSON payload.
 */
export function extractJsonFromResponse<T>(response: string): T {
  if (!response || !response.trim()) {
    throw new Error('Empty response — no JSON to extract');
  }

  // Try fenced JSON block first: ```json ... ```
  const fenceMatch = response.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      // Fall through to other strategies
    }
  }

  // Try plain fenced block: ``` ... ```
  const plainFenceMatch = response.match(/```\s*\n?([\s\S]*?)\n?\s*```/);
  if (plainFenceMatch) {
    const content = plainFenceMatch[1].trim();
    if (content.startsWith('{') || content.startsWith('[')) {
      try {
        return JSON.parse(content) as T;
      } catch {
        // Fall through
      }
    }
  }

  // Fallback: find first { and last } (or [ and ])
  const firstBrace = response.indexOf('{');
  const lastBrace = response.lastIndexOf('}');
  const firstBracket = response.indexOf('[');
  const lastBracket = response.lastIndexOf(']');

  // Try object
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(response.slice(firstBrace, lastBrace + 1)) as T;
    } catch {
      // Fall through
    }
  }

  // Try array
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return JSON.parse(response.slice(firstBracket, lastBracket + 1)) as T;
    } catch {
      // Fall through
    }
  }

  throw new Error(
    'Could not extract valid JSON from response. Expected a JSON object or array, ' +
      'optionally wrapped in ```json ... ``` fences.'
  );
}

/**
 * Format a table of planned issues grouped by milestone, with colored
 * priority and complexity columns.
 */
export function formatIssueTable(
  issues: PlannedIssue[],
  milestones: PlannedMilestone[]
): string {
  if (issues.length === 0) {
    return `${GRAY}No issues to display.${NC}`;
  }

  const sorted = [...milestones].sort((a, b) => a.order - b.order);
  const milestoneOrder = sorted.map((m) => m.title);

  // Group issues by milestone
  const grouped = new Map<string, PlannedIssue[]>();
  for (const issue of issues) {
    const key = issue.milestone || '(no milestone)';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(issue);
  }

  const lines: string[] = [];

  for (const msTitle of milestoneOrder) {
    const group = grouped.get(msTitle);
    if (!group || group.length === 0) continue;
    grouped.delete(msTitle);

    const ms = sorted.find((m) => m.title === msTitle);
    const due = ms?.dueOn ? ` (due ${ms.dueOn})` : '';
    lines.push(`\n${BOLD}${CYAN}── ${msTitle}${due} ──${NC}`);
    lines.push(formatIssueRows(group));
  }

  // Any remaining issues not in a known milestone
  for (const [msTitle, group] of grouped) {
    if (group.length === 0) continue;
    lines.push(`\n${BOLD}${CYAN}── ${msTitle} ──${NC}`);
    lines.push(formatIssueRows(group));
  }

  return lines.join('\n');
}

function formatIssueRows(issues: PlannedIssue[]): string {
  const rows = issues.map((issue) => {
    const pColor = PRIORITY_COLORS[issue.priority];
    const cColor = COMPLEXITY_COLORS[issue.complexity];
    const deps = issue.dependsOn.length > 0 ? ` → [${issue.dependsOn.join(', ')}]` : '';
    const sel = issue.selected ? '✓' : ' ';
    return (
      `  [${sel}] #${issue.id} ${issue.title}` +
      `  ${pColor}${issue.priority}${NC}` +
      `  ${cColor}${issue.complexity}${NC}` +
      `${deps}`
    );
  });
  return rows.join('\n');
}

/**
 * Format triage findings grouped by category.
 */
export function formatTriageFindings(findings: TriageFinding[]): string {
  if (findings.length === 0) {
    return `${GRAY}No triage findings.${NC}`;
  }

  const categories: TriageCategory[] = ['stale', 'unclear', 'too_large', 'duplicate', 'enrich'];
  const categoryLabels: Record<TriageCategory, string> = {
    stale: 'Stale Issues',
    unclear: 'Unclear Issues',
    too_large: 'Too Large',
    duplicate: 'Duplicates',
    enrich: 'Needs Enrichment',
  };

  const grouped = new Map<TriageCategory, TriageFinding[]>();
  for (const f of findings) {
    if (!grouped.has(f.category)) grouped.set(f.category, []);
    grouped.get(f.category)!.push(f);
  }

  const lines: string[] = [];

  for (const cat of categories) {
    const group = grouped.get(cat);
    if (!group || group.length === 0) continue;

    lines.push(`\n${BOLD}${YELLOW}── ${categoryLabels[cat]} (${group.length}) ──${NC}`);
    for (const f of group) {
      const sel = f.selected ? '✓' : ' ';
      lines.push(`  [${sel}] #${f.issueNum} ${f.title}`);
      lines.push(`      ${GRAY}Reason: ${f.reason}${NC}`);
      lines.push(`      Action: ${f.action}`);
      if (f.duplicateOf != null) {
        lines.push(`      ${GRAY}Duplicate of #${f.duplicateOf}${NC}`);
      }
      if (f.splitInto && f.splitInto.length > 0) {
        lines.push(`      ${GRAY}Split into: ${f.splitInto.join(', ')}${NC}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format a roadmap table grouped by milestone, showing [NEW]/[EXISTS] tags
 * per milestone and [currently: <milestone>]/[currently: unassigned] per issue.
 */
export function formatRoadmapTable(
  milestones: PlannedMilestone[],
  assignments: RoadmapAssignment[],
  existingMilestones: string[],
): string {
  if (assignments.length === 0) {
    return `${GRAY}No assignments to display.${NC}`;
  }

  const sorted = [...milestones].sort((a, b) => a.order - b.order);
  const existingSet = new Set(existingMilestones);

  // Group assignments by milestone
  const grouped = new Map<string, RoadmapAssignment[]>();
  for (const a of assignments) {
    const key = a.milestone || '(no milestone)';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(a);
  }

  const lines: string[] = [];

  for (const ms of sorted) {
    const group = grouped.get(ms.title);
    if (!group || group.length === 0) continue;
    grouped.delete(ms.title);

    const tag = existingSet.has(ms.title) ? `${BLUE}[EXISTS]${NC}` : `${CYAN}[NEW]${NC}`;
    const due = ms.dueOn ? ` (due: ${ms.dueOn})` : '';
    lines.push(`\n${BOLD}${CYAN}── ${ms.title}${due} ${tag}${NC}`);

    for (const a of group) {
      const current = a.currentMilestone
        ? `${GRAY}[currently: ${a.currentMilestone}]${NC}`
        : `${GRAY}[currently: unassigned]${NC}`;
      lines.push(`  #${a.issueNum}  ${a.title}  ${current}`);
    }
  }

  // Any remaining assignments not in a known milestone
  for (const [msTitle, group] of grouped) {
    if (group.length === 0) continue;
    lines.push(`\n${BOLD}${CYAN}── ${msTitle} ──${NC}`);
    for (const a of group) {
      const current = a.currentMilestone
        ? `${GRAY}[currently: ${a.currentMilestone}]${NC}`
        : `${GRAY}[currently: unassigned]${NC}`;
      lines.push(`  #${a.issueNum}  ${a.title}  ${current}`);
    }
  }

  return lines.join('\n');
}

/**
 * Read files matching glob patterns for seeding the plan.
 * Uses simple recursive directory walking with minimatch-style matching.
 */
export function readSeedFiles(
  patterns: string[],
  cwd: string
): Array<{ path: string; content: string }> {
  const results: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    const matched = matchFiles(pattern, cwd);
    for (const filePath of matched) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      try {
        const content = readFileSync(filePath, 'utf-8');
        results.push({ path: relative(cwd, filePath), content });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return results;
}

/**
 * Simple glob matching: supports * and ** patterns.
 */
function matchFiles(pattern: string, cwd: string): string[] {
  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  const regex = new RegExp(`^${regexStr}$`);

  const results: string[] = [];
  walkDir(cwd, cwd, regex, results);
  return results;
}

function walkDir(base: string, dir: string, regex: RegExp, results: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // skip dotfiles
    const fullPath = join(dir, entry);
    const relPath = relative(base, fullPath);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(base, fullPath, regex, results);
      } else if (regex.test(relPath)) {
        results.push(fullPath);
      }
    } catch {
      // Skip inaccessible entries
    }
  }
}

/**
 * Load common planning context: vision, project context, and existing issues.
 */
export function buildPlanningContext(config: Config): {
  visionContext: string | null;
  projectContext: string | null;
  existingIssues: Issue[];
} {
  const visionContext = getVisionContext();
  const projectContext = getProjectContext();
  const existingIssues = pollIssues(config.repo, config.labelReady, 100, {
    repoOwner: config.repoOwner,
    milestone: config.milestone,
  });

  return { visionContext, projectContext, existingIssues };
}

/**
 * Save a plan draft to .alpha-loop/plan.json for recovery.
 */
export function savePlanDraft(draft: PlanDraft, projectDir: string): void {
  const dir = join(projectDir, '.alpha-loop');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(draft, null, 2), 'utf-8');
}

/**
 * Load a previously saved plan draft from .alpha-loop/plan.json.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function loadPlanDraft(projectDir: string): PlanDraft | null {
  const draftPath = join(projectDir, '.alpha-loop', 'plan.json');
  try {
    const content = readFileSync(draftPath, 'utf-8');
    return JSON.parse(content) as PlanDraft;
  } catch {
    return null;
  }
}
