# `alpha-loop add` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `alpha-loop add` CLI command that creates a single GitHub issue from a free-form description, using AI to generate title, body, labels, and milestone assignment.

**Architecture:** New command file `src/commands/add.ts` following the triage/roadmap pattern — load config, gather context, call AI agent with one-shot prompt, parse JSON response, interactive review, create GitHub resources. New prompt builder `buildAddPrompt()` in `src/lib/prompts.ts`.

**Tech Stack:** TypeScript, Commander.js, `@inquirer/prompts`, `gh` CLI via existing `github.ts` helpers.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/commands/add.ts` | Command handler: input, AI call, review, creation |
| Modify | `src/cli.ts:73` | Register new `add` command |
| Modify | `src/lib/prompts.ts` | Add `buildAddPrompt()` function |
| Create | `tests/commands/add.test.ts` | Unit tests for the add command |

---

### Task 1: Add `buildAddPrompt()` to prompts.ts

**Files:**
- Modify: `src/lib/prompts.ts` (append new type + function)
- Test: `tests/commands/add.test.ts` (tested indirectly via command tests)

- [ ] **Step 1: Define the AddPromptOptions type and buildAddPrompt function**

Append to the end of `src/lib/prompts.ts`:

```typescript
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
```

- [ ] **Step 2: Verify the build passes**

Run: `pnpm build`
Expected: Clean compilation, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/prompts.ts
git commit -m "feat(add): add buildAddPrompt() to prompts library"
```

---

### Task 2: Create the add command handler

**Files:**
- Create: `src/commands/add.ts`

- [ ] **Step 1: Create `src/commands/add.ts`**

