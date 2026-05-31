/**
 * Resume Command — pick up stranded work from a crashed or hung loop session.
 *
 * Finds local branches matching agent/issue-* that have commits ahead of
 * origin/<baseBranch> but no corresponding open PR, then pushes, reviews,
 * and opens a PR for each one. Also updates the session PR if one exists.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveStepConfig } from '../lib/config.js';
import { log } from '../lib/logger.js';
import { exec, shellQuote } from '../lib/shell.js';
import { ghExec } from '../lib/rate-limit.js';
import { spawnAgent } from '../lib/agent.js';
import { buildReviewPrompt } from '../lib/prompts.js';
import {
  generateSessionSummary,
  repairSessionLearningArtifacts,
  repairSessionSummaryArtifact,
} from '../lib/learning.js';
import {
  clearCrashMarker,
  findCrashMarkers,
  findLatestResumableSessionForIssue,
  formatAutoCommittedResultsSection,
  finalizeSession,
  rehydrateSessionContextFromManifest,
  transitionHumanFeedbackSessionStatus,
  transitionSessionStatus,
  type CrashMarkerRef,
  type DurableSessionManifest,
  type ResumableSessionRef,
  type SessionStage,
  type SessionStatus,
} from '../lib/session.js';
import {
  labelIssue,
  commentIssue,
  createPR,
  getIssueWithComments,
  updateProjectStatus,
  type Comment,
  type Issue,
} from '../lib/github.js';
import { isRecoveredResult, processIssue } from '../lib/pipeline.js';
import type { PipelineResult, PipelineResumeStage } from '../lib/pipeline.js';
import {
  classifyFeedback,
  githubLabelChangesForStatus,
  normalizeHumanFeedbackStatus,
  type FeedbackClassification,
} from '../lib/session-state.js';
import { emitLifecycleEvent } from '../lib/events.js';

export type ResumeOptions = {
  issue?: string;
  session?: string;
};

type StrandedBranch = {
  branch: string;
  issueNum: number;
  commits: string[];
  filesChanged: string[];
  crashMarker?: CrashMarkerRef;
};

type ResumeFeedbackContext = {
  issue: Pick<Issue, 'number' | 'title' | 'body' | 'comments'>;
  newComments: Comment[];
  commentsUsedForClassification: Comment[];
  classification: FeedbackClassification;
  resumeStage: PipelineResumeStage;
  contextText: string;
  existingPrUrl: string | null;
};

const FEEDBACK_RESUME_STATUSES: SessionStatus[] = [
  'human_input_requested',
  'qa_requested',
  'feedback_received',
  'resume_requested',
  'resuming',
  'paused',
  'waiting-for-feedback',
  'qa-requested',
  'resumed',
];

function normalizeGitBranchLine(line: string): string {
  return line.trim().replace(/^[*+]\s*/, '');
}

function listAgentIssueBranches(): string[] {
  const branches = new Set<string>();

  const listResult = exec('git branch --list "agent/issue-*"');
  if (listResult.exitCode === 0) {
    for (const line of listResult.stdout.split('\n')) {
      const branch = normalizeGitBranchLine(line);
      if (branch) branches.add(branch);
    }
  }

  const worktreeResult = exec('git worktree list --porcelain');
  if (worktreeResult.exitCode === 0) {
    for (const line of worktreeResult.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('branch refs/heads/')) continue;
      const branch = trimmed.slice('branch refs/heads/'.length);
      if (branch.startsWith('agent/issue-')) branches.add(branch);
    }
  }

  return Array.from(branches).sort();
}

function worktreePathForBranch(branch: string): string | null {
  const worktreeResult = exec('git worktree list --porcelain');
  if (worktreeResult.exitCode !== 0) return null;

  let currentWorktree: string | null = null;
  for (const line of worktreeResult.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('worktree ')) {
      currentWorktree = trimmed.slice('worktree '.length);
      continue;
    }
    if (trimmed === `branch refs/heads/${branch}`) {
      return currentWorktree;
    }
  }

  return null;
}

function checkoutBranchForResume(branch: string): string | null {
  const existingWorktree = worktreePathForBranch(branch);
  if (existingWorktree) return existingWorktree;

  const toplevelResult = exec('git rev-parse --show-toplevel');
  const cwd = toplevelResult.exitCode === 0 && toplevelResult.stdout
    ? toplevelResult.stdout
    : process.cwd();
  const checkoutResult = exec(`git checkout ${shellQuote(branch)}`, { cwd });
  if (checkoutResult.exitCode !== 0) {
    log.error(`Could not check out ${branch}: ${checkoutResult.stderr || checkoutResult.stdout}`);
    return null;
  }
  return cwd;
}

function changedLearningPaths(cwd: string, issueNum: number): string[] {
  const statusResult = exec('git status --porcelain -- ".alpha-loop/learnings"', { cwd });
  if (statusResult.exitCode !== 0 || !statusResult.stdout.trim()) return [];

  return statusResult.stdout
    .split('\n')
    .map((line) => {
      const path = line.slice(3).trim();
      return path.includes(' -> ') ? path.split(' -> ').pop()!.trim() : path;
    })
    .filter((path) => path.startsWith(`.alpha-loop/learnings/issue-${issueNum}-`) && path.endsWith('.md'));
}

