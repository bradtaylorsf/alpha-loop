/**
 * Run Command — the main loop: poll issues, process them, finalize session.
 */
import { join } from 'node:path';
import * as readline from 'node:readline';
import { log } from '../lib/logger.js';
import { exec } from '../lib/shell.js';
import { loadConfig, assertSafeShellArg, resolveStepConfig, type Config } from '../lib/config.js';
import {
  pollIssues, listMilestones, listEpics, getEpicSubIssues, getIssueWithComments,
  getMergedPRForIssue, updateEpicChecklist, commentIssue, closeIssue, labelIssue,
  type Milestone, type Issue,
} from '../lib/github.js';
import { buildEpicSummary, parseSubIssues } from '../lib/epics.js';
import { verifyEpic } from '../lib/verify-epic.js';
import { processIssue, processBatch } from '../lib/pipeline.js';
import { createSession, finalizeSession, type SessionContext } from '../lib/session.js';
import { cleanupWorktree } from '../lib/worktree.js';
import {
  generateSessionSummary,
  repairSessionLearningArtifacts,
  repairSessionSummaryArtifact,
} from '../lib/learning.js';
import { hasVision } from '../lib/vision.js';
import { contextNeedsRefresh } from '../lib/context.js';
import { runPreflight } from '../lib/preflight.js';
import { syncAgentAssets, resolveHarnesses } from './sync.js';
import { saveCapturedCase, detectFailureStep } from '../lib/eval.js';
import { readGateResult, formatGateFindings } from '../lib/pipeline.js';
import { spawnAgent } from '../lib/agent.js';
import { buildSessionReviewPrompt, type EpicPromptContext } from '../lib/prompts.js';
import { writeTraceToSubdir } from '../lib/traces.js';
import { validateGeneratedMarkdownForCommit } from '../lib/scan-validation.js';
import { readFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { validateIssueQueue, printValidationReport, commentOnIncompleteIssues, parseDependencies, type ValidationReport } from '../lib/validation.js';
import { hasLabel } from '../lib/labels.js';
import {
  createEpicQueueManifest,
  createEpicQueueValidationFailureManifest,
  parseEpicQueue,
  validateEpicQueue,
  writeQueueManifest,
  type BranchAncestryMode,
  type EpicQueueManifest,
  type EpicQueueManifestEntry,
  type EpicQueueManifestFailure,
  type QueueEpicLink,
  type QueueSessionContext,
  type ValidatedEpicQueueEntry,
} from '../lib/epic-queue.js';

export type RunOptions = {
  dryRun?: boolean;
  model?: string;
  milestone?: string;
  skipTests?: boolean;
  skipReview?: boolean;
  skipLearn?: boolean;
  autoMerge?: boolean;
  mergeTo?: string;
  batch?: boolean;
  batchSize?: number;
  verbose?: boolean;
  validate?: boolean;
  fix?: boolean;
  /** Force a specific epic by number, skip picker. */
  epic?: number;
  /** Force a specific issue by number, skip picker and queue selection. */
  issue?: number;
  /** Process multiple epics in the provided comma-separated order. */
  epics?: string;
  /** Branch ancestry mode for multi-epic queues. */
  queueBranchMode?: BranchAncestryMode;
  /** Skip the epic picker entirely, use flat/milestone flow. */
  skipEpic?: boolean;
  /** Run only the verification pass on an existing epic. */
  verifyOnly?: number;
  /** Internal queue mode: treat an unfinished epic as a queue-stopping failure. */
  stopOnPartialEpic?: boolean;
};

export type EpicExecutionFailureCode =
  | 'invalid-issue-number'
  | 'issue-not-found'
  | 'issue-closed'
  | 'issue-is-epic'
  | 'issue-not-ready'
  | 'issue-blocked'
  | 'ambiguous-parent-epics'
  | 'invalid-epic-number'
  | 'epic-not-found'
  | 'missing-epic-label'
  | 'no-eligible-child-issues'
  | 'checklist-update-failed'
  | 'issue-processing-error'
  | 'batch-processing-error'
  | 'pipeline-failure'
  | 'transient-stop'
  | 'epic-verification-failed'
  | 'epic-incomplete'
  | 'epic-run-error';

export type EpicExecutionFailure = {
  code: EpicExecutionFailureCode;
  message: string;
  issueNum?: number;
  exitCode?: number;
};

export type EpicExecutionResult = {
  epicNumber: number;
  sessionName: string | null;
  sessionBranch: string | null;
  sessionPrUrl: string | null;
  status: 'success' | 'failure';
  failures: EpicExecutionFailure[];
  verificationClosedEpic: boolean;
};

export type IssueExecutionResult = {
  issueNumber: number;
  parentEpicNumber: number | null;
  sessionName: string | null;
  sessionBranch: string | null;
  sessionPrUrl: string | null;
  status: 'success' | 'failure';
  failures: EpicExecutionFailure[];
  verificationClosedEpic: boolean;
};

type EpicVerificationFlowResult = {
  epicNumber: number;
  status: 'pass' | 'needs-human-input' | 'skipped' | 'failure';
  closedEpic: boolean;
  verdict?: string;
  failure?: EpicExecutionFailure;
};

type SessionExecutionTarget =
  | { type: 'epic'; epicNum: number; epicTitle?: string; epicIssue: Issue; queue?: QueueSessionContext }
  | { type: 'issue'; issue: Issue; parentEpic?: Issue }
  | { type: 'flat'; activeMilestone: string };

type SessionExecutionResult = {
  session: SessionContext;
  sessionPrUrl: string | null;
  failures: EpicExecutionFailure[];
  verificationClosedEpic: boolean;
};

type CommandExitErrorCode =
  | 'missing-repository'
  | 'missing-prerequisite'
  | 'ambiguous-milestone-epics'
  | 'invalid-verify-only'
  | 'incompatible-issue-options'
  | 'incompatible-epic-queue-options'
  | 'invalid-epic-queue'
  | 'invalid-queue-branch-mode'
  | 'epic-queue-validation-failed'
  | 'epic-queue-stopped'
  | 'session-interrupt-cleanup-failed';

class CommandExitError extends Error {
  readonly code: CommandExitErrorCode | EpicExecutionFailureCode;
  readonly exitCode: number;
  readonly logged: boolean;

  constructor(args: {
    code: CommandExitErrorCode | EpicExecutionFailureCode;
    message: string;
    exitCode?: number;
    logged?: boolean;
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = new.target.name;
    this.code = args.code;
    this.exitCode = args.exitCode ?? 1;
    this.logged = args.logged ?? false;
  }
}

class QueueExecutionError extends CommandExitError {
  readonly result?: EpicExecutionResult;
  readonly manifest?: EpicQueueManifest;

  constructor(args: {
    code: 'epic-queue-stopped' | 'epic-queue-validation-failed';
    message: string;
    exitCode?: number;
    logged?: boolean;
    cause?: unknown;
    result?: EpicExecutionResult;
    manifest?: EpicQueueManifest;
  }) {
    super(args);
    this.result = args.result;
    this.manifest = args.manifest;
  }
}

function isCommandExitError(err: unknown): err is CommandExitError {
  return err instanceof CommandExitError;
}

function isRecoveredRunResult(result: { recoveryMode?: unknown }): boolean {
  return result.recoveryMode !== undefined;
}

/**
 * Check that required CLI tools are installed.
 * Also warns about optional tools (playwright-cli) that improve the pipeline.
 */
function checkPrerequisites(config: Config): void {
  const AGENT_INSTALL_URLS: Record<string, string> = {
    claude: 'https://claude.ai/code',
    codex: 'https://developers.openai.com/codex/cli/reference',
    opencode: 'https://github.com/sst/opencode',
  };

  const agentUrl = AGENT_INSTALL_URLS[config.agent] ?? '';
  const agentMsg = `${config.agent} CLI not found.${agentUrl ? ` Install: ${agentUrl}` : ''}`;

  const safeAgent = assertSafeShellArg(config.agent, 'agent');

  const tools = [
    { name: 'gh', message: 'GitHub CLI not found. Install: https://cli.github.com/' },
    { name: 'git', message: 'git not found.' },
    { name: safeAgent, message: agentMsg },
  ];

  for (const tool of tools) {
    const result = exec(`command -v "${tool.name}"`);
    if (result.exitCode !== 0) {
      log.error(tool.message);
      throw new CommandExitError({
        code: 'missing-prerequisite',
        message: tool.message,
        exitCode: 1,
        logged: true,
      });
    }
  }

  // Warn about optional playwright-cli for live verification
  if (!config.skipVerify) {
    const pwResult = exec('command -v "playwright-cli"');
    if (pwResult.exitCode !== 0) {
      log.warn('playwright-cli not installed — live verification will be skipped');
      log.warn('  Install: npm install -g @anthropic-ai/claude-code');
      log.warn('  Then run: playwright-cli install --skills');
    }
  }
}

/**
 * Print the startup banner showing all configuration.
 */
function printBanner(config: Config, session: SessionContext): void {
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[0;36m';
  const NC = '\x1b[0m';

  console.error('');
  console.error(`${BOLD}${CYAN}=====================================${NC}`);
  console.error(`${BOLD}${CYAN}  Alpha Loop${NC}`);
  console.error(`${BOLD}${CYAN}=====================================${NC}`);
  console.error('');
  console.error(`  Repo:           ${BOLD}${config.repo}${NC}`);
  console.error(`  Project:        ${BOLD}#${config.project} (${config.repoOwner})${NC}`);
  console.error(`  Model:          ${BOLD}${config.model}${NC}`);
  console.error(`  Review Model:   ${BOLD}${config.reviewModel}${NC}`);
  console.error(`  Base Branch:    ${BOLD}${config.baseBranch}${NC}`);
  console.error(`  Label:          ${BOLD}${config.labelReady}${NC}`);
  console.error(`  Dry Run:        ${BOLD}${config.dryRun}${NC}`);
  console.error(`  Skip Tests:     ${BOLD}${config.skipTests}${NC}`);
  console.error(`  Skip Review:    ${BOLD}${config.skipReview}${NC}`);
  console.error(`  Skip Learn:     ${BOLD}${config.skipLearn}${NC}`);
  console.error(`  Skip Verify:    ${BOLD}${config.skipVerify}${NC}`);
  console.error(`  Verbose:        ${BOLD}${config.verbose}${NC}`);
  console.error(`  Test Retries:   ${BOLD}${config.maxTestRetries}${NC}`);
  console.error(`  Max Issues:     ${BOLD}${config.maxIssues || 'unlimited'}${NC}`);
  console.error(`  Max Duration:   ${BOLD}${config.maxSessionDuration ? config.maxSessionDuration + 's' : 'unlimited'}${NC}`);
  console.error(`  Auto Merge:     ${BOLD}${config.autoMerge}${NC}`);
  console.error(`  Batch Mode:     ${BOLD}${config.batch}${NC}`);
  if (config.batch) {
    console.error(`  Batch Size:     ${BOLD}${config.batchSize}${NC}`);
  }
  console.error(`  Session:        ${BOLD}${session.branch}${NC}`);
  console.error('');
}

function askYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() !== 'n');
    });
  });
}

