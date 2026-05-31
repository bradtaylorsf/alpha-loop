import {
  DEFAULT_DAEMON_CONFIG,
  loadConfig,
  type Config,
  type DaemonConfig,
  type DaemonMode,
} from '../lib/config.js';
import {
  DaemonLockError,
  runDaemonLoop,
  type DaemonActions,
  type DaemonFeedbackPollResult,
  type DaemonRunLoopOptions,
} from '../lib/daemon.js';
import { emitLifecycleEvent } from '../lib/events.js';
import { ingestFeedback, parseFeedbackPayloadText } from '../lib/feedback.js';
import { getIssueWithComments, pollIssues } from '../lib/github.js';
import { log } from '../lib/logger.js';
import { decisionAllowed, evaluateCommandPolicy } from '../lib/automation-policy.js';
import { exec } from '../lib/shell.js';
import { runSingleIssueExecution } from './run.js';
import { resumePausedIssueFromManifest } from './resume.js';
import { triageCommand } from './triage.js';

export type DaemonCommandOptions = {
  mode?: string;
  triageInterval?: number;
  feedbackInterval?: number;
  runInterval?: number;
  healthInterval?: number;
  idleSleep?: number;
  feedbackCommand?: string;
  lock?: boolean;
  onceTick?: boolean;
  maxTicks?: number;
};

const VALID_DAEMON_MODES: DaemonMode[] = ['full', 'triage-only', 'feedback-only', 'run-only'];

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

export function resolveDaemonConfig(config: Config, options: DaemonCommandOptions = {}): DaemonConfig {
  const daemon: DaemonConfig = {
    ...DEFAULT_DAEMON_CONFIG,
    ...(config.daemon ?? {}),
    lock: {
      ...DEFAULT_DAEMON_CONFIG.lock,
      ...(config.daemon?.lock ?? {}),
    },
  };

  if (options.mode !== undefined) {
    if (!VALID_DAEMON_MODES.includes(options.mode as DaemonMode)) {
      throw new Error(`Invalid daemon mode "${options.mode}". Expected one of ${VALID_DAEMON_MODES.join(', ')}`);
    }
    daemon.mode = options.mode as DaemonMode;
  }
  daemon.triageIntervalSeconds = positiveNumber(options.triageInterval) ?? daemon.triageIntervalSeconds;
  daemon.feedbackIntervalSeconds = positiveNumber(options.feedbackInterval) ?? daemon.feedbackIntervalSeconds;
  daemon.runIntervalSeconds = positiveNumber(options.runInterval) ?? daemon.runIntervalSeconds;
  daemon.healthIntervalSeconds = positiveNumber(options.healthInterval) ?? daemon.healthIntervalSeconds;
  daemon.idleSleepSeconds = positiveNumber(options.idleSleep) ?? daemon.idleSleepSeconds;
  if (options.feedbackCommand !== undefined) daemon.feedbackPollCommand = options.feedbackCommand.trim();
  if (options.lock !== undefined) daemon.lock.enabled = options.lock;

  return daemon;
}

export function parseFeedbackPollOutput(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Feedback poll JSON array entries must be objects.');
      }
      return item as Record<string, unknown>;
    });
    if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>];
    throw new Error('Feedback poll JSON must be an object or array.');
  } catch (err) {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length > 1) {
        return lines.map((line) => parseFeedbackPayloadText(line));
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseFeedbackPayloadText(line));
}

async function pollFeedback(config: Config, daemon: DaemonConfig): Promise<DaemonFeedbackPollResult> {
  if (!daemon.feedbackPollCommand) {
    return {
      status: 'skipped',
      processed: 0,
      reason: 'No daemon.feedback_poll_command configured.',
    };
  }

  const decision = evaluateCommandPolicy(config, daemon.feedbackPollCommand, { stage: 'command' });
  if (!decisionAllowed(decision)) {
    return {
      status: 'skipped',
      processed: 0,
      reason: decision.reason,
      policyDecision: decision,
    };
  }

  const result = exec(daemon.feedbackPollCommand, { cwd: process.cwd(), timeout: 5 * 60 * 1000 });
  if (result.exitCode !== 0) {
    throw new Error(`Feedback poll command failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }

  const payloads = parseFeedbackPollOutput(result.stdout);
  let processed = 0;
  let alreadyProcessed = 0;
  for (const payload of payloads) {
    const ingestResult = ingestFeedback({
      payload: {
        ...payload,
        repo: payload.repo ?? payload.repository ?? config.repo,
      },
      repo: config.repo,
      readyLabel: config.labelReady,
      requestResume: true,
    });
    if (ingestResult.status === 'already_processed') {
      alreadyProcessed += 1;
      continue;
    }
    processed += 1;
    await emitLifecycleEvent({
      config,
      type: 'feedback.received',
      manifestPath: ingestResult.session.manifestPath,
      context: {
        issueNumber: ingestResult.githubComment.issueNumber,
        prNumber: ingestResult.githubComment.prNumber,
        feedback: {
          idempotencyHash: ingestResult.idempotencyHash,
          source: ingestResult.githubComment.marker.source,
          externalEventId: ingestResult.githubComment.marker.externalEventId,
          externalThreadId: ingestResult.githubComment.marker.externalThreadId,
          externalMessageId: ingestResult.githubComment.marker.externalMessageId,
          classification: ingestResult.classification,
          resumeCommand: ingestResult.resumeCommand,
        },
        metadata: {
          daemon: true,
          githubCommentTarget: ingestResult.githubComment.targetNumber,
          sessionFound: ingestResult.session.found,
          sessionLookup: ingestResult.session.lookup,
        },
      },
    });
  }

  return {
    status: 'processed',
    processed,
    alreadyProcessed,
  };
}

function createDaemonActions(): DaemonActions {
  return {
    triage: async () => {
      await triageCommand({ yes: true });
    },
    pollFeedback,
    pollIssues: (config) => pollIssues(config.repo, config.labelReady, 25, {
      project: config.project,
      repoOwner: config.repoOwner,
      milestone: config.milestone || undefined,
    }),
    getIssue: (config, issueNumber) => getIssueWithComments(config.repo, issueNumber),
    runIssue: async (config, issue) => {
      const result = await runSingleIssueExecution({
        config,
        issueNumber: issue.number,
        issue,
        options: { issue: issue.number },
      });
      return {
        issueNumber: result.issueNumber,
        status: result.status,
      };
    },
    resumeIssue: async (config, issueNumber, statuses) => resumePausedIssueFromManifest(issueNumber, config, { statuses }),
    emitEvent: emitLifecycleEvent,
  };
}

export async function daemonCommand(
  options: DaemonCommandOptions,
  loopOptions: DaemonRunLoopOptions = {},
): Promise<void> {
  try {
    const baseConfig = loadConfig();
    if (!baseConfig.repo) {
      throw new Error('No repository configured. Run "alpha-loop init" or set repo in .alpha-loop.yaml');
    }
    const daemon = resolveDaemonConfig(baseConfig, options);
    const config: Config = { ...baseConfig, daemon };

    log.step(`Starting alpha-loop daemon (${daemon.mode})`);
    await runDaemonLoop(config, daemon, createDaemonActions(), {
      onceTick: options.onceTick,
      maxTicks: options.maxTicks,
      ...loopOptions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof DaemonLockError) {
      log.error(message);
      process.exitCode = 2;
      return;
    }
    log.error(message);
    process.exitCode = 1;
  }
}