```typescript
/**
 * Add command — create a single GitHub issue from a free-form description
 * using AI to generate title, body, labels, and milestone assignment.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { input, confirm, select, editor } from '@inquirer/prompts';
import { loadConfig, assertSafeShellArg } from '../lib/config.js';
import { buildOneShotCommand } from '../lib/agent.js';
import { buildAddPrompt } from '../lib/prompts.js';
import { exec } from '../lib/shell.js';
import { log } from '../lib/logger.js';
import { extractJsonFromResponse, buildPlanningContext } from '../lib/planning.js';
import {
  listMilestones,
  listLabels,
  createIssue,
  createMilestone,
  setIssueMilestone,
  addIssueToProject,
  type Milestone,
} from '../lib/github.js';

export type AddOptions = {
  seed?: string;
  milestone?: string;
  dryRun?: boolean;
  yes?: boolean;
};

type AddIssueProposal = {
  title: string;
  body: string;
  labels: string[];
  milestone: {
    title: string;
    description?: string;
    isNew: boolean;
  };
};

export async function addCommand(options: AddOptions): Promise<void> {
  const config = loadConfig({ dryRun: options.dryRun });

  // ── Input ──────────────────────────────────────────────────────────────────
  let description: string;

  if (options.seed) {
    try {
      description = readFileSync(options.seed, 'utf-8').trim();
    } catch (err) {
      log.error(`Could not read seed file: ${(err as Error).message}`);
      return;
    }
  } else if (!process.stdin.isTTY && !options.yes) {
    log.info('The add command requires an interactive terminal. Use --seed with --yes for non-interactive mode.');
    return;
  } else {
    description = await input({
      message: 'Describe the issue (bug, feature, task, etc.):',
    });
  }

  if (!description.trim()) {
    log.error('Please provide a description.');
    return;
  }

  // ── Context gathering ──────────────────────────────────────────────────────
  log.step('Gathering project context...');
  const milestones = listMilestones(config.repo);
  const existingLabels = listLabels(config.repo);
  const ctx = buildPlanningContext(config);

  // ── AI generation ──────────────────────────────────────────────────────────
  log.step('Generating issue via AI agent...');
  const prompt = buildAddPrompt({
    description,
    milestones: milestones.map((m) => ({
      title: m.title,
      description: m.description,
      openIssues: m.openIssues,
    })),
    projectContext: ctx.projectContext,
    existingLabels,
  });

  const safeModel = assertSafeShellArg(config.model, 'model');
  const agentCmd = buildOneShotCommand(config.agent, safeModel);
  const promptFile = join(tmpdir(), `alpha-loop-prompt-${Date.now()}`);
  writeFileSync(promptFile, prompt, 'utf-8');

  let result;
  try {
    result = exec(
      `${agentCmd} < "${promptFile}" 2>/dev/null`,
      { cwd: process.cwd(), timeout: 5 * 60 * 1000 },
    );
  } finally {
    try { unlinkSync(promptFile); } catch { /* cleanup best-effort */ }
  }

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    log.error('Agent failed to generate issue. Check agent configuration and try again.');
    if (result.stderr) log.error(result.stderr.slice(0, 500));
    return;
  }

  let proposal: AddIssueProposal;
  try {
    proposal = extractJsonFromResponse<AddIssueProposal>(result.stdout);
  } catch (err) {
    log.error(`Failed to parse AI response: ${(err as Error).message}`);
    log.error(`Agent response (first 500 chars): ${result.stdout.slice(0, 500)}`);
    return;
  }

  if (!proposal.title || !proposal.body || !proposal.milestone?.title) {
    log.error('AI response missing required fields (title, body, milestone). Try again.');
    return;
  }

  // ── Apply --milestone override ─────────────────────────────────────────────
  if (options.milestone) {
    const existing = milestones.find(
      (m) => m.title.toLowerCase() === options.milestone!.toLowerCase(),
    );
    proposal.milestone = {
      title: options.milestone,
      description: existing?.description ?? '',
      isNew: !existing,
    };
  }

  // ── Display proposal ──────────────────────────────────────────────────────
  const milestoneTag = proposal.milestone.isNew ? '(NEW)' : '(existing)';
  console.log('');
  log.step('Proposed Issue:');
  console.log(`  Title:      ${proposal.title}`);
  console.log(`  Labels:     ${proposal.labels.join(', ')}`);
  console.log(`  Milestone:  ${proposal.milestone.title} ${milestoneTag}`);
  console.log('');
  console.log('  Body:');
  for (const line of proposal.body.split('\n').slice(0, 20)) {
    console.log(`    ${line}`);
  }
  if (proposal.body.split('\n').length > 20) {
    console.log('    ...(truncated)');
  }
  console.log('');

  // ── Dry run exit ──────────────────────────────────────────────────────────
  if (options.dryRun) {
    log.dry('Dry run — no changes will be made.');
    return;
  }

  // ── Interactive review ─────────────────────────────────────────────────────
  if (!options.yes) {
    // Milestone confirmation
    if (!options.milestone) {
      const milestoneChoice = await select({
        message: `Milestone: "${proposal.milestone.title}" ${milestoneTag}. Accept?`,
        choices: [
          { name: 'Yes, use this milestone', value: 'accept' },
          { name: 'Pick a different milestone', value: 'pick' },
          { name: 'Create a new milestone', value: 'new' },
        ],
      });

      if (milestoneChoice === 'pick') {
        if (milestones.length === 0) {
          log.warn('No existing milestones to pick from. Keeping AI suggestion.');
        } else {
          const picked = await select({
            message: 'Select a milestone:',
            choices: milestones.map((m) => ({
              name: `${m.title} (${m.openIssues} open)`,
              value: m.title,
            })),
          });
          proposal.milestone = { title: picked, isNew: false };
        }
      } else if (milestoneChoice === 'new') {
        const newTitle = await input({ message: 'New milestone title:' });
        const newDesc = await input({ message: 'Milestone description (optional):' });
        proposal.milestone = { title: newTitle, description: newDesc || undefined, isNew: true };
      }
    }

    // Offer to edit the body
    const editChoice = await select({
      message: 'Issue body:',
      choices: [
        { name: 'Looks good, create it', value: 'create' },
        { name: 'Edit body in editor', value: 'edit' },
        { name: 'Cancel', value: 'cancel' },
      ],
    });

    if (editChoice === 'cancel') {
      log.info('Cancelled.');
      return;
    }

    if (editChoice === 'edit') {
      proposal.body = await editor({
        message: 'Edit issue body:',
        default: proposal.body,
      });
    }
  }

  // ── Create resources ──────────────────────────────────────────────────────
  log.step('Creating issue on GitHub...');

  // Create milestone if new
  if (proposal.milestone.isNew) {
    const msNum = createMilestone(
      config.repo,
      proposal.milestone.title,
      proposal.milestone.description ?? '',
    );
    if (msNum > 0) {
      log.success(`Created milestone: ${proposal.milestone.title}`);
    } else {
      log.warn(`Failed to create milestone "${proposal.milestone.title}". Issue will be created without milestone.`);
      proposal.milestone.isNew = false;
      proposal.milestone.title = '';
    }
  }

  // Create the issue
  const milestoneArg = proposal.milestone.title || undefined;
  const issueNum = createIssue(config.repo, proposal.title, proposal.body, proposal.labels, milestoneArg);

  if (issueNum === 0) {
    log.error('Failed to create issue. Check GitHub permissions and try again.');
    return;
  }

  log.success(`Created issue #${issueNum}: ${proposal.title}`);
  console.log(`  https://github.com/${config.repo}/issues/${issueNum}`);

  // Add to project board if configured
  if (config.project && config.project > 0) {
    addIssueToProject(config.repoOwner, config.project, config.repo, issueNum);
    log.info('Added to project board');
  }
}
```

- [ ] **Step 2: Verify the build passes**

Run: `pnpm build`
Expected: Clean compilation, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/add.ts
git commit -m "feat(add): create add command handler"
```