function commitChangedLearningArtifacts(cwd: string, issueNum: number): boolean {
  const paths = changedLearningPaths(cwd, issueNum);
  if (paths.length === 0) return false;

  const pathspecs = paths.map((path) => shellQuote(path)).join(' ');
  const addResult = exec(`git add -- ${pathspecs}`, { cwd });
  if (addResult.exitCode !== 0) {
    log.warn(`Could not stage learning artifact for #${issueNum}: ${addResult.stderr || addResult.stdout}`);
    return false;
  }

  const stagedResult = exec(`git diff --cached --name-only -- ${pathspecs}`, { cwd });
  if (stagedResult.exitCode !== 0 || !stagedResult.stdout.trim()) return false;

  const stagedPaths = stagedResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => paths.includes(line));
  if (stagedPaths.length === 0) return false;

  const commitResult = exec(
    `git commit -m ${shellQuote(`chore: add learning artifact for issue #${issueNum}`)} -- ${stagedPaths.map((path) => shellQuote(path)).join(' ')}`,
    { cwd },
  );
  if (commitResult.exitCode !== 0) {
    log.warn(`Could not commit learning artifact for #${issueNum}: ${commitResult.stderr || commitResult.stdout}`);
    return false;
  }

  log.success(`Learning artifact committed for #${issueNum}`);
  return true;
}

/**
 * Find local branches matching agent/issue-* that have no open PR and have
 * commits ahead of the remote base branch.
 */
export function findStrandedBranches(baseBranch: string, filterIssue?: number): StrandedBranch[] {
  const branches = listAgentIssueBranches();
  const stranded: StrandedBranch[] = [];

  for (const branch of branches) {
    // Parse issue number from branch name
    const match = branch.match(/^agent\/issue-(\d+)$/);
    if (!match) continue;

    const issueNum = parseInt(match[1], 10);

    // Apply --issue filter if provided
    if (filterIssue !== undefined && issueNum !== filterIssue) continue;

    const item = inspectStrandedBranch(baseBranch, branch, issueNum);
    if (item) stranded.push(item);
  }

  return stranded;
}

function inspectStrandedBranch(
  baseBranch: string,
  branch: string,
  issueNum: number,
  crashMarker?: CrashMarkerRef,
): StrandedBranch | null {
  // Check if there are commits ahead of the base branch
  const range = shellQuote(`origin/${baseBranch}..${branch}`);
  const aheadResult = exec(
    `git log ${range} --oneline`,
  );
  if (aheadResult.exitCode !== 0 || !aheadResult.stdout.trim()) {
    // No commits ahead — not stranded
    return null;
  }

  const commits = aheadResult.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Get files changed relative to base branch
  const filesResult = exec(
    `git diff --name-only ${shellQuote(`origin/${baseBranch}...${branch}`)}`,
  );
  const filesChanged = filesResult.exitCode === 0
    ? filesResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    : [];

  return { branch, issueNum, commits, filesChanged, crashMarker };
}

function matchesSessionFilter(marker: CrashMarkerRef, sessionFilter?: string): boolean {
  if (!sessionFilter) return true;
  const wanted = sessionFilter.trim();
  if (!wanted) return true;
  const timestamp = marker.sessionName.split('/').pop() ?? marker.sessionName;
  return marker.sessionName === wanted
    || marker.sessionName.endsWith(wanted)
    || timestamp === wanted;
}

function findStrandedBranchesFromCrashMarkers(
  baseBranch: string,
  filterIssue?: number,
  sessionFilter?: string,
): StrandedBranch[] {
  const markers = findCrashMarkers()
    .filter((marker) => marker.recoverable && marker.hasCommits)
    .filter((marker) => filterIssue === undefined || marker.issueNum === filterIssue)
    .filter((marker) => matchesSessionFilter(marker, sessionFilter));

  const seenIssues = new Set<number>();
  const stranded: StrandedBranch[] = [];
  for (const marker of markers) {
    if (seenIssues.has(marker.issueNum)) continue;
    seenIssues.add(marker.issueNum);
    const item = inspectStrandedBranch(baseBranch, marker.branch, marker.issueNum, marker);
    if (item) stranded.push(item);
  }

  return stranded;
}

/**
 * Return true if an open PR already exists for the given branch.
 */
