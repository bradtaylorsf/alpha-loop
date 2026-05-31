export const HUMAN_FEEDBACK_SESSION_STATUSES = [
  'running',
  'human_input_requested',
  'qa_requested',
  'feedback_received',
  'resume_requested',
  'resuming',
  'completed',
  'failed',
] as const;

export type HumanFeedbackSessionStatus = typeof HUMAN_FEEDBACK_SESSION_STATUSES[number];

export const FEEDBACK_CLASSIFICATIONS = [
  'clarification',
  'change_request',
  'approval',
  'rejection',
  'new_scope',
  'unknown',
] as const;

export type FeedbackClassification = typeof FEEDBACK_CLASSIFICATIONS[number];

export type HumanFeedbackEventType =
  | 'human_input'
  | 'qa'
  | 'feedback'
  | 'resume'
  | 'completed'
  | 'failed'
  | 'feedback.received'
  | 'feedback.classified'
  | 'session.resume_requested';

export type HumanFeedbackAttachment = string | {
  url?: string;
  title?: string;
  filename?: string;
  contentType?: string;
};

export type HumanFeedbackIngestRecord = {
  idempotencyKey: string;
  idempotencyHash: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  sessionId: string | null;
  sessionName: string | null;
  source: string;
  externalEventId: string | null;
  externalThreadId: string | null;
  externalMessageId: string | null;
  author: string | null;
  body: string;
  attachments: HumanFeedbackAttachment[];
  eventTimestamp: string;
  receivedAt: string;
  classification: FeedbackClassification;
  githubCommentTarget: number;
  commentMarker: string;
  resumeRequested: boolean;
  resumeCommand: string | null;
};

export type HumanFeedbackTransitionRecord = {
  from: HumanFeedbackSessionStatus;
  to: HumanFeedbackSessionStatus;
  reason: string;
  issueNum?: number;
  at: string;
};

export type HumanFeedbackEvent = {
  id: string;
  type: HumanFeedbackEventType;
  status: HumanFeedbackSessionStatus;
  issueNum?: number;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type HumanFeedbackStateBlock = {
  currentStatus: HumanFeedbackSessionStatus;
  question: string | null;
  resumeInstructions: string | null;
  qaChecklist: string[];
  prUrl: string | null;
  previewUrl: string | null;
  classification: FeedbackClassification | null;
  followUpIssueNumber: number | null;
  followUpIssueUrl: string | null;
  transitionHistory: HumanFeedbackTransitionRecord[];
  events: HumanFeedbackEvent[];
  latestFeedback?: HumanFeedbackIngestRecord | null;
  feedbackHistory?: HumanFeedbackIngestRecord[];
  updatedAt: string;
};

export type HumanFeedbackTransitionInput = {
  to: HumanFeedbackSessionStatus;
  reason: string;
  issueNum?: number;
  question?: string | null;
  resumeInstructions?: string | null;
  qaChecklist?: string[];
  prUrl?: string | null;
  previewUrl?: string | null;
  classification?: FeedbackClassification | null;
  followUpIssueNumber?: number | null;
  followUpIssueUrl?: string | null;
  eventType?: HumanFeedbackEventType;
  eventPayload?: Record<string, unknown>;
  at?: string;
};

export type HumanFeedbackEventInput = {
  type: HumanFeedbackEventType;
  status?: HumanFeedbackSessionStatus;
  issueNum?: number;
  payload?: Record<string, unknown>;
  at?: string;
};

export type StateLabelChange = {
  add: string;
  remove?: string;
};

export class InvalidSessionTransitionError extends Error {
  readonly from: HumanFeedbackSessionStatus;
  readonly to: HumanFeedbackSessionStatus;

  constructor(from: HumanFeedbackSessionStatus, to: HumanFeedbackSessionStatus) {
    super(`Invalid session status transition: ${from} -> ${to}`);
    this.name = 'InvalidSessionTransitionError';
    this.from = from;
    this.to = to;
  }
}

const CANONICAL_STATUS_SET = new Set<string>(HUMAN_FEEDBACK_SESSION_STATUSES);
const FEEDBACK_CLASSIFICATION_SET = new Set<string>(FEEDBACK_CLASSIFICATIONS);

const CLASSIFICATION_ALIASES: Record<string, FeedbackClassification> = {
  clarification_answer: 'clarification',
  qa_change_request: 'change_request',
  change: 'change_request',
  change_requested: 'change_request',
  approved: 'approval',
  rejected: 'rejection',
  new_work: 'new_scope',
};

const STATUS_ALIASES: Record<string, HumanFeedbackSessionStatus> = {
  active: 'running',
  paused: 'human_input_requested',
  'waiting-for-feedback': 'human_input_requested',
  'qa-requested': 'qa_requested',
  resumed: 'resuming',
  'cleaned-up': 'completed',
};

const TRANSITIONS: Record<HumanFeedbackSessionStatus, HumanFeedbackSessionStatus[]> = {
  running: ['human_input_requested', 'qa_requested', 'completed', 'failed'],
  human_input_requested: ['feedback_received', 'resume_requested', 'failed'],
  qa_requested: ['feedback_received', 'completed', 'failed'],
  feedback_received: ['human_input_requested', 'qa_requested', 'resume_requested', 'completed', 'failed'],
  resume_requested: ['resuming', 'failed'],
  resuming: ['running', 'human_input_requested', 'qa_requested', 'completed', 'failed'],
  completed: ['resume_requested'],
  failed: ['resume_requested'],
};

export function normalizeHumanFeedbackStatus(status: string): HumanFeedbackSessionStatus | null {
  if (CANONICAL_STATUS_SET.has(status)) return status as HumanFeedbackSessionStatus;
  return STATUS_ALIASES[status] ?? null;
}

export function normalizeFeedbackClassification(value: string | undefined | null): FeedbackClassification | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (CLASSIFICATION_ALIASES[normalized]) return CLASSIFICATION_ALIASES[normalized];
  return FEEDBACK_CLASSIFICATION_SET.has(normalized) ? normalized as FeedbackClassification : null;
}

