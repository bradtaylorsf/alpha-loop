/**
 * Prompt Builder — construct prompts for AI agents.
 * Pure string template functions with no side effects.
 */

export type ImplementPromptOptions = {
  issueNum: number;
  title: string;
  body: string;
  planContent?: string;
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
 */
export function buildImplementPrompt(options: ImplementPromptOptions): string {
  const { issueNum, title, body, planContent, visionContext, projectContext, previousResult, learningContext } = options;

  const sections: string[] = [
    `Implement GitHub issue #${issueNum}: ${title}`,
    '',
    body,
  ];

  if (planContent) {
    sections.push('', '', `## Implementation Plan`, planContent);
  }

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
    '## Scope Rules (CRITICAL)',
    '- ONLY modify files directly related to this issue',
    '- If tests fail due to environment issues (missing venv, wrong port, missing deps), report it — do NOT rewrite test infrastructure',
    '- Do NOT fix unrelated code, even if you notice problems',
    '- Do NOT modify dev server config, build config, fonts, or styling unless the issue specifically requires it',
    '- If the issue lists "Affected Files/Areas", stay within that scope',
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
    '### 4. Documentation Sync',
    '- If CLI commands were added/changed: is README.md updated? CLAUDE.md? --help text in cli.ts?',
    '- If config options were added/changed: is README.md Configuration Reference updated?',
    '- If directory structure changed: is CLAUDE.md Directory Structure updated?',
    '- Never leave docs referencing commands, options, or paths that no longer exist.',
    '',
    '### 5. UX Review',
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
    `## Gate Result (REQUIRED)`,
    '',
    `After your review, write a JSON file to: review-issue-${issueNum}.json`,
    '',
    'The file must contain ONLY valid JSON with this exact schema:',
    '',
    '{',
    '  "passed": true,',
    '  "summary": "One-line summary of review outcome",',
    '  "findings": [',
    '    {',
    '      "severity": "critical",',
    '      "description": "What the issue is",',
    '      "fixed": true,',
    '      "file": "path/to/affected/file.ts"',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- passed: true if all critical/warning issues were fixed. false if any remain unfixed.',
    '- findings: list ALL issues found, with fixed=true for ones you fixed, fixed=false for ones you could not fix.',
    '- severity: "critical" for blockers, "warning" for should-fix, "info" for notes.',
    '- If you fixed everything and the code is clean, set passed=true with an empty findings array.',
    '- If there are unfixed critical/warning issues, set passed=false — the implementer will be sent back to fix them.',
  );

  return sections.join('\n');
}

export type SessionReviewPromptOptions = {
  sessionName: string;
  baseBranch: string;
  issuesSummary: Array<{
    issueNum: number;
    title: string;
    status: string;
    testsPassing: boolean;
  }>;
  includeSecurityScan: boolean;
  visionContext?: string;
};

/**
 * Build the post-session holistic code review prompt.
 * Reviews the FULL session diff (all issues combined) to catch
 * cross-issue integration problems that per-issue reviews miss.
 */
export function buildSessionReviewPrompt(options: SessionReviewPromptOptions): string {
  const { sessionName, baseBranch, issuesSummary, includeSecurityScan, visionContext } = options;

  const issuesList = issuesSummary.map((i) =>
    `- #${i.issueNum}: ${i.title} — ${i.status}${i.testsPassing ? '' : ' (tests failing)'}`,
  ).join('\n');

  const sections: string[] = [
    `Post-session holistic code review for session: ${sessionName}`,
    '',
    `Run \`git diff origin/${baseBranch}...HEAD\` to see ALL changes made in this session.`,
    'Then read the actual files that were modified.',
    '',
    '## Issues Processed in This Session',
    '',
    issuesList,
    '',
    '## Review Focus',
    '',
    'Each issue already received its own per-issue code review.',
    'Your job is to catch problems that per-issue reviews MISS — things that only become visible when looking at ALL changes together:',
    '',
    '### 1. Cross-Issue Integration (MOST IMPORTANT)',
    '- Do changes from different issues conflict or create inconsistencies?',
    '- Are there duplicate implementations of the same concept from different issues?',
    '- Do shared types, interfaces, or utilities remain consistent across all changes?',
    '- Are there orphaned imports or dead code created when different issues refactored the same area?',
    '',
    '### 2. Completeness vs Requirements',
    '- For each issue above, do the changes actually fulfill what the issue asked for?',
    '- Are there any partial implementations (e.g., new types defined but never used, API endpoints without callers)?',
    '- Did any issue introduce a feature that another issue accidentally broke?',
    '',
    '### 3. Code Quality',
    '- Inconsistent naming or patterns across changes from different issues',
    '- Dead code (functions, imports, variables) that no remaining code references',
    '- Missing error handling at integration boundaries',
  ];

  if (includeSecurityScan) {
    sections.push(
      '',
      '### 4. Security Scan',
      '- Command injection (unquoted shell interpolation, unsanitized user input in exec)',
      '- Path traversal (unchecked relative paths, missing boundary validation)',
      '- Unsafe file operations (writing to user-controlled paths without validation)',
      '- Hardcoded secrets or credentials',
    );
  }

  if (visionContext) {
    sections.push('', '## Product Vision (guide your review decisions)', visionContext);
  }

  sections.push(
    '',
    '## Actions',
    '',
    '- CRITICAL: Fix the issue directly, run tests, and commit with: `git commit -m "fix: address session review findings"`',
    '- WARNING: Fix if possible, commit the fix',
    '- INFO: Note it but do not block',
    '',
    '## Gate Result',
    '',
    'After your review, write your findings to a JSON file named `review-session.json` in the current directory.',
    '',
    '```json',
    '{',
    '  "passed": true,',
    '  "summary": "One-line summary of session review",',
    '  "findings": [',
    '    {',
    '      "severity": "critical|warning|info",',
    '      "description": "What the issue is",',
    '      "fixed": true,',
    '      "file": "path/to/file.ts"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Rules:',
    '- passed=true if all critical/warning issues are fixed.',
    '- passed=false if any critical/warning issues remain unfixed.',
    '- findings: list ALL issues found, with fixed=true for ones you fixed.',
    '- If the code is clean, set passed=true with an empty findings array.',
  );

  return sections.join('\n');
}

/**
 * Build the learning extraction prompt.
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
- Test fix retries: ${retries} (number of times tests failed and the agent was sent back to fix)
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
test_fix_retries: ${retries}
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
