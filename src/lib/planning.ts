/**
 * Shared planning library — types, JSON extraction, and formatting utilities
 * used by plan, triage, and roadmap commands.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getVisionContext } from './vision.js';
import { getProjectContext } from './context.js';
import { pollIssues, type Issue, type Milestone, type RoadmapEpicContext } from './github.js';
import type { Config } from './config.js';
import { extractFilePaths, parseDependencies } from './validation.js';

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

export type ProposedEpicGroup = {
  title: string;
  goal: string;
  rationale: string;
  orderedChildIssueNumbers: number[];
  acceptanceCriteria: string[];
  selected: boolean;
  existingEpicIssueNum?: number;
};

export type TriageAnalysis = {
  findings: TriageFinding[];
  epicGroups: ProposedEpicGroup[];
};

export type RoadmapAssignment = {
  issueNum: number;
  title: string;
  milestone: string;
  currentMilestone: string;
  selected: boolean;
};

export type RoadmapAssignmentGroups = {
  epicAssignments: RoadmapAssignment[];
  standaloneAssignments: RoadmapAssignment[];
};

export type RoadmapPlan = RoadmapAssignmentGroups & {
  milestones: PlannedMilestone[];
};

export type EpicQueueChildStatus = 'complete' | 'ready' | 'not_ready' | 'blocked';

export type EpicQueueChildReadiness = {
  issueNum: number;
  title: string;
  checked: boolean;
  labels: string[];
  state: string | null;
  milestone: string | null;
  status: EpicQueueChildStatus;
  reason: string;
};

export type EpicQueuePlanItemStatus = 'runnable' | 'blocked';

export type EpicQueuePlanItem = {
  issueNum: number;
  title: string;
  milestone: string | null;
  status: EpicQueuePlanItemStatus;
  childReadiness: EpicQueueChildReadiness[];
  completedChildCount: number;
  readyChildCount: number;
  blockedChildCount: number;
  totalChildCount: number;
  explicitDependencies: number[];
  queueDependencies: number[];
  externalOpenDependencies: number[];
  resolvedDependencies: number[];
  filePaths: string[];
  rationale: string[];
  blockers: string[];
  risks: string[];
};

export type EpicQueuePlan = {
  milestoneFilter: string | null;
  totalEpicCount: number;
  consideredEpicCount: number;
  orderedEpics: EpicQueuePlanItem[];
  blockedEpics: EpicQueuePlanItem[];
  command: string | null;
};

export type EpicQueuePlanOptions = {
  labelReady: string;
  milestone?: string | null;
  openIssues?: Issue[];
  milestones?: Milestone[];
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
): { milestones: PlannedMilestone[]; assignments: RoadmapAssignment[] };
export function normalizeRoadmapMilestones(
  milestones: PlannedMilestone[],
  assignments: RoadmapAssignmentGroups,
): RoadmapPlan;
export function normalizeRoadmapMilestones(
  milestones: PlannedMilestone[],
  assignments: RoadmapAssignment[] | RoadmapAssignmentGroups,
): { milestones: PlannedMilestone[]; assignments: RoadmapAssignment[] } | RoadmapPlan {
  const originalTitles = milestones.map((ms) => ms.title);
  const normalized = normalizeMilestoneTitles(milestones);
  const titleMap = new Map<string, string>();
  for (let i = 0; i < originalTitles.length; i++) {
    if (originalTitles[i] !== normalized[i].title) {
      titleMap.set(originalTitles[i], normalized[i].title);
    }
  }

  const updateAssignments = (items: RoadmapAssignment[]): RoadmapAssignment[] => {
    if (titleMap.size === 0) return items;
    return items.map((a) => {
        const mapped = titleMap.get(a.milestone);
        return mapped ? { ...a, milestone: mapped } : a;
      });
  };

  if (Array.isArray(assignments)) {
    return { milestones: normalized, assignments: updateAssignments(assignments) };
  }

  return {
    milestones: normalized,
    epicAssignments: updateAssignments(assignments.epicAssignments),
    standaloneAssignments: updateAssignments(assignments.standaloneAssignments),
  };
}

function normalizeRoadmapAssignment(value: unknown, context: string): RoadmapAssignment {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }

  const issueNum = value.issueNum;
  if (!Number.isInteger(issueNum) || (issueNum as number) <= 0) {
    throw new Error(`${context}.issueNum must be a positive integer`);
  }

  const title = value.title;
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error(`${context}.title must be a non-empty string`);
  }

  const milestone = value.milestone;
  if (typeof milestone !== 'string' || milestone.trim().length === 0) {
    throw new Error(`${context}.milestone must be a non-empty string`);
  }

  const currentMilestone = value.currentMilestone;
  if (currentMilestone !== undefined && typeof currentMilestone !== 'string') {
    throw new Error(`${context}.currentMilestone must be a string`);
  }

  const selected = value.selected;
  if (selected !== undefined && typeof selected !== 'boolean') {
    throw new Error(`${context}.selected must be a boolean`);
  }

  return {
    issueNum: issueNum as number,
    title: title.trim(),
    milestone: milestone.trim(),
    currentMilestone: typeof currentMilestone === 'string' ? currentMilestone.trim() : '',
    selected: selected === undefined ? false : selected,
  };
}

function normalizeRoadmapAssignmentArray(value: unknown, field: string): RoadmapAssignment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Roadmap ${field} must be an array`);
  }
  return value.map((assignment, index) => normalizeRoadmapAssignment(assignment, `${field}[${index}]`));
}

/**
 * Normalize roadmap JSON into split assignment arrays. Legacy `assignments`
 * responses are accepted as standalone issue assignments for no-epic repos.
 */
