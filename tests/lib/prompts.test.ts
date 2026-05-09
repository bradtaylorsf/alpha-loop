import {
  buildImplementPrompt,
  buildReviewPrompt,
  buildLearnPrompt,
  buildIssuePlanPrompt,
  buildBatchPlanPrompt,
  buildBatchImplementPrompt,
  buildBatchReviewPrompt,
  buildSessionReviewPrompt,
  buildTriagePrompt,
  formatEpicPromptContext,
  type EpicPromptContext,
} from '../../src/lib/prompts';

const epicContext: EpicPromptContext = {
  number: 195,
  title: 'Improve epic execution',
  bodySummary: 'Make sub-issue agents aware of the parent epic goal.',
  acceptanceCriteria: [
    '- [ ] Agents receive parent context',
    '- [ ] Sibling checklist order is preserved',
  ],
  subIssues: [
    { issueNum: 188, title: 'Add epic issue template during init', checked: true },
    { issueNum: 189, title: 'Inject parent epic context into sub-issue agents', checked: false },
  ],
};

describe('formatEpicPromptContext', () => {
  test('renders parent title, summary, acceptance criteria, and ordered checklist', () => {
    const prompt = formatEpicPromptContext(epicContext);

    expect(prompt).toContain('## Parent Epic Context');
    expect(prompt).toContain('Epic #195: Improve epic execution');
    expect(prompt).toContain('Make sub-issue agents aware of the parent epic goal.');
    expect(prompt).toContain('- [ ] Agents receive parent context');
    expect(prompt).toContain('1. [x] #188 Add epic issue template during init');
    expect(prompt).toContain('2. [ ] #189 Inject parent epic context into sub-issue agents');
  });
});

describe('buildIssuePlanPrompt', () => {
  test('includes parent epic context when provided', () => {
    const prompt = buildIssuePlanPrompt({
      issueNum: 189,
      title: 'Inject parent context',
      body: 'Child issue body',
      epicContext,
    });

    expect(prompt).toContain('Analyze this GitHub issue and produce a structured implementation plan.');
    expect(prompt).toContain('## Parent Epic Context');
    expect(prompt).toContain('Epic #195: Improve epic execution');
    expect(prompt).toContain('Ordered Sub-Issue Checklist');
  });

  test('omits parent epic context when not provided', () => {
    const prompt = buildIssuePlanPrompt({
      issueNum: 42,
      title: 'Flat issue',
      body: 'Child issue body',
    });

    expect(prompt).not.toContain('## Parent Epic Context');
  });
});

describe('buildImplementPrompt', () => {
  test('includes issue number, title, and body', () => {
    const prompt = buildImplementPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page with email/password fields',
    });

    expect(prompt).toContain('Implement GitHub issue #42: Add login page');
    expect(prompt).toContain('Create a login page with email/password fields');
  });

  test('includes all context sections when provided', () => {
    const prompt = buildImplementPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
      visionContext: 'We are building a SaaS platform',
      projectContext: 'TypeScript, React, Express',
      previousResult: '## Previous Issue Result\nCompleted #41',
      learningContext: '## Learnings\nUse form validation',
    });

    expect(prompt).toContain('## Product Vision');
    expect(prompt).toContain('We are building a SaaS platform');
    expect(prompt).toContain('## Technical Context');
    expect(prompt).toContain('TypeScript, React, Express');
    expect(prompt).toContain('## Previous Issue Result');
    expect(prompt).toContain('## Learnings');
  });

  test('omits empty sections (no blank headers)', () => {
    const prompt = buildImplementPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
    });

    expect(prompt).not.toContain('## Product Vision');
    expect(prompt).not.toContain('## Technical Context');
  });

  test('includes Before You Start and After Implementing sections', () => {
    const prompt = buildImplementPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
    });

    expect(prompt).toContain('## Before You Start');
    expect(prompt).toContain('## After Implementing');
    expect(prompt).toContain('git commit -m "feat: Add login page (closes #42)"');
  });

  test('includes parent epic context and narrow scope guidance when provided', () => {
    const prompt = buildImplementPrompt({
      issueNum: 189,
      title: 'Inject parent context',
      body: 'Child issue body',
      epicContext,
    });

    expect(prompt).toContain('## Parent Epic Context');
    expect(prompt).toContain('Epic #195: Improve epic execution');
    expect(prompt).toContain('Keep the implementation narrowly scoped to issue #189');
    expect(prompt).toContain('Preserve contracts that sibling sub-issues depend on');
  });
});