export function isWaitingFeedbackStatus(status: string): boolean {
  const normalized = normalizeHumanFeedbackStatus(status);
  return normalized === 'human_input_requested'
    || normalized === 'qa_requested'
    || normalized === 'feedback_received'
    || normalized === 'resume_requested';
}

export function assertValidSessionTransition(
  from: HumanFeedbackSessionStatus,
  to: HumanFeedbackSessionStatus,
): void {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidSessionTransitionError(from, to);
  }
}

export function initialHumanFeedbackState(
  status: HumanFeedbackSessionStatus = 'running',
  at = new Date().toISOString(),
): HumanFeedbackStateBlock {
  return {
    currentStatus: status,
    question: null,
    resumeInstructions: null,
    qaChecklist: [],
    prUrl: null,
    previewUrl: null,
    classification: null,
    followUpIssueNumber: null,
    followUpIssueUrl: null,
    transitionHistory: [],
    events: [],
    latestFeedback: null,
    feedbackHistory: [],
    updatedAt: at,
  };
}

function eventId(at: string, count: number): string {
  return `feedback-${at.replace(/[^0-9A-Za-z]/g, '')}-${count}`;
}

export function applyHumanFeedbackTransition<T extends {
  status: string;
  stage: string;
  lastEventId?: string | null;
  feedback?: HumanFeedbackStateBlock;
}>(
  manifest: T,
  input: HumanFeedbackTransitionInput,
): T & { feedback: HumanFeedbackStateBlock; status: HumanFeedbackSessionStatus; stage: HumanFeedbackSessionStatus } {
  const from = currentManifestStatus(manifest);
  if (!from) {
    throw new Error(`Unknown session status: ${manifest.feedback?.currentStatus ?? manifest.status}`);
  }

  assertValidSessionTransition(from, input.to);

  const at = input.at ?? new Date().toISOString();
  const prior = manifest.feedback ?? initialHumanFeedbackState(from, at);
  const transition: HumanFeedbackTransitionRecord = {
    from,
    to: input.to,
    reason: input.reason,
    ...(input.issueNum !== undefined ? { issueNum: input.issueNum } : {}),
    at,
  };
  const eventType = input.eventType ?? eventTypeForStatus(input.to);
  const event: HumanFeedbackEvent = {
    id: eventId(at, prior.events.length + 1),
    type: eventType,
    status: input.to,
    ...(input.issueNum !== undefined ? { issueNum: input.issueNum } : {}),
    createdAt: at,
    payload: {
      reason: input.reason,
      ...(input.eventPayload ?? {}),
    },
  };

  return {
    ...manifest,
    status: input.to,
    stage: input.to,
    lastEventId: event.id,
    feedback: {
      ...prior,
      currentStatus: input.to,
      question: input.question !== undefined ? input.question : prior.question,
      resumeInstructions: input.resumeInstructions !== undefined ? input.resumeInstructions : prior.resumeInstructions,
      qaChecklist: input.qaChecklist ?? prior.qaChecklist,
      prUrl: input.prUrl !== undefined ? input.prUrl : prior.prUrl,
      previewUrl: input.previewUrl !== undefined ? input.previewUrl : prior.previewUrl,
      classification: input.classification !== undefined ? input.classification : prior.classification,
      followUpIssueNumber: input.followUpIssueNumber !== undefined ? input.followUpIssueNumber : prior.followUpIssueNumber,
      followUpIssueUrl: input.followUpIssueUrl !== undefined ? input.followUpIssueUrl : prior.followUpIssueUrl,
      transitionHistory: [...prior.transitionHistory, transition],
      events: [...prior.events, event],
      updatedAt: at,
    },
  } as T & { feedback: HumanFeedbackStateBlock; status: HumanFeedbackSessionStatus; stage: HumanFeedbackSessionStatus };
}

