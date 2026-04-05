/**
 * Pre-session Validation — analyze queued issues before execution.
 * Checks dependency ordering, completeness, duplicates, and file overlap.
 */
import { log } from './logger.js';
import { commentIssue } from './github.js';

export type ValidationIssue = {
  number: number;
  title: string;
  body: string;
};

export type DependencyWarning = {
  issueNum: number;
  dependsOn: number;
  reason: string;
};

export type CompletenessWarning = {
  issueNum: number;
  title: string;
  score: number;
  reasons: string[];
};

export type OverlapWarning = {
  issueA: number;
  issueB: number;
  sharedFiles: string[];
};

export type ValidationReport = {
  dependencyWarnings: DependencyWarning[];
  reorderedQueue: ValidationIssue[];
  completenessWarnings: CompletenessWarning[];
  overlapWarnings: OverlapWarning[];
  skippedIssues: number[];
};

/**
 * Parse issue body for dependency references like "depends on #N", "after #N", "requires #N".
 */
export function parseDependencies(body: string): number[] {
  const deps: number[] = [];
  const patterns = [
    /depends\s+on\s+#(\d+)/gi,
    /after\s+#(\d+)/gi,
    /requires\s+#(\d+)/gi,
    /blocked\s+by\s+#(\d+)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(body)) !== null) {
      const num = parseInt(match[1], 10);
      if (!deps.includes(num)) deps.push(num);
    }
  }
  return deps;
}

/**
 * Extract file paths mentioned in an issue body.
 * Looks for patterns like `src/lib/foo.ts`, backtick-wrapped paths, etc.
 */
export function extractFilePaths(body: string): string[] {
  const paths: string[] = [];
  // Match file paths in backticks or standalone that look like relative paths with extensions
  const pattern = /(?:`([^`]+\.[a-z]{1,5})`|(?:^|\s)((?:src|tests|lib|templates|\.alpha-loop)\/[\w./\-]+\.[a-z]{1,5}))/gm;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const path = match[1] || match[2];
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * Score an issue's completeness for autonomous implementation.
 * Returns 0-100; higher = more complete.
 */
export function scoreCompleteness(issue: ValidationIssue): { score: number; reasons: string[] } {
  let score = 100;
  const reasons: string[] = [];
  const body = issue.body || '';

  // Very short body
  if (body.length < 100) {
    score -= 40;
    reasons.push('Issue body is very short (< 100 chars)');
  } else if (body.length < 300) {
    score -= 15;
    reasons.push('Issue body is brief (< 300 chars)');
  }

  // No acceptance criteria
  if (!/- \[[ x]\]/i.test(body) && !/acceptance criteria/i.test(body)) {
    score -= 25;
    reasons.push('No acceptance criteria found');
  }

  // No file references
  if (extractFilePaths(body).length === 0) {
    score -= 10;
    reasons.push('No file paths referenced');
  }

  // No code blocks or technical detail
  if (!body.includes('```') && !body.includes('`')) {
    score -= 10;
    reasons.push('No code examples or inline code');
  }

  return { score: Math.max(0, score), reasons };
}

/**
 * Check dependency ordering: if issue A depends on B, B should come before A.
 * Returns warnings and a reordered queue.
 */
export function checkDependencyOrder(issues: ValidationIssue[]): {
  warnings: DependencyWarning[];
  reordered: ValidationIssue[];
} {
  const issueNums = new Set(issues.map((i) => i.number));
  const depMap = new Map<number, number[]>();
  const warnings: DependencyWarning[] = [];

  for (const issue of issues) {
    const deps = parseDependencies(issue.body || '');
    // Only track deps that are in the queue
    const queueDeps = deps.filter((d) => issueNums.has(d));
    depMap.set(issue.number, queueDeps);
  }

  // Check for misordering
  const posMap = new Map(issues.map((issue, idx) => [issue.number, idx]));
  for (const issue of issues) {
    const deps = depMap.get(issue.number) || [];
    for (const dep of deps) {
      const depPos = posMap.get(dep)!;
      const issuePos = posMap.get(issue.number)!;
      if (depPos > issuePos) {
        warnings.push({
          issueNum: issue.number,
          dependsOn: dep,
          reason: `#${issue.number} depends on #${dep}, but #${dep} comes later in the queue`,
        });
      }
    }
  }

  // Topological sort for reordering
  const reordered = topologicalSort(issues, depMap);
  return { warnings, reordered };
}

/**
 * Topological sort of issues based on dependency map.
 * Falls back to original order if cycles are detected.
 */
