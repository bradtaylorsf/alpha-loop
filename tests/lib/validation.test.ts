import {
  parseDependencies,
  extractFilePaths,
  scoreCompleteness,
  checkDependencyOrder,
  detectOverlap,
  validateIssueQueue,
  printValidationReport,
  commentOnIncompleteIssues,
  type ValidationIssue,
} from '../../src/lib/validation';

jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    step: jest.fn(),
    dry: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../../src/lib/github', () => ({
  commentIssue: jest.fn(),
}));

import { commentIssue } from '../../src/lib/github';
const mockCommentIssue = commentIssue as jest.MockedFunction<typeof commentIssue>;

describe('parseDependencies', () => {
  test('extracts "depends on #N" references', () => {
    expect(parseDependencies('This depends on #42 and depends on #43')).toEqual([42, 43]);
  });

  test('extracts "after #N" references', () => {
    expect(parseDependencies('Should be done after #10')).toEqual([10]);
  });

  test('extracts "requires #N" references', () => {
    expect(parseDependencies('Requires #5 to be completed first')).toEqual([5]);
  });

  test('extracts "blocked by #N" references', () => {
    expect(parseDependencies('Blocked by #7')).toEqual([7]);
  });

  test('deduplicates references', () => {
    expect(parseDependencies('depends on #5, requires #5')).toEqual([5]);
  });

  test('returns empty array for no dependencies', () => {
    expect(parseDependencies('No dependencies here')).toEqual([]);
  });
});

describe('extractFilePaths', () => {
  test('extracts backtick-wrapped file paths', () => {
    const paths = extractFilePaths('Modify `src/lib/config.ts` and `tests/config.test.ts`');
    expect(paths).toContain('src/lib/config.ts');
    expect(paths).toContain('tests/config.test.ts');
  });

  test('extracts standalone file paths', () => {
    const paths = extractFilePaths('The file src/lib/agent.ts needs changes');
    expect(paths).toContain('src/lib/agent.ts');
  });

  test('returns empty array for no paths', () => {
    expect(extractFilePaths('No file paths here')).toEqual([]);
  });

  test('deduplicates paths', () => {
    const paths = extractFilePaths('Edit `src/lib/foo.ts` and also src/lib/foo.ts');
    expect(paths.filter((p) => p === 'src/lib/foo.ts')).toHaveLength(1);
  });
});

describe('scoreCompleteness', () => {
  test('gives high score for detailed issue', () => {
    const issue: ValidationIssue = {
      number: 1,
      title: 'Add validation',
      body: `## Summary
This is a detailed issue with lots of information about what needs to be done.
We need to add validation to the pipeline.

## Acceptance Criteria
- [ ] Add validation function
- [ ] Write tests
- [ ] Update \`src/lib/pipeline.ts\`

\`\`\`typescript
function validate() { return true; }
\`\`\``,
    };
    const { score } = scoreCompleteness(issue);
    expect(score).toBeGreaterThanOrEqual(80);
  });

  test('gives low score for minimal issue', () => {
    const issue: ValidationIssue = {
      number: 2,
      title: 'Fix bug',
      body: 'Fix the bug',
    };
    const { score, reasons } = scoreCompleteness(issue);
    expect(score).toBeLessThan(40);
    expect(reasons.length).toBeGreaterThan(0);
  });

  test('penalizes missing acceptance criteria', () => {
    const withCriteria: ValidationIssue = {
      number: 1,
      title: 'Test',
      body: 'A reasonably long description that explains the feature we need to build in detail with enough context.\n\n- [ ] Criterion 1\n`src/foo.ts`\n```code```',
    };
    const withoutCriteria: ValidationIssue = {
      number: 2,
      title: 'Test',
      body: 'A reasonably long description that explains the feature we need to build in detail with enough context.\n`src/foo.ts`\n```code```',
    };
    const scoreWith = scoreCompleteness(withCriteria).score;
    const scoreWithout = scoreCompleteness(withoutCriteria).score;
    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });
});