function askChoice(prompt: string, max: number): Promise<number> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);
      if (isNaN(num) || num < 0 || num > max) {
        resolve(-1); // invalid
      } else {
        resolve(num);
      }
    });
  });
}

export type PickTargetResult =
  | { type: 'epic'; epicNum: number; epicTitle: string; epic: Issue }
  | { type: 'milestone'; title: string }
  | { type: 'all' };

type ResolvedRunTarget = {
  activeEpic?: number;
  activeEpicTitle?: string;
  activeEpicIssue?: Issue;
  activeMilestone: string;
};

function hasEpicLabel(issue: Issue): boolean {
  return hasLabel(issue.labels, 'epic');
}

export function formatEpicPickerMeta(epic: Issue): string {
  const summary = buildEpicSummary(epic);
  const progress = summary.totalCount > 0
    ? `${summary.doneCount}/${summary.totalCount} done`
    : 'no sub-issues';
  const milestone = epic.milestone ? ` · milestone ${epic.milestone}` : '';
  return `${progress}${milestone}`;
}

export function formatMilestonePickerMeta(milestone: Milestone, epics: Issue[]): string {
  const progress = milestone.openIssues + milestone.closedIssues > 0
    ? `${milestone.closedIssues}/${milestone.openIssues + milestone.closedIssues} done`
    : 'empty';
  const due = milestone.dueOn ? ` · due ${milestone.dueOn.split('T')[0]}` : '';
  const scheduledEpicCount = epics.filter((epic) => epic.milestone === milestone.title).length;
  const scheduled = scheduledEpicCount > 0
    ? ` · ${scheduledEpicCount} scheduled epic${scheduledEpicCount === 1 ? '' : 's'}`
    : '';
  return `${milestone.openIssues} open, ${progress}${due}${scheduled}`;
}

/**
 * Show open epics + milestones and let the user pick one, or choose "all in order".
 * Epics are listed first (they're typically what the user actually wants).
 *
 * When `preferEpics` is true and there's exactly one open epic, the picker
 * auto-selects it without prompting.
 *
 * When `hideEpics` is true, epics are not shown or auto-selected (the `--skip-epic`
 * flag path).
 */
async function pickTarget(
  repo: string,
  opts: { preferEpics: boolean; hideEpics: boolean },
): Promise<PickTargetResult> {
  const epics = opts.hideEpics ? [] : listEpics(repo);
  const milestones = listMilestones(repo);

  if (epics.length === 0 && milestones.length === 0) {
    log.info('No open epics or milestones found — processing all ready issues');
    return { type: 'all' };
  }

  // preferEpics: when there's exactly one open epic and the user has opted in,
  // skip the picker and use it. This is the common case for a single-initiative repo.
  if (opts.preferEpics && epics.length === 1) {
    const only = epics[0];
    log.info(`preferEpics: auto-selecting sole open epic #${only.number}`);
    return { type: 'epic', epicNum: only.number, epicTitle: only.title, epic: only };
  }

  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const NC = '\x1b[0m';

  console.error('');
  if (epics.length > 0) {
    console.error(`${BOLD}  Open Epics${NC}`);
    console.error('');
    for (let i = 0; i < epics.length; i++) {
      const e = epics[i];
      console.error(`  ${BOLD}${i + 1}${NC}  ${e.title} #${e.number} ${DIM}(${formatEpicPickerMeta(e)})${NC}`);
    }
    console.error('');
  }

  if (milestones.length > 0) {
    console.error(`${BOLD}  Open Milestones${NC}`);
    console.error('');
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      console.error(`  ${BOLD}${epics.length + i + 1}${NC}  ${m.title} ${DIM}(${formatMilestonePickerMeta(m, epics)})${NC}`);
    }
    console.error('');
  }

  const total = epics.length + milestones.length;
  console.error(`  ${BOLD}0${NC}  All ready issues (no filter)`);
  console.error('');

  const choice = await askChoice(`  Select [0-${total}]: `, total);

  if (choice <= 0) {
    log.info('Processing all ready issues (no filter)');
    return { type: 'all' };
  }

  if (choice <= epics.length) {
    const selected = epics[choice - 1];
    log.success(`Epic selected: ${selected.title} (#${selected.number})`);
    return { type: 'epic', epicNum: selected.number, epicTitle: selected.title, epic: selected };
  }

  const milestoneIdx = choice - epics.length - 1;
  const selected = milestones[milestoneIdx];
  log.success(`Milestone selected: ${selected.title} (${selected.openIssues} open issues)`);
  return { type: 'milestone', title: selected.title };
}

async function resolveRunTarget(config: Config, options: RunOptions): Promise<ResolvedRunTarget | null> {
  let activeMilestone = config.milestone;

  if (activeMilestone && options.skipEpic !== true) {
    const scheduledEpics = listEpics(config.repo, { milestone: activeMilestone });

    if (scheduledEpics.length === 1) {
      const epic = scheduledEpics[0];
      log.info(`Milestone '${activeMilestone}' has one scheduled epic; processing epic #${epic.number}: ${epic.title}`);
      return {
        activeEpic: epic.number,
        activeEpicTitle: epic.title,
        activeEpicIssue: epic,
        activeMilestone: '',
      };
    }

    if (scheduledEpics.length > 1) {
      log.error(`Milestone '${activeMilestone}' has multiple scheduled epics:`);
      for (const epic of scheduledEpics) {
        log.error(`  #${epic.number} ${epic.title}`);
      }
      log.error(`Use --epic <N> to choose one, or --skip-epic --milestone ${JSON.stringify(activeMilestone)} to process flat issues.`);
      throw new CommandExitError({
        code: 'ambiguous-milestone-epics',
        message: `Milestone '${activeMilestone}' has multiple scheduled epics`,
        exitCode: 1,
        logged: true,
      });
    }

    log.info(`No open epics scheduled for milestone '${activeMilestone}' — using flat milestone issue flow`);
  }

  // Interactive picker when TTY and nothing preset
  if (!activeMilestone && !config.dryRun && process.stdin.isTTY) {
    const target = await pickTarget(config.repo, {
      preferEpics: config.preferEpics,
      hideEpics: options.skipEpic === true,
    });
    if (target.type === 'epic') {
      return {
        activeEpic: target.epicNum,
        activeEpicTitle: target.epicTitle,
        activeEpicIssue: target.epic,
        activeMilestone: '',
      };
    }
    if (target.type === 'milestone') {
      activeMilestone = target.title;
    }
  }

  return { activeMilestone };
}

/**
 * Run the verification pass on an epic: fetch sub-issues + merged PRs, evaluate
 * AC via the review model, post a summary comment, and close the epic on pass
 * (or add `needs-human-input` on partial/fail).
 *
 * Shared between the post-loop trigger and the `--verify-only` entry point.
 */