export function appendHumanFeedbackEvent<T extends {
  status: string;
  lastEventId?: string | null;
  feedback?: HumanFeedbackStateBlock;
}>(
  manifest: T,
  input: HumanFeedbackEventInput,
): T & { feedback: HumanFeedbackStateBlock; lastEventId: string | null } {
  const at = input.at ?? new Date().toISOString();
  const currentStatus = input.status
    ?? currentManifestStatus(manifest)
    ?? 'running';
  const prior = manifest.feedback ?? initialHumanFeedbackState(currentStatus, at);
  const event: HumanFeedbackEvent = {
    id: eventId(at, prior.events.length + 1),
    type: input.type,
    status: currentStatus,
    ...(input.issueNum !== undefined ? { issueNum: input.issueNum } : {}),
    createdAt: at,
    payload: input.payload ?? {},
  };

  return {
    ...manifest,
    lastEventId: event.id,
    feedback: {
      ...prior,
      currentStatus,
      events: [...prior.events, event],
      updatedAt: at,
    },
  } as T & { feedback: HumanFeedbackStateBlock; lastEventId: string | null };
}

function currentManifestStatus(manifest: {
  status: string;
  feedback?: HumanFeedbackStateBlock;
}): HumanFeedbackSessionStatus | null {
  const status = normalizeHumanFeedbackStatus(manifest.status);
  const feedback = normalizeHumanFeedbackStatus(manifest.feedback?.currentStatus ?? '');
  if (status && status !== 'running' && feedback === 'running') return status;
  return feedback ?? status;
}

export function mapLabelsToHumanFeedbackStatus(labels: string[], readyLabel = 'ready'): HumanFeedbackSessionStatus | null {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  if (normalized.has('in-progress')) return 'running';
  if (normalized.has('in-review')) return 'qa_requested';
  if (normalized.has('needs-human-input')) return 'human_input_requested';
  if (normalized.has(readyLabel.toLowerCase())) return 'resume_requested';
  return null;
}

export function githubLabelChangesForStatus(
  status: HumanFeedbackSessionStatus,
  readyLabel = 'ready',
): StateLabelChange[] {
  switch (status) {
    case 'running':
    case 'resuming':
      return [
        { add: 'in-progress', remove: readyLabel },
        { add: 'in-progress', remove: 'needs-human-input' },
      ];
    case 'human_input_requested':
      return [
        { add: 'needs-human-input', remove: 'in-progress' },
        { add: 'needs-human-input', remove: readyLabel },
      ];
    case 'qa_requested':
      return [
        { add: 'in-review', remove: 'in-progress' },
        { add: 'needs-human-input', remove: readyLabel },
      ];
    case 'feedback_received':
      return [
        { add: 'needs-human-input', remove: 'in-progress' },
      ];
    case 'resume_requested':
      return [
        { add: readyLabel, remove: 'needs-human-input' },
      ];
    case 'completed':
      return [
        { add: 'in-review', remove: 'needs-human-input' },
        { add: 'in-review', remove: 'in-progress' },
      ];
    case 'failed':
      return [
        { add: 'failed', remove: 'in-progress' },
        { add: 'failed', remove: 'needs-human-input' },
      ];
  }
}

