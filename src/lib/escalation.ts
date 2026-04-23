/**
 * Retry-with-escalation: when a local-model stage emits malformed tool calls
 * or fails structural checks twice within the same turn, auto-escalate that
 * turn to the configured frontier fallback model. Also implements the 24h
 * rolling-rate guardrail that pins a stage to fallback when the primary's
 * tool-error rate exceeds the configured threshold.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RoutingStageName, FallbackPolicy } from './config.js';

/** Reason classes we detect in agent output. */
export type ToolErrorKind = 'json_parse' | 'unknown_tool' | 'schema_validation';

/** Structured classification of a tool-call error found in agent output. */
export type ToolErrorClassification = {
  kind: ToolErrorKind;
  reason: string;
};

/** One tool-call failure attempt tracked within a single turn. */
export type TurnErrorState = {
  /** Classified errors seen in this turn so far, in encounter order. */
  errors: ToolErrorClassification[];
  /** Whether this turn has already been escalated once (max 1 per turn). */
  escalated: boolean;
};

/** Structured event recorded when escalation or guardrail logic fires. */
export type EscalationEvent = {
  type: 'escalation' | 'stage_revert' | 'stage_revert_active' | 'needs_human_input';
  stage: RoutingStageName;
  from_model: string;
  to_model: string;
  reason: string;
  turn_index: number;
  issue: number;
  ts: string;
};

/** Per-stage record of a single turn outcome (used by the rolling guardrail). */
export type TurnRecord = {
  /** Whether any tool-call error was classified in the turn. */
  errored: boolean;
  /** Whether this turn was escalated to the fallback model. */
  escalated: boolean;
  /** Epoch ms when the turn completed. */
  timestampMs: number;
};

/** Serialized guardrail state persisted to disk. */
type EscalationState = {
  /** Rolling window of turns per stage — newest appended. */
  history: Partial<Record<RoutingStageName, TurnRecord[]>>;
  /** Active revert pins per stage (epoch ms the pin expires). */
  reverts: Partial<Record<RoutingStageName, number>>;
};

const EMPTY_STATE: EscalationState = { history: {}, reverts: {} };

/**
 * Patterns used to classify tool-call errors found in agent output.
 *
 * We scan only the last ~4KB of output to avoid matching code the agent wrote
 * (e.g. docstrings containing the word "ZodError" or "unknown tool"). If the
 * signal appears anywhere further up, it's far more likely to be content than
 * a genuine error.
 */
const CLASSIFY_TAIL_CHARS = 4000;

const JSON_PARSE_PATTERNS: RegExp[] = [
  /SyntaxError:\s*Unexpected token/i,
  /SyntaxError:\s*Expected.*JSON/i,
  /JSON\.parse\s*\(/,
  /Unexpected end of JSON input/i,
  /Invalid JSON in tool (call|arguments?)/i,
  /failed to parse tool arguments?/i,
  /malformed (tool[- ])?(call|arguments?|json)/i,
];

const UNKNOWN_TOOL_PATTERNS: RegExp[] = [
  /unknown tool[: ]/i,
  /tool not (found|defined|registered)/i,
  /no such tool[: ]/i,
  /unrecognized tool[: ]/i,
];

const SCHEMA_VALIDATION_PATTERNS: RegExp[] = [
  /ZodError/,
  /"code":\s*"invalid_type"/,
  /invalid_type/i,
  /required field.*missing/i,
  /schema validation failed/i,
  /does not match schema/i,
  /parameter .+ is required/i,
];

/**
 * Classify a single tool-call failure signal in agent output.
 * Returns null when no classified pattern is found.
 *
 * Use `classifyToolErrors` to detect multiple distinct failures in one turn.
 */
export function classifyToolError(output: string): ToolErrorClassification | null {
  if (!output) return null;
  const tail = output.slice(-CLASSIFY_TAIL_CHARS);

  for (const p of JSON_PARSE_PATTERNS) {
    const m = tail.match(p);
    if (m) return { kind: 'json_parse', reason: m[0].trim() };
  }
  for (const p of UNKNOWN_TOOL_PATTERNS) {
    const m = tail.match(p);
    if (m) return { kind: 'unknown_tool', reason: m[0].trim() };
  }
  for (const p of SCHEMA_VALIDATION_PATTERNS) {
    const m = tail.match(p);
    if (m) return { kind: 'schema_validation', reason: m[0].trim() };
  }
  return null;
}

/**
 * Scan an output buffer for every classified tool-call failure occurrence.
 * Returned in encounter order; duplicates of the same exact reason are kept —
 * two hits means two consecutive errors, which is the escalation trigger.
 */
export function classifyToolErrors(output: string): ToolErrorClassification[] {
  if (!output) return [];
  const tail = output.slice(-CLASSIFY_TAIL_CHARS);
  const hits: Array<{ index: number; classification: ToolErrorClassification }> = [];

  const scan = (patterns: RegExp[], kind: ToolErrorKind): void => {
    for (const p of patterns) {
      const globalPattern = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g');
      let m: RegExpExecArray | null;
      while ((m = globalPattern.exec(tail)) !== null) {
        hits.push({ index: m.index, classification: { kind, reason: m[0].trim() } });
        if (m.index === globalPattern.lastIndex) globalPattern.lastIndex++;
      }
    }
  };

  scan(JSON_PARSE_PATTERNS, 'json_parse');
  scan(UNKNOWN_TOOL_PATTERNS, 'unknown_tool');
  scan(SCHEMA_VALIDATION_PATTERNS, 'schema_validation');

  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => h.classification);
}

