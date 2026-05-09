/**
 * Prompt Builder — construct prompts for AI agents.
 * Pure string template functions with no side effects.
 */

export type ImplementPromptOptions = {
  issueNum: number;
  title: string;
  body: string;
  comments?: Array<{ author: string; body: string; createdAt: string }>;
  planContent?: string;
  epicContext?: EpicPromptContext;
  visionContext?: string;
  projectContext?: string;
  previousResult?: string;
  learningContext?: string;
};

export type ReviewPromptOptions = {
  issueNum: number;
  title: string;
  body: string;
  comments?: Array<{ author: string; body: string; createdAt: string }>;
  baseBranch: string;
  epicContext?: EpicPromptContext;
  visionContext?: string;
};

export type EpicPromptContext = {
  number: number;
  title: string;
  bodySummary: string;
  acceptanceCriteria: string[];
  subIssues: Array<{
    issueNum: number;
    title?: string;
    checked: boolean;
  }>;
};

/** A single issue within a batch. */
export type BatchIssue = {
  issueNum: number;
  title: string;
  body: string;
  comments?: Array<{ author: string; body: string; createdAt: string }>;
};

export type BatchPlanPromptOptions = {
  issues: BatchIssue[];
  epicContext?: EpicPromptContext;
};

export type BatchImplementPromptOptions = {
  issues: BatchIssue[];
  planContent?: string;
  epicContext?: EpicPromptContext;
  visionContext?: string;
  projectContext?: string;
  learningContext?: string;
};

export type BatchReviewPromptOptions = {
  issues: BatchIssue[];
  baseBranch: string;
  epicContext?: EpicPromptContext;
  visionContext?: string;
};

