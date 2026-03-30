/**
 * Prompt Builder — construct prompts for AI agents.
 * Port of loop.sh's build_implement_prompt(), build_review_prompt(), build_learn_prompt().
 * Pure string template functions with no side effects.
 */

export type ImplementPromptOptions = {
  issueNum: number;
  title: string;
  body: string;
  visionContext?: string;
  projectContext?: string;
  previousResult?: string;
  learningContext?: string;
};

export type ReviewPromptOptions = {
  issueNum: number;
  title: string;
  body: string;
  baseBranch: string;
  visionContext?: string;
};

export type LearnPromptOptions = {
  issueNum: number;
  title: string;
  status: string;
  retries: number;
  duration: number;
  diff: string;
  testOutput: string;
  reviewOutput: string;
  verifyOutput: string;
  body?: string;
};

/**
 * Build the implementation prompt for an AI agent.
 * Matches loop.sh lines 1260-1289.
 */
export function buildImplementPrompt(options: ImplementPromptOptions): string {
  const { issueNum, title, body, visionContext, projectContext, previousResult, learningContext } = options;

  const sections: string[] = [
    `Implement GitHub issue #${issueNum}: ${title}`,
    '',
    body,
  ];

  if (visionContext) {
    sections.push('', '', '## Product Vision', visionContext);
  }

  if (projectContext) {
    sections.push('', '', '## Technical Context', projectContext);
  }

  if (previousResult) {
    sections.push('', '', previousResult);
  }

  if (learningContext) {
    sections.push('', '', learningContext);
  }

  sections.push(
    '',
    '## Before You Start',
    '1. Read the product vision and technical context above',
    '2. Make decisions that align with the target users and current priority',
    '3. Understand how your changes connect to existing code',
    "4. If you're creating new files, make sure they're wired into the appropriate entry points",
    '',
    '## After Implementing',
    '1. Write tests for your changes',
    '2. Run the test command to verify',
    `3. Commit with: git commit -m "feat: ${title} (closes #${issueNum})"`,
  );

  return sections.join('\n');
}

/**
 * Build the code review prompt for an AI agent.
 * Matches loop.sh lines 1297-1353.
 */
export function buildReviewPrompt(options: ReviewPromptOptions): string {
  const { issueNum, title, body, baseBranch, visionContext } = options;

  const sections: string[] = [
    `Review the code changes for issue #${issueNum}: ${title}`,
    '',
    `Run git diff origin/${baseBranch}...HEAD to see what changed. Then read the actual files that were modified.`,
    '',
    'Original requirements:',
    body,
  ];

  if (visionContext) {
    sections.push('', '', '## Product Vision (guide your review decisions)', visionContext);
  }

  sections.push(
    '',
    '## Review Checklist',
    '',
    '### 1. Functional Completeness (MOST IMPORTANT)',
    '- Does the implementation FULLY address the issue requirements?',
    '- Are there any acceptance criteria that were NOT implemented?',
    '- If backend API endpoints were created, are they called from the frontend?',
    '- If frontend components were created, do they have working backend endpoints?',
    '- Are there any dead code paths (created but never wired in)?',
    '- Does the feature work end-to-end (data flows from UI → API → database → back to UI)?',
    '',
    '### 2. Integration Gaps',
    '- Are new routes/endpoints registered in the server entry point?',
    '- Are new components imported and rendered in the app?',
    '- Are new database tables/columns used by the API?',
    '- Are there missing imports, missing route registrations, or orphaned files?',
    '',
    '### 3. Code Quality',
    '- Security issues (injection, XSS, auth bypass)',
    '- Missing error handling for user-facing operations',
    '- Missing tests for new functionality',
    '- Code follows project conventions',
    '',
    '### 4. UX Review',
    '- Do UI changes match the target user profile?',
    '- Are error states handled (loading, empty, error)?',
    '- Is the feature discoverable (can users find it)?',
    '',
    '## Actions',
    '',
    'For any issues you find:',
    `- CRITICAL (gaps, missing wiring, broken features): FIX THEM directly, run tests, commit with "fix: address review findings for #${issueNum}"`,
    '- WARNING (quality, security): FIX THEM directly if possible',
    '- INFO (suggestions, minor improvements): Note them in your report but don\'t block',
    '',
    'After fixing, output a structured review report:',
    '',
    '### Findings Fixed',
    '- (list what you found and fixed)',
    '',
    '### Remaining Gaps',
    '- (anything you couldn\'t fix — these need human attention)',
    '',
    '### Verification Notes',
    '- (what a human should manually check)',
  );

  return sections.join('\n');
}

/**
 * Build the learning extraction prompt.
 * Matches loop.sh lines 1369-1416.
 */
export function buildLearnPrompt(options: LearnPromptOptions): string {
  const {
    issueNum, title, status, retries, duration,
    diff, testOutput, reviewOutput, verifyOutput, body,
  } = options;

  const today = new Date().toISOString().split('T')[0];

  return `Analyze this completed development run. Output ONLY a markdown document with the exact structure below. Keep each section to 2-3 bullet points max. Be factual and concise -- no creative writing.

## Run Info
- Issue: #${issueNum} "${title}"
- Status: ${status}
- Retries: ${retries}
- Duration: ${duration}s

## Issue Requirements
${body || '(no description)'}

## Code Changes
${diff || '(no diff available)'}

## Test Results
${testOutput || '(no test output)'}

## Review Findings
${reviewOutput || '(no review output)'}

## Verification Results
${verifyOutput || '(no verification output)'}

Output ONLY this markdown structure, nothing else:

---
issue: ${issueNum}
status: ${status}
retries: ${retries}
duration: ${duration}
date: ${today}
---
## What Worked
- (list what went well)

## What Failed
- (list what went wrong, or "Nothing" if all passed)

## Patterns
- (reusable patterns discovered)

## Anti-Patterns
- (mistakes to avoid in future)

## Suggested Skill Updates
- (specific skill file changes, or "None")`;
}