/** Start a new per-turn error-state object. */
export function newTurnState(): TurnErrorState {
  return { errors: [], escalated: false };
}

/**
 * Record tool-call errors from an output into the turn state.
 * Returns true when the turn has reached the 2-error escalation threshold
 * AND hasn't already been escalated.
 */
export function shouldEscalate(turn: TurnErrorState, output: string): boolean {
  if (turn.escalated) return false;
  const newErrors = classifyToolErrors(output);
  if (newErrors.length === 0) return false;
  turn.errors.push(...newErrors);
  return turn.errors.length >= 2;
}

/**
 * Rolling-window guardrail that tracks per-stage tool-error rates across
 * recent turns and pins a stage to fallback when the rate exceeds the
 * configured threshold. All time comes from the injected `now()` so tests
 * can advance fake timers.
 */
export class EscalationTracker {
  private state: EscalationState;
  private readonly statePath: string | null;
  private readonly nowFn: () => number;

  constructor(options: { statePath?: string | null; now?: () => number } = {}) {
    this.statePath = options.statePath ?? null;
    this.nowFn = options.now ?? (() => Date.now());
    this.state = this.load();
  }

  now(): number {
    return this.nowFn();
  }

  /** Append a turn outcome for a stage. Trims to the rolling window size. */
  recordTurn(entry: {
    stage: RoutingStageName;
    errored: boolean;
    escalated: boolean;
    timestampMs?: number;
    windowSize: number;
  }): void {
    const history = this.state.history[entry.stage] ?? [];
    history.push({
      errored: entry.errored,
      escalated: entry.escalated,
      timestampMs: entry.timestampMs ?? this.nowFn(),
    });
    while (history.length > entry.windowSize) history.shift();
    this.state.history[entry.stage] = history;
    this.save();
  }

  /** Current rolling error rate for a stage (0..1). Returns 0 when no data. */
  errorRate(stage: RoutingStageName): number {
    const history = this.state.history[stage] ?? [];
    if (history.length === 0) return 0;
    const errored = history.filter((h) => h.errored).length;
    return errored / history.length;
  }

  /** Whether the stage is currently pinned to fallback. */
  isStageReverted(stage: RoutingStageName, now?: number): boolean {
    const pin = this.state.reverts[stage];
    if (pin == null) return false;
    const current = now ?? this.nowFn();
    if (current >= pin) {
      delete this.state.reverts[stage];
      this.save();
      return false;
    }
    return true;
  }

  /** Pin a stage to fallback until `untilMs`. */
  markRevert(stage: RoutingStageName, untilMs: number): void {
    this.state.reverts[stage] = untilMs;
    this.save();
  }

  /**
   * Evaluate whether the stage should be pinned to fallback. Call after
   * recordTurn(). Returns true when a new revert was just applied.
   */
  maybeTriggerRevert(stage: RoutingStageName, policy: FallbackPolicy): boolean {
    if (this.isStageReverted(stage)) return false;
    const history = this.state.history[stage] ?? [];
    if (history.length < policy.escalation_window_issues) return false;
    const rate = this.errorRate(stage);
    if (rate > policy.escalation_error_threshold) {
      this.markRevert(stage, this.nowFn() + policy.escalation_revert_ms);
      return true;
    }
    return false;
  }

  /** When the current pin expires (epoch ms) or null if unpinned. */
  revertUntil(stage: RoutingStageName): number | null {
    const pin = this.state.reverts[stage];
    return pin ?? null;
  }

  private load(): EscalationState {
    if (!this.statePath || !existsSync(this.statePath)) {
      return { history: {}, reverts: {} };
    }
    try {
      const raw = readFileSync(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<EscalationState>;
      return {
        history: parsed.history ?? {},
        reverts: parsed.reverts ?? {},
      };
    } catch {
      return { history: {}, reverts: {} };
    }
  }

  private save(): void {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + '\n');
    } catch {
      // Non-fatal — guardrail is a best-effort cache.
    }
  }
}

/** Default filesystem location for the persisted guardrail state. */
export function defaultEscalationStatePath(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), '.alpha-loop', 'escalation-state.json');
}

/**
 * Append a structured escalation event to the traces ndjson log.
 * Silent on failure — telemetry should never break the pipeline.
 */
export function appendEscalationEventToTrace(
  runDir: string,
  event: EscalationEvent,
): void {
  try {
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, 'events.ndjson');
    writeFileSync(path, JSON.stringify(event) + '\n', { flag: 'a' });
  } catch {
    // Non-fatal.
  }
}