export function normalizeRoadmapPlan(value: unknown): RoadmapPlan {
  if (!isRecord(value)) {
    throw new Error('Roadmap plan must be a JSON object');
  }

  if (!Array.isArray(value.milestones)) {
    throw new Error('Roadmap milestones must be an array');
  }

  const epicAssignments = normalizeRoadmapAssignmentArray(value.epicAssignments, 'epicAssignments');
  const explicitStandaloneAssignments = normalizeRoadmapAssignmentArray(
    value.standaloneAssignments,
    'standaloneAssignments',
  );
  const legacyAssignments = normalizeRoadmapAssignmentArray(value.assignments, 'assignments');
  const standaloneAssignments = explicitStandaloneAssignments.length > 0 || value.standaloneAssignments !== undefined
    ? explicitStandaloneAssignments
    : legacyAssignments;

  return normalizeRoadmapMilestones(
    value.milestones as PlannedMilestone[],
    { epicAssignments, standaloneAssignments },
  ) as RoadmapPlan;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  field: keyof ProposedEpicGroup,
  context: string,
): string {
  const raw = value[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${context}.${String(field)} must be a non-empty string`);
  }
  return raw.trim();
}

function requireStringArray(
  value: Record<string, unknown>,
  field: keyof ProposedEpicGroup,
  context: string,
): string[] {
  const raw = value[field];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new Error(`${context}.${String(field)} must be a non-empty array of non-empty strings`);
  }
  return raw.map((item) => (item as string).trim());
}

function requireIssueNumberArray(
  value: Record<string, unknown>,
  field: keyof ProposedEpicGroup,
  context: string,
): number[] {
  const raw = value[field];
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error(`${context}.${String(field)} must include at least two issue numbers`);
  }
  const numbers = raw.map((item) => {
    if (!Number.isInteger(item) || item <= 0) {
      throw new Error(`${context}.${String(field)} must contain positive integer issue numbers`);
    }
    return item as number;
  });
  const unique = new Set(numbers);
  if (unique.size !== numbers.length) {
    throw new Error(`${context}.${String(field)} must not contain duplicate issue numbers`);
  }
  return numbers;
}

function normalizeSelected(value: Record<string, unknown>, context: string): boolean {
  const raw = value.selected;
  if (raw === undefined) return false;
  if (typeof raw !== 'boolean') {
    throw new Error(`${context}.selected must be a boolean`);
  }
  return raw;
}

function normalizeOptionalIssueNumber(
  value: Record<string, unknown>,
  field: keyof ProposedEpicGroup,
  context: string,
): number | undefined {
  const raw = value[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${context}.${String(field)} must be a positive integer issue number`);
  }
  return raw;
}

