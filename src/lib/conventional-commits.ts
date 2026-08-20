export const CONVENTIONAL_COMMIT_TYPES = [
  'fix',
  'feat',
  'chore',
  'docs',
  'refactor',
  'test',
  'perf',
  'build',
  'ci',
] as const;

export type ConventionalCommitType = typeof CONVENTIONAL_COMMIT_TYPES[number];

export type ConventionalIssue = {
  title: string;
  labels?: readonly string[];
};

const PREFIX_PATTERN = CONVENTIONAL_COMMIT_TYPES.join('|');
const CONVENTIONAL_PREFIX = new RegExp(`^(${PREFIX_PATTERN}):\\s*`);
const DOUBLE_PREFIX = new RegExp(`^(${PREFIX_PATTERN}):\\s*(${PREFIX_PATTERN}):`);

const LABEL_TYPES: ReadonlyArray<readonly [string, ConventionalCommitType]> = [
  ['bug', 'fix'],
  ['enhancement', 'feat'],
  ['feature', 'feat'],
  ['documentation', 'docs'],
];

/** Reject titles that would make release classification depend on the outer prefix. */
export function assertNoDoubleConventionalPrefix(title: string): void {
  if (DOUBLE_PREFIX.test(title.trim())) {
    throw new Error(`Generated title contains a double Conventional Commit prefix: ${title}`);
  }
}

/** Resolve an issue's Conventional Commit type without assuming every change is a feature. */
export function conventionalType(issue: ConventionalIssue): ConventionalCommitType {
  const titleType = issue.title.trim().match(CONVENTIONAL_PREFIX)?.[1] as ConventionalCommitType | undefined;
  if (titleType) return titleType;

  const labels = new Set((issue.labels ?? []).map((label) => label.trim().toLowerCase()));
  return LABEL_TYPES.find(([label]) => labels.has(label))?.[1] ?? 'chore';
}

/** Preserve an existing supported prefix or add the type derived from issue labels. */
export function conventionalTitle(issue: ConventionalIssue, suffix?: string): string {
  const issueTitle = issue.title.trim();
  const title = CONVENTIONAL_PREFIX.test(issueTitle)
    ? issueTitle
    : `${conventionalType(issue)}: ${issueTitle}`;
  const withSuffix = suffix?.trim() ? `${title} ${suffix.trim()}` : title;
  assertNoDoubleConventionalPrefix(withSuffix);
  return withSuffix;
}

/** Aggregate titles use release-safe precedence: feat, then fix, then chore. */
export function conventionalBatchType(issues: readonly ConventionalIssue[]): 'feat' | 'fix' | 'chore' {
  const types = issues.map(conventionalType);
  if (types.includes('feat')) return 'feat';
  if (types.includes('fix')) return 'fix';
  return 'chore';
}

/** Build a guarded aggregate title for batch and quick-session artifacts. */
export function conventionalBatchTitle(
  issues: readonly ConventionalIssue[],
  description: string,
): string {
  const title = `${conventionalBatchType(issues)}: ${description.trim()}`;
  assertNoDoubleConventionalPrefix(title);
  return title;
}