export function formatHumanInputComment(args: {
  question: string;
  resumeInstructions?: string | null;
  sessionName?: string;
  branch?: string;
  worktreePath?: string;
}): string {
  const lines = [
    '## Alpha Loop Needs Human Input',
    '',
    args.question.trim(),
    '',
    '### Resume Instructions',
    args.resumeInstructions?.trim() || 'Reply with the requested clarification, then resume this issue with `alpha-loop resume --issue <issue-number>` when resume support is available.',
  ];

  const refs = [
    args.sessionName ? `- Session: \`${args.sessionName}\`` : '',
    args.branch ? `- Branch: \`${args.branch}\`` : '',
    args.worktreePath ? `- Worktree: \`${args.worktreePath}\`` : '',
  ].filter(Boolean);
  if (refs.length > 0) lines.push('', '### Preserved Context', ...refs);
  lines.push('', '---', '*Alpha Loop paused this session instead of guessing.*');
  return lines.join('\n');
}

export function formatQaRequestComment(args: {
  checklist: string[];
  prUrl?: string | null;
  previewUrl?: string | null;
  resumeInstructions?: string | null;
}): string {
  const checklist = args.checklist.length > 0
    ? args.checklist
    : ['Review the implementation PR and confirm whether the issue is ready to merge.'];
  const lines = [
    '## Alpha Loop Requests Human QA',
    '',
    'Please complete the QA checklist before merge:',
    '',
    ...checklist.map((item) => `- [ ] ${item}`),
  ];

  if (args.prUrl || args.previewUrl) {
    lines.push('', '### References');
    if (args.prUrl) lines.push(`- PR: ${args.prUrl}`);
    if (args.previewUrl) lines.push(`- Preview: ${args.previewUrl}`);
  }

  if (args.resumeInstructions) {
    lines.push('', '### Resume Instructions', args.resumeInstructions.trim());
  }

  lines.push('', '---', '*Alpha Loop is waiting for QA feedback and will not merge this work blindly.*');
  return lines.join('\n');
}

export function formatNewScopeComment(args: {
  summary: string;
  followUpIssueNumber?: number | null;
  followUpIssueUrl?: string | null;
  question?: string | null;
}): string {
  const lines = [
    '## Alpha Loop Detected New Scope',
    '',
    args.summary.trim() || 'The latest feedback appears to expand the issue beyond the current scope.',
    '',
  ];

  if (args.followUpIssueNumber || args.followUpIssueUrl) {
    lines.push('A follow-up issue was created instead of expanding this PR silently.');
    if (args.followUpIssueUrl) lines.push('', `Follow-up: ${args.followUpIssueUrl}`);
    else if (args.followUpIssueNumber) lines.push('', `Follow-up: #${args.followUpIssueNumber}`);
  } else {
    lines.push(args.question?.trim() || 'Please confirm whether Alpha Loop should create a separate follow-up issue for this new scope.');
  }

  lines.push('', '---', '*Alpha Loop kept the active PR scoped to the original issue.*');
  return lines.join('\n');
}

export function classifyFeedback(text: string): FeedbackClassification {
  if (!text.trim()) return 'unknown';
  const lower = text.toLowerCase();
  if (/\b(lgtm|approved|approve|ship it|looks good)\b/.test(lower)) return 'approval';
  if (/\b(reject|rejected|not approved|decline|do not proceed|don't proceed)\b/.test(lower)) return 'rejection';
  if (/\b(new scope|follow[- ]?up|separate issue|another issue|also add|also include|while you're there)\b/.test(lower)) {
    return 'new_scope';
  }
  if (/^\s*(thanks|thank you)( for the update)?[.!]*\s*$/.test(lower)) return 'unknown';
  if (/\b(change|fix|update|remove|revise|adjust|fail|failed|failing|broken)\b/.test(lower)) return 'change_request';
  if (/\b(does not work|doesn't work|not working)\b/.test(lower)) return 'change_request';
  if (/\b(use|choose|selected|go with|answer|answered)\b/.test(lower)) return 'clarification';
  if (text.includes('?') || /\b(clarify|clarification|what i meant|answer)\b/.test(lower)) return 'clarification';
  return 'unknown';
}

function eventTypeForStatus(status: HumanFeedbackSessionStatus): HumanFeedbackEventType {
  switch (status) {
    case 'human_input_requested':
      return 'human_input';
    case 'qa_requested':
      return 'qa';
    case 'feedback_received':
      return 'feedback';
    case 'resume_requested':
    case 'resuming':
    case 'running':
      return 'resume';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
  }
}