function normalizeProposedEpicGroup(value: unknown, index: number): ProposedEpicGroup {
  const context = `epicGroups[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object`);
  }

  return {
    title: requireString(value, 'title', context),
    goal: requireString(value, 'goal', context),
    rationale: requireString(value, 'rationale', context),
    orderedChildIssueNumbers: requireIssueNumberArray(value, 'orderedChildIssueNumbers', context),
    acceptanceCriteria: requireStringArray(value, 'acceptanceCriteria', context),
    selected: normalizeSelected(value, context),
    existingEpicIssueNum: normalizeOptionalIssueNumber(value, 'existingEpicIssueNum', context),
  };
}

/**
 * Normalize triage JSON into the current analysis shape. Legacy TriageFinding[]
 * responses are still accepted so older agents fail gracefully.
 */
export function normalizeTriageAnalysis(value: unknown): TriageAnalysis {
  if (Array.isArray(value)) {
    return { findings: value as TriageFinding[], epicGroups: [] };
  }

  if (!isRecord(value)) {
    throw new Error('Triage analysis must be a JSON object with findings and epicGroups arrays');
  }

  const findings = value.findings ?? [];
  const epicGroups = value.epicGroups ?? [];

  if (!Array.isArray(findings)) {
    throw new Error('Triage analysis findings must be an array');
  }
  if (!Array.isArray(epicGroups)) {
    throw new Error('Triage analysis epicGroups must be an array');
  }

  return {
    findings: findings as TriageFinding[],
    epicGroups: epicGroups.map((group, index) => normalizeProposedEpicGroup(group, index)),
  };
}

/**
 * Extract and normalize a triage agent response.
 */