async function runEpicVerificationFlow(
  epicNum: number,
  config: Config,
  session: SessionContext | null,
): Promise<EpicVerificationFlowResult> {
  const epic = getIssueWithComments(config.repo, epicNum);
  if (!epic) {
    const message = `Could not fetch epic #${epicNum}`;
    log.error(message);
    return {
      epicNumber: epicNum,
      status: 'failure',
      closedEpic: false,
      failure: { code: 'epic-not-found', message },
    };
  }
  if (!hasEpicLabel(epic)) {
    const message = `Issue #${epicNum} is not labeled 'epic'. Add the epic label before running epic verification.`;
    log.error(message);
    return {
      epicNumber: epicNum,
      status: 'failure',
      closedEpic: false,
      failure: { code: 'missing-epic-label', message, issueNum: epicNum, exitCode: 1 },
    };
  }
  const refs = getEpicSubIssues(config.repo, epicNum);
  if (refs.length === 0) {
    log.warn(`Epic #${epicNum} has no sub-issues in its checklist — nothing to verify`);
    return { epicNumber: epicNum, status: 'skipped', closedEpic: false };
  }

  const subIssues: Issue[] = [];
  const mergedPRUrls: Array<string | null> = [];
  for (const ref of refs) {
    const sub = getIssueWithComments(config.repo, ref.number);
    if (!sub) continue;
    subIssues.push(sub);
    mergedPRUrls.push(getMergedPRForIssue(config.repo, ref.number));
  }

  const logsDir = session?.logsDir
    ?? join(process.cwd(), '.alpha-loop', 'sessions', `verify-${epicNum}-${Date.now()}`, 'logs');

  if (!session) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(logsDir, { recursive: true });
  }

  const result = await verifyEpic({ epic, subIssues, mergedPRUrls }, config, logsDir);

  if (config.dryRun) {
    log.dry(`[verify-only] Would post comment on #${epicNum} (verdict=${result.verdict})`);
    console.error(result.comment);
    return {
      epicNumber: epicNum,
      status: result.verdict === 'pass' ? 'pass' : 'needs-human-input',
      closedEpic: false,
      verdict: result.verdict,
    };
  }

  commentIssue(config.repo, epicNum, result.comment);
  if (result.verdict === 'pass') {
    closeIssue(config.repo, epicNum, 'completed');
    log.success(`Epic #${epicNum} verified and closed`);
    return {
      epicNumber: epicNum,
      status: 'pass',
      closedEpic: true,
      verdict: result.verdict,
    };
  } else {
    labelIssue(config.repo, epicNum, 'needs-human-input');
    log.warn(`Epic #${epicNum} needs human review: verdict=${result.verdict}`);
    return {
      epicNumber: epicNum,
      status: 'needs-human-input',
      closedEpic: false,
      verdict: result.verdict,
    };
  }
}

type EpicChecklistPromptItem = {
  issueNum: number;
  checked: boolean;
  title?: string;
};

const MAX_EPIC_BODY_SUMMARY_CHARS = 1200;

function extractChecklistTitle(line: string, issueNum: number): string | undefined {
  const marker = `#${issueNum}`;
  const idx = line.indexOf(marker);
  if (idx === -1) return undefined;
  const suffix = line.slice(idx + marker.length).trim().replace(/^[-:]\s*/, '').trim();
  return suffix || undefined;
}

function parseEpicChecklistForPrompt(body: string): EpicChecklistPromptItem[] {
  const lines = body.split('\n');
  return parseSubIssues(body).map((ref) => ({
    issueNum: ref.number,
    checked: ref.checked,
    title: extractChecklistTitle(lines[ref.lineIndex] ?? '', ref.number),
  }));
}

function findMarkdownSection(body: string, headingPattern: RegExp): string[] {
  const lines = body.split('\n');
  const section: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (heading) {
      if (inSection) break;
      inSection = headingPattern.test(heading[1]);
      continue;
    }
    if (inSection) section.push(line);
  }

  return section;
}

function removeMarkdownSection(body: string, headingPattern: RegExp): string {
  const lines = body.split('\n');
  const kept: string[] = [];
  let skip = false;

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (heading) {
      if (skip && !headingPattern.test(heading[1])) {
        skip = false;
      } else if (headingPattern.test(heading[1])) {
        skip = true;
        continue;
      }
    }
    if (!skip) kept.push(line);
  }

  return kept.join('\n');
}

function extractEpicAcceptanceCriteria(body: string): string[] {
  const section = findMarkdownSection(body, /acceptance criteria/i);
  if (section.length === 0) return [];

  const listItems = section
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line));

  if (listItems.length > 0) return listItems;

  return section
    .map((line) => line.trim())
    .filter(Boolean);
}

function summarizeEpicBody(body: string): string {
  const checklistLines = new Set(parseSubIssues(body).map((ref) => ref.lineIndex));
  const withoutChecklist = body
    .split('\n')
    .filter((_, index) => !checklistLines.has(index))
    .join('\n');
  const withoutAcceptance = removeMarkdownSection(withoutChecklist, /acceptance criteria/i);
  const compact = withoutAcceptance
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (compact.length <= MAX_EPIC_BODY_SUMMARY_CHARS) return compact;
  return `${compact.slice(0, MAX_EPIC_BODY_SUMMARY_CHARS).trimEnd()}\n...(truncated)`;
}

function buildEpicPromptContextFromIssue(
  epic: Issue,
  checklist: EpicChecklistPromptItem[],
): EpicPromptContext {
  return {
    number: epic.number,
    title: epic.title,
    bodySummary: summarizeEpicBody(epic.body),
    acceptanceCriteria: extractEpicAcceptanceCriteria(epic.body),
    subIssues: checklist.map((item) => ({
      issueNum: item.issueNum,
      title: item.title,
      checked: item.checked,
    })),
  };
}

function markEpicChecklistItem(
  checklist: EpicChecklistPromptItem[],
  context: EpicPromptContext | undefined,
  issueNum: number,
  checked: boolean,
): void {
  const item = checklist.find((entry) => entry.issueNum === issueNum);
  if (item) item.checked = checked;

  const contextItem = context?.subIssues.find((entry) => entry.issueNum === issueNum);
  if (contextItem) contextItem.checked = checked;
}