describe('checkDependencyOrder', () => {
  test('detects misordered dependencies', () => {
    const issues: ValidationIssue[] = [
      { number: 2, title: 'Build UI', body: 'Depends on #1 for the API endpoint' },
      { number: 1, title: 'Add API endpoint', body: 'Create the REST API' },
    ];
    const { warnings, reordered } = checkDependencyOrder(issues);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].issueNum).toBe(2);
    expect(warnings[0].dependsOn).toBe(1);
    // Reordered should have #1 before #2
    expect(reordered[0].number).toBe(1);
    expect(reordered[1].number).toBe(2);
  });

  test('returns no warnings for correctly ordered deps', () => {
    const issues: ValidationIssue[] = [
      { number: 1, title: 'Add API endpoint', body: 'Create the REST API' },
      { number: 2, title: 'Build UI', body: 'Depends on #1' },
    ];
    const { warnings } = checkDependencyOrder(issues);
    expect(warnings).toHaveLength(0);
  });

  test('ignores dependencies not in the queue', () => {
    const issues: ValidationIssue[] = [
      { number: 5, title: 'Feature', body: 'Depends on #99' },
    ];
    const { warnings } = checkDependencyOrder(issues);
    expect(warnings).toHaveLength(0);
  });

  test('handles circular dependencies gracefully', () => {
    const issues: ValidationIssue[] = [
      { number: 1, title: 'A', body: 'Depends on #2' },
      { number: 2, title: 'B', body: 'Depends on #1' },
    ];
    const { reordered } = checkDependencyOrder(issues);
    // Should return original order on cycle
    expect(reordered).toHaveLength(2);
  });
});

describe('detectOverlap', () => {
  test('detects shared files between issues', () => {
    const issues: ValidationIssue[] = [
      { number: 1, title: 'A', body: 'Edit `src/lib/config.ts`' },
      { number: 2, title: 'B', body: 'Modify `src/lib/config.ts` and `src/lib/agent.ts`' },
    ];
    const warnings = detectOverlap(issues);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].sharedFiles).toContain('src/lib/config.ts');
  });

  test('returns empty for no overlap', () => {
    const issues: ValidationIssue[] = [
      { number: 1, title: 'A', body: 'Edit `src/lib/config.ts`' },
      { number: 2, title: 'B', body: 'Edit `src/lib/agent.ts`' },
    ];
    expect(detectOverlap(issues)).toHaveLength(0);
  });
});

describe('validateIssueQueue', () => {
  test('returns full report combining all checks', () => {
    const issues: ValidationIssue[] = [
      { number: 2, title: 'UI', body: 'Depends on #1. Edit `src/lib/config.ts`' },
      { number: 1, title: 'API', body: 'Create endpoint. Edit `src/lib/config.ts`\n\n- [ ] Done\n```ts\ncode\n```' },
    ];
    const report = validateIssueQueue(issues);
    expect(report.dependencyWarnings.length).toBeGreaterThanOrEqual(1);
    expect(report.overlapWarnings.length).toBeGreaterThanOrEqual(1);
    expect(report.reorderedQueue).toBeDefined();
  });

  test('skips issues below completeness threshold', () => {
    const issues: ValidationIssue[] = [
      { number: 1, title: 'Good', body: 'Detailed issue with lots of context and information.\n\n- [ ] Criterion\n`src/foo.ts`\n```code```' },
      { number: 2, title: 'Bad', body: 'Fix bug' },
    ];
    const report = validateIssueQueue(issues, 40);
    expect(report.skippedIssues).toContain(2);
    expect(report.skippedIssues).not.toContain(1);
  });
});

describe('printValidationReport', () => {
  test('prints report without errors', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation();
    printValidationReport({
      dependencyWarnings: [],
      reorderedQueue: [],
      completenessWarnings: [],
      overlapWarnings: [],
      skippedIssues: [],
    });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('commentOnIncompleteIssues', () => {
  test('posts comments on incomplete issues', () => {
    commentOnIncompleteIssues('owner/repo', {
      dependencyWarnings: [],
      reorderedQueue: [],
      completenessWarnings: [
        { issueNum: 42, title: 'Bad issue', score: 20, reasons: ['Too short'] },
      ],
      overlapWarnings: [],
      skippedIssues: [42],
    });
    expect(mockCommentIssue).toHaveBeenCalledWith(
      'owner/repo',
      42,
      expect.stringContaining('Pre-Session Validation'),
    );
  });
});