export function parseTriageAnalysisResponse(response: string): TriageAnalysis {
  return normalizeTriageAnalysis(extractJsonFromResponse<unknown>(response));
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
 * Format proposed epic groups separately from per-issue cleanup findings.
 */
export function formatEpicGroupProposals(groups: ProposedEpicGroup[]): string {
  if (groups.length === 0) {
    return `${GRAY}No proposed epic groups.${NC}`;
  }

  const lines: string[] = [`\n${BOLD}${CYAN}── Proposed Epic Groups (${groups.length}) ──${NC}`];

  groups.forEach((group, index) => {
    const sel = group.selected ? '✓' : ' ';
    const target = group.existingEpicIssueNum
      ? `updates epic #${group.existingEpicIssueNum}`
      : 'creates new epic';
    lines.push(`  [${sel}] ${index + 1}. ${group.title} (${target})`);
    lines.push(`      ${GRAY}Goal: ${group.goal}${NC}`);
    lines.push(`      ${GRAY}Rationale: ${group.rationale}${NC}`);
    lines.push(`      Children: ${group.orderedChildIssueNumbers.map((n) => `#${n}`).join(' -> ')}`);
    lines.push('      Acceptance Criteria:');
    for (const criterion of group.acceptanceCriteria) {
      lines.push(`        - ${criterion.replace(/^[-*]\s+/, '').trim()}`);
    }
  });

  return lines.join('\n');
}

/**
 * Format a roadmap table grouped by milestone, showing [NEW]/[EXISTS] tags
 * per milestone and [currently: <milestone>]/[currently: unassigned] per issue.
 */
export function formatRoadmapTable(
  milestones: PlannedMilestone[],
  assignments: RoadmapAssignment[] | RoadmapAssignmentGroups,
  existingMilestones: string[],
): string {
  const groups = Array.isArray(assignments)
    ? { epicAssignments: [], standaloneAssignments: assignments }
    : assignments;
  const hasEpicAssignments = groups.epicAssignments.length > 0;
  const hasStandaloneAssignments = groups.standaloneAssignments.length > 0;

  if (!hasEpicAssignments && !hasStandaloneAssignments) {
    return `${GRAY}No assignments to display.${NC}`;
  }

  const sorted = [...milestones].sort((a, b) => a.order - b.order);
  const existingSet = new Set(existingMilestones);
  const lines: string[] = [];

  if (hasEpicAssignments) {
    lines.push(
      `${BOLD}${YELLOW}Epic Milestone Assignments (${groups.epicAssignments.length})${NC}`,
      formatRoadmapAssignmentSection(sorted, groups.epicAssignments, existingSet),
    );
  }

  if (hasStandaloneAssignments) {
    if (lines.length > 0) lines.push('');
    const header = hasEpicAssignments
      ? `${BOLD}${YELLOW}Standalone Issue Milestone Assignments (${groups.standaloneAssignments.length})${NC}`
      : '';
    if (header) lines.push(header);
    lines.push(formatRoadmapAssignmentSection(sorted, groups.standaloneAssignments, existingSet));
  }

  return lines.filter((line) => line !== '').join('\n');
}

function formatRoadmapAssignmentSection(
  sortedMilestones: PlannedMilestone[],
  assignments: RoadmapAssignment[],
  existingSet: Set<string>,
): string {
  const grouped = new Map<string, RoadmapAssignment[]>();
  for (const a of assignments) {
    const key = a.milestone || '(no milestone)';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(a);
  }

  const lines: string[] = [];

  for (const ms of sortedMilestones) {
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

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function hasLabel(labels: string[] | undefined, label: string): boolean {
  const wanted = normalizeLabel(label);
  return (labels ?? []).some((candidate) => normalizeLabel(candidate) === wanted);
}

function normalizeIssueState(value: string | undefined): string | null {
  return value ? value.toLowerCase() : null;
}

function childReadiness(
  child: RoadmapEpicContext['children'][number],
  labelReady: string,
): EpicQueueChildReadiness {
  const labels = child.labels ?? [];
  const state = normalizeIssueState(child.state);
  const milestone = child.milestone ?? null;

  if (child.checked) {
    return {
      issueNum: child.issueNum,
      title: child.title,
      checked: child.checked,
      labels,
      state,
      milestone,
      status: 'complete',
      reason: 'Checklist item is already complete',
    };
  }

  if (!child.title || child.title === '(issue details unavailable)') {
    return {
      issueNum: child.issueNum,
      title: child.title,
      checked: child.checked,
      labels,
      state,
      milestone,
      status: 'blocked',
      reason: 'Issue details could not be fetched',
    };
  }

  if (state && state !== 'open') {
    return {
      issueNum: child.issueNum,
      title: child.title,
      checked: child.checked,
      labels,
      state,
      milestone,
      status: 'blocked',
      reason: `Issue is ${state}`,
    };
  }

  if (hasLabel(labels, 'epic')) {
    return {
      issueNum: child.issueNum,
      title: child.title,
      checked: child.checked,
      labels,
      state,
      milestone,
      status: 'blocked',
      reason: 'Nested epic child issues are not supported',
    };
  }

  if (!hasLabel(labels, labelReady)) {
    return {
      issueNum: child.issueNum,
      title: child.title,
      checked: child.checked,
      labels,
      state,
      milestone,
      status: 'not_ready',
      reason: `Missing '${labelReady}' label`,
    };
  }

  return {
    issueNum: child.issueNum,
    title: child.title,
    checked: child.checked,
    labels,
    state,
    milestone,
    status: 'ready',
    reason: `Open and labeled '${labelReady}'`,
  };
}

function collectEpicText(epic: RoadmapEpicContext): string {
  return [
    epic.title,
    epic.bodySummary,
    ...epic.children.map((child) => child.bodySummary),
  ].filter(Boolean).join('\n');
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function collectEpicDependencies(epic: RoadmapEpicContext): number[] {
  const childIssueNums = new Set(epic.children.map((child) => child.issueNum));
  return uniqueSorted(parseDependencies(collectEpicText(epic)))
    .filter((issueNum) => issueNum !== epic.issueNum && !childIssueNums.has(issueNum));
}

function collectEpicFiles(epic: RoadmapEpicContext): string[] {
  return [...new Set(extractFilePaths(collectEpicText(epic)))].sort();
}

function milestoneSortIndex(milestones: Milestone[] | undefined, milestone: string | null): number {
  if (!milestone) return Number.MAX_SAFE_INTEGER - 1;
  const index = (milestones ?? []).findIndex((candidate) => candidate.title === milestone);
  return index === -1 ? Number.MAX_SAFE_INTEGER - 2 : index;
}

function sortEpicsForPlanning(
  epics: RoadmapEpicContext[],
  milestones: Milestone[] | undefined,
): RoadmapEpicContext[] {
  return [...epics].sort((a, b) => {
    const milestoneDelta = milestoneSortIndex(milestones, a.currentMilestone ?? null) -
      milestoneSortIndex(milestones, b.currentMilestone ?? null);
    if (milestoneDelta !== 0) return milestoneDelta;
    return a.issueNum - b.issueNum;
  });
}

function topologicalOrderEpicItems(items: EpicQueuePlanItem[]): {
  ordered: EpicQueuePlanItem[];
  cycleIssueNums: number[];
} {
  const itemMap = new Map(items.map((item) => [item.issueNum, item]));
  const originalIndex = new Map(items.map((item, index) => [item.issueNum, index]));
  const dependents = new Map<number, number[]>();
  const remainingDeps = new Map<number, Set<number>>();

  for (const item of items) {
    const deps = item.queueDependencies.filter((dep) => itemMap.has(dep));
    remainingDeps.set(item.issueNum, new Set(deps));
    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(item.issueNum);
    }
  }

  const ready = items
    .filter((item) => (remainingDeps.get(item.issueNum)?.size ?? 0) === 0)
    .map((item) => item.issueNum)
    .sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0));
  const ordered: EpicQueuePlanItem[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    const item = itemMap.get(current);
    if (!item) continue;
    ordered.push(item);

    for (const dependent of dependents.get(current) ?? []) {
      const deps = remainingDeps.get(dependent);
      if (!deps) continue;
      deps.delete(current);
      if (deps.size === 0) {
        ready.push(dependent);
        ready.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0));
      }
    }
  }

  if (ordered.length === items.length) {
    return { ordered, cycleIssueNums: [] };
  }

  const orderedSet = new Set(ordered.map((item) => item.issueNum));
  return {
    ordered,
    cycleIssueNums: items
      .map((item) => item.issueNum)
      .filter((issueNum) => !orderedSet.has(issueNum)),
  };
}