async function runIssueSession(
  config: Config,
  options: RunOptions,
  target: SessionExecutionTarget,
): Promise<SessionExecutionResult> {
  const activeEpic = target.type === 'epic'
    ? target.epicNum
    : target.type === 'issue'
      ? target.parentEpic?.number
      : undefined;
  const activeEpicTitle = target.type === 'epic'
    ? target.epicTitle
    : target.type === 'issue'
      ? target.parentEpic?.title
      : undefined;
  const activeEpicIssue = target.type === 'epic'
    ? target.epicIssue
    : target.type === 'issue'
      ? target.parentEpic
      : undefined;
  const queueContext = target.type === 'epic' ? target.queue : undefined;
  const activeMilestone = target.type === 'flat' ? target.activeMilestone : '';
  const failures: EpicExecutionFailure[] = [];
  let verificationClosedEpic = false;

  if (target.type === 'issue') {
    log.info(`Processing targeted issue #${target.issue.number}: ${target.issue.title}`);
    if (activeEpic !== undefined) {
      log.info(`Using parent epic #${activeEpic}${activeEpicTitle ? ': ' + activeEpicTitle : ''}`);
    }
  } else if (activeEpic !== undefined) {
    log.info(`Processing epic #${activeEpic}${activeEpicTitle ? ': ' + activeEpicTitle : ''}`);
  } else if (activeMilestone) {
    log.info(`Filtering issues by milestone: ${activeMilestone}`);
  }

  // Create session (named after epic or milestone if selected)
  const session = createSession(config, {
    milestone: activeMilestone || undefined,
    epicNum: activeEpic,
    epicTitle: activeEpicTitle,
    queue: queueContext,
  });

  // Print startup banner
  printBanner(config, session);

  // Check prerequisites
  checkPrerequisites(config);

  // Track active worktree for cleanup on signal
  let activeIssueNum: number | null = null;

  // Handle Ctrl+C gracefully
  const cleanup = async () => {
    log.info('');
    log.info('Shutting down...');

    // Clean up active worktree if any — preserve if it has commits so work isn't lost
    if (activeIssueNum !== null) {
      log.info(`Cleaning up worktree for issue #${activeIssueNum}...`);
      try {
        await cleanupWorktree({
          issueNum: activeIssueNum,
          projectDir: process.cwd(),
          autoCleanup: true,
          preserveIfCommits: true,
        });
      } catch {
        // Best effort cleanup
      }
    }

    // Finalize session
    let finalizationError: unknown;
    try {
      await finalizeSession(session, config);
    } catch (err) {
      finalizationError = err;
      log.error(`Session finalization failed: ${err instanceof Error ? err.message : err}`);
    }

    const issueCount = session.results.length;
    const successCount = session.results.filter((r) => r.status === 'success' && !isRecoveredRunResult(r)).length;
    log.info(`Session complete: ${successCount}/${issueCount} issues succeeded`);

    if (finalizationError) {
      throw new CommandExitError({
        code: 'session-interrupt-cleanup-failed',
        message: `Session finalization failed: ${finalizationError instanceof Error ? finalizationError.message : finalizationError}`,
        exitCode: 1,
        logged: true,
        cause: finalizationError,
      });
    }

    process.exitCode = 0;
  };

  const handleSignalCleanupError = (err: unknown): void => {
    if (isCommandExitError(err)) {
      process.exitCode = err.exitCode;
      if (!err.logged) log.error(err.message);
      return;
    }
    process.exitCode = 1;
    log.error(`Session cleanup failed: ${err instanceof Error ? err.message : err}`);
  };
  const handleSigint = () => { void cleanup().catch(handleSignalCleanupError); };
  const handleSigterm = () => { void cleanup().catch(handleSignalCleanupError); };
  process.on('SIGINT', handleSigint);
  process.on('SIGTERM', handleSigterm);

  // Sync agent assets to all configured harnesses before starting the loop.
  // Dry-run must remain read-only, so report what would happen instead.
  if (config.dryRun) {
    log.dry('Would sync agent assets before run');
  } else {
    const syncResult = syncAgentAssets(resolveHarnesses(config.harnesses, config.agent));
    if (syncResult.synced) {
      log.success('Agent assets synced before run');
    }
  }

  // Pre-flight test validation
  log.step('Running pre-flight test validation...');
  const preflightResult = await runPreflight({
    testCommand: config.testCommand,
    skipPreflight: config.skipPreflight,
    skipTests: config.skipTests,
    dryRun: config.dryRun,
  });
  if (preflightResult.passed) {
    if (!config.skipPreflight && !config.skipTests && !config.dryRun) {
      log.success('Pre-flight tests passed');
    }
  } else {
    log.warn(`Pre-flight: ${preflightResult.preExistingFailures.length} pre-existing failure(s) will be ignored`);
    for (const f of preflightResult.preExistingFailures) {
      log.warn(`  ${f}`);
    }
  }

  // Prompt for project vision if it doesn't exist (interactive only)
  if (!config.dryRun && !hasVision() && process.stdin.isTTY) {
    log.warn('No project vision found. The agent will make better decisions with one.');
    const answer = await askYesNo('Set up project vision now? [Y/n]: ');
    if (answer) {
      const { visionCommand } = await import('./vision.js');
      await visionCommand();
    }
  }

  // Generate or refresh project context if needed
  if (contextNeedsRefresh()) {
    if (config.dryRun) {
      log.dry('Would refresh project context and instructions');
    } else {
      log.info('Project context is stale or missing. Generating...');
      const { scanCommand } = await import('./scan.js');
      scanCommand();
    }
  } else {
    log.info('Project context is fresh');
  }

  // If vision or context were created/updated, commit them so worktrees get them
  if (!config.dryRun) {
    const statusResult = exec('git status --porcelain .alpha-loop/ AGENTS.md CLAUDE.md');
    if (statusResult.stdout.trim()) {
      const validation = validateGeneratedMarkdownForCommit(process.cwd(), statusResult.stdout);
      if (!validation.valid) {
        log.warn('Skipping generated context/instructions auto-commit because validation failed:');
        for (const error of validation.errors) {
          log.warn(`  ${error}`);
        }
      } else {
        log.info('New files generated — committing so worktrees include them...');
        exec('git add .alpha-loop/ AGENTS.md CLAUDE.md 2>/dev/null || true');
        const diffCheck = exec('git diff --cached --quiet');
        if (diffCheck.exitCode !== 0) {
          exec('git commit -m "chore: add project vision and context for alpha-loop"');
          exec(`git push origin "${config.baseBranch}"`);
          log.success('Vision and context committed to ' + config.baseBranch);
        }
      }
    }
  }

  // --- Fetch issue queue ---
  // When an epic is selected, the queue is its sub-issues in checklist order.
  // Otherwise, fetch via the usual project/label/milestone path and exclude
  // epic-labeled issues (AC #2: epics never picked up by the normal `ready` flow).
  let issues: Issue[];
  let epicChecklist: EpicChecklistPromptItem[] = [];
  let epicPromptContext: EpicPromptContext | undefined;
  if (target.type === 'issue') {
    issues = [target.issue];
    if (activeEpicIssue) {
      epicChecklist = parseEpicChecklistForPrompt(activeEpicIssue.body);
      const item = epicChecklist.find((entry) => entry.issueNum === target.issue.number);
      if (item) item.title = item.title ?? target.issue.title;
      epicPromptContext = buildEpicPromptContextFromIssue(activeEpicIssue, epicChecklist);
    }
  } else if (activeEpic !== undefined) {
    log.info(`Fetching sub-issues of epic #${activeEpic} in checklist order...`);
    const epicIssue = activeEpicIssue;
    if (!epicIssue) {
      const message = `Could not fetch epic #${activeEpic}`;
      failures.push({ code: 'epic-not-found', message, issueNum: activeEpic, exitCode: 1 });
      issues = [];
    } else {
      epicChecklist = parseEpicChecklistForPrompt(epicIssue.body);
      issues = [];
      for (const ref of epicChecklist) {
        if (ref.checked) continue; // already done
        const sub = getIssueWithComments(config.repo, ref.issueNum);
        if (!sub) {
          log.warn(`Sub-issue #${ref.issueNum} skipped: could not fetch`);
          continue;
        }
        ref.title = ref.title ?? sub.title;
        if (hasEpicLabel(sub)) {
          log.warn(`Sub-issue #${sub.number} skipped: is itself an epic (nested epics unsupported in v1)`);
          continue;
        }
        if (!hasLabel(sub.labels, config.labelReady)) {
          log.warn(`Sub-issue #${sub.number} skipped: not labeled '${config.labelReady}'`);
          continue;
        }
        issues.push(sub);
      }
      epicPromptContext = buildEpicPromptContextFromIssue(epicIssue, epicChecklist);
    }
  } else {
    const milestoneMsg = activeMilestone ? ` in milestone '${activeMilestone}'` : '';
    log.info(`Fetching issues${milestoneMsg}...`);
    issues = pollIssues(config.repo, config.labelReady, 100, {
      project: config.project,
      repoOwner: config.repoOwner,
      milestone: activeMilestone || undefined,
    }).filter((iss) => !hasEpicLabel(iss));
  }

  // When set mid-loop, skip post-loop epic verification (e.g. checklist body inconsistency).
  let epicAbort = false;

  if (issues.length === 0) {
    log.info('No issues found. Nothing to do.');
    const uncheckedEpicItems = epicChecklist.filter((item) => !item.checked).length;
    if (activeEpic !== undefined && (epicChecklist.length === 0 || uncheckedEpicItems > 0)) {
      failures.push({
        code: 'no-eligible-child-issues',
        message: `Epic #${activeEpic} has no eligible child issues to process`,
        issueNum: activeEpic,
      });
    }
  } else {
    const issueLimit = config.maxIssues > 0 ? Math.min(issues.length, config.maxIssues) : issues.length;
    let issuesToProcess = issues.slice(0, issueLimit);

    // Pre-session validation
    if (options.validate) {
      log.step('Running pre-session validation...');
      const report: ValidationReport = validateIssueQueue(
        issuesToProcess.map((i) => ({ number: i.number, title: i.title, body: i.body })),
      );
      printValidationReport(report);

      if (options.fix) {
        // Reorder based on dependency analysis
        if (report.dependencyWarnings.length > 0) {
          const reorderedNums = report.reorderedQueue.map((i) => i.number);
          issuesToProcess = reorderedNums
            .map((num) => issuesToProcess.find((i) => i.number === num))
            .filter((i): i is typeof issuesToProcess[number] => i !== undefined);
          log.info(`Reordered queue: ${issuesToProcess.map((i) => `#${i.number}`).join(', ')}`);
        }

        // Comment on incomplete issues and skip them
        if (report.completenessWarnings.length > 0 && !config.dryRun) {
          commentOnIncompleteIssues(config.repo, report);
        }
      }

      // Skip incomplete issues only when --fix is active
      if (options.fix && report.skippedIssues.length > 0) {
        const skippedSet = new Set(report.skippedIssues);
        issuesToProcess = issuesToProcess.filter((i) => !skippedSet.has(i.number));
        log.info(`Skipped ${report.skippedIssues.length} incomplete issue(s)`);
      }

      if (issuesToProcess.length === 0) {
        log.info('No issues remaining after validation. Nothing to do.');
      }
    }

    if (config.maxIssues > 0 && issues.length > config.maxIssues) {
      log.info(`Found ${issues.length} issue(s), processing first ${issueLimit} (max_issues=${config.maxIssues})`);
    } else {
      log.info(`Found ${issuesToProcess.length} issue(s) to process`);
    }

    const sessionStartTime = Date.now();

    if (config.batch) {
      // --- Batch mode: chunk issues and process each chunk as one agent session ---
      const batchSize = config.batchSize;
      const totalBatches = Math.ceil(issuesToProcess.length / batchSize);
      log.info(`Batch mode: ${issuesToProcess.length} issues in ${totalBatches} batch(es) of up to ${batchSize}`);

      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        // Check duration limit before each batch
        if (config.maxSessionDuration > 0) {
          const elapsed = Math.round((Date.now() - sessionStartTime) / 1000);
          if (elapsed >= config.maxSessionDuration) {
            log.info(`Stopping: max_session_duration reached (${elapsed}s / ${config.maxSessionDuration}s)`);
            break;
          }
        }

        const batchStart = batchIdx * batchSize;
        const batchIssues = issuesToProcess.slice(batchStart, batchStart + batchSize);
        const batchNums = batchIssues.map((i) => `#${i.number}`).join(', ');

        log.info('==========================================');
        log.info(`Batch ${batchIdx + 1}/${totalBatches}: ${batchNums} (${batchIssues.length} issues)`);
        log.info('==========================================');

        activeIssueNum = batchIssues[0].number;

        try {
          const results = epicPromptContext
            ? await processBatch(batchIssues, config, session, { epicContext: epicPromptContext })
            : await processBatch(batchIssues, config, session);
          session.results.push(...results);

          // Flip epic checklist for each successful sub-issue.
          // Skipped in dry-run: `processIssue` returns status='success' when tests are
          // stubbed in dry-run, which would otherwise mutate the live epic body.
          if (activeEpic !== undefined && !config.dryRun) {
            let checklistError = false;
            for (const r of results) {
              if (r.status !== 'success' || isRecoveredRunResult(r)) continue;
              try {
                updateEpicChecklist(config.repo, activeEpic, r.issueNum, true);
                markEpicChecklistItem(epicChecklist, epicPromptContext, r.issueNum, true);
              } catch (err) {
                const message = `Epic #${activeEpic} checklist update failed for sub-issue #${r.issueNum}: ${err instanceof Error ? err.message : err}`;
                log.error(message);
                failures.push({ code: 'checklist-update-failed', message, issueNum: r.issueNum });
                // One-agent-per-epic contract — halt further processing on body inconsistency
                epicAbort = true;
                checklistError = true;
                break;
              }
            }
            if (checklistError) {
              activeIssueNum = null;
              break;
            }
          } else if (activeEpic !== undefined && config.dryRun) {
            for (const r of results) {
              if (r.status === 'success' && !isRecoveredRunResult(r)) {
                log.dry(`Would flip epic #${activeEpic} checklist for sub-issue #${r.issueNum}`);
              }
            }
          }

          // Stop if any issue hit a transient error
          if (results.some((r) => r.failureReason === 'transient' && !isRecoveredRunResult(r))) {
            log.warn('Agent hit a rate/usage limit — stopping session to avoid wasting cycles');
            break;
          }
        } catch (err) {
          const message = `Failed to process batch ${batchIdx + 1}: ${err}`;
          log.error(message);
          failures.push({ code: 'batch-processing-error', message });
        }

        activeIssueNum = null;
      }
    } else {
      // --- Sequential mode (original behavior) ---
      for (const issue of issuesToProcess) {
        // Check duration limit before each issue
        if (config.maxSessionDuration > 0) {
          const elapsed = Math.round((Date.now() - sessionStartTime) / 1000);
          if (elapsed >= config.maxSessionDuration) {
            log.info(`Stopping: max_session_duration reached (${elapsed}s / ${config.maxSessionDuration}s)`);
            break;
          }
        }

        log.info('==========================================');
        log.info(`Processing issue #${issue.number}: ${issue.title}`);
        log.info('==========================================');

        activeIssueNum = issue.number;

        try {
          const result = epicPromptContext
            ? await processIssue(
                issue.number,
                issue.title,
                issue.body,
                config,
                session,
                { epicContext: epicPromptContext },
              )
            : await processIssue(
                issue.number,
                issue.title,
                issue.body,
                config,
                session,
              );
          session.results.push(result);

          // Flip the epic checklist box when this sub-issue succeeded.
          // Skipped in dry-run: `processIssue` stubs tests in dry-run and returns success,
          // which would otherwise mutate the live epic body.
          if (activeEpic !== undefined && result.status === 'success' && !isRecoveredRunResult(result) && !config.dryRun) {
            try {
              updateEpicChecklist(config.repo, activeEpic, issue.number, true);
              markEpicChecklistItem(epicChecklist, epicPromptContext, issue.number, true);
            } catch (err) {
              const message = `Epic #${activeEpic} checklist update failed for sub-issue #${issue.number}: ${err instanceof Error ? err.message : err}`;
              log.error(message);
              failures.push({ code: 'checklist-update-failed', message, issueNum: issue.number });
              // One-agent-per-epic contract — halt further processing on body inconsistency
              epicAbort = true;
              activeIssueNum = null;
              break;
            }
          } else if (activeEpic !== undefined && result.status === 'success' && !isRecoveredRunResult(result) && config.dryRun) {
            log.dry(`Would flip epic #${activeEpic} checklist for sub-issue #${issue.number}`);
          }

          // Stop processing if agent hit a transient error (usage/rate limit)
          if (result.failureReason === 'transient' && !isRecoveredRunResult(result)) {
            log.warn('Agent hit a rate/usage limit — stopping session to avoid wasting cycles');
            break;
          }
        } catch (err) {
          const message = `Failed to process issue #${issue.number}: ${err}`;
          log.error(message);
          failures.push({ code: 'issue-processing-error', message, issueNum: issue.number });
        }

        activeIssueNum = null;
      }
    }
  }

  // --- Epic completion check: verify and close if all sub-issues are now done ---
  if (activeEpic !== undefined && !epicAbort && !config.dryRun) {
    try {
      const remaining = epicChecklist.filter((r) => !r.checked);
      if (remaining.length === 0) {
        log.step(`All sub-issues of epic #${activeEpic} are complete — running verification pass`);
        const verification = await runEpicVerificationFlow(activeEpic, config, session);
        verificationClosedEpic = verification.closedEpic;
        if (verification.failure) {
          failures.push(verification.failure);
        } else if (verification.status === 'needs-human-input') {
          failures.push({
            code: 'epic-verification-failed',
            message: `Epic #${activeEpic} verification needs human review: verdict=${verification.verdict ?? 'unknown'}`,
            issueNum: activeEpic,
          });
        }
      } else {
        const message = `Epic #${activeEpic}: ${remaining.length} sub-issue(s) still open — verification deferred`;
        log.info(message);
        const hasFailedIssueResult = session.results.some((result) => result.status === 'failure' && !isRecoveredRunResult(result));
        if (options.stopOnPartialEpic && !hasFailedIssueResult) {
          failures.push({
            code: 'epic-incomplete',
            message,
            issueNum: activeEpic,
          });
        }
      }
    } catch (err) {
      const message = `Epic completion check failed: ${err instanceof Error ? err.message : err}`;
      log.warn(message);
      failures.push({ code: 'epic-verification-failed', message, issueNum: activeEpic });
    }
  }

  for (const result of session.results) {
    if (result.status === 'failure' && !isRecoveredRunResult(result)) {
      const transient = result.failureReason === 'transient';
      failures.push({
        code: transient ? 'transient-stop' : 'pipeline-failure',
        message: transient
          ? `Issue #${result.issueNum} stopped due to a transient agent or rate-limit failure`
          : `Issue #${result.issueNum} failed during processing`,
        issueNum: result.issueNum,
      });
    }
  }

  // Auto-capture failures as eval case skeletons
  if (config.autoCapture && session.results.length > 0) {
    const failures = session.results.filter((r) => r.status === 'failure' && !isRecoveredRunResult(r));
    if (failures.length > 0) {
      log.step(`Auto-capturing ${failures.length} failure(s) as eval cases...`);
      for (const failure of failures) {
        try {
          const step = detectFailureStep(failure);
          saveCapturedCase({
            issueNum: failure.issueNum,
            title: failure.title,
            step,
            session: session.name,
          });
        } catch (err) {
          log.warn(`Failed to auto-capture issue #${failure.issueNum}: ${err instanceof Error ? err.message : err}`);
        }
      }
      log.info('Run "alpha-loop eval capture" to add failure descriptions to these cases.');
    }
  }

  // Generate session summary (aggregates learnings across all issues)
  if (session.results.length > 0) {
    const learningsDir = join(process.cwd(), '.alpha-loop', 'learnings');
    if (config.autoMerge) {
      repairSessionLearningArtifacts({
        sessionName: session.name,
        issues: session.results.map((r) => ({
          issueNum: r.issueNum,
          title: r.title,
          status: r.status,
          duration: r.duration,
        })),
        learningsDir,
        sessionLogsDir: session.logsDir,
      });
      await generateSessionSummary({
        sessionName: session.name,
        results: session.results,
        learningsDir,
        config,
      });
      repairSessionSummaryArtifact({
        sessionName: session.name,
        learningsDir,
      });
    } else {
      log.info('Skipping parent learning artifact repair; issue learnings are committed in child PRs');
    }
  }

  // Post-session holistic code review
  if (session.results.length > 0 && !config.skipPostSessionReview && !config.dryRun) {
    log.step('Running post-session code review...');

    const projectDir = process.cwd();

    // Ensure we're on the session branch
    exec(`git checkout "${session.branch}"`, { cwd: projectDir });

    // Get full session diff
    const diffResult = exec(`git diff "origin/${config.baseBranch}...HEAD"`, { cwd: projectDir });
    const sessionDiff = diffResult.stdout;

    if (sessionDiff.trim()) {
      // Load vision context if available
      const visionPath = join(projectDir, '.alpha-loop', 'vision.md');
      const visionContext = existsSync(visionPath) ? readFileSync(visionPath, 'utf-8') : undefined;

      const reviewFile = join(projectDir, 'review-session.json');
      const reviewFileSession = join(session.logsDir, 'review-session.json');

      for (let attempt = 1; attempt <= config.maxTestRetries; attempt++) {
        log.info(`Session review attempt ${attempt} of ${config.maxTestRetries}`);

        try {
          const reviewPrompt = buildSessionReviewPrompt({
            sessionName: session.name,
            baseBranch: config.baseBranch,
            issuesSummary: session.results.map((r) => ({
              issueNum: r.issueNum,
              title: r.title,
              status: r.status,
              testsPassing: r.testsPassing,
            })),
            includeSecurityScan: !config.skipPostSessionSecurity,
            epicContext: epicPromptContext,
            visionContext,
          });

          // Trace review prompt
          writeTraceToSubdir(session.name, 'prompts', `session-review${attempt > 1 ? `-${attempt}` : ''}.md`, reviewPrompt);

          const reviewStep = resolveStepConfig(config, 'review');
          const reviewResult = await spawnAgent({
            agent: reviewStep.agent as typeof config.agent,
            model: reviewStep.model,
            prompt: reviewPrompt,
            cwd: projectDir,
            logFile: join(session.logsDir, `session-review${attempt > 1 ? `-${attempt}` : ''}.log`),
            verbose: config.verbose,
          });

          // Trace review output
          writeTraceToSubdir(session.name, 'outputs', `session-review${attempt > 1 ? `-${attempt}` : ''}.log`, reviewResult.output);
        } catch {
          log.warn('Session review failed, continuing without review');
          break;
        }

        // Read gate result
        const gate = readGateResult(reviewFile);

        // Move gate file to session logs
        if (existsSync(reviewFile)) {
          try { renameSync(reviewFile, reviewFileSession); } catch { /* cross-device */ }
        }

        if (gate.passed) {
          log.success(`Session review passed: ${gate.summary || 'no issues found'}`);
          session.sessionReviewFindings = gate;
          break;
        }

        // Review found unfixed issues — send to implementer
        const unfixedCount = gate.findings.filter((f) => !f.fixed).length;
        log.warn(`Session review found ${unfixedCount} unfixed issue(s)`);

        if (attempt < config.maxTestRetries) {
          const findings = formatGateFindings(gate, 'Session Review');
          const fixPrompt = `The post-session code review found problems that need to be fixed.\n\n${findings}\n\nInstructions:\n1. Address each finding listed above\n2. Run tests to make sure nothing is broken\n3. Commit your fixes with: git commit -m "fix: address session review findings"`;

          // Trace fix prompt
          writeTraceToSubdir(session.name, 'prompts', `session-review-fix-${attempt}.md`, fixPrompt);

          try {
            const implementStep = resolveStepConfig(config, 'implement');
            const fixResult = await spawnAgent({
              agent: implementStep.agent as typeof config.agent,
              model: implementStep.model,
              prompt: fixPrompt,
              cwd: projectDir,
              logFile: join(session.logsDir, `session-review-fix-${attempt}.log`),
              verbose: config.verbose,
            });

            // Trace fix output
            writeTraceToSubdir(session.name, 'outputs', `session-review-fix-${attempt}.log`, fixResult.output);

            // Auto-commit if agent left changes
            const fixStatus = exec('git status --porcelain', { cwd: projectDir });
            if (fixStatus.stdout.trim()) {
              exec('git add -A', { cwd: projectDir });
              exec('git commit -m "fix: address session review findings"', { cwd: projectDir });
            }
          } catch {
            log.warn('Session review fix failed, continuing');
          }
        } else {
          log.warn('Session review: max attempts reached, continuing with unfixed findings');
          session.sessionReviewFindings = gate;
        }
      }

      // Clean up gate file if it wasn't moved
      if (existsSync(reviewFile)) {
        try { unlinkSync(reviewFile); } catch { /* ignore */ }
      }
    } else {
      log.info('No changes in session diff, skipping session review');
    }
  } else if (config.skipPostSessionReview) {
    log.info('Post-session review skipped');
  }

  // Finalize session
  const finalizedPrUrl = await finalizeSession(session, config);
  const sessionPrUrl = finalizedPrUrl ?? session.sessionPrUrl ?? null;

  const successCount = session.results.filter((r) => r.status === 'success' && !isRecoveredRunResult(r)).length;
  log.info(`Session complete: ${successCount}/${session.results.length} issues succeeded`);
  process.off('SIGINT', handleSigint);
  process.off('SIGTERM', handleSigterm);

  return {
    session,
    sessionPrUrl,
    failures,
    verificationClosedEpic,
  };
}