describe('buildReviewPrompt', () => {
  test('includes issue number, title, and original requirements', () => {
    const prompt = buildReviewPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
      baseBranch: 'master',
    });

    expect(prompt).toContain('Review the code changes for issue #42: Add login page');
    expect(prompt).toContain('Original requirements:');
    expect(prompt).toContain('Create a login page');
  });

  test('includes git diff command with base branch', () => {
    const prompt = buildReviewPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
      baseBranch: 'main',
    });

    expect(prompt).toContain('git diff origin/main...HEAD');
  });

  test('includes all four checklist sections', () => {
    const prompt = buildReviewPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
      baseBranch: 'master',
    });

    expect(prompt).toContain('### 1. Functional Completeness (MOST IMPORTANT)');
    expect(prompt).toContain('### 2. Dependency Wiring (CRITICAL');
    expect(prompt).toContain('### 3. Code Quality');
    expect(prompt).toContain('### 4. Documentation Sync');
    expect(prompt).toContain('### 5. UX Review');
  });

  test('includes Actions section with severity levels', () => {
    const prompt = buildReviewPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
      baseBranch: 'master',
    });

    expect(prompt).toContain('## Actions');
    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('WARNING');
    expect(prompt).toContain('INFO');
  });

  test('includes vision context when provided', () => {
    const prompt = buildReviewPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
      baseBranch: 'master',
      visionContext: 'Enterprise SaaS for finance',
    });

    expect(prompt).toContain('## Product Vision (guide your review decisions)');
    expect(prompt).toContain('Enterprise SaaS for finance');
  });

  test('omits vision section when not provided', () => {
    const prompt = buildReviewPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
      baseBranch: 'master',
    });

    expect(prompt).not.toContain('## Product Vision');
  });

  test('includes gate result JSON schema', () => {
    const prompt = buildReviewPrompt({
      issueNum: 42,
      title: 'Add login page',
      body: 'Create a login page',
      baseBranch: 'master',
    });

    expect(prompt).toContain('## Gate Result (REQUIRED)');
    expect(prompt).toContain('review-issue-42.json');
    expect(prompt).toContain('"passed"');
    expect(prompt).toContain('"findings"');
  });

  test('includes parent epic context when provided', () => {
    const prompt = buildReviewPrompt({
      issueNum: 189,
      title: 'Inject parent context',
      body: 'Child issue body',
      baseBranch: 'master',
      epicContext,
    });

    expect(prompt).toContain('## Parent Epic Context');
    expect(prompt).toContain('judge whether this child issue preserves integration');
  });
});

describe('buildLearnPrompt', () => {
  const baseOptions = {
    issueNum: 42,
    title: 'Add login page',
    status: 'success',
    retries: 1,
    duration: 300,
    diff: 'diff --git a/login.ts b/login.ts\n+export function login() {}',
    testOutput: 'Tests: 5 passed, 0 failed',
    reviewOutput: 'No issues found',
    verifyOutput: 'Verification passed',
    body: 'Create a login page with email/password',
  };

  test('includes all run metadata', () => {
    const prompt = buildLearnPrompt(baseOptions);

    expect(prompt).toContain('## Run Info');
    expect(prompt).toContain('#42 "Add login page"');
    expect(prompt).toContain('Status: success');
    expect(prompt).toContain('Test fix retries: 1');
    expect(prompt).toContain('Duration: 300s');
  });

  test('includes all input sections', () => {
    const prompt = buildLearnPrompt(baseOptions);

    expect(prompt).toContain('## Issue Requirements');
    expect(prompt).toContain('Create a login page with email/password');
    expect(prompt).toContain('## Code Changes');
    expect(prompt).toContain('diff --git');
    expect(prompt).toContain('## Test Results');
    expect(prompt).toContain('Tests: 5 passed');
    expect(prompt).toContain('## Review Findings');
    expect(prompt).toContain('No issues found');
    expect(prompt).toContain('## Verification Results');
    expect(prompt).toContain('Verification passed');
  });

  test('includes frontmatter template in output structure', () => {
    const prompt = buildLearnPrompt(baseOptions);

    expect(prompt).toContain('issue: 42');
    expect(prompt).toContain('status: success');
    expect(prompt).toContain('retries: 1');
    expect(prompt).toContain('duration: 300');
    expect(prompt).toContain('date:');
  });

  test('includes all output sections', () => {
    const prompt = buildLearnPrompt(baseOptions);

    expect(prompt).toContain('## What Worked');
    expect(prompt).toContain('## What Failed');
    expect(prompt).toContain('## Patterns');
    expect(prompt).toContain('## Anti-Patterns');
    expect(prompt).toContain('## Suggested Skill Updates');
  });

  test('uses fallback text when optional fields are empty', () => {
    const prompt = buildLearnPrompt({
      ...baseOptions,
      body: '',
      diff: '',
      testOutput: '',
      reviewOutput: '',
      verifyOutput: '',
    });

    expect(prompt).toContain('(no description)');
    expect(prompt).toContain('(no diff available)');
    expect(prompt).toContain('(no test output)');
    expect(prompt).toContain('(no review output)');
    expect(prompt).toContain('(no verification output)');
  });
});