function addFileOverlapRisks(items: EpicQueuePlanItem[]): void {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const left = items[i];
      const right = items[j];
      const shared = left.filePaths.filter((file) => right.filePaths.includes(file));
      if (shared.length === 0) continue;
      const files = shared.slice(0, 5).join(', ');
      const suffix = shared.length > 5 ? `, +${shared.length - 5} more` : '';
      left.risks.push(`Likely file overlap with #${right.issueNum}: ${files}${suffix}`);
      right.risks.push(`Likely file overlap with #${left.issueNum}: ${files}${suffix}`);
    }
  }
}

function buildEpicQueuePlanItem(
  epic: RoadmapEpicContext,
  options: Required<Pick<EpicQueuePlanOptions, 'labelReady'>> & EpicQueuePlanOptions,
  candidateNums: Set<number>,
  openIssueNums: Set<number>,
): EpicQueuePlanItem {
  const childSignals = epic.children.map((child) => childReadiness(child, options.labelReady));
  const completedChildCount = childSignals.filter((child) => child.status === 'complete').length;
  const readyChildCount = childSignals.filter((child) => child.status === 'ready').length;
  const blockedChildren = childSignals.filter((child) => child.status === 'blocked' || child.status === 'not_ready');
  const explicitDependencies = collectEpicDependencies(epic);
  const queueDependencies = explicitDependencies.filter((issueNum) => candidateNums.has(issueNum));
  const externalOpenDependencies = explicitDependencies.filter((issueNum) => (
    !candidateNums.has(issueNum) && openIssueNums.has(issueNum)
  ));
  const resolvedDependencies = explicitDependencies.filter((issueNum) => (
    !candidateNums.has(issueNum) && !openIssueNums.has(issueNum)
  ));
  const filePaths = collectEpicFiles(epic);
  const blockers: string[] = [];

  if (epic.children.length === 0) {
    blockers.push('No child issues found in the epic checklist');
  }
  for (const child of blockedChildren) {
    blockers.push(`Child #${child.issueNum} ${child.title}: ${child.reason}`);
  }
  for (const dep of externalOpenDependencies) {
    blockers.push(`Open dependency #${dep} is outside the planned epic queue`);
  }

  const rationale = [
    epic.currentMilestone ? `Milestone: ${epic.currentMilestone}` : 'Milestone: unassigned',
    `Child readiness: ${readyChildCount} ready, ${completedChildCount} complete, ${blockedChildren.length} blocked/not ready`,
  ];
  if (queueDependencies.length > 0) {
    rationale.push(`Queue dependencies: ${queueDependencies.map((dep) => `#${dep}`).join(', ')}`);
  } else {
    rationale.push('Queue dependencies: none');
  }
  if (resolvedDependencies.length > 0) {
    rationale.push(`Dependencies not open: ${resolvedDependencies.map((dep) => `#${dep}`).join(', ')} (assumed complete)`);
  }

  return {
    issueNum: epic.issueNum,
    title: epic.title,
    milestone: epic.currentMilestone ?? null,
    status: blockers.length > 0 ? 'blocked' : 'runnable',
    childReadiness: childSignals,
    completedChildCount,
    readyChildCount,
    blockedChildCount: blockedChildren.length,
    totalChildCount: epic.children.length,
    explicitDependencies,
    queueDependencies,
    externalOpenDependencies,
    resolvedDependencies,
    filePaths,
    rationale,
    blockers,
    risks: [],
  };
}

/**
 * Analyze open roadmap epics and recommend a safe ordered `run --epics` queue.
 *
 * The helper is intentionally pure: it only consumes already-fetched GitHub
 * context and never mutates issues, milestones, projects, branches, or sessions.
 */
export function planEpicQueue(
  epics: RoadmapEpicContext[],
  options: EpicQueuePlanOptions,
): EpicQueuePlan {
  const milestoneFilter = options.milestone?.trim() || null;
  const considered = milestoneFilter
    ? epics.filter((epic) => epic.currentMilestone === milestoneFilter)
    : epics;
  const sortedEpics = sortEpicsForPlanning(considered, options.milestones);
  const candidateNums = new Set(sortedEpics.map((epic) => epic.issueNum));
  const openIssueNums = new Set((options.openIssues ?? []).map((issue) => issue.number));
  const items = sortedEpics.map((epic) => buildEpicQueuePlanItem(epic, options, candidateNums, openIssueNums));
  const itemMap = new Map(items.map((item) => [item.issueNum, item]));

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.status === 'blocked') continue;
      const blockedDeps = item.queueDependencies.filter((dep) => itemMap.get(dep)?.status === 'blocked');
      if (blockedDeps.length === 0) continue;
      for (const dep of blockedDeps) {
        item.blockers.push(`Depends on blocked epic #${dep}`);
      }
      item.status = 'blocked';
      changed = true;
    }
  }

  const runnableCandidates = items.filter((item) => item.status === 'runnable');
  const topo = topologicalOrderEpicItems(runnableCandidates);
  if (topo.cycleIssueNums.length > 0) {
    for (const issueNum of topo.cycleIssueNums) {
      const item = itemMap.get(issueNum);
      if (!item) continue;
      item.status = 'blocked';
      item.blockers.push('Cyclic dependency with another runnable epic');
    }
  }

  const orderedEpics = topo.cycleIssueNums.length > 0
    ? topologicalOrderEpicItems(items.filter((item) => item.status === 'runnable')).ordered
    : topo.ordered;
  const blockedEpics = items.filter((item) => item.status === 'blocked');

  addFileOverlapRisks([...orderedEpics, ...blockedEpics]);

  return {
    milestoneFilter,
    totalEpicCount: epics.length,
    consideredEpicCount: considered.length,
    orderedEpics,
    blockedEpics,
    command: orderedEpics.length > 0
      ? `alpha-loop run --epics ${orderedEpics.map((item) => item.issueNum).join(',')}`
      : null,
  };
}