function prExists(repo: string, branch: string): boolean {
  const result = ghExec(
    `gh pr list --repo ${shellQuote(repo)} --head ${shellQuote(branch)} --state open --json number --limit 1`,
  );
  if (result.exitCode !== 0) return false;
  try {
    const prs = JSON.parse(result.stdout) as Array<{ number: number }>;
    return prs.length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch the issue title from GitHub.
 */
function getIssueTitle(repo: string, issueNum: number): string {
  const result = ghExec(
    `gh issue view ${issueNum} --repo ${shellQuote(repo)} --json title`,
  );
  if (result.exitCode !== 0) return `Issue #${issueNum}`;
  try {
    const data = JSON.parse(result.stdout) as { title: string };
    return data.title;
  } catch {
    return `Issue #${issueNum}`;
  }
}

/**
 * Get the diff between the base branch and the given branch.
 */
function getBranchDiff(baseBranch: string, branch: string): string {
  const result = exec(`git diff ${shellQuote(`origin/${baseBranch}...${branch}`)}`);
  if (result.exitCode !== 0) return '';
  // Cap at 50k chars to avoid bloating the review prompt
  const MAX = 50_000;
  if (result.stdout.length > MAX) {
    return result.stdout.slice(0, MAX) + '\n... (diff truncated)';
  }
  return result.stdout;
}

/**
 * Print what was found for a stranded branch.
 */
function printStrandedSummary(item: StrandedBranch): void {
  log.step(`Found stranded branch: ${item.branch}`);
  log.info(`  Issue:   #${item.issueNum}`);
  if (item.crashMarker) {
    log.info(`  Crash:   ${item.crashMarker.step} at ${item.crashMarker.timestamp}`);
    log.info(`  Session: ${item.crashMarker.sessionName}`);
  }
  log.info(`  Commits: ${item.commits.length}`);
  for (const commit of item.commits) {
    log.info(`    ${commit}`);
  }
  log.info(`  Files changed: ${item.filesChanged.length}`);
  for (const file of item.filesChanged.slice(0, 10)) {
    log.info(`    ${file}`);
  }
  if (item.filesChanged.length > 10) {
    log.info(`    ... and ${item.filesChanged.length - 10} more`);
  }
}

/**
 * Resume a single stranded branch — push, review, open PR, update labels.
 */
async function resumeBranch(
  item: StrandedBranch,
  config: ReturnType<typeof loadConfig>,
): Promise<{ issueNum: number; prUrl: string; title: string; filesChanged: number } | null> {
  const { branch, issueNum } = item;
  const repo = config.repo;
  const baseBranch = config.baseBranch;

  const title = getIssueTitle(repo, issueNum);
  log.step(`Resuming issue #${issueNum}: ${title}`);

  const branchWorktree = checkoutBranchForResume(branch);
  if (!branchWorktree) return null;

  const session = findSessionForIssue(issueNum);
  if (session && !config.skipLearn) {
    repairSessionLearningArtifacts({
      sessionName: session.sessionName,
      issues: [{ issueNum, title, status: 'failure', duration: 0, retries: 0 }],
      learningsDir: join(branchWorktree, '.alpha-loop', 'learnings'),
      sessionLogsDir: join(session.sessionDir, 'logs'),
    });
    commitChangedLearningArtifacts(branchWorktree, issueNum);
  } else if (config.skipLearn) {
    log.info('Skipping learning artifact repair (skipLearn=true)');
  }

  // Push the branch so createPR can work with it.
  // createPR also pushes internally, but we do it first here for explicit
  // feedback and to fail fast if the push is going to be a problem.
  log.info(`Pushing ${branch} to origin...`);
  const quotedBranch = shellQuote(branch);
  const pushResult = exec(`git push -u origin ${quotedBranch}`, { cwd: branchWorktree });
  if (pushResult.exitCode !== 0) {
    log.warn(`Push failed: ${pushResult.stderr}. Attempting force push...`);
    const forceResult = exec(`git push -u origin ${quotedBranch} --force`, { cwd: branchWorktree });
    if (forceResult.exitCode !== 0) {
      log.error(`Could not push ${branch}: ${forceResult.stderr}`);
      return null;
    }
  }

  // Run code review
  let reviewOutput = '';
  if (!config.skipReview) {
    log.step(`Running code review for #${issueNum}...`);

    const diff = getBranchDiff(baseBranch, branch);

    // buildReviewPrompt expects body and baseBranch; we pass the diff as body
    // context so the reviewer can see the changes inline.
    const reviewPrompt = buildReviewPrompt({
      issueNum,
      title,
      body: diff ? `## Diff\n\`\`\`diff\n${diff}\n\`\`\`` : '(no diff available)',
      baseBranch,
    });

    const reviewStep = resolveStepConfig(config, 'review');
    const reviewResult = await spawnAgent({
      agent: reviewStep.agent as typeof config.agent,
      model: reviewStep.model,
      prompt: reviewPrompt,
      cwd: branchWorktree,
      verbose: config.verbose,
      timeout: 10 * 60 * 1000, // 10 minutes for a review
      maxTurns: 20,
    });

    reviewOutput = reviewResult.output;

    if (reviewResult.exitCode !== 0) {
      log.warn(`Review agent exited with code ${reviewResult.exitCode}`);
    } else {
      log.success(`Review complete for #${issueNum}`);
    }
  }

  // Build PR body. Resume recovers stranded work; it does not prove the issue
  // is complete, so every recovered PR carries an explicit verification caveat.
  const resumeCaveat = `## Resume Caveat

This PR was recovered by \`alpha-loop resume\`. Resume creates the PR and runs best-effort review only; it does not rerun the project test suite or final verification smoke tests. Treat this PR as WIP until those checks pass.`;

  const prBody = reviewOutput
    ? `${resumeCaveat}\n\n## Code Review\n\n${reviewOutput}`
    : `${resumeCaveat}\n\nResumes stranded work for issue #${issueNum}.`;

  // Create PR (createPR handles push internally as well; that is idempotent)
  log.step(`Creating PR for #${issueNum}...`);
  let prUrl: string;
  try {
    prUrl = createPR({
      repo,
      base: baseBranch,
      head: branch,
      title: `feat: ${title} (closes #${issueNum})`,
      body: prBody,
      cwd: branchWorktree,
    });
  } catch (err) {
    log.error(`Failed to create PR for #${issueNum}: ${String(err)}`);
    return null;
  }

  log.success(`PR created: ${prUrl}`);

  // Update issue labels: add in-review, remove in-progress
  labelIssue(repo, issueNum, 'in-review', 'in-progress');

  // Recovered PRs still need review and verification; do not mark them Done.
  if (config.project && config.project > 0) {
    updateProjectStatus(repo, config.project, config.repoOwner, issueNum, 'In Review');
  }

  // Comment on the issue with the PR link
  commentIssue(
    repo,
    issueNum,
    `Resumed by alpha-loop. PR opened for review: ${prUrl}\n\nFinal tests and verification were not run by resume; treat the PR as WIP until they pass.`,
  );

  return { issueNum, prUrl, title, filesChanged: item.filesChanged.length };
}

/**
 * Find the session directory that an issue belongs to.
 * Checks for result files first, then falls back to log files, then most recent session.
 */
function findSessionForIssue(issueNum: number): { sessionDir: string; sessionName: string } | null {
  const sessionsRoot = join(process.cwd(), '.alpha-loop', 'sessions');
  if (!existsSync(sessionsRoot)) return null;

  const crashMarker = findCrashMarkers(sessionsRoot).find((marker) => (
    marker.issueNum === issueNum && marker.recoverable
  ));
  if (crashMarker) {
    return { sessionDir: crashMarker.sessionDir, sessionName: crashMarker.sessionName };
  }

  // Walk all session directories, sorted newest first
  const sessionDirs: Array<{ dir: string; name: string }> = [];
  for (const a of readdirSync(sessionsRoot)) {
    const aDir = join(sessionsRoot, a);
    try {
      for (const b of readdirSync(aDir)) {
        sessionDirs.push({ dir: join(aDir, b), name: `${a}/${b}` });
      }
    } catch { /* not a directory */ }
  }
  sessionDirs.sort((a, b) => b.name.localeCompare(a.name));

  // First: look for a session with logs for this issue (the crashed session)
  for (const s of sessionDirs) {
    const logsDir = join(s.dir, 'logs');
    if (existsSync(logsDir)) {
      const hasLogs = readdirSync(logsDir).some((f) => f.startsWith(`issue-${issueNum}`));
      if (hasLogs) return { sessionDir: s.dir, sessionName: s.name };
    }
  }

  // Fallback: most recent session
  if (sessionDirs.length > 0) return { sessionDir: sessionDirs[0].dir, sessionName: sessionDirs[0].name };

  return null;
}

/**
 * Save a result file to the session directory and update the session PR.
 */
function saveResumedResult(
  sessionDir: string,
  result: PipelineResult,
): void {
  const filePath = join(sessionDir, `result-${result.issueNum}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n');
  log.info(`Session result saved: ${filePath}`);
  clearCrashMarker(sessionDir, result.issueNum);
}

function formatSessionIssueStatus(result: PipelineResult): string {
  if (isRecoveredResult(result)) return `RECOVERED BY ${result.recoveryMode?.toUpperCase()}`;
  if (result.status === 'waiting') return result.waitingStatus?.toUpperCase() ?? 'WAITING';
  return result.status === 'success' ? 'SUCCESS' : 'FAILURE';
}

/**
 * Find and update the session PR with current results.
 */
async function updateSessionPR(
  config: ReturnType<typeof loadConfig>,
  sessionName: string,
  sessionDir: string,
): Promise<void> {
  const repo = config.repo;
  const baseBranch = config.baseBranch;

  // Find the session branch
  const sessionBranch = sessionName;

  // Find the PR for this session branch
  const prResult = ghExec(
    `gh pr list --repo ${shellQuote(repo)} --head ${shellQuote(sessionBranch)} --state open --json number,url --limit 1`,
  );
  if (prResult.exitCode !== 0 || !prResult.stdout.trim()) {
    log.info('No session PR found to update');
    return;
  }

  let prData: Array<{ number: number; url: string }>;
  try {
    prData = JSON.parse(prResult.stdout);
  } catch {
    return;
  }
  if (prData.length === 0) return;

  const prNumber = prData[0].number;
  const prUrl = prData[0].url;

  // Read all result files from the session directory
  const resultFiles = readdirSync(sessionDir)
    .filter((f) => f.startsWith('result-') && f.endsWith('.json'))
    .sort();

  const results: PipelineResult[] = [];
  for (const f of resultFiles) {
    try {
      const content = readFileSync(join(sessionDir, f), 'utf-8');
      results.push(JSON.parse(content) as PipelineResult);
    } catch { /* skip invalid */ }
  }

  if (results.length === 0) return;

  const learningsDir = join(process.cwd(), '.alpha-loop', 'learnings');
  if (!config.skipLearn) {
    repairSessionLearningArtifacts({
      sessionName,
      issues: results.map((r) => ({
        issueNum: r.issueNum,
        title: r.title,
        status: r.status,
        duration: r.duration,
      })),
      learningsDir,
      sessionLogsDir: join(sessionDir, 'logs'),
    });
    await generateSessionSummary({
      sessionName,
      results,
      learningsDir,
      config,
    });
    repairSessionSummaryArtifact({
      sessionName,
      learningsDir,
    });
  } else {
    log.info('Skipping session summary regeneration (skipLearn=true)');
  }

  const recovered = results.filter(isRecoveredResult);
  const naturalResults = results.filter((r) => !isRecoveredResult(r));
  const successes = naturalResults.filter((r) => r.status === 'success');
  const failures = naturalResults.filter((r) => r.status === 'failure');
  const totalDuration = naturalResults.reduce((sum, r) => sum + r.duration, 0);
  const resumeCaveat = recovered.length > 0
    ? `
### Resume Caveat

${recovered.length} recovered PR(s) were not counted as succeeded or failed because \`alpha-loop resume\` does not rerun tests or final verification smoke tests.
`
    : '';
  const titleStatus = naturalResults.length > 0
    ? `${successes.length}/${naturalResults.length} succeeded`
    : `${successes.length} succeeded`;
  const titleRecovery = recovered.length > 0 ? `, ${recovered.length} recovered` : '';
  const autoCommittedSection = formatAutoCommittedResultsSection(results).join('\n');

  const title = `Session: ${sessionName} — ${titleStatus}${titleRecovery}`;
  const body = `## Session Summary

**Branch:** ${sessionBranch}
**Issues processed:** ${results.length} (${successes.length} succeeded, ${failures.length} failed, ${recovered.length} recovered)
**Total duration:** ${Math.round(totalDuration / 60)} minutes
**Updated:** ${new Date().toISOString()}
${resumeCaveat}

### Issues
${naturalResults.length > 0
    ? naturalResults.map((r) => `- #${r.issueNum}: ${r.title} — ${formatSessionIssueStatus(r)}${r.prUrl ? ` ([PR](${r.prUrl}))` : ''}`).join('\n')
    : 'No naturally completed issues yet.'}
${recovered.length > 0 ? `
### Recovered Issues
${recovered.map((r) => `- #${r.issueNum}: ${r.title} — ${formatSessionIssueStatus(r)}${r.prUrl ? ` ([PR](${r.prUrl}))` : ''}`).join('\n')}
` : ''}
${autoCommittedSection ? `\n${autoCommittedSection}` : ''}

---
This PR collects all changes from this session for final review before merging to ${baseBranch}.

*Automated by alpha-loop*`;

  const quotedRepo = shellQuote(repo);
  ghExec(`gh pr edit ${prNumber} --repo ${quotedRepo} --title ${shellQuote(title)}`, undefined, true);

  // Use --body-file to avoid escaping issues
  const bodyFile = join(tmpdir(), `alpha-loop-session-pr-${Date.now()}`);
  writeFileSync(bodyFile, body, 'utf-8');
  ghExec(`gh pr edit ${prNumber} --repo ${quotedRepo} --body-file ${shellQuote(bodyFile)}`, undefined, true);
  try { unlinkSync(bodyFile); } catch { /* cleanup */ }

  log.success(`Session PR updated: ${prUrl}`);
}

function currentManifestFeedbackStatus(manifest: DurableSessionManifest): string {
  const status = normalizeHumanFeedbackStatus(manifest.status);
  const feedback = normalizeHumanFeedbackStatus(manifest.feedback?.currentStatus ?? '');
  if (status && status !== 'running' && feedback === 'running') return status;
  return feedback ?? status ?? manifest.status;
}

function isDuplicateResume(manifest: DurableSessionManifest): boolean {
  return currentManifestFeedbackStatus(manifest) === 'resuming' || manifest.status === 'resuming';
}

function acquireResumeLock(ref: ResumableSessionRef): string | null {
  const lockPath = join(ref.sessionDir, 'resume.lock');
  try {
    writeFileSync(lockPath, JSON.stringify({
      issueNumber: ref.manifest.issueNumber,
      session: ref.manifest.name,
      startedAt: new Date().toISOString(),
    }, null, 2) + '\n', { flag: 'wx' });
    return lockPath;
  } catch {
    return null;
  }
}

function releaseResumeLock(lockPath: string | null): void {
  if (!lockPath) return;
  try { unlinkSync(lockPath); } catch { /* cleanup best-effort */ }
}

function latestFeedbackCutoff(manifest: DurableSessionManifest): string {
  return manifest.feedback?.updatedAt
    ?? manifest.timestamps.updatedAt
    ?? manifest.timestamps.startedAt;
}

function commentsAfterCutoff(comments: Comment[], cutoff: string): Comment[] {
  return comments.filter((comment) => comment.createdAt && comment.createdAt > cutoff);
}

function fallbackIssueFromManifest(issueNum: number, manifest: DurableSessionManifest): Issue {
  return {
    number: issueNum,
    title: manifest.currentIssue?.title
      ?? manifest.issues.find((issue) => issue.issueNum === issueNum)?.title
      ?? `Issue #${issueNum}`,
    body: '',
    labels: manifest.labels,
    comments: [],
  };
}

function commentsForClassification(newComments: Comment[], comments: Comment[]): Comment[] {
  if (newComments.length > 0) return newComments;
  return comments.slice(-3);
}

function classifyResumeStage(classification: FeedbackClassification): PipelineResumeStage {
  if (classification === 'approval') return 'verification';
  if (classification === 'change_request') return 'implementation';
  return 'clarification';
}

function formatCommentBullet(comment: Comment): string {
  const body = comment.body.trim();
  const trimmed = body.length > 1500 ? `${body.slice(0, 1500)}\n... (comment truncated)` : body;
  return `- **@${comment.author}** (${comment.createdAt}): ${trimmed}`;
}

function formatPromptRefs(manifest: DurableSessionManifest): string[] {
  if (manifest.prompts.length === 0) return ['- (no prompt references recorded)'];
  return manifest.prompts.map((prompt) => {
    const issue = prompt.issueNum !== undefined ? `#${prompt.issueNum} ` : '';
    return `- ${issue}${prompt.stage}: \`${prompt.path}\` (${prompt.hash.slice(0, 12)})`;
  });
}

function formatTranscriptRefs(manifest: DurableSessionManifest): string[] {
  const lines: string[] = [];
  if (manifest.transcripts.length > 0) {
    for (const transcript of manifest.transcripts) {
      const issue = transcript.issueNum !== undefined ? `#${transcript.issueNum} ` : '';
      lines.push(`- ${issue}${transcript.stage}: \`${transcript.path}\``);
    }
  }
  for (const file of manifest.logs.files) {
    lines.push(`- log: \`${file}\``);
  }
  return lines.length > 0 ? lines : ['- (no transcript or log references recorded)'];
}

function buildResumeFeedbackContext(
  ref: ResumableSessionRef,
  issue: Pick<Issue, 'number' | 'title' | 'body' | 'comments'>,
): ResumeFeedbackContext {
  const comments = issue.comments ?? [];
  const newComments = commentsAfterCutoff(comments, latestFeedbackCutoff(ref.manifest));
  const commentsUsedForClassification = commentsForClassification(newComments, comments);
  const feedbackText = commentsUsedForClassification.map((comment) => comment.body).join('\n\n')
    || ref.manifest.feedback.resumeInstructions
    || ref.manifest.feedback.question
    || 'Resume requested without new comment text.';
  const classification = classifyFeedback(feedbackText);
  const resumeStage = classifyResumeStage(classification);
  const existingPrUrl = ref.manifest.feedback.prUrl
    ?? ref.manifest.prUrl
    ?? ref.manifest.sessionPrUrl
    ?? ref.manifest.issues.find((entry) => entry.issueNum === issue.number)?.prUrl
    ?? null;
  const savedBranch = ref.recoveryBranch ?? ref.manifest.worktree?.branch ?? ref.manifest.lastKnownBranch;
  const savedWorktree = ref.worktreePath ?? ref.manifest.worktree?.path ?? null;

  const lines: string[] = [
    `### Session`,
    `- Session: \`${ref.manifest.name}\``,
    `- Prior status: \`${ref.manifest.status}\` / feedback \`${ref.manifest.feedback.currentStatus}\``,
    `- Resume classification: \`${classification}\``,
    `- Resume stage: \`${resumeStage}\``,
    `- Saved branch: ${savedBranch ? `\`${savedBranch}\`` : '(not recorded)'}`,
    `- Saved worktree: ${savedWorktree ? `\`${savedWorktree}\`${ref.worktreeExists ? ' (exists)' : ' (missing, recreate from branch)'}` : '(not recorded)'}`,
    `- Existing PR: ${existingPrUrl ?? '(none recorded)'}`,
  ];

  if (ref.manifest.parentEpicNumber) {
    lines.push(`- Parent epic: #${ref.manifest.parentEpicNumber}${ref.manifest.parentEpicTitle ? ` ${ref.manifest.parentEpicTitle}` : ''}`);
  }

  lines.push('', '### Prior Human Feedback State');
  if (ref.manifest.feedback.question) lines.push(`- Question: ${ref.manifest.feedback.question}`);
  if (ref.manifest.feedback.resumeInstructions) lines.push(`- Prior resume instructions: ${ref.manifest.feedback.resumeInstructions}`);
  if (ref.manifest.feedback.qaChecklist.length > 0) {
    lines.push('- QA checklist:');
    for (const item of ref.manifest.feedback.qaChecklist) lines.push(`  - ${item}`);
  }
  if (!ref.manifest.feedback.question && !ref.manifest.feedback.resumeInstructions && ref.manifest.feedback.qaChecklist.length === 0) {
    lines.push('- (no prior question or QA checklist recorded)');
  }

  lines.push('', '### New Human Feedback');
  if (newComments.length > 0) {
    lines.push(...newComments.map(formatCommentBullet));
  } else if (commentsUsedForClassification.length > 0) {
    lines.push('- No comments newer than the saved pause timestamp; using the latest issue comments for context:');
    lines.push(...commentsUsedForClassification.map(formatCommentBullet));
  } else {
    lines.push('- No GitHub issue comments were available. Use the prior feedback state and issue body.');
  }

  lines.push('', '### Prior Prompt References', ...formatPromptRefs(ref.manifest));
  lines.push('', '### Transcript And Log References', ...formatTranscriptRefs(ref.manifest));

  lines.push('', '### Resume Instructions');
  if (resumeStage === 'verification') {
    lines.push('- Human feedback appears to approve the current work. Do not make arbitrary implementation changes; run the normal tests, review, and verification path and update the existing PR.');
  } else if (resumeStage === 'implementation') {
    lines.push('- Human feedback requests a change. Address only that feedback, preserve prior work, run tests/review/verification, and update the existing PR.');
  } else {
    lines.push('- Treat the feedback as clarification or scope guidance. Use it to continue safely; if it is still ambiguous or expands scope, pause again with a concrete request.');
  }

  return {
    issue,
    newComments,
    commentsUsedForClassification,
    classification,
    resumeStage,
    contextText: lines.join('\n'),
    existingPrUrl,
  };
}

function markResumeLabels(config: ReturnType<typeof loadConfig>, issueNum: number): void {
  for (const change of githubLabelChangesForStatus('resuming', config.labelReady)) {
    labelIssue(config.repo, issueNum, change.add, change.remove);
  }
}

function transitionManifestToResuming(ref: ResumableSessionRef, context: ResumeFeedbackContext): void {
  let current = currentManifestFeedbackStatus(ref.manifest);
  if (current === 'human_input_requested' || current === 'qa_requested') {
    transitionHumanFeedbackSessionStatus(ref.manifestPath, {
      to: 'feedback_received',
      reason: `Feedback loaded from GitHub issue comments (${context.classification})`,
      issueNum: context.issue.number,
      classification: context.classification,
      prUrl: context.existingPrUrl,
      eventPayload: {
        source: 'github_issue_comments',
        newCommentCount: context.newComments.length,
        commentsUsedForClassification: context.commentsUsedForClassification.length,
      },
    });
    current = 'feedback_received';
  }

  if (current === 'feedback_received') {
    transitionHumanFeedbackSessionStatus(ref.manifestPath, {
      to: 'resume_requested',
      reason: `Resume requested for ${context.resumeStage} after ${context.classification} feedback`,
      issueNum: context.issue.number,
      classification: context.classification,
      prUrl: context.existingPrUrl,
      eventPayload: {
        resumeStage: context.resumeStage,
      },
    });
    current = 'resume_requested';
  }

  if (current !== 'resume_requested') {
    transitionSessionStatus(ref.manifestPath, 'resume_requested', 'resume_requested');
  }
  transitionHumanFeedbackSessionStatus(ref.manifestPath, {
    to: 'resuming',
    reason: `alpha-loop resume --issue ${context.issue.number} started`,
    issueNum: context.issue.number,
    classification: context.classification,
    prUrl: context.existingPrUrl,
    eventPayload: {
      resumeStage: context.resumeStage,
    },
  });
}

function formatResumeSummaryComment(context: ResumeFeedbackContext, result: PipelineResult): string {
  const status = result.status === 'success'
    ? 'completed'
    : result.status === 'waiting'
      ? `waiting (${result.waitingStatus ?? 'feedback required'})`
      : 'failed';
  const lines = [
    '## Alpha Loop Resume Summary',
    '',
    `Feedback classification: \`${context.classification}\``,
    `Resume stage: \`${context.resumeStage}\``,
    `Result: \`${status}\``,
    '',
    '### Feedback Addressed',
  ];

  const comments = context.newComments.length > 0 ? context.newComments : context.commentsUsedForClassification;
  if (comments.length > 0) lines.push(...comments.map(formatCommentBullet));
  else lines.push('- No new GitHub comments were available; resumed from saved session feedback state.');

  lines.push('', '### Verification');
  lines.push(`- Tests: ${result.testsPassing ? 'PASS' : 'FAIL'}`);
  lines.push(`- Verification: ${result.verifySkipped ? 'SKIPPED' : result.verifyPassing ? 'PASS' : 'FAIL'}`);
  if (result.prUrl) lines.push(`- PR: ${result.prUrl}`);
  else if (context.existingPrUrl) lines.push(`- PR: ${context.existingPrUrl}`);

  lines.push('', '### Remaining');
  if (result.status === 'waiting') {
    if (result.humanInputQuestion) lines.push(`- Waiting for clarification: ${result.humanInputQuestion}`);
    else if (result.qaChecklist && result.qaChecklist.length > 0) lines.push(`- Waiting for QA: ${result.qaChecklist.join('; ')}`);
    else lines.push(`- Waiting reason: ${result.waitingReason ?? 'human feedback required'}`);
  } else if (result.status === 'failure') {
    lines.push(`- Resume failed during the automated pipeline. Check session logs for issue #${result.issueNum}.`);
  } else {
    lines.push('- No remaining feedback items were recorded by the resumed run.');
  }

  lines.push('', '---', '*Resumed by alpha-loop from the saved session manifest.*');
  return lines.join('\n');
}

function finalStatusForResult(result: PipelineResult): SessionStatus {
  if (result.status === 'success') return 'completed';
  if (result.status === 'waiting') {
    if (result.waitingStatus === 'human_input_requested') return 'human_input_requested';
    if (result.waitingStatus === 'qa_requested') return 'qa_requested';
    return 'waiting-for-feedback';
  }
  return 'failed';
}

function finalStageForStatus(status: SessionStatus): SessionStage {
  if (status === 'active') return 'status';
  if (status === 'cleaned-up') return 'cleanup';
  return status as SessionStage;
}

export async function resumePausedIssueFromManifest(
  issueNum: number,
  config: ReturnType<typeof loadConfig>,
  options: { statuses?: Iterable<SessionStatus> } = {},
): Promise<boolean> {
  const ref = findLatestResumableSessionForIssue(issueNum, join(process.cwd(), '.alpha-loop', 'sessions'), {
    statuses: options.statuses ?? FEEDBACK_RESUME_STATUSES,
  });
  if (!ref) return false;

  if (isDuplicateResume(ref.manifest)) {
    log.warn(`Issue #${issueNum} is already resuming in ${ref.manifest.name}; duplicate resume skipped.`);
    return true;
  }

  const lockPath = acquireResumeLock(ref);
  if (!lockPath) {
    log.warn(`Issue #${issueNum} already has an active resume lock in ${ref.manifest.name}; duplicate resume skipped.`);
    return true;
  }

  try {
    const issue = getIssueWithComments(config.repo, issueNum) ?? fallbackIssueFromManifest(issueNum, ref.manifest);
    const context = buildResumeFeedbackContext(ref, issue);
    const session = rehydrateSessionContextFromManifest(ref);
    const savedBranch = ref.recoveryBranch ?? ref.manifest.worktree?.branch ?? ref.manifest.lastKnownBranch;
    const savedPath = ref.worktreePath ?? ref.manifest.worktree?.path ?? undefined;

    log.step(`Resuming paused issue #${issueNum}: ${issue.title}`);
    log.info(`Session: ${ref.manifest.name}`);
    log.info(`Feedback classification: ${context.classification}; stage: ${context.resumeStage}`);

    transitionManifestToResuming(ref, context);
    await emitLifecycleEvent({
      config,
      type: 'session.resumed',
      manifestPath: ref.manifestPath,
      session,
      context: {
        issueNumber: issueNum,
        issueTitle: issue.title,
        prUrl: context.existingPrUrl,
        branch: savedBranch,
        worktreePath: savedPath,
        feedback: {
          classification: context.classification,
          newCommentCount: context.newComments.length,
          commentsUsedForClassification: context.commentsUsedForClassification.length,
        },
        metadata: {
          resumeStage: context.resumeStage,
        },
      },
    });
    if (!config.dryRun) {
      markResumeLabels(config, issueNum);
    }

    const result = await processIssue(
      issueNum,
      issue.title,
      issue.body,
      config,
      session,
      {
        resumeContext: context.contextText,
        resumeStage: context.resumeStage,
        existingPrUrl: context.existingPrUrl,
        savedWorktree: {
          branch: savedBranch,
          path: savedPath,
        },
      },
    );
    session.results = session.results.filter((entry) => entry.issueNum !== result.issueNum);
    session.results.push(result);

    const finalStatus = finalStatusForResult(result);
    if (finalStatus === 'completed' || finalStatus === 'failed') {
      transitionHumanFeedbackSessionStatus(ref.manifestPath, {
        to: finalStatus,
        reason: `Resume finished with pipeline status ${result.status}`,
        issueNum,
        classification: context.classification,
        prUrl: result.prUrl ?? context.existingPrUrl,
        eventPayload: {
          testsPassing: result.testsPassing,
          verifyPassing: result.verifyPassing,
          verifySkipped: result.verifySkipped,
        },
      });
    } else {
      transitionSessionStatus(ref.manifestPath, finalStatus, finalStageForStatus(finalStatus), {
        prUrl: result.prUrl ?? context.existingPrUrl,
      });
    }

    if (config.autoMerge) {
      await finalizeSession(session, config);
    }

    if (finalStatus === 'completed' || finalStatus === 'failed') {
      await emitLifecycleEvent({
        config,
        type: finalStatus === 'completed' ? 'session.completed' : 'session.failed',
        manifestPath: ref.manifestPath,
        session,
        context: {
          issueNumber: issueNum,
          issueTitle: issue.title,
          prUrl: result.prUrl ?? context.existingPrUrl,
          error: result.status === 'failure' ? `Resume pipeline failed for issue #${issueNum}` : null,
          feedback: {
            classification: context.classification,
          },
          metadata: {
            resumed: true,
            resumeStage: context.resumeStage,
            testsPassing: result.testsPassing,
            verifyPassing: result.verifyPassing,
            verifySkipped: result.verifySkipped,
          },
        },
      });
    }

    if (!config.dryRun) {
      commentIssue(config.repo, issueNum, formatResumeSummaryComment(context, result));
    }

    return true;
  } catch (err) {
    try {
      transitionHumanFeedbackSessionStatus(ref.manifestPath, {
        to: 'failed',
        reason: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
        issueNum,
      });
    } catch {
      transitionSessionStatus(ref.manifestPath, 'failed', 'failed');
    }
    await emitLifecycleEvent({
      config,
      type: 'session.failed',
      manifestPath: ref.manifestPath,
      context: {
        issueNumber: issueNum,
        error: err instanceof Error ? err.message : String(err),
        metadata: {
          resumed: true,
        },
      },
    });
    throw err;
  } finally {
    releaseResumeLock(lockPath);
  }
}

/**
 * Main entry point for `alpha-loop resume`.
 */
export async function resumeCommand(options: ResumeOptions): Promise<void> {
  const config = loadConfig();

  if (!config.repo) {
    log.error('No repo configured. Set `repo` in .alpha-loop.yaml or the REPO env var.');
    process.exit(1);
  }

  const filterIssue = options.issue ? parseInt(options.issue, 10) : undefined;

  if (options.issue && isNaN(filterIssue!)) {
    log.error(`Invalid issue number: ${options.issue}`);
    process.exit(1);
  }

  if (filterIssue !== undefined && !options.session) {
    const handledPausedSession = await resumePausedIssueFromManifest(filterIssue, config);
    if (handledPausedSession) return;
  }

  log.step('Scanning for stranded branches...');

  // Prefer explicit crash markers when present; fall back to branch walking for older sessions.
  //
  // IMPORTANT: when --session is provided, ONLY trust crash markers. Branch walking has no
  // session context and would silently resume work from unrelated sessions, defeating the
  // filter. If the requested session has no recoverable markers, surface that explicitly
  // rather than papering over it with cross-session results.
  const markerStranded = findStrandedBranchesFromCrashMarkers(config.baseBranch, filterIssue, options.session);
  let stranded: StrandedBranch[];
  if (options.session) {
    stranded = markerStranded;
    if (stranded.length === 0) {
      log.info(
        `No recoverable crash markers matched --session ${options.session}. ` +
        `Branch walking is skipped when --session is set to avoid resuming unrelated work.`,
      );
    }
  } else {
    stranded = markerStranded.length > 0
      ? markerStranded
      : findStrandedBranches(config.baseBranch, filterIssue);
  }

  // Filter out branches that already have an open PR
  const withoutPR = stranded.filter((item) => !prExists(config.repo, item.branch));

  if (withoutPR.length === 0) {
    if (stranded.length > 0) {
      log.info('All stranded branches already have open PRs — nothing to resume.');
    } else {
      log.info('No stranded branches found — nothing to resume.');
    }
    return;
  }

  log.info(`Found ${withoutPR.length} stranded branch(es) without a PR:`);
  for (const item of withoutPR) {
    printStrandedSummary(item);
  }

  // Process each stranded branch
  const results: Array<{ issueNum: number; prUrl: string; title: string; filesChanged: number }> = [];
  const failed: number[] = [];

  for (const item of withoutPR) {
    const result = await resumeBranch(item, config);
    if (result) {
      results.push(result);
    } else {
      failed.push(item.issueNum);
    }
  }

  // Save all recovered results before updating each touched session PR, so the
  // regenerated summary sees the complete recovered set for that session.
  const sessionsToUpdate = new Map<string, { sessionDir: string; sessionName: string }>();
  for (const r of results) {
    const session = findSessionForIssue(r.issueNum);
    if (session) {
      const pipelineResult: PipelineResult = {
        issueNum: r.issueNum,
        title: r.title,
        status: 'failure',
        recoveryMode: 'resume',
        failureReason: 'transient',
        prUrl: r.prUrl,
        testsPassing: false,
        verifyPassing: false, // verification was skipped/crashed
        verifySkipped: true,
        duration: 0,
        filesChanged: r.filesChanged,
      };
      saveResumedResult(session.sessionDir, pipelineResult);
      sessionsToUpdate.set(session.sessionDir, session);
    }
  }

  for (const session of sessionsToUpdate.values()) {
    await updateSessionPR(config, session.sessionName, session.sessionDir);
  }

  // Print summary
  console.error('');
  log.step('Resume summary');

  if (results.length > 0) {
    log.success(`Resumed ${results.length} issue(s):`);
    for (const r of results) {
      log.info(`  #${r.issueNum} -> ${r.prUrl}`);
    }
  }

  if (failed.length > 0) {
    log.warn(`Failed to resume ${failed.length} issue(s): ${failed.map((n) => `#${n}`).join(', ')}`);
  }
}