describe('buildBatchPlanPrompt', () => {
  test('includes dependency_chain in JSON schema', () => {
    const prompt = buildBatchPlanPrompt({
      issues: [{ issueNum: 1, title: 'Test', body: 'Body' }],
    });
    expect(prompt).toContain('dependency_chain');
    expect(prompt).toContain('where_created');
    expect(prompt).toContain('where_consumed');
    expect(prompt).toContain('verified');
  });

  test('instructs planner to grep for dependency verification', () => {
    const prompt = buildBatchPlanPrompt({
      issues: [{ issueNum: 1, title: 'Test', body: 'Body' }],
    });
    expect(prompt).toContain('grep the codebase to verify it exists');
  });

  test('includes parent epic context for epic batches', () => {
    const prompt = buildBatchPlanPrompt({
      issues: [{ issueNum: 189, title: 'Test', body: 'Body' }],
      epicContext,
    });

    expect(prompt).toContain('## Parent Epic Context');
    expect(prompt).toContain('Plan only the listed batch issues');
  });
});

describe('buildBatchImplementPrompt', () => {
  test('includes parent epic context and batch scope guidance', () => {
    const prompt = buildBatchImplementPrompt({
      issues: [{ issueNum: 189, title: 'Test', body: 'Body' }],
      epicContext,
    });

    expect(prompt).toContain('## Parent Epic Context');
    expect(prompt).toContain('Keep this batch limited to the listed issues');
  });
});

describe('buildBatchReviewPrompt', () => {
  test('includes REQUIRED end-to-end flow verification', () => {
    const prompt = buildBatchReviewPrompt({
      issues: [{ issueNum: 1, title: 'Test', body: 'Body' }],
      baseBranch: 'master',
    });
    expect(prompt).toContain('End-to-End Flow Verification (REQUIRED)');
  });

  test('includes silent failure detection in dependency wiring', () => {
    const prompt = buildBatchReviewPrompt({
      issues: [{ issueNum: 1, title: 'Test', body: 'Body' }],
      baseBranch: 'master',
    });
    expect(prompt).toContain('RED FLAG');
    expect(prompt).toContain('silently hide missing injection');
  });

  test('includes parent epic context for epic batches', () => {
    const prompt = buildBatchReviewPrompt({
      issues: [{ issueNum: 189, title: 'Test', body: 'Body' }],
      baseBranch: 'master',
      epicContext,
    });

    expect(prompt).toContain('## Parent Epic Context');
    expect(prompt).toContain('integration-sensitive work across siblings');
  });
});

describe('buildTriagePrompt', () => {
  test('includes epic grouping instructions and guardrails', () => {
    const prompt = buildTriagePrompt({
      issues: [
        { number: 1, title: 'Add settings API', body: 'Implement endpoint', labels: ['ready', 'backend'] },
        { number: 2, title: 'Wire settings UI', body: 'Call endpoint', labels: ['ready', 'frontend'] },
      ],
    });

    expect(prompt).toContain('candidate epic groups');
    expect(prompt).toContain('coherent deliverable');
    expect(prompt).toContain('Labels: ready, backend');
    expect(prompt).toContain('Use each issue\'s Labels line to identify existing epics');
    expect(prompt).toContain('Do NOT propose nested epics');
    expect(prompt).toContain('Do NOT group unrelated issues merely because they share a milestone, label');
  });

  test('includes triage analysis JSON schema with epicGroups', () => {
    const prompt = buildTriagePrompt({
      issues: [{ number: 1, title: 'Issue', body: 'Body' }],
    });

    expect(prompt).toContain('"findings": [');
    expect(prompt).toContain('"epicGroups": [');
    expect(prompt).toContain('"title": "Epic: Settings reliability"');
    expect(prompt).toContain('"goal":');
    expect(prompt).toContain('"rationale":');
    expect(prompt).toContain('"orderedChildIssueNumbers": [46, 47, 48]');
    expect(prompt).toContain('"acceptanceCriteria": [');
    expect(prompt).toContain('{ "findings": [], "epicGroups": [] }');
  });

  test('frames triage as bounded analysis instead of implementation work', () => {
    const prompt = buildTriagePrompt({
      issues: [{ number: 1, title: 'Issue', body: 'Body' }],
      projectContext: 'src/commands/triage.ts handles issue cleanup.',
    });

    expect(prompt).toContain('analysis-only backlog triage task');
    expect(prompt).toContain('not an implementation task');
    expect(prompt).toContain('Do not modify files');
    expect(prompt).toContain('Do not inspect repository files or run shell commands');
    expect(prompt).toContain('Return exactly one JSON object');
    expect(prompt).toContain('Check the provided codebase context');
  });
});

describe('buildSessionReviewPrompt', () => {
  test('includes boot test section', () => {
    const prompt = buildSessionReviewPrompt({
      sessionName: 'test-session',
      baseBranch: 'master',
      issuesSummary: [{ issueNum: 1, title: 'Test', status: 'success', testsPassing: true }],
      includeSecurityScan: false,
    });
    expect(prompt).toContain('Boot Test (REQUIRED before gate result)');
    expect(prompt).toContain('entry point');
    expect(prompt).toContain('smoke_test');
  });

  test('numbers security scan as section 6 when present', () => {
    const prompt = buildSessionReviewPrompt({
      sessionName: 'test-session',
      baseBranch: 'master',
      issuesSummary: [{ issueNum: 1, title: 'Test', status: 'success', testsPassing: true }],
      includeSecurityScan: true,
    });
    expect(prompt).toContain('### 6. Security Scan');
  });
});
