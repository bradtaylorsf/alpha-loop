/**
 * Epic primitives — pure functions for parsing and mutating epic issue bodies.
 *
 * An "epic" is a GitHub issue whose body contains a task-list of sub-issue
 * references (`- [ ] #N` lines). This module is the single source of truth
 * for how that checklist is parsed and modified.
 *
 * All functions here are pure — no gh CLI calls, no side effects. Callers in
 * github.ts wire these into read/modify/write flows.
 */
import type { Issue } from './github.js';

const SUB_ISSUE_LINE_RE = /^(\s*)- \[([ xX])\] #(\d+)\b/;
const EPIC_HEURISTIC_MIN_ITEMS = 3;

export type SubIssueRef = {
  number: number;
  checked: boolean;
  /** Zero-indexed line position in the split body — used for surgical replacement. */
  lineIndex: number;
};

export type EpicSummary = {
  number: number;
  title: string;
  subIssues: SubIssueRef[];
  doneCount: number;
  totalCount: number;
};

/**
 * Parse task-list sub-issue references from an issue body.
 *
 * Matches lines like `- [ ] #42` or `- [x] #42` (with optional leading
 * whitespace to allow nested markdown lists). Cross-repo refs like
 * `- [ ] owner/repo#42` are silently skipped — see the v1 non-goals.
 *
 * Returns refs in document order.
 */
export function parseSubIssues(body: string): SubIssueRef[] {
  const lines = body.split('\n');
  const refs: SubIssueRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = SUB_ISSUE_LINE_RE.exec(line);
    if (!m) continue;
    refs.push({
      number: parseInt(m[3], 10),
      checked: m[2] === 'x' || m[2] === 'X',
      lineIndex: i,
    });
  }
  return refs;
}

/**
 * Flip the checkbox state for a specific sub-issue in a body string.
 *
 * Surgical: finds the first line matching `- [?] #N` and rewrites only
 * that line's checkbox character. All other markdown is preserved byte-for-byte.
 *
 * Returns the new body. If the target sub-issue is not found, returns the
 * original body unchanged — callers in github.ts detect this case by
 * comparing before/after and throwing, since one-agent-per-epic is the contract.
 */
export function flipChecklistItem(body: string, subIssueNum: number, checked: boolean): string {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = SUB_ISSUE_LINE_RE.exec(lines[i]);
    if (!m) continue;
    if (parseInt(m[3], 10) !== subIssueNum) continue;
    const newBox = checked ? 'x' : ' ';
    lines[i] = lines[i].replace(SUB_ISSUE_LINE_RE, `${m[1]}- [${newBox}] #${m[3]}`);
    return lines.join('\n');
  }
  return body;
}

/**
 * Heuristic epic detection. Returns true when the body contains at least
 * {@link EPIC_HEURISTIC_MIN_ITEMS} sub-issue task-list refs.
 *
 * This is a warning hint only — the authoritative epic detection is the
 * `epic` label. An unlabeled tracker issue just looks like a regular issue.
 */
export function looksLikeEpic(body: string): boolean {
  return parseSubIssues(body).length >= EPIC_HEURISTIC_MIN_ITEMS;
}

/**
 * Build an EpicSummary from a parsed issue.
 */
export function buildEpicSummary(issue: Issue): EpicSummary {
  const subIssues = parseSubIssues(issue.body);
  const doneCount = subIssues.filter(r => r.checked).length;
  return {
    number: issue.number,
    title: issue.title,
    subIssues,
    doneCount,
    totalCount: subIssues.length,
  };
}
