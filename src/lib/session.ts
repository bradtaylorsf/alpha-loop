/**
 * Session Management — create sessions, save results, finalize with PR.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';
import { exec, formatTimestamp } from './shell.js';
import { ghExec } from './rate-limit.js';
import { createPR, updateProjectStatus } from './github.js';
import type { Config } from './config.js';
import type { PipelineResult, GateResult } from './pipeline.js';

export type SessionContext = {
  name: string;
  branch: string;
  resultsDir: string;
  logsDir: string;
  results: PipelineResult[];
  sessionReviewFindings?: GateResult;
  /** When set, this session processes sub-issues of the given epic. */
  epic?: number;
};

export type CreateSessionOptions = {
  milestone?: string;
  /** When set, session is scoped to an epic — drives the name slug and PR title. */
  epicNum?: number;
  /** Title of the epic, used to form a human-readable session slug. */
  epicTitle?: string;
};

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Create a new session context with timestamp-based name.
 * Optionally creates a session branch when autoMerge is enabled.
 */
export function createSession(config: Config, options?: CreateSessionOptions): SessionContext {
  const now = new Date();
  const timestamp = formatTimestamp(now);
  const milestone = options?.milestone;
  const epicNum = options?.epicNum;
  const epicTitle = options?.epicTitle;

  let slug: string;
  if (epicNum !== undefined) {
    const titleSlug = epicTitle ? slugify(epicTitle) : '';
    slug = titleSlug ? `epic-${epicNum}-${titleSlug}` : `epic-${epicNum}`;
  } else if (milestone) {
    slug = slugify(milestone);
  } else {
    slug = timestamp;
  }
  const name = `session/${slug}`;
  const branch = config.mergeTo || name;

  const projectDir = process.cwd();
  const resultsDir = join(projectDir, '.alpha-loop', 'sessions', name);
  const logsDir = join(resultsDir, 'logs');

  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  // Create session branch and draft PR if auto-merge is enabled
  if (config.autoMerge && !config.dryRun) {
    // Fetch latest to ensure we have remote refs
    exec('git fetch origin', { cwd: projectDir });

    const branchExists = exec(`git rev-parse --verify "${branch}"`, { cwd: projectDir });
    if (branchExists.exitCode !== 0) {
      // Create from remote base branch first, fall back to local
      const fromRemote = exec(
        `git checkout -b "${branch}" "origin/${config.baseBranch}"`,
        { cwd: projectDir },
      );
      if (fromRemote.exitCode !== 0) {
        exec(`git checkout -b "${branch}" "${config.baseBranch}"`, { cwd: projectDir });
      }
      // Create an initial commit so the branch has a diff from base (required for PR creation)
      exec(`git commit --allow-empty -m "chore: start session ${name}"`, { cwd: projectDir });
      // Push session branch to remote so PRs can target it
      exec(`git push origin "${branch}"`, { cwd: projectDir });
      // Switch back to the original branch
      exec(`git checkout -`, { cwd: projectDir });
      log.info(`Created session branch: ${branch}`);

      // Create a draft PR immediately so the session is visible in GitHub
      try {
        const draftPR = createPR({
          repo: config.repo,
          base: config.baseBranch,
          head: branch,
          title: epicNum !== undefined
            ? `Epic #${epicNum}${epicTitle ? `: ${epicTitle}` : ''}`
            : milestone ? `Milestone: ${milestone}` : `Session: ${name}`,
          body: `## Session In Progress\n\n${
            epicNum !== undefined
              ? `**Epic:** #${epicNum}${epicTitle ? ` — ${epicTitle}` : ''}\n`
              : milestone ? `**Milestone:** ${milestone}\n` : ''
          }**Branch:** ${branch}\n**Started:** ${new Date().toISOString()}\n\nThis PR will be updated as issues are processed.\n\n---\n*Automated by alpha-loop*`,
          cwd: projectDir,
        });
        log.success(`Session PR (draft): ${draftPR}`);
      } catch {
        // Non-fatal — PR can be created later during finalization
        log.warn('Could not create draft session PR — will create during finalization');
      }
    } else {
      // Ensure session branch exists on remote (may have been deleted after a previous merge)
      const remoteCheck = exec(`git ls-remote --heads origin "${branch}"`, { cwd: projectDir });
      if (!remoteCheck.stdout.trim()) {
        log.warn(`Session branch "${branch}" exists locally but not on remote — recreating from ${config.baseBranch}`);
        // Ensure we're not on the branch we're about to delete
        exec(`git checkout "${config.baseBranch}"`, { cwd: projectDir });
        // Delete stale local branch and recreate from current base (the old one is behind after merge)
        exec(`git branch -D "${branch}"`, { cwd: projectDir });
        const fromRemote = exec(
          `git checkout -b "${branch}" "origin/${config.baseBranch}"`,
          { cwd: projectDir },
        );
        if (fromRemote.exitCode !== 0) {
          exec(`git checkout -b "${branch}" "${config.baseBranch}"`, { cwd: projectDir });
        }
        exec(`git commit --allow-empty -m "chore: start session ${name}"`, { cwd: projectDir });
        const pushResult = exec(`git push origin "${branch}"`, { cwd: projectDir });
        if (pushResult.exitCode !== 0) {
          log.error(`Failed to push recreated session branch: ${pushResult.stderr}`);
        }
        exec(`git checkout -`, { cwd: projectDir });
        log.info(`Recreated session branch: ${branch}`);

        // Recreate draft PR for the session
        try {
          const draftPR = createPR({
            repo: config.repo,
            base: config.baseBranch,
            head: branch,
            title: milestone ? `Milestone: ${milestone}` : `Session: ${name}`,
            body: `## Session In Progress\n\n${milestone ? `**Milestone:** ${milestone}\n` : ''}**Branch:** ${branch}\n**Started:** ${new Date().toISOString()}\n\nThis PR will be updated as issues are processed.\n\n---\n*Automated by alpha-loop*`,
            cwd: projectDir,
          });
          log.success(`Session PR (draft): ${draftPR}`);
        } catch {
          log.warn('Could not create draft session PR — will create during finalization');
        }
      } else {
        log.info(`Session branch already exists: ${branch}`);
      }
    }
  }

  return { name, branch, resultsDir, logsDir, results: [], epic: epicNum };
}