function buildEpicFailureResult(epicNumber: number, failure: EpicExecutionFailure): EpicExecutionResult {
  return {
    epicNumber,
    sessionName: null,
    sessionBranch: null,
    sessionPrUrl: null,
    status: 'failure',
    failures: [failure],
    verificationClosedEpic: false,
  };
}

function buildIssueFailureResult(
  issueNumber: number,
  failure: EpicExecutionFailure,
  parentEpicNumber: number | null = null,
): IssueExecutionResult {
  return {
    issueNumber,
    parentEpicNumber,
    sessionName: null,
    sessionBranch: null,
    sessionPrUrl: null,
    status: 'failure',
    failures: [failure],
    verificationClosedEpic: false,
  };
}

function issueIsOpen(issue: Issue): boolean {
  return issue.state === undefined || issue.state.toLowerCase() === 'open';
}

function formatParentEpicList(epics: Issue[]): string {
  return epics.map((epic) => `#${epic.number} ${epic.title}`).join(', ');
}

function findOpenParentEpics(config: Config, issueNumber: number): Issue[] {
  return listEpics(config.repo).filter((epic) => (
    epic.number !== issueNumber
    && parseSubIssues(epic.body).some((ref) => ref.number === issueNumber)
  ));
}

function logSingleIssueDryRunDecision(config: Config, issue: Issue, parentEpic: Issue | undefined): void {
  if (!config.dryRun) return;
  const parent = parentEpic
    ? `child of open epic #${parentEpic.number} ${parentEpic.title}`
    : 'standalone issue with no open parent epic';
  log.dry(`Resolved --issue #${issue.number}: ${issue.title}`);
  log.dry(`Issue #${issue.number} is eligible: open, labeled '${config.labelReady}', not blocked, ${parent}`);
}