---

### Task 3: Register the command in cli.ts

**Files:**
- Modify: `src/cli.ts` (insert new command block after the `plan` command at line 84)

- [ ] **Step 1: Add the `add` command registration**

Insert after line 84 (after the `plan` command's closing `});`):

```typescript
program
  .command('add')
  .description('Create a new issue from a free-form description using AI')
  .option('--seed <file>', 'Read description from a file instead of prompting')
  .option('--milestone <name>', 'Override milestone assignment')
  .option('--dry-run', 'Preview the issue without creating it')
  .option('-y, --yes', 'Skip interactive prompts, create directly')
  .action(async (options) => {
    const { addCommand } = await import('./commands/add.js');
    await addCommand(options);
  });
```

- [ ] **Step 2: Verify the build passes**

Run: `pnpm build`
Expected: Clean compilation, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat(add): register add command in CLI"
```

---

### Task 4: Write tests for the add command

**Files:**
- Create: `tests/commands/add.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { addCommand } from '../../src/commands/add';

// Mock all external dependencies
jest.mock('@inquirer/prompts', () => ({
  input: jest.fn(),
  confirm: jest.fn(),
  select: jest.fn(),
  editor: jest.fn(),
}));

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn(() => ({
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 0,
    agent: 'claude' as const,
    model: 'sonnet',
    labelReady: 'ready',
    dryRun: false,
    milestone: '',
  })),
  assertSafeShellArg: jest.fn((val: string) => val),
}));

jest.mock('../../src/lib/agent', () => ({
  buildOneShotCommand: jest.fn(() => 'claude -p --dangerously-skip-permissions --output-format text'),
}));

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(() => ({ stdout: '', stderr: '', exitCode: 0 })),
}));

jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    step: jest.fn(),
    dry: jest.fn(),
    debug: jest.fn(),
    rate: jest.fn(),
  },
}));

jest.mock('../../src/lib/planning', () => ({
  extractJsonFromResponse: jest.fn(),
  buildPlanningContext: jest.fn(() => ({
    visionContext: null,
    projectContext: null,
    existingIssues: [],
  })),
}));

jest.mock('../../src/lib/rate-limit', () => ({
  ghExec: jest.fn(() => ({ stdout: '', stderr: '', exitCode: 0 })),
  getRateLimitStatus: jest.fn(() => ({ remaining: 5000, limit: 5000, used: 0, resetAt: 0, ratio: 1 })),
  getProjectCache: jest.fn(() => null),
  setProjectCache: jest.fn(),
  clearProjectCache: jest.fn(),
  resetRateLimitState: jest.fn(),
  parseRateLimitHeaders: jest.fn(() => null),
  stripDebugOutput: jest.fn((s: string) => s),
}));

jest.mock('../../src/lib/github', () => ({
  listMilestones: jest.fn(() => []),
  listLabels: jest.fn(() => []),
  createIssue: jest.fn(() => 0),
  createMilestone: jest.fn(() => 0),
  setIssueMilestone: jest.fn(),
  addIssueToProject: jest.fn(),
}));

import { input, select, editor } from '@inquirer/prompts';
import { exec } from '../../src/lib/shell';
import { log } from '../../src/lib/logger';
import { extractJsonFromResponse } from '../../src/lib/planning';
import {
  listMilestones,
  listLabels,
  createIssue,
  createMilestone,
  addIssueToProject,
} from '../../src/lib/github';