function formatPlanList(values: string[], empty: string): string[] {
  return values.length > 0
    ? values.map((value) => `     - ${value}`)
    : [`     - ${empty}`];
}

function formatEpicQueuePlanItem(item: EpicQueuePlanItem, index?: number): string[] {
  const prefix = index === undefined ? '-' : `${index + 1}.`;
  const lines = [
    `  ${prefix} #${item.issueNum} ${item.title}`,
    `     Readiness: ${item.readyChildCount} ready, ${item.completedChildCount} complete, ${item.blockedChildCount} blocked/not ready (${item.totalChildCount} total)`,
    '     Rationale:',
    ...formatPlanList(item.rationale, 'No rationale signals found'),
    '     Blockers:',
    ...formatPlanList(item.blockers, 'None'),
    '     Risks:',
    ...formatPlanList(item.risks, 'None detected'),
  ];
  return lines;
}

export function formatEpicQueuePlan(plan: EpicQueuePlan): string {
  const scope = plan.milestoneFilter
    ? `milestone "${plan.milestoneFilter}"`
    : 'all open epics';
  const lines = [
    `${BOLD}${CYAN}Epic Queue Recommendation${NC}`,
    `Scope: ${scope}`,
    `Open epics considered: ${plan.consideredEpicCount}/${plan.totalEpicCount}`,
    '',
  ];

  if (plan.totalEpicCount === 0) {
    lines.push('No open epics found.');
    return lines.join('\n');
  }

  if (plan.consideredEpicCount === 0) {
    lines.push('No open epics matched the requested scope.');
    return lines.join('\n');
  }

  if (plan.orderedEpics.length > 0) {
    lines.push(`${BOLD}Runnable Queue (${plan.orderedEpics.length})${NC}`);
    plan.orderedEpics.forEach((item, index) => {
      lines.push(...formatEpicQueuePlanItem(item, index));
    });
  } else {
    lines.push(`${BOLD}Runnable Queue (0)${NC}`);
    lines.push('  No runnable epic queue found.');
  }

  lines.push('');
  if (plan.blockedEpics.length > 0) {
    lines.push(`${BOLD}Blocked Epics (${plan.blockedEpics.length})${NC}`);
    for (const item of plan.blockedEpics) {
      lines.push(...formatEpicQueuePlanItem(item));
    }
  } else {
    lines.push(`${BOLD}Blocked Epics (0)${NC}`);
    lines.push('  None');
  }

  lines.push('');
  lines.push(`${BOLD}Command${NC}`);
  if (plan.command) {
    lines.push(`  ${plan.command}`);
  } else {
    lines.push('  No executable queue command because no runnable epics were found.');
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