function topologicalSort(issues: ValidationIssue[], depMap: Map<number, number[]>): ValidationIssue[] {
  const issueMap = new Map(issues.map((i) => [i.number, i]));
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const result: ValidationIssue[] = [];

  function visit(num: number): boolean {
    if (visited.has(num)) return true;
    if (visiting.has(num)) return false; // cycle
    visiting.add(num);
    const deps = depMap.get(num) || [];
    for (const dep of deps) {
      if (issueMap.has(dep) && !visit(dep)) return false;
    }
    visiting.delete(num);
    visited.add(num);
    const issue = issueMap.get(num);
    if (issue) result.push(issue);
    return true;
  }

  for (const issue of issues) {
    if (!visit(issue.number)) {
      // Cycle detected, return original order
      return [...issues];
    }
  }

  return result;
}

/**
 * Detect file overlap between issues.
 */
export function detectOverlap(issues: ValidationIssue[]): OverlapWarning[] {
  const warnings: OverlapWarning[] = [];
  const filesByIssue = new Map<number, string[]>();

  for (const issue of issues) {
    filesByIssue.set(issue.number, extractFilePaths(issue.body || ''));
  }

  for (let i = 0; i < issues.length; i++) {
    for (let j = i + 1; j < issues.length; j++) {
      const filesA = filesByIssue.get(issues[i].number) || [];
      const filesB = filesByIssue.get(issues[j].number) || [];
      const shared = filesA.filter((f) => filesB.includes(f));
      if (shared.length > 0) {
        warnings.push({
          issueA: issues[i].number,
          issueB: issues[j].number,
          sharedFiles: shared,
        });
      }
    }
  }

  return warnings;
}

/**
 * Run all validation checks on a queue of issues.
 */
export function validateIssueQueue(issues: ValidationIssue[], completenessThreshold = 40): ValidationReport {
  // Dependency ordering
  const { warnings: dependencyWarnings, reordered } = checkDependencyOrder(issues);

  // Completeness scoring
  const completenessWarnings: CompletenessWarning[] = [];
  const skippedIssues: number[] = [];

  for (const issue of issues) {
    const { score, reasons } = scoreCompleteness(issue);
    if (score < completenessThreshold) {
      completenessWarnings.push({
        issueNum: issue.number,
        title: issue.title,
        score,
        reasons,
      });
      skippedIssues.push(issue.number);
    }
  }

  // File overlap detection
  const overlapWarnings = detectOverlap(issues);

  return {
    dependencyWarnings,
    reorderedQueue: reordered,
    completenessWarnings,
    overlapWarnings,
    skippedIssues,
  };
}

/**
 * Print a validation summary report to stderr.
 */
export function printValidationReport(report: ValidationReport): void {
  const BOLD = '\x1b[1m';
  const YELLOW = '\x1b[33m';
  const RED = '\x1b[31m';
  const GREEN = '\x1b[32m';
  const NC = '\x1b[0m';

  console.error('');
  console.error(`${BOLD}  Pre-Session Validation Report${NC}`);
  console.error('');

  // Dependency warnings
  if (report.dependencyWarnings.length > 0) {
    console.error(`${YELLOW}  Dependency Ordering Issues:${NC}`);
    for (const w of report.dependencyWarnings) {
      console.error(`    ${w.reason}`);
    }
    console.error('');
  }

  // Completeness warnings
  if (report.completenessWarnings.length > 0) {
    console.error(`${RED}  Incomplete Issues (will be skipped):${NC}`);
    for (const w of report.completenessWarnings) {
      console.error(`    #${w.issueNum}: ${w.title} (score: ${w.score}/100)`);
      for (const r of w.reasons) {
        console.error(`      - ${r}`);
      }
    }
    console.error('');
  }

  // Overlap warnings
  if (report.overlapWarnings.length > 0) {
    console.error(`${YELLOW}  File Overlap Warnings:${NC}`);
    for (const w of report.overlapWarnings) {
      console.error(`    #${w.issueA} and #${w.issueB} both modify: ${w.sharedFiles.join(', ')}`);
    }
    console.error('');
  }

  const totalWarnings = report.dependencyWarnings.length + report.completenessWarnings.length + report.overlapWarnings.length;
  if (totalWarnings === 0) {
    console.error(`${GREEN}  All issues passed validation.${NC}`);
  } else {
    console.error(`  ${totalWarnings} warning(s) found.`);
  }
  console.error('');
}

/**
 * Post comments on issues that failed completeness validation, asking for more detail.
 */
export function commentOnIncompleteIssues(
  repo: string,
  report: ValidationReport,
): void {
  for (const w of report.completenessWarnings) {
    const reasons = w.reasons.map((r) => `- ${r}`).join('\n');
    const body = `## Pre-Session Validation: More Detail Needed

This issue was flagged during pre-session validation as needing more information for autonomous implementation (completeness score: ${w.score}/100).

**Issues found:**
${reasons}

**Suggestions:**
- Add acceptance criteria using checkbox format (\`- [ ] Criterion\`)
- Reference specific files that need to be modified
- Include code examples or expected behavior
- Add more technical detail about the expected implementation

_This comment was generated automatically by alpha-loop pre-session validation._`;

    commentIssue(repo, w.issueNum, body);
    log.info(`Posted validation comment on #${w.issueNum}`);
  }
}