export async function runSingleIssueExecution(args: {
  config: Config;
  issueNumber: number;
  issue?: Issue;
  options?: RunOptions;
}): Promise<IssueExecutionResult> {
  const { config, issueNumber } = args;
  const options = args.options ?? {};

  if (typeof issueNumber !== 'number' || !Number.isFinite(issueNumber) || issueNumber <= 0) {
    return buildIssueFailureResult(issueNumber, {
      code: 'invalid-issue-number',
      message: '--issue requires a positive integer issue number (e.g. --issue 42)',
      exitCode: 1,
    });
  }

  const issue = args.issue ?? getIssueWithComments(config.repo, issueNumber);
  if (!issue) {
    return buildIssueFailureResult(issueNumber, {
      code: 'issue-not-found',
      message: `Could not fetch issue #${issueNumber}. Check the issue number and repository before running --issue.`,
      issueNum: issueNumber,
      exitCode: 1,
    });
  }

  if (!issueIsOpen(issue)) {
    return buildIssueFailureResult(issueNumber, {
      code: 'issue-closed',
      message: `Issue #${issueNumber} is closed. Reopen it before running --issue.`,
      issueNum: issueNumber,
      exitCode: 1,
    });
  }

  if (hasEpicLabel(issue)) {
    return buildIssueFailureResult(issueNumber, {
      code: 'issue-is-epic',
      message: `Issue #${issueNumber} is labeled 'epic'. Use alpha-loop run --epic ${issueNumber} instead.`,
      issueNum: issueNumber,
      exitCode: 1,
    });
  }

  if (hasLabel(issue.labels, 'blocked')) {
    return buildIssueFailureResult(issueNumber, {
      code: 'issue-blocked',
      message: `Issue #${issueNumber} is blocked. Remove the 'blocked' label before running --issue.`,
      issueNum: issueNumber,
      exitCode: 1,
    });
  }

  if (!hasLabel(issue.labels, config.labelReady)) {
    return buildIssueFailureResult(issueNumber, {
      code: 'issue-not-ready',
      message: `Issue #${issueNumber} is not labeled '${config.labelReady}'. Add that label before running --issue.`,
      issueNum: issueNumber,
      exitCode: 1,
    });
  }

  const parentEpics = findOpenParentEpics(config, issueNumber);
  if (parentEpics.length > 1) {
    return buildIssueFailureResult(issueNumber, {
      code: 'ambiguous-parent-epics',
      message: `Issue #${issueNumber} is referenced by multiple open parent epics: ${formatParentEpicList(parentEpics)}. Remove duplicate parent checklist references or close the unintended parent epic before running --issue.`,
      issueNum: issueNumber,
      exitCode: 1,
    });
  }

  const parentEpic = parentEpics[0];
  logSingleIssueDryRunDecision(config, issue, parentEpic);

  const sessionResult = await runIssueSession(config, options, {
    type: 'issue',
    issue,
    parentEpic,
  });

  return {
    issueNumber: issue.number,
    parentEpicNumber: parentEpic?.number ?? null,
    sessionName: sessionResult.session.name,
    sessionBranch: sessionResult.session.branch,
    sessionPrUrl: sessionResult.sessionPrUrl,
    status: sessionResult.failures.length > 0 ? 'failure' : 'success',
    failures: sessionResult.failures,
    verificationClosedEpic: sessionResult.verificationClosedEpic,
  };
}

export async function runSingleEpicExecution(args: {
  config: Config;
  epicNumber: number;
  epicIssue?: Issue;
  options?: RunOptions;
  queue?: QueueSessionContext;
}): Promise<EpicExecutionResult> {
  const { config, epicNumber } = args;
  const options = args.options ?? {};

  if (typeof epicNumber !== 'number' || !Number.isFinite(epicNumber) || epicNumber <= 0) {
    return buildEpicFailureResult(epicNumber, {
      code: 'invalid-epic-number',
      message: '--epic requires a positive integer issue number (e.g. --epic 165)',
      exitCode: 1,
    });
  }

  const epic = args.epicIssue ?? getIssueWithComments(config.repo, epicNumber);
  if (!epic) {
    return buildEpicFailureResult(epicNumber, {
      code: 'epic-not-found',
      message: `Could not fetch epic #${epicNumber}`,
      issueNum: epicNumber,
      exitCode: 1,
    });
  }

  if (!hasEpicLabel(epic)) {
    return buildEpicFailureResult(epicNumber, {
      code: 'missing-epic-label',
      message: `Issue #${epicNumber} is not labeled 'epic'. Add the epic label before running --epic.`,
      issueNum: epicNumber,
      exitCode: 1,
    });
  }

  const sessionResult = await runIssueSession(config, options, {
    type: 'epic',
    epicNum: epic.number,
    epicTitle: epic.title,
    epicIssue: epic,
    queue: args.queue,
  });

  return {
    epicNumber: epic.number,
    sessionName: sessionResult.session.name,
    sessionBranch: sessionResult.session.branch,
    sessionPrUrl: sessionResult.sessionPrUrl,
    status: sessionResult.failures.length > 0 ? 'failure' : 'success',
    failures: sessionResult.failures,
    verificationClosedEpic: sessionResult.verificationClosedEpic,
  };
}

