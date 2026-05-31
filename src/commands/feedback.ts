import { readFileSync } from 'node:fs';
import { ingestFeedback, normalizeFeedbackIngestPayload, parseFeedbackPayloadText } from '../lib/feedback.js';
import { loadConfig } from '../lib/config.js';
import { log } from '../lib/logger.js';
import { emitLifecycleEvent } from '../lib/events.js';

export type FeedbackIngestCommandOptions = {
  bodyFile?: string;
  json?: boolean;
  requestResume?: boolean;
  repo?: string;
  issue?: string;
  pr?: string;
  session?: string;
  source?: string;
  externalEventId?: string;
  externalThreadId?: string;
  externalMessageId?: string;
  author?: string;
  body?: string;
  attachment?: string[];
  timestamp?: string;
  classification?: string;
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let raw = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    raw += String(chunk);
  }
  return raw;
}

function optionPayload(options: FeedbackIngestCommandOptions): Record<string, unknown> {
  return {
    ...(options.repo ? { repo: options.repo } : {}),
    ...(options.issue ? { issueNumber: options.issue } : {}),
    ...(options.pr ? { prNumber: options.pr } : {}),
    ...(options.session ? { sessionId: options.session } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.externalEventId ? { externalEventId: options.externalEventId } : {}),
    ...(options.externalThreadId ? { externalThreadId: options.externalThreadId } : {}),
    ...(options.externalMessageId ? { externalMessageId: options.externalMessageId } : {}),
    ...(options.author ? { author: options.author } : {}),
    ...(options.body ? { body: options.body } : {}),
    ...(options.attachment ? { attachments: options.attachment } : {}),
    ...(options.timestamp ? { eventTimestamp: options.timestamp } : {}),
    ...(options.classification ? { classification: options.classification } : {}),
    ...(options.requestResume ? { resumeRequested: true } : {}),
  };
}

function mergePayloads(...payloads: Array<Record<string, unknown>>): Record<string, unknown> {
  return payloads.reduce<Record<string, unknown>>((merged, payload) => ({
    ...merged,
    ...Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)),
  }), {});
}

function printHumanResult(result: ReturnType<typeof ingestFeedback>): void {
  if (result.status === 'already_processed') {
    log.info(`Feedback already processed: ${result.idempotencyHash}`);
    log.info(`Record: ${result.recordPath}`);
    return;
  }

  log.success(`Feedback ingested for ${result.githubComment.repo}#${result.githubComment.targetNumber}`);
  log.info(`Classification: ${result.classification}`);
  if (result.session.found && result.session.name) {
    log.info(`Session: ${result.session.name}`);
  } else {
    log.info('Session: not found');
  }
  if (result.resumeCommand) {
    log.info(`Resume command: ${result.resumeCommand}`);
  }
}

export async function feedbackIngestCommand(
  options: FeedbackIngestCommandOptions,
  inputText?: string,
): Promise<void> {
  try {
    const config = loadConfig();
    const rawInput = options.bodyFile
      ? readFileSync(options.bodyFile, 'utf-8')
      : inputText ?? await readStdin();
    const inputPayload = rawInput.trim() ? parseFeedbackPayloadText(rawInput) : {};
    const hasInputRepo = inputPayload.repo !== undefined || inputPayload.repository !== undefined;
    const payload = normalizeFeedbackIngestPayload(mergePayloads(
      inputPayload,
      config.repo && !options.repo && !hasInputRepo ? { repo: config.repo } : {},
      optionPayload(options),
    ));

    const result = ingestFeedback({
      payload,
      repo: config.repo,
      readyLabel: config.labelReady,
      requestResume: options.requestResume,
    });

    if (result.status === 'processed') {
      await emitLifecycleEvent({
        config,
        type: 'feedback.received',
        manifestPath: result.session.manifestPath,
        context: {
          issueNumber: result.githubComment.issueNumber,
          prNumber: result.githubComment.prNumber,
          feedback: {
            idempotencyHash: result.idempotencyHash,
            source: result.githubComment.marker.source,
            externalEventId: result.githubComment.marker.externalEventId,
            externalThreadId: result.githubComment.marker.externalThreadId,
            externalMessageId: result.githubComment.marker.externalMessageId,
            classification: result.classification,
            resumeCommand: result.resumeCommand,
          },
          metadata: {
            githubCommentTarget: result.githubComment.targetNumber,
            sessionFound: result.session.found,
            sessionLookup: result.session.lookup,
          },
        },
      });
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanResult(result);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ status: 'error', error: message }, null, 2));
    } else {
      log.error(message);
    }
    process.exitCode = 1;
  }
}