/**
 * Save a pipeline result to the session directory as JSON.
 */
export function saveResult(session: SessionContext, result: PipelineResult): void {
  const filePath = join(session.resultsDir, `result-${result.issueNum}.json`);
  writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n');
  log.info(`Session result saved: ${filePath}`);
}

/**
 * Get the previous issue result formatted for prompt context.
 * Returns null if no previous results exist.
 */
export function getPreviousResult(session: SessionContext): string | null {
  if (session.results.length === 0) return null;

  const prev = session.results[session.results.length - 1];
  return `## Previous Issue in This Session
- Issue #${prev.issueNum}: ${prev.title}
- Status: ${prev.status}
- Tests: ${prev.testsPassing ? 'PASSING' : 'FAILING'}
- Files changed: ${prev.filesChanged}
- Duration: ${prev.duration}s
${prev.prUrl ? `- PR: ${prev.prUrl}` : ''}

Build on what was already done. Avoid duplicating work.`;
}

/**
 * Finalize session: commit learnings to session branch, create session PR.
 * Only runs when autoMerge is enabled and issues were processed.
 */
export async function finalizeSession(
  session: SessionContext,
  config: Config,
): Promise<string | null> {
  if (!config.autoMerge) return null;
  if (session.branch === config.baseBranch) return null;
  if (session.results.length === 0) return null;

  if (config.dryRun) {
    log.dry(`Would finalize session: ${session.branch} -> ${config.baseBranch}`);
    return null;
  }

  log.step(`Finalizing session: ${session.branch}`);

  const projectDir = process.cwd();

  // Ensure we're on the session branch and up to date with remote
  // (batch PRs may have been auto-merged into the remote session branch)
  exec('git fetch origin', { cwd: projectDir });
  const checkout = exec(`git checkout "${session.branch}"`, { cwd: projectDir });
  if (checkout.exitCode !== 0) {
    log.warn('Could not checkout session branch for finalization');
    return null;
  }
  // Pull remote changes (auto-merged batch PRs) into local branch
  const pull = exec(`git pull origin "${session.branch}" --no-edit`, { cwd: projectDir });
  if (pull.exitCode !== 0) {
    log.warn(`Could not pull remote session branch — trying rebase`);
    exec(`git rebase "origin/${session.branch}"`, { cwd: projectDir });
  }

  // Save session manifest to learnings directory (tracked in git, shared with team)
  const learningsDir = join(projectDir, '.alpha-loop', 'learnings');
  mkdirSync(learningsDir, { recursive: true });

  const manifestName = `session-${session.name.replace(/\//g, '-')}.json`;
  const manifest = {
    name: session.name,
    branch: session.branch,
    completed: new Date().toISOString(),
    results: session.results.map((r) => ({
      issueNum: r.issueNum,
      title: r.title,
      status: r.status,
      prUrl: r.prUrl,
      testsPassing: r.testsPassing,
      verifyPassing: r.verifyPassing,
      duration: r.duration,
      filesChanged: r.filesChanged,
    })),
  };
  writeFileSync(join(learningsDir, manifestName), JSON.stringify(manifest, null, 2) + '\n');
  log.info(`Session manifest saved: ${manifestName}`);

  // Stage learnings (including session manifest)
  exec('git add .alpha-loop/learnings/', { cwd: projectDir });

  // Commit if there are staged changes
  const diffResult = exec('git diff --cached --quiet', { cwd: projectDir });
  if (diffResult.exitCode !== 0) {
    const commitIssueCount = session.results.length;
    exec(
      `git commit -m "chore: learnings from ${session.name}\n\nProcessed ${commitIssueCount} issue(s) in this session."`,
      { cwd: projectDir },
    );
    exec(`git push origin "${session.branch}"`, { cwd: projectDir });
  }

  // Create or update session PR
  const successes = session.results.filter((r) => r.status === 'success');
  const permanentFailures = session.results.filter((r) => r.status === 'failure' && r.failureReason !== 'transient');
  const transientFailures = session.results.filter((r) => r.status === 'failure' && r.failureReason === 'transient');
  const totalDuration = session.results.reduce((sum, r) => sum + r.duration, 0);

  // Only count completed issues (not transient failures that were re-queued)
  const completedCount = successes.length + permanentFailures.length;
  const prTitle = `Session: ${session.name} — ${successes.length}/${completedCount} succeeded`;

  const prLines: string[] = [
    '## Session Summary',
    '',
    `**Branch:** ${session.branch}`,
    `**Issues completed:** ${completedCount} (${successes.length} succeeded, ${permanentFailures.length} failed)`,
    `**Total duration:** ${Math.round(totalDuration / 60)} minutes`,
    `**Completed:** ${new Date().toISOString()}`,
    '',
  ];

  // Successes — the main content
  if (successes.length > 0) {
    prLines.push('### Issues');
    for (const r of successes) {
      prLines.push(`- #${r.issueNum}: ${r.title} — SUCCESS${r.prUrl ? ` ([PR](${r.prUrl}))` : ''}`);
    }
    prLines.push('');
    prLines.push(...successes.map((r) => `Closes #${r.issueNum}`));
    prLines.push('');
  }

  // Permanent failures — collapsed
  if (permanentFailures.length > 0) {
    prLines.push('<details>');
    prLines.push(`<summary>Failed Issues (${permanentFailures.length})</summary>`);
    prLines.push('');
    for (const r of permanentFailures) {
      prLines.push(`- #${r.issueNum}: ${r.title} — FAILURE`);
    }
    prLines.push('');
    prLines.push('</details>');
    prLines.push('');
  }

  // Transient failures — brief note, these were re-queued
  if (transientFailures.length > 0) {
    prLines.push(`*${transientFailures.length} issue(s) were re-queued due to agent rate limits.*`);
    prLines.push('');
  }

  // Session review findings
  if (session.sessionReviewFindings) {
    const gate = session.sessionReviewFindings;
    prLines.push('### Session Review');
    prLines.push('');
    prLines.push(`**Status:** ${gate.passed ? 'PASSED' : 'NEEDS ATTENTION'}`);
    prLines.push(`**Summary:** ${gate.summary || 'No summary'}`);
    if (gate.findings.length > 0) {
      prLines.push('');
      for (const f of gate.findings) {
        const fixedTag = f.fixed ? ' (fixed)' : '';
        prLines.push(`- [${f.severity.toUpperCase()}] ${f.description}${fixedTag}${f.file ? ` — \`${f.file}\`` : ''}`);
      }
    }
    prLines.push('');
  }

  prLines.push('---');
  prLines.push(`This PR collects all changes from this session for final review before merging to ${config.baseBranch}.`);
  prLines.push('');
  prLines.push('Automated by alpha-loop');

  const prBody = prLines.join('\n');

  try {
    const prUrl = createPR({
      repo: config.repo,
      base: config.baseBranch,
      head: session.branch,
      title: prTitle,
      body: prBody,
      cwd: projectDir,
    });
    log.success(`Session PR: ${prUrl}`);

    // Mark successful issues on the project board
    // When autoMerge is enabled, session PR still needs review — keep issues "In Review"
    // When not auto-merging, individual PRs were already created, so mark as "Done"
    const boardStatus = config.autoMerge ? 'In Review' : 'Done';
    for (const r of session.results) {
      if (r.status === 'success' && config.project > 0) {
        updateProjectStatus(config.repo, config.project, config.repoOwner, r.issueNum, boardStatus);
      }
    }

    return prUrl;
  } catch (err) {
    // If createPR failed (e.g. nothing to compare), try creating via gh directly
    log.warn(`createPR failed: ${err instanceof Error ? err.message : err}`);
    try {
      const fallback = ghExec(
        `gh pr create --repo "${config.repo}" --base "${config.baseBranch}" --head "${session.branch}" --title "${prTitle}" --body "Session finalization — see branch for details"`,
        { cwd: projectDir }, true,
      );
      if (fallback.exitCode === 0 && fallback.stdout.trim()) {
        log.success(`Session PR (fallback): ${fallback.stdout.trim()}`);
        return fallback.stdout.trim();
      }
    } catch {
      // Fall through
    }
    log.warn('Could not create session PR — check branch manually');
    return null;
  }
}