function exitForCliEpicValidationFailure(result: EpicExecutionResult): void {
  const failure = result.failures.find((entry) => entry.exitCode !== undefined);
  if (!failure) return;
  log.error(failure.message);
  throw new CommandExitError({
    code: failure.code,
    message: failure.message,
    exitCode: failure.exitCode ?? 1,
    logged: true,
  });
}

function exitForCliIssueFailure(result: IssueExecutionResult): void {
  if (result.status !== 'failure') return;
  const failure = result.failures.find((entry) => entry.exitCode !== undefined) ?? result.failures[0];
  if (!failure) return;
  log.error(failure.message);
  throw new CommandExitError({
    code: failure.code,
    message: failure.message,
    exitCode: failure.exitCode ?? 1,
    logged: true,
  });
}

function buildConfigOverrides(options: RunOptions): Partial<Config> {
  const overrides: Partial<Config> = {};
  if (options.dryRun) overrides.dryRun = true;
  if (options.model) overrides.model = options.model;
  if (options.skipTests) overrides.skipTests = true;
  if (options.skipReview) overrides.skipReview = true;
  if (options.skipLearn) overrides.skipLearn = true;
  if (options.milestone) overrides.milestone = options.milestone;
  if (options.autoMerge) overrides.autoMerge = true;
  if (options.mergeTo) overrides.mergeTo = options.mergeTo;
  if (options.batch) overrides.batch = true;
  if (options.batchSize) overrides.batchSize = options.batchSize;
  if (options.verbose) overrides.verbose = true;
  return overrides;
}

function rejectIncompatibleSingleIssueOptions(options: RunOptions): void {
  const incompatible: string[] = [];
  if (options.epic !== undefined) incompatible.push('--epic');
  if (options.epics !== undefined) incompatible.push('--epics');
  if (options.verifyOnly !== undefined) incompatible.push('--verify-only');

  if (incompatible.length === 0) return;

  log.error(`--issue cannot be combined with ${incompatible.join(', ')}`);
  throw new CommandExitError({
    code: 'incompatible-issue-options',
    message: `--issue cannot be combined with ${incompatible.join(', ')}`,
    exitCode: 1,
    logged: true,
  });
}

function rejectIncompatibleEpicQueueOptions(options: RunOptions): void {
  const incompatible: string[] = [];
  if (options.issue !== undefined) incompatible.push('--issue');
  if (options.epic !== undefined) incompatible.push('--epic');
  if (options.verifyOnly !== undefined) incompatible.push('--verify-only');
  if (options.milestone) incompatible.push('--milestone');
  if (options.skipEpic) incompatible.push('--skip-epic');
  if (options.mergeTo) incompatible.push('--merge-to');

  if (incompatible.length === 0) return;

  log.error(`--epics cannot be combined with ${incompatible.join(', ')}`);
  throw new CommandExitError({
    code: 'incompatible-epic-queue-options',
    message: `--epics cannot be combined with ${incompatible.join(', ')}`,
    exitCode: 1,
    logged: true,
  });
}

function printDryRunEpicQueue(entries: ReturnType<typeof validateEpicQueue>['entries']): void {
  log.dry(`Validated epic queue (${entries.length} epic${entries.length === 1 ? '' : 's'}):`);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const suffixes = [
      entry.status === 'already-complete' ? 'already complete; will skip' : '',
      entry.validationWarning ? `warning: ${entry.validationWarning}` : '',
    ].filter(Boolean);
    const suffix = suffixes.length > 0 ? ` (${suffixes.join('; ')})` : '';
    log.dry(`  ${index + 1}. #${entry.epicNumber} ${entry.title}${suffix}`);
  }
}

function normalizeQueueBranchMode(value: BranchAncestryMode | undefined): BranchAncestryMode {
  if (value === undefined) return 'stacked';
  if (value === 'stacked' || value === 'independent') return value;
  throw new Error(`Invalid queue branch mode: ${value}. Expected "stacked" or "independent".`);
}

function toManifestFailures(failures: EpicExecutionFailure[]): EpicQueueManifestFailure[] {
  return failures.map((failure) => ({
    code: failure.code,
    message: failure.message,
    ...(failure.issueNum !== undefined ? { issueNum: failure.issueNum } : {}),
    ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
  }));
}

function stopReasonForEpicResult(result: EpicExecutionResult): string {
  const firstFailure = result.failures[0];
  if (!firstFailure) return `Epic #${result.epicNumber} stopped without a reported failure`;

  const reasonByCode: Partial<Record<EpicExecutionFailureCode, string>> = {
    'checklist-update-failed': 'checklist-consistency-error',
    'epic-verification-failed': 'epic-verification-failed',
    'epic-incomplete': 'epic-incomplete',
    'transient-stop': 'transient-agent-stop',
  };
  const reason = reasonByCode[firstFailure.code] ?? firstFailure.code;
  return `Epic #${result.epicNumber} stopped: ${reason}`;
}

type QueueRiskMap = Map<number, { dependencyWarnings: string[]; overlapWarnings: string[] }>;

function queueEpicLink(entry: ValidatedEpicQueueEntry | EpicQueueManifestEntry | undefined): QueueEpicLink | null {
  if (!entry) return null;
  const link: QueueEpicLink = {
    number: entry.epicNumber,
    title: entry.title,
  };
  if ('sessionBranch' in entry) link.sessionBranch = entry.sessionBranch;
  if ('sessionPrUrl' in entry) link.sessionPrUrl = entry.sessionPrUrl;
  return link;
}

function addQueueDependencyNote(risks: QueueRiskMap, epicNumber: number, note: string): void {
  const entry = risks.get(epicNumber);
  if (!entry || entry.dependencyWarnings.includes(note)) return;
  entry.dependencyWarnings.push(note);
}

function addQueueOverlapNote(risks: QueueRiskMap, epicNumber: number, note: string): void {
  const entry = risks.get(epicNumber);
  if (!entry || entry.overlapWarnings.includes(note)) return;
  entry.overlapWarnings.push(note);
}

function buildQueueRiskMap(entries: ValidatedEpicQueueEntry[]): QueueRiskMap {
  const risks: QueueRiskMap = new Map(entries.map((entry) => [
    entry.epicNumber,
    { dependencyWarnings: [], overlapWarnings: [] },
  ]));
  const queuedEpicNumbers = new Set(entries.map((entry) => entry.epicNumber));

  for (const entry of entries) {
    for (const dep of parseDependencies(entry.issue.body).filter((num) => queuedEpicNumbers.has(num))) {
      addQueueDependencyNote(
        risks,
        entry.epicNumber,
        `Epic #${entry.epicNumber} declares a dependency on queued epic #${dep}.`,
      );
      addQueueDependencyNote(
        risks,
        dep,
        `Later queued epic #${entry.epicNumber} declares a dependency on this epic.`,
      );
    }
  }

  const report = validateIssueQueue(
    entries.map((entry) => ({ number: entry.epicNumber, title: entry.title, body: entry.issue.body })),
    0,
  );
  for (const warning of report.dependencyWarnings) {
    const note = `Queue order warning: ${warning.reason}.`;
    addQueueDependencyNote(risks, warning.issueNum, note);
    addQueueDependencyNote(risks, warning.dependsOn, note);
  }
  for (const warning of report.overlapWarnings) {
    const note = `Epics #${warning.issueA} and #${warning.issueB} both mention ${warning.sharedFiles.join(', ')}.`;
    addQueueOverlapNote(risks, warning.issueA, note);
    addQueueOverlapNote(risks, warning.issueB, note);
  }

  return risks;
}

function buildQueueSessionContext(args: {
  manifest: EpicQueueManifest;
  entries: ValidatedEpicQueueEntry[];
  currentIndex: number;
  branchAncestryMode: BranchAncestryMode;
  baseBranch: string;
  previousSessionBranch: string | null;
  previousSessionPrUrl: string | null;
  risks: QueueRiskMap;
}): QueueSessionContext {
  const currentEntry = args.entries[args.currentIndex];
  const manifestEntry = args.manifest.epics.find((entry) => entry.epicNumber === currentEntry.epicNumber);
  const previousManifestEntry = args.currentIndex > 0 ? args.manifest.epics[args.currentIndex - 1] : undefined;
  const nextManifestEntry = args.currentIndex < args.manifest.epics.length - 1
    ? args.manifest.epics[args.currentIndex + 1]
    : undefined;
  const dependsOnSessionBranch = args.branchAncestryMode === 'stacked' ? args.previousSessionBranch : null;
  const dependsOnSessionPrUrl = dependsOnSessionBranch ? args.previousSessionPrUrl : null;
  const risk = args.risks.get(currentEntry.epicNumber) ?? { dependencyWarnings: [], overlapWarnings: [] };

  return {
    queueId: args.manifest.queueId,
    queueIndex: args.currentIndex + 1,
    queueTotal: args.entries.length,
    currentEpic: {
      number: currentEntry.epicNumber,
      title: currentEntry.title,
      sessionBranch: manifestEntry?.sessionBranch ?? null,
      sessionPrUrl: manifestEntry?.sessionPrUrl ?? null,
    },
    previousEpic: queueEpicLink(previousManifestEntry),
    nextEpic: queueEpicLink(nextManifestEntry),
    previousSessionBranch: args.previousSessionBranch,
    previousSessionPrUrl: args.previousSessionPrUrl,
    branchAncestryMode: args.branchAncestryMode,
    branchedFromBranch: dependsOnSessionBranch ?? args.baseBranch,
    dependsOnSessionBranch,
    dependsOnSessionPrUrl,
    rebaseOntoBranch: dependsOnSessionBranch ? args.baseBranch : null,
    dependencyWarnings: risk.dependencyWarnings,
    overlapWarnings: risk.overlapWarnings,
  };
}