export type IssuePlanPromptOptions = {
  issueNum: number;
  title: string;
  body: string;
  epicContext?: EpicPromptContext;
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

function normalizeBulletText(text: string): string {
  return text.trim().replace(/^[-*]\s+/, '').trim();
}

export function formatEpicPromptContext(context: EpicPromptContext): string {
  const lines: string[] = [
    '## Parent Epic Context',
    '',
    `Epic #${context.number}: ${context.title}`,
    '',
    '### Goal / Body Summary',
    context.bodySummary.trim() || '(no parent epic body summary available)',
    '',
    '### Acceptance Criteria',
  ];

  if (context.acceptanceCriteria.length > 0) {
    for (const criterion of context.acceptanceCriteria) {
      lines.push(`- ${normalizeBulletText(criterion)}`);
    }
  } else {
    lines.push('- (none identified in parent epic body)');
  }

  lines.push('', '### Ordered Sub-Issue Checklist');
  if (context.subIssues.length > 0) {
    context.subIssues.forEach((issue, index) => {
      const status = issue.checked ? '[x]' : '[ ]';
      const title = issue.title ? ` ${issue.title}` : '';
      lines.push(`${index + 1}. ${status} #${issue.issueNum}${title}`);
    });
  } else {
    lines.push('(no sub-issues found)');
  }

  return lines.join('\n');
}

function appendEpicContextSection(
  sections: string[],
  epicContext: EpicPromptContext | undefined,
  guidance?: string[],
): void {
  if (!epicContext) return;
  sections.push('', '', formatEpicPromptContext(epicContext));
  if (guidance && guidance.length > 0) {
    sections.push('', '### Epic Scope Guidance', ...guidance.map((line) => `- ${line}`));
  }
}

/**
 * Build the planning prompt for a single issue.
 */
export function buildIssuePlanPrompt(options: IssuePlanPromptOptions): string {
  const { issueNum, title, body, epicContext } = options;

  const sections: string[] = [
    'Analyze this GitHub issue and produce a structured implementation plan.',
    '',
    `Issue #${issueNum}: ${title}`,
    '',
    body,
  ];

  appendEpicContextSection(sections, epicContext, [
    `Plan only the work needed for issue #${issueNum}; use sibling items to understand dependencies and integration boundaries.`,
  ]);

  sections.push(
    '',
    '',
    `Write a JSON file to: plan-issue-${issueNum}.json`,
    '',
    'The file must contain ONLY valid JSON with this exact schema:',
    '',
    '{',
    '  "summary": "One-line description of what needs to be done",',
    '  "files": ["src/path/to/file.ts", "..."],',
    '  "implementation": "Concise step-by-step plan. What to create, modify, wire up. No issue restatement.",',
    '  "testing": {',
    '    "needed": true,',
    '    "reason": "Why tests are or aren\'t needed for this change"',
    '  },',
    '  "verification": {',
    '    "needed": false,',
    '    "method": "playwright",',
    '    "command": "optional shell command for script/cli/boot/api methods",',
    '    "instructions": "If needed: specific steps to verify the feature. If not needed: omit this field.",',
    '    "reason": "Why verification is or isn\'t needed"',
    '  }',
    '}',
    '',
    'Rules:',
    '- testing.needed: true if ANY code changes could affect behavior. false only for docs, config, or comments.',
    '- verification.needed: true if the issue changes behavior that can be validated at runtime.',
    '- verification.method: "playwright" for UI changes, "script" for validation scripts, "boot" for service startup checks, "cli" for CLI testing, "api" for API endpoint testing.',
    '- verification.command: required for script/cli/boot/api methods - the shell command to run. Exit code 0 = pass.',
    '- verification.instructions: for playwright method, list the exact playwright-cli commands to verify.',
    '- implementation: be concise and actionable. List files to modify and what to change in each.',
    '- Write ONLY the JSON file. Do not create any other files or make any code changes.',
  );

  return sections.join('\n');
}

/**
 * Build the implementation prompt for an AI agent.
 */
export function buildImplementPrompt(options: ImplementPromptOptions): string {
  const { issueNum, title, body, comments, planContent, epicContext, visionContext, projectContext, previousResult, learningContext } = options;

  const sections: string[] = [
    `Implement GitHub issue #${issueNum}: ${title}`,
    '',
    body,
  ];

  appendEpicContextSection(sections, epicContext, [
    `Keep the implementation narrowly scoped to issue #${issueNum}. Do not implement sibling checklist items unless this issue explicitly requires shared integration work.`,
    'Preserve contracts that sibling sub-issues depend on, and call out any integration assumptions in your final notes.',
  ]);

  if (comments && comments.length > 0) {
    sections.push('', '', '## Discussion (issue comments)');
    for (const c of comments) {
      sections.push(`- **@${c.author}** (${c.createdAt}): ${c.body}`);
    }
  }

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
 * Build a batch planning prompt — plans all issues in a single agent call.
 * The agent writes one plan JSON per issue.
 */
export function buildBatchPlanPrompt(options: BatchPlanPromptOptions): string {
  const { issues, epicContext } = options;

  const issueList = issues.map((i) => {
    let entry = `### Issue #${i.issueNum}: ${i.title}\n${i.body || '(no description)'}`;
    if (i.comments && i.comments.length > 0) {
      entry += '\n\n**Comments:**';
      for (const c of i.comments) {
        entry += `\n- **@${c.author}** (${c.createdAt}): ${c.body}`;
      }
    }
    return entry;
  }).join('\n\n');

  const fileList = issues.map((i) => `plan-issue-${i.issueNum}.json`).join(', ');
  const epicSection = epicContext
    ? `\n\n${formatEpicPromptContext(epicContext)}\n\n### Epic Scope Guidance\n- Plan only the listed batch issues. Use unchecked sibling items to identify integration boundaries, not to expand this batch scope.`
    : '';

  return `Analyze the following GitHub issues and produce a structured implementation plan for EACH one.${epicSection}

## Issues to Plan

${issueList}

## Output

Write one JSON file per issue: ${fileList}

Each file must contain ONLY valid JSON with this exact schema:

{
  "summary": "One-line description of what needs to be done",
  "files": ["src/path/to/file.ts", "..."],
  "implementation": "Concise step-by-step plan. What to create, modify, wire up.",
  "testing": {
    "needed": true,
    "reason": "Why tests are or aren't needed for this change"
  },
  "verification": {
    "needed": false,
    "instructions": "If needed: specific steps to verify the feature.",
    "reason": "Why verification is or isn't needed"
  },
  "dependency_chain": [
    {
      "what": "service or module this feature depends on",
      "where_created": "file:line where it's instantiated",
      "where_consumed": "file:line where this feature uses it",
      "verified": true
    }
  ]
}

## Rules
- Consider dependencies BETWEEN issues — if issue A creates something issue B uses, note that in the plan.
- For each dependency your plan references, grep the codebase to verify it exists and note where it is instantiated. Set verified=true only if you confirmed the dependency exists.
- testing.needed: true if ANY code changes could affect behavior. false only for docs, config, or comments.
- verification.needed: true ONLY if the issue changes user-visible UI that can be tested in a browser.
- implementation: be concise and actionable. List files to modify and what to change in each.
- Write ONLY the JSON files. Do not create any other files or make any code changes.`;
}

/**
 * Build a batch implementation prompt — implements all issues in a single agent call.
 */
export function buildBatchImplementPrompt(options: BatchImplementPromptOptions): string {
  const { issues, planContent, epicContext, visionContext, projectContext, learningContext } = options;

  const issueList = issues.map((i) => {
    let entry = `### Issue #${i.issueNum}: ${i.title}\n${i.body || '(no description)'}`;
    if (i.comments && i.comments.length > 0) {
      entry += '\n\n**Comments:**';
      for (const c of i.comments) {
        entry += `\n- **@${c.author}** (${c.createdAt}): ${c.body}`;
      }
    }
    return entry;
  }).join('\n\n');

  const closesRefs = issues.map((i) => `closes #${i.issueNum}`).join(', ');

  const sections: string[] = [
    `Implement the following ${issues.length} GitHub issues. Work through them in order, committing after each one.`,
    '',
    '## Issues to Implement',
    '',
    issueList,
  ];

  appendEpicContextSection(sections, epicContext, [
    'Keep this batch limited to the listed issues. Leave other sibling checklist items for their own runs unless a shared integration contract must be preserved.',
    'When touching shared code, maintain compatibility with sibling work described in the epic checklist.',
  ]);

  if (planContent) {
    sections.push('', '', '## Implementation Plans', planContent);
  }

  if (visionContext) {
    sections.push('', '', '## Product Vision', visionContext);
  }

  if (projectContext) {
    sections.push('', '', '## Technical Context', projectContext);
  }

  if (learningContext) {
    sections.push('', '', learningContext);
  }

  sections.push(
    '',
    '## Scope Rules (CRITICAL)',
    '- ONLY modify files directly related to these issues',
    '- If tests fail due to environment issues (missing venv, wrong port, missing deps), report it — do NOT rewrite test infrastructure',
    '- Do NOT fix unrelated code, even if you notice problems',
    '- Do NOT modify dev server config, build config, fonts, or styling unless an issue specifically requires it',
    '',
    '## Workflow',
    '1. Read the product vision and technical context above',
    '2. Consider dependencies between the issues — implement foundational ones first',
    '3. For EACH issue, in order:',
    '   a. Implement the changes',
    '   b. Write tests for those changes',
    '   c. Run the test command to verify',
    '   d. Commit with: `git commit -m "feat: <title> (closes #<issueNum>)"`',
    '4. After all issues are done, run the full test suite one final time',
    '',
    '## Commit Convention',
    'Make ONE commit per issue. Each commit message must include `closes #<issueNum>` for the specific issue.',
    `Example: git commit -m "feat: add user auth (closes #42)"`,
  );

  return sections.join('\n');
}

/**
 * Build a batch review prompt — reviews all issues' changes in a single agent call.
 */
export function buildBatchReviewPrompt(options: BatchReviewPromptOptions): string {
  const { issues, baseBranch, epicContext, visionContext } = options;

  const issueList = issues.map((i) => {
    let entry = `### Issue #${i.issueNum}: ${i.title}\n${i.body || '(no description)'}`;
    if (i.comments && i.comments.length > 0) {
      entry += '\n\n**Comments:**';
      for (const c of i.comments) {
        entry += `\n- **@${c.author}** (${c.createdAt}): ${c.body}`;
      }
    }
    return entry;
  }).join('\n\n');

  const sections: string[] = [
    `Review the code changes for the following ${issues.length} issues.`,
    '',
    `Run git diff origin/${baseBranch}...HEAD to see all changes. Then read the actual files that were modified.`,
    '',
    '## Issues Implemented',
    '',
    issueList,
  ];

  appendEpicContextSection(sections, epicContext, [
    'Use the epic context to judge integration-sensitive work across siblings.',
    'Do not block this batch for unrelated sibling checklist items that were intentionally left for separate runs.',
  ]);

  if (visionContext) {
    sections.push('', '', '## Product Vision (guide your review decisions)', visionContext);
  }

  sections.push(
    '',
    '## Review Checklist',
    '',
    '### 1. Per-Issue Completeness (MOST IMPORTANT)',
    '- For EACH issue above, does the implementation FULLY address the requirements?',
    '- Are there any acceptance criteria that were NOT implemented?',
    '- Are there dead code paths (created but never wired in)?',
    '',
    '### 2. Cross-Issue Integration',
    '- Do changes from different issues conflict or create inconsistencies?',
    '- Are there duplicate implementations across issues?',
    '- Do shared types, interfaces, or utilities remain consistent?',
    '',
    '### 3. Dependency Wiring (CRITICAL — most common source of silent failures)',
    '- For every service/repo/dependency that new code USES: is it instantiated AND passed to the consumer?',
    '- RED FLAG: Parameters defaulting to None with "if x is not None" guards — may silently hide missing injection.',
    '- For new routes: static routes must be registered BEFORE parameterized routes to avoid shadowing.',
    '- For new data consumers: trace data back to its source — if a script reads from a table, verify something writes to it.',
    '- For metrics: are values real or estimated/hardcoded?',
    '',
    '### 4. End-to-End Flow Verification (REQUIRED)',
    '- Pick the MOST critical data flow touched by this batch and trace it:',
    '  1. Where is data created? (tool execution, API call, user action)',
    '  2. Where is it persisted? (repo.save(), DB write)',
    '  3. Where is it read back? (query, API endpoint)',
    '  4. Where is it displayed? (dashboard, CLI output, eval score)',
    '- If ANY step in the chain is broken (service not injected, query returns empty because nothing writes), that is a CRITICAL finding.',
    '',
    '### 5. Code Quality',
    '- Security issues (injection, XSS, auth bypass)',
    '- Missing error handling for user-facing operations',
    '- Missing tests for new functionality',
    '',
    '## Actions',
    '',
    'For any issues you find:',
    '- CRITICAL: FIX THEM directly, run tests, commit with `git commit -m "fix: address review findings"`',
    '- WARNING: FIX THEM directly if possible',
    '- INFO: Note them but don\'t block',
    '',
    '## Gate Result (REQUIRED)',
    '',
    'After your review, write a JSON file to: review-batch.json',
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
    '      "file": "path/to/affected/file.ts",',
    '      "issueNum": 42',
    '    }',
    '  ]',
    '}',
    '',
    'Rules:',
    '- passed: true if all critical/warning issues were fixed.',
    '- findings: list ALL issues found, with fixed=true for ones you fixed.',
    '- Include issueNum in each finding to track which issue it relates to.',
    '- If everything is clean, set passed=true with an empty findings array.',
  );

  return sections.join('\n');
}

/**
 * Build the code review prompt for an AI agent.
 */
export function buildReviewPrompt(options: ReviewPromptOptions): string {
  const { issueNum, title, body, comments, baseBranch, epicContext, visionContext } = options;

  const sections: string[] = [
    `Review the code changes for issue #${issueNum}: ${title}`,
    '',
    `Run git diff origin/${baseBranch}...HEAD to see what changed. Then read the actual files that were modified.`,
    '',
    'Original requirements:',
    body,
  ];

  appendEpicContextSection(sections, epicContext, [
    'Use the epic context to judge whether this child issue preserves integration with sibling work.',
    `Do not fail issue #${issueNum} for parent checklist items that belong to other sub-issues unless this change breaks their integration contract.`,
  ]);

  if (comments && comments.length > 0) {
    sections.push('', 'Discussion (issue comments):');
    for (const c of comments) {
      sections.push(`- **@${c.author}** (${c.createdAt}): ${c.body}`);
    }
  }

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
    '### 2. Dependency Wiring (CRITICAL — most common source of silent failures)',
    '- For every service, repo, or dependency the new code USES:',
    '  1. Is it instantiated somewhere? (e.g., in a bootstrap function, DI container, or factory)',
    '  2. Is it actually PASSED to the consumer? Check function call sites — not just that the parameter exists.',
    '  3. RED FLAG: If a parameter defaults to None and code guards with "if x is not None" — this may silently hide missing injection. The guard makes tests pass but the feature is dead.',
    '- For new routes: Are static routes (e.g., /evals/compare) registered BEFORE parameterized routes (e.g., /evals/{id})? Parameterized routes shadow static ones in most frameworks.',
    '- For new data consumers (scripts, eval engines, dashboards): Trace the data back to its source. If a script queries a table, verify that something actually WRITES to that table in the production pipeline.',
    '- For metrics and cost tracking: Are values computed from real data or estimated/hardcoded? Hardcoded "0" or len()//4 estimates violate data accuracy if displayed as real metrics.',
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
  epicContext?: EpicPromptContext;
  visionContext?: string;
};

/**
 * Build the post-session holistic code review prompt.
 * Reviews the FULL session diff (all issues combined) to catch
 * cross-issue integration problems that per-issue reviews miss.
 */
export function buildSessionReviewPrompt(options: SessionReviewPromptOptions): string {
  const { sessionName, baseBranch, issuesSummary, includeSecurityScan, epicContext, visionContext } = options;

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
    '### 2. Dependency Wiring Across Issues',
    '- If Issue A creates a service/repo and Issue B consumes data from it: is the service actually injected in the bootstrap/DI layer?',
    '- Are there None-guard patterns (if x is not None) that silently hide missing wiring?',
    '- For new data pipelines: trace from write (tool execution, API call) → persist (DB) → read (query) → display (UI/CLI). Is any step broken?',
    '',
    '### 3. Completeness vs Requirements',
    '- For each issue above, do the changes actually fulfill what the issue asked for?',
    '- Are there any partial implementations (e.g., new types defined but never used, API endpoints without callers)?',
    '- Did any issue introduce a feature that another issue accidentally broke?',
    '',
    '### 4. Code Quality',
    '- Inconsistent naming or patterns across changes from different issues',
    '- Dead code (functions, imports, variables) that no remaining code references',
    '- Missing error handling at integration boundaries',
  ];

  appendEpicContextSection(sections, epicContext, [
    'Use this parent epic context to catch cross-issue integration problems across the processed sub-issues.',
  ]);

  sections.push(
    '',
    '### 5. Boot Test (REQUIRED before gate result)',
    '- Run the application\'s entry point and verify it starts without import errors.',
    '- If a smoke_test command is configured in .alpha-loop.yaml, run it and report results.',
    '- If the entry point fails to start (import errors, missing modules, syntax errors), that is a CRITICAL finding.',
  );

  if (includeSecurityScan) {
    sections.push(
      '',
      '### 6. Security Scan',
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

export type AssumptionsPromptOptions = {
  issueNum: number;
  title: string;
  body: string;
  diff: string;
  reviewSummary: string;
};

/**
 * Build a prompt that asks the agent to summarize assumptions and decisions
 * made during implementation. Posted as a comment for user validation.
 */
export function buildAssumptionsPrompt(options: AssumptionsPromptOptions): string {
  const { issueNum, title, body, diff, reviewSummary } = options;

  return `You just implemented GitHub issue #${issueNum}: ${title}

## Original Requirements
${body}

## Code Changes (first 5000 chars)
${diff.slice(0, 5000)}

## Review Summary
${reviewSummary}

Analyze the implementation and list any assumptions or decisions you had to make where the requirements were ambiguous or incomplete. Output ONLY a markdown document with this structure:

## Assumptions
- (list each assumption made, e.g. "Assumed the date format should be ISO 8601 since it wasn't specified")
- If no assumptions were needed, write "None — requirements were fully specified"

## Decisions
- (list each design/implementation decision where multiple valid approaches existed, e.g. "Chose to validate on the server side rather than client side for security")
- If no notable decisions, write "None — implementation was straightforward"

## Items to Validate
- (list specific things the user should check, e.g. "Verify the error message wording matches your team's style guide")
- If nothing needs validation, write "None"

Keep it concise. Only include genuinely ambiguous items, not obvious implementation choices.`;
}

export type TriagePromptOptions = {
  issues: Array<{
    number: number;
    title: string;
    body: string;
    labels?: string[];
    comments?: Array<{ author: string; body: string; createdAt: string }>;
  }>;
  projectContext?: string | null;
  visionContext?: string | null;
};

/**
 * Build the triage analysis prompt for an AI agent.
 * Instructs the agent to categorize open issues and output TriageAnalysis JSON.
 */
export function buildTriagePrompt(options: TriagePromptOptions): string {
  const { issues, projectContext, visionContext } = options;

  const capped = issues.slice(0, 100);
  const cappedWarning = issues.length > 100
    ? `\n\nWARNING: Only the first 100 of ${issues.length} issues are included. There may be more issues not shown here.`
    : '';

  const issueList = capped.map((i) => {
    const labels = i.labels && i.labels.length > 0 ? i.labels.join(', ') : '(none)';
    let entry = `### Issue #${i.number}: ${i.title}\nLabels: ${labels}\n\n${i.body || '(no description)'}`;
    if (i.comments && i.comments.length > 0) {
      const commentLines = i.comments.map((c) =>
        `- **@${c.author}** (${c.createdAt}): ${c.body.length > 200 ? c.body.slice(0, 200) + '...' : c.body}`
      ).join('\n');
      entry += `\n\n**Comments:**\n${commentLines}`;
    }
    return entry;
  }).join('\n\n');

  const sections: string[] = [
    'You are a project triage assistant. Analyze the following open GitHub issues and categorize any that need attention.',
    '',
    '## Open Issues',
    issueList,
    cappedWarning,
  ];

  if (visionContext) {
    sections.push('', '## Product Vision', visionContext);
  }

  if (projectContext) {
    sections.push('', '## Technical Context', projectContext);
  }

  sections.push(
    '',
    '## Instructions',
    '',
    'For each issue, determine if it falls into one of these categories:',
    '- **stale**: No longer relevant given the current codebase state (e.g., referenced files deleted, feature already implemented)',
    '- **unclear**: Missing acceptance criteria, vague scope, no clear "done" definition',
    '- **too_large**: Should be split into 2-4 smaller, focused issues',
    '- **duplicate**: Substantially overlaps with another open issue',
    '- **enrich**: Raw support ticket, sparse form submission, or bug report that needs investigation and enrichment — has some useful info but lacks technical detail, affected areas, acceptance criteria, or reproduction steps',
    '- **ok**: Issue is fine as-is — do NOT include "ok" issues in output',
    '',
    'For each finding, provide:',
    '- `reason`: Brief explanation of why this issue was flagged',
    '- For `unclear` issues: include `rewrittenBody` with proper acceptance criteria in checkbox format (`- [ ] Criterion`)',
    '- For `enrich` issues: include `enrichedBody` — a thorough rewrite that preserves the original description in a collapsed `<details>` block, then adds: summary, affected files/areas (inferred from codebase context), acceptance criteria, and reproduction steps if applicable. Use the issue comments for additional context.',
    '- For `too_large` issues: include `splitInto` array of title strings for the sub-issues',
    '- For `duplicate` issues: include `duplicateOf` with the canonical issue number',
    '',
    'Also identify candidate epic groups among the open issues when multiple existing issues form one coherent deliverable.',
    'An epic group should represent a single outcome with a clear goal, concrete rationale, and an ordered set of existing child issue numbers.',
    'Use each issue\'s Labels line to identify existing epics. Do NOT propose nested epics: do not include issues labeled `epic`, issues that are already parent epics, umbrella planning issues, or issues whose purpose is to collect child issues.',
    'Do NOT group unrelated issues merely because they share a milestone, label, component, or broad theme; the rationale must cite a concrete shared deliverable, dependency chain, or acceptance goal.',
    'Epic groups must use existing open issue numbers only. Do not list newly split sub-issue titles from `too_large` findings as epic children.',
    '',
    'Check the codebase context for staleness signals (referenced files deleted, features already implemented).',
    'When rewriting unclear issues, use markdown with acceptance criteria in checkbox format.',
    'When enriching issues, analyze the codebase context to identify affected files and areas, and validate that the reported issue is plausible.',
    '',
    '## Output Requirements',
    '',
    'Output ONLY valid JSON matching this schema (no explanation, no surrounding text).',
    'The example below uses fences for illustration only — your output must be raw JSON with no fences:',
    '',
    '```json',
    '{',
    '  "findings": [',
    '    {',
    '      "issueNum": 42,',
    '      "title": "Issue title",',
    '      "category": "stale",',
    '      "reason": "This feature was already implemented in PR #30",',
    '      "action": "close",',
    '      "selected": true',
    '    },',
    '    {',
    '      "issueNum": 43,',
    '      "title": "Vague issue title",',
    '      "category": "unclear",',
    '      "reason": "No acceptance criteria, scope is ambiguous",',
    '      "action": "rewrite",',
    '      "rewrittenBody": "## Summary\\n...\\n\\n## Acceptance Criteria\\n- [ ] Criterion 1\\n- [ ] Criterion 2",',
    '      "selected": true',
    '    },',
    '    {',
    '      "issueNum": 44,',
    '      "title": "Large issue title",',
    '      "category": "too_large",',
    '      "reason": "Covers 3 independent features",',
    '      "action": "split",',
    '      "splitInto": ["Sub-issue A", "Sub-issue B", "Sub-issue C"],',
    '      "selected": true',
    '    },',
    '    {',
    '      "issueNum": 45,',
    '      "title": "Duplicate issue",',
    '      "category": "duplicate",',
    '      "reason": "Same scope as #42",',
    '      "action": "merge",',
    '      "duplicateOf": 42,',
    '      "selected": true',
    '    },',
    '    {',
    '      "issueNum": 46,',
    '      "title": "Button broken on settings page",',
    '      "category": "enrich",',
    '      "reason": "Raw support ticket with minimal detail — needs affected areas, reproduction steps, and acceptance criteria",',
    '      "action": "enrich",',
    '      "enrichedBody": "<details><summary>Original description</summary>\\n\\nButton broken on settings page\\n\\n</details>\\n\\n## Summary\\nThe save button on the settings page is non-functional...\\n\\n## Affected Areas\\n- `src/components/Settings.tsx`\\n\\n## Acceptance Criteria\\n- [ ] Save button triggers form submission\\n- [ ] Success feedback shown to user\\n\\n## Reproduction Steps\\n1. Navigate to Settings\\n2. Click Save\\n3. Observe no response",',
    '      "selected": true',
    '    }',
    '  ],',
    '  "epicGroups": [',
    '    {',
    '      "title": "Epic: Settings reliability",',
    '      "goal": "Make settings changes save reliably and expose clear user feedback.",',
    '      "rationale": "Issues #46, #47, and #48 all describe dependent parts of the same settings-save workflow; completing them together creates one coherent deliverable.",',
    '      "orderedChildIssueNumbers": [46, 47, 48],',
    '      "acceptanceCriteria": [',
    '        "- [ ] Settings saves persist successfully",',
    '        "- [ ] Users see success and failure states",',
    '        "- [ ] Regression coverage exists for the settings-save flow"',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## Rules',
    '- Only include issues that need action (skip "ok" issues)',
    '- Always output an object with `findings` and `epicGroups` arrays',
    '- If ALL issues are fine, output `{ "findings": [], "epicGroups": [] }`',
    '- If there are cleanup findings but no epic groups, set `epicGroups: []`',
    '- If there are epic groups but no cleanup findings, set `findings: []`',
    '- Set `selected: true` for all findings (user will deselect if needed)',
    '- action mapping: stale→close, unclear→rewrite, too_large→split, duplicate→merge, enrich→enrich',
    '- Be conservative — only flag issues when you are confident about the categorization',
    '- Prefer `enrich` over `unclear` for issues that have some useful info (e.g., support tickets, bug reports) but need technical detail added',
    '- For epic groups, include at least two ordered child issue numbers and at least one acceptance criterion',
  );

  return sections.join('\n');
}

export type RoadmapPromptOptions = {
  issues: Array<{ number: number; title: string; body: string; milestone: string | null }>;
  milestones: Array<{ title: string; description: string; dueOn: string | null }>;
  projectContext?: string | null;
  visionContext?: string | null;
};

/**
 * Build the roadmap prompt for an AI agent.
 * Instructs the agent to suggest milestone groupings for open issues.
 */
export function buildRoadmapPrompt(options: RoadmapPromptOptions): string {
  const { issues, milestones, projectContext, visionContext } = options;

  const capped = issues.slice(0, 100);
  const cappedWarning = issues.length > 100
    ? `\n\nWARNING: Only the first 100 of ${issues.length} issues are included.`
    : '';

  const issueList = capped.map((i) => {
    const ms = i.milestone ? ` [milestone: ${i.milestone}]` : ' [unassigned]';
    const body = i.body.length > 300 ? i.body.slice(0, 300) + '...' : i.body;
    return `### Issue #${i.number}: ${i.title}${ms}\n${body || '(no description)'}`;
  }).join('\n\n');

  const milestoneList = milestones.length > 0
    ? milestones.map((m) => {
        const due = m.dueOn ? ` (due: ${m.dueOn})` : '';
        return `- **${m.title}**${due}: ${m.description || '(no description)'}`;
      }).join('\n')
    : '(none)';

  const sections: string[] = [
    'You are a project roadmap assistant. Analyze the following open issues and existing milestones, then suggest how to organize issues into milestones.',
    '',
    '## Open Issues',
    issueList,
    cappedWarning,
    '',
    '## Existing Milestones',
    milestoneList,
  ];

  if (visionContext) {
    sections.push('', '## Product Vision', visionContext);
  }

  if (projectContext) {
    sections.push('', '## Technical Context', projectContext);
  }

  sections.push(
    '',
    '## Output Requirements',
    '',
    'Output ONLY valid JSON matching this schema (no explanation, no surrounding text).',
    'The example below uses fences for illustration only — your output must be raw JSON with no fences:',
    '',
    '```json',
    '{',
    '  "milestones": [',
    '    {',
    '      "title": "001 - Milestone Name",',
    '      "description": "What this milestone delivers",',
    '      "dueOn": "2026-05-01",',
    '      "order": 1',
    '    }',
    '  ],',
    '  "assignments": [',
    '    {',
    '      "issueNum": 3,',
    '      "title": "Issue title",',
    '      "milestone": "001 - Milestone Name",',
    '      "currentMilestone": "",',
    '      "selected": true',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '## Instructions',
    '- Respect existing milestone structure — reuse existing milestones where appropriate',
    '- Only create new milestones when issues clearly don\'t fit existing ones',
    '- Consider dependency order: foundational work (database, API, infra) in earlier milestones',
    '- Suggest realistic due dates based on issue complexity and number of issues per milestone',
    '- Set `currentMilestone` to the issue\'s current milestone title, or empty string if unassigned',
    '- Include ALL open issues in assignments (even ones already assigned to milestones)',
    '- Set `selected: true` for all assignments (user will deselect if needed)',
    '- Order milestones by suggested execution order (order field)',
    '- Group related issues together (same feature area, same dependency chain)',
    '- Milestone titles MUST be prefixed with a zero-padded 3-digit number matching their order, e.g. "001 - Foundation", "002 - Core Features", "010 - Polish"',
  );

  return sections.join('\n');
}

export type PlanPromptOptions = {
  seedDescription: string;
  seedFiles?: Array<{ path: string; content: string }>;
  visionContext?: string | null;
  projectContext?: string | null;
  existingIssues?: Array<{ number: number; title: string }>;
  existingMilestones?: Array<{ title: string; description: string; openIssues: number }>;
};

/**
 * Build the prompt for AI-driven project plan generation.
 * Instructs the agent to output a PlanDraft JSON with milestones and issues.
 */
export function buildPlanPrompt(options: PlanPromptOptions): string {
  const { seedDescription, seedFiles, visionContext, projectContext, existingIssues, existingMilestones } = options;

  const sections: string[] = [
    'You are a project planning assistant. Analyze the following inputs and generate a complete project plan as JSON.',
    '',
    '## Seed Description',
    seedDescription,
  ];

  if (seedFiles && seedFiles.length > 0) {
    sections.push('', '## Seed Files');
    for (const file of seedFiles) {
      sections.push(`### ${file.path}`, '```', file.content, '```');
    }
  }

  if (visionContext) {
    sections.push('', '## Product Vision', visionContext);
  }

  if (projectContext) {
    sections.push('', '## Technical Context', projectContext);
  }

  if (existingIssues && existingIssues.length > 0) {
    sections.push(
      '',
      '## Existing Issues (avoid duplicates)',
      ...existingIssues.map((i) => `- #${i.number}: ${i.title}`),
    );
  }

  if (existingMilestones && existingMilestones.length > 0) {
    sections.push(
      '',
      '## Existing Milestones (reuse when appropriate)',
      'These milestones already exist on GitHub. Assign issues to existing milestones when they fit.',
      'Only create new milestones for work that does not belong in any existing milestone.',
      ...existingMilestones.map((m) => `- **${m.title}**: ${m.description} (${m.openIssues} open issue(s))`),
    );
  }

  sections.push(
    '',
    '## Output Requirements',
    '',
    'Output ONLY valid JSON matching this schema (no explanation, no surrounding text).',
    'The example below uses fences for illustration only — your output must be raw JSON with no fences:',
    '',
    '```json',
    '{',
    '  "vision": null,',
    '  "milestones": [',
    '    {',
    '      "title": "001 - Milestone Name",',
    '      "description": "What this milestone delivers",',
    '      "dueOn": "2026-05-01",',
    '      "order": 1',
    '    }',
    '  ],',
    '  "issues": [',
    '    {',
    '      "id": 1,',
    '      "title": "Issue title",',
    '      "body": "## Summary\\n...\\n\\n## Acceptance Criteria\\n- [ ] Criterion 1\\n- [ ] Criterion 2",',
    '      "labels": ["enhancement"],',
    '      "milestone": "001 - Milestone Name",',
    '      "priority": "p1",',
    '      "complexity": "medium",',
    '      "dependsOn": [],',
    '      "selected": true',
    '    }',
    '  ],',
    '  "projectBoard": null',
    '}',
    '```',
    '',
    '## Instructions',
    '- Group issues into logical milestones with suggested due dates',
    '- Each issue body MUST use markdown with acceptance criteria in checkbox format: `- [ ] Criterion`',
    '- Priority: p0 (critical), p1 (high), p2 (medium), p3 (low)',
    '- Complexity: trivial, small, medium, large',
    '- Use `dependsOn` to reference other issue `id` values within the plan',
    '- Set all issues to `"selected": true`',
    '- Do NOT duplicate any existing issues listed above',
    '- Reuse existing milestones when the work fits; only create new milestones for genuinely new scope',
    '- Consider the codebase structure for realistic issue scoping',
    '- Issue `id` values are temporary local IDs (1, 2, 3...) used only for dependency references',
    '- Milestone titles MUST be prefixed with a zero-padded 3-digit number matching their order, e.g. "001 - Foundation", "002 - Core Features", "010 - Polish"',
  );

  return sections.join('\n');
}

export type AddPromptOptions = {
  description: string;
  milestones: Array<{ title: string; description: string; openIssues: number }>;
  projectContext: string | null;
  existingLabels: string[];
};

export function buildAddPrompt(options: AddPromptOptions): string {
  const { description, milestones, projectContext, existingLabels } = options;

  const milestoneList = milestones.length > 0
    ? milestones.map((m) => `- **${m.title}**: ${m.description || '(no description)'} (${m.openIssues} open issues)`).join('\n')
    : '(No milestones exist yet — you must propose a new one.)';

  const labelList = existingLabels.length > 0
    ? existingLabels.join(', ')
    : '(none yet)';

  const contextBlock = projectContext
    ? `## Project Context\n${projectContext}`
    : '## Project Context\nNo project context available.';

  return `You are an issue writer for a software project. Given a user's description and project context, generate a single well-structured GitHub issue.

${contextBlock}

## Existing Milestones
${milestoneList}

## Existing Labels
${labelList}

## User Description
${description}

## Instructions
- Write a clear, actionable issue title (imperative mood, under 80 chars)
- Write a detailed body in Markdown with: Problem/Goal, Proposed Solution, Acceptance Criteria
- Assign appropriate labels for type (bug/feature/chore/docs/refactor), priority (p0-p3), and complexity (trivial/small/medium/large)
- Recommend the best-fit existing milestone, or propose a new one if none fit well
- Return ONLY a JSON object with no markdown fences:

{"title":"...","body":"...","labels":["type","priority","complexity"],"milestone":{"title":"...","description":"...","isNew":false}}

Set isNew to true and provide a description only when proposing a new milestone. For existing milestones, set isNew to false.`;
}