const mockInput = input as jest.MockedFunction<typeof input>;
const mockSelect = select as jest.MockedFunction<typeof select>;
const mockEditor = editor as jest.MockedFunction<typeof editor>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockExtractJson = extractJsonFromResponse as jest.MockedFunction<typeof extractJsonFromResponse>;
const mockListMilestones = listMilestones as jest.MockedFunction<typeof listMilestones>;
const mockListLabels = listLabels as jest.MockedFunction<typeof listLabels>;
const mockCreateIssue = createIssue as jest.MockedFunction<typeof createIssue>;
const mockCreateMilestone = createMilestone as jest.MockedFunction<typeof createMilestone>;
const mockAddIssueToProject = addIssueToProject as jest.MockedFunction<typeof addIssueToProject>;

const SAMPLE_PROPOSAL = {
  title: 'Add dark mode support',
  body: '## Problem\nNo dark mode.\n\n## Solution\nAdd theme toggle.\n\n## Acceptance Criteria\n- [ ] Toggle works',
  labels: ['feature', 'p1', 'medium'],
  milestone: {
    title: 'v2.0 - UI Refresh',
    description: '',
    isNew: false,
  },
};

const SAMPLE_MILESTONES = [
  { number: 1, title: 'v1.0 - MVP', description: 'First release', openIssues: 3, closedIssues: 5, dueOn: null, state: 'open' },
  { number: 2, title: 'v2.0 - UI Refresh', description: 'UI overhaul', openIssues: 7, closedIssues: 0, dueOn: null, state: 'open' },
];