function applyQueueContextToManifestEntry(entry: EpicQueueManifestEntry, queue: QueueSessionContext): void {
  entry.queueIndex = queue.queueIndex;
  entry.queueTotal = queue.queueTotal;
  entry.previousEpic = queue.previousEpic;
  entry.nextEpic = queue.nextEpic;
  entry.branchAncestryMode = queue.branchAncestryMode;
  entry.branchedFromBranch = queue.branchedFromBranch;
  entry.dependsOnSessionBranch = queue.dependsOnSessionBranch;
  entry.dependsOnSessionPrUrl = queue.dependsOnSessionPrUrl;
  entry.rebaseOntoBranch = queue.rebaseOntoBranch;
  entry.dependencyWarnings = queue.dependencyWarnings;
  entry.overlapWarnings = queue.overlapWarnings;
}

function writeQueueManifestUpdate(manifest: EpicQueueManifest): void {
  const manifestPath = writeQueueManifest(process.cwd(), manifest);
  log.info(`Queue manifest saved: ${manifestPath}`);
}

async function runEpicQueue(config: Config, options: RunOptions): Promise<void> {
  rejectIncompatibleEpicQueueOptions(options);

  let epicNumbers: number[];
  try {
    epicNumbers = parseEpicQueue(options.epics ?? '');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    throw new CommandExitError({
      code: 'invalid-epic-queue',
      message,
      exitCode: 1,
      logged: true,
      cause: err,
    });
  }

  let branchAncestryMode: BranchAncestryMode;
  try {
    branchAncestryMode = normalizeQueueBranchMode(options.queueBranchMode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    throw new CommandExitError({
      code: 'invalid-queue-branch-mode',
      message,
      exitCode: 1,
      logged: true,
      cause: err,
    });
  }

  const validation = validateEpicQueue(config.repo, epicNumbers, undefined, {
    allowMissingEpicLabel: config.dryRun,
  });
  if (validation.errors.length > 0) {
    for (const error of validation.errors) {
      log.error(error.message);
    }
    if (!config.dryRun) {
      writeQueueManifestUpdate(createEpicQueueValidationFailureManifest(epicNumbers, validation.errors, new Date(), branchAncestryMode));
    }
    throw new QueueExecutionError({
      code: 'epic-queue-validation-failed',
      message: validation.errors.map((error) => error.message).join('\n'),
      exitCode: 1,
      logged: true,
    });
  }

  if (config.dryRun) {
    printDryRunEpicQueue(validation.entries);
    return;
  }

  const manifest = createEpicQueueManifest(validation.entries, new Date(), branchAncestryMode);
  const queueRisks = buildQueueRiskMap(validation.entries);
  writeQueueManifestUpdate(manifest);

  const queueConfig: Config = {
    ...config,
    autoMerge: true,
    mergeTo: '',
  };
  const queueOptions: RunOptions = {
    ...options,
    autoMerge: true,
    mergeTo: undefined,
    epics: undefined,
    stopOnPartialEpic: true,
  };

  let previousSessionBranch: string | null = null;
  let previousSessionPrUrl: string | null = null;
  let previousSessionManifestEntry: EpicQueueManifestEntry | null = null;

  for (let index = 0; index < validation.entries.length; index++) {
    const validatedEntry = validation.entries[index];
    const manifestEntry = manifest.epics.find((entry) => entry.epicNumber === validatedEntry.epicNumber);
    if (!manifestEntry) continue;

    if (manifestEntry.status === 'skipped') {
      log.info(`Skipping epic #${validatedEntry.epicNumber}: ${manifestEntry.skipReason}`);
      continue;
    }

    const queueContext = buildQueueSessionContext({
      manifest,
      entries: validation.entries,
      currentIndex: index,
      branchAncestryMode,
      baseBranch: config.baseBranch,
      previousSessionBranch,
      previousSessionPrUrl,
      risks: queueRisks,
    });
    applyQueueContextToManifestEntry(manifestEntry, queueContext);
    manifestEntry.status = 'running';
    manifestEntry.startedAt = new Date().toISOString();
    writeQueueManifestUpdate(manifest);

    const result = await (async (): Promise<EpicExecutionResult> => {
      try {
        return await runSingleEpicExecution({
          config: queueConfig,
          epicNumber: validatedEntry.epicNumber,
          epicIssue: validatedEntry.issue,
          options: queueOptions,
          queue: queueContext,
        });
      } catch (err) {
        return buildEpicFailureResult(validatedEntry.epicNumber, {
          code: 'epic-run-error',
          message: `Epic #${validatedEntry.epicNumber} failed with an unhandled error: ${err instanceof Error ? err.message : err}`,
          issueNum: validatedEntry.epicNumber,
        });
      }
    })();

    manifestEntry.sessionName = result.sessionName;
    manifestEntry.sessionBranch = result.sessionBranch;
    manifestEntry.sessionPrUrl = result.sessionPrUrl;
    manifestEntry.failures = toManifestFailures(result.failures);
    manifestEntry.endedAt = new Date().toISOString();
    manifestEntry.status = result.status === 'success' ? 'success' : 'failure';

    if (result.status === 'failure') {
      manifest.status = 'stopped';
      manifest.stopReason = stopReasonForEpicResult(result);
      manifest.endedAt = manifestEntry.endedAt;
      writeQueueManifestUpdate(manifest);
      log.error(manifest.stopReason);
      throw new QueueExecutionError({
        code: 'epic-queue-stopped',
        message: manifest.stopReason,
        exitCode: 1,
        logged: true,
        result,
        manifest,
      });
    }

    writeQueueManifestUpdate(manifest);
    if (previousSessionManifestEntry) {
      previousSessionManifestEntry.nextSessionBranch = result.sessionBranch;
      previousSessionManifestEntry.nextSessionPrUrl = result.sessionPrUrl;
    }
    previousSessionBranch = result.sessionBranch;
    previousSessionPrUrl = result.sessionPrUrl;
    previousSessionManifestEntry = manifestEntry;
  }

  manifest.status = 'success';
  manifest.endedAt = new Date().toISOString();
  writeQueueManifestUpdate(manifest);
  log.success(`Epic queue complete: ${manifest.epics.length} epic${manifest.epics.length === 1 ? '' : 's'}`);
}

/**
 * Run the main loop: poll issues, process them, finalize session.
 */
export async function runCommand(options: RunOptions): Promise<void> {
  try {
    const config = loadConfig(buildConfigOverrides(options));

    if (!config.repo) {
      const message = 'No repository configured. Run "alpha-loop init" or set repo in .alpha-loop.yaml';
      log.error(message);
      throw new CommandExitError({
        code: 'missing-repository',
        message,
        exitCode: 1,
        logged: true,
      });
    }

    if (options.issue !== undefined) {
      rejectIncompatibleSingleIssueOptions(options);
      const result = await runSingleIssueExecution({
        config,
        issueNumber: options.issue,
        options,
      });
      exitForCliIssueFailure(result);
      return;
    }

    if (options.epics !== undefined) {
      await runEpicQueue(config, options);
      return;
    }

    // --- Verify-only path: bypass the normal loop entirely ---
    if (options.verifyOnly !== undefined) {
      if (!Number.isFinite(options.verifyOnly) || options.verifyOnly <= 0) {
        const message = '--verify-only requires a positive integer issue number (e.g. --verify-only 165)';
        log.error(message);
        throw new CommandExitError({
          code: 'invalid-verify-only',
          message,
          exitCode: 1,
          logged: true,
        });
      }
      log.step(`Running verify-only pass for epic #${options.verifyOnly}`);
      const verification = await runEpicVerificationFlow(options.verifyOnly, config, null);
      if (verification.failure?.exitCode !== undefined) {
        throw new CommandExitError({
          code: verification.failure.code,
          message: verification.failure.message,
          exitCode: verification.failure.exitCode,
          logged: true,
        });
      }
      return;
    }

    // --epic <N> overrides everything except --verify-only.
    if (options.epic !== undefined) {
      const result = await runSingleEpicExecution({
        config,
        epicNumber: options.epic,
        options,
      });
      exitForCliEpicValidationFailure(result);
      return;
    }

    // --- Target selection (epic or milestone) — must happen before session creation ---
    const target = await resolveRunTarget(config, options);
    if (!target) return;

    if (target.activeEpic !== undefined) {
      const result = await runSingleEpicExecution({
        config,
        epicNumber: target.activeEpic,
        epicIssue: target.activeEpicIssue,
        options,
      });
      exitForCliEpicValidationFailure(result);
      return;
    }

    await runIssueSession(config, options, {
      type: 'flat',
      activeMilestone: target.activeMilestone,
    });
  } catch (err) {
    if (!isCommandExitError(err)) throw err;
    if (!err.logged) log.error(err.message);
    process.exitCode = err.exitCode;
  }
}