describe('add command', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.clearAllMocks();
    // Default: TTY mode
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prompts for description and creates issue with AI-generated content', async () => {
    mockInput.mockResolvedValueOnce('Add dark mode to the app');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue(['bug', 'feature']);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);

    // Accept milestone, accept body
    mockSelect.mockResolvedValueOnce('accept');
    mockSelect.mockResolvedValueOnce('create');

    mockCreateIssue.mockReturnValue(42);

    await addCommand({});

    expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Describe'),
    }));
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      'Add dark mode support',
      expect.stringContaining('dark mode'),
      ['feature', 'p1', 'medium'],
      'v2.0 - UI Refresh',
    );
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('#42'));
  });

  it('exits early when description is empty', async () => {
    mockInput.mockResolvedValueOnce('');

    await addCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('description'));
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('reads description from --seed file', async () => {
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);
    mockSelect.mockResolvedValueOnce('accept');
    mockSelect.mockResolvedValueOnce('create');
    mockCreateIssue.mockReturnValue(10);

    // Mock readFileSync for the seed file via the exec mock (seed is read by readFileSync in the command)
    const fs = require('node:fs');
    const origReadFileSync = fs.readFileSync;
    fs.readFileSync = jest.fn((path: string, ...args: unknown[]) => {
      if (path === '/tmp/seed.txt') return 'Seed description from file';
      return origReadFileSync(path, ...args);
    });

    await addCommand({ seed: '/tmp/seed.txt' });

    expect(mockInput).not.toHaveBeenCalled(); // should not prompt
    expect(mockCreateIssue).toHaveBeenCalled();

    fs.readFileSync = origReadFileSync;
  });

  it('does not create resources in dry-run mode', async () => {
    mockInput.mockResolvedValueOnce('Some feature');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);

    await addCommand({ dryRun: true });

    expect(log.dry).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockCreateMilestone).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('skips prompts with --yes flag', async () => {
    mockInput.mockResolvedValueOnce('Quick feature');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);
    mockCreateIssue.mockReturnValue(15);

    await addCommand({ yes: true });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockEditor).not.toHaveBeenCalled();
    expect(mockCreateIssue).toHaveBeenCalled();
  });

  it('creates a new milestone when AI proposes one', async () => {
    const proposalWithNewMs = {
      ...SAMPLE_PROPOSAL,
      milestone: { title: 'v3.0 - API Rewrite', description: 'Full API redesign', isNew: true },
    };

    mockInput.mockResolvedValueOnce('Rewrite the API');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(proposalWithNewMs);
    mockCreateMilestone.mockReturnValue(3);
    mockCreateIssue.mockReturnValue(20);

    // Accept milestone, accept body
    mockSelect.mockResolvedValueOnce('accept');
    mockSelect.mockResolvedValueOnce('create');

    await addCommand({});

    expect(mockCreateMilestone).toHaveBeenCalledWith(
      'owner/repo', 'v3.0 - API Rewrite', 'Full API redesign',
    );
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('milestone'));
    expect(mockCreateIssue).toHaveBeenCalled();
  });

  it('overrides milestone with --milestone flag', async () => {
    mockInput.mockResolvedValueOnce('Some task');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);
    mockSelect.mockResolvedValueOnce('create'); // only body prompt, no milestone prompt
    mockCreateIssue.mockReturnValue(25);

    await addCommand({ milestone: 'v1.0 - MVP' });

    // Should not prompt for milestone
    expect(mockSelect).toHaveBeenCalledTimes(1); // only body choice
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      'v1.0 - MVP',
    );
  });

  it('handles agent failure gracefully', async () => {
    mockInput.mockResolvedValueOnce('Some feature');
    mockListMilestones.mockReturnValue([]);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '', stderr: 'agent error', exitCode: 1 });

    await addCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Agent failed'));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('handles JSON parse failure gracefully', async () => {
    mockInput.mockResolvedValueOnce('Some feature');
    mockListMilestones.mockReturnValue([]);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: 'not json', stderr: '', exitCode: 0 });
    mockExtractJson.mockImplementation(() => {
      throw new Error('Could not extract valid JSON');
    });

    await addCommand({});

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('allows user to cancel during body review', async () => {
    mockInput.mockResolvedValueOnce('Some feature');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);

    mockSelect.mockResolvedValueOnce('accept'); // milestone
    mockSelect.mockResolvedValueOnce('cancel'); // body

    await addCommand({});

    expect(log.info).toHaveBeenCalledWith('Cancelled.');
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it('allows user to edit body in editor', async () => {
    mockInput.mockResolvedValueOnce('Some feature');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);
    mockCreateIssue.mockReturnValue(30);

    mockSelect.mockResolvedValueOnce('accept'); // milestone
    mockSelect.mockResolvedValueOnce('edit');   // body
    mockEditor.mockResolvedValueOnce('Edited body content');

    await addCommand({});

    expect(mockEditor).toHaveBeenCalledWith(expect.objectContaining({
      default: SAMPLE_PROPOSAL.body,
    }));
    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      SAMPLE_PROPOSAL.title,
      'Edited body content',
      expect.any(Array),
      expect.any(String),
    );
  });

  it('allows user to pick a different milestone', async () => {
    mockInput.mockResolvedValueOnce('Some feature');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);
    mockCreateIssue.mockReturnValue(35);

    mockSelect.mockResolvedValueOnce('pick');        // pick different
    mockSelect.mockResolvedValueOnce('v1.0 - MVP');  // choose milestone
    mockSelect.mockResolvedValueOnce('create');       // accept body

    await addCommand({});

    expect(mockCreateIssue).toHaveBeenCalledWith(
      'owner/repo',
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      'v1.0 - MVP',
    );
  });

  it('adds issue to project board when configured', async () => {
    const { loadConfig } = require('../../src/lib/config');
    (loadConfig as jest.Mock).mockReturnValueOnce({
      repo: 'owner/repo',
      repoOwner: 'owner',
      project: 5,
      agent: 'claude',
      model: 'sonnet',
      labelReady: 'ready',
      dryRun: false,
      milestone: '',
    });

    mockInput.mockResolvedValueOnce('Some feature');
    mockListMilestones.mockReturnValue(SAMPLE_MILESTONES);
    mockListLabels.mockReturnValue([]);
    mockExec.mockReturnValue({ stdout: '{"json":"here"}', stderr: '', exitCode: 0 });
    mockExtractJson.mockReturnValue(SAMPLE_PROPOSAL);
    mockSelect.mockResolvedValueOnce('accept');
    mockSelect.mockResolvedValueOnce('create');
    mockCreateIssue.mockReturnValue(50);

    await addCommand({});

    expect(mockAddIssueToProject).toHaveBeenCalledWith('owner', 5, 'owner/repo', 50);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm test -- tests/commands/add.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Fix any test failures**

If any tests fail, adjust mocks or assertions to match the actual implementation.

- [ ] **Step 4: Commit**

```bash
git add tests/commands/add.test.ts
git commit -m "test(add): add unit tests for add command"
```

---

### Task 5: Update CLAUDE.md and run full test suite

**Files:**
- Modify: `CLAUDE.md` (add `alpha-loop add` to Commands section)

- [ ] **Step 1: Add the command to CLAUDE.md**

In the Commands section, add after the `alpha-loop plan` line:

```
alpha-loop add           # Create a new issue from a free-form description using AI
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: All tests pass, including existing tests and new add tests.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add alpha-loop add command to CLAUDE.md"
```
