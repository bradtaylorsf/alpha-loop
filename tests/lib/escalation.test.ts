import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  classifyToolError,
  classifyToolErrors,
  EscalationTracker,
  newTurnState,
  shouldEscalate,
  defaultEscalationStatePath,
  appendEscalationEventToTrace,
} from '../../src/lib/escalation.js';
import type { EscalationEvent } from '../../src/lib/escalation.js';
import type { FallbackPolicy } from '../../src/lib/config.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-escalation-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('classifyToolError', () => {
  it('returns null on empty output', () => {
    expect(classifyToolError('')).toBeNull();
    expect(classifyToolError('all good')).toBeNull();
  });

  it('detects a JSON.parse failure as json_parse', () => {
    const output = 'some text\nSyntaxError: Unexpected token } in JSON at position 42\n';
    const r = classifyToolError(output);
    expect(r?.kind).toBe('json_parse');
  });

  it('detects an unknown tool name', () => {
    const output = 'attempted to call tool but got: unknown tool: frobnicate';
    const r = classifyToolError(output);
    expect(r?.kind).toBe('unknown_tool');
  });

  it('detects a schema validation failure (ZodError)', () => {
    const output = 'ZodError: [ { "code": "invalid_type", "expected": "string" } ]';
    const r = classifyToolError(output);
    expect(r?.kind).toBe('schema_validation');
  });

  it('only inspects the tail — signal earlier in output is ignored', () => {
    // "ZodError" appears at the very start, then thousands of chars of clean output.
    const noise = 'ok\n'.repeat(2000);
    const output = `ZodError at startup\n${noise}`;
    expect(classifyToolError(output)).toBeNull();
  });
});

describe('classifyToolErrors', () => {
  it('returns every classified failure in encounter order', () => {
    const output = [
      'something went wrong',
      'SyntaxError: Unexpected token } in JSON',
      'unknown tool: frobnicate',
      'ZodError: invalid_type',
    ].join('\n');
    const errors = classifyToolErrors(output);
    const kinds = errors.map((e) => e.kind);
    expect(kinds).toContain('json_parse');
    expect(kinds).toContain('unknown_tool');
    expect(kinds).toContain('schema_validation');
  });

  it('returns empty for clean output', () => {
    expect(classifyToolErrors('no problem here')).toEqual([]);
  });
});

describe('shouldEscalate / per-turn counter', () => {
  it('does not trigger on a single error', () => {
    const turn = newTurnState();
    expect(shouldEscalate(turn, 'SyntaxError: Unexpected token')).toBe(false);
    expect(turn.errors.length).toBe(1);
  });

  it('triggers after two classified errors within the same turn', () => {
    const turn = newTurnState();
    expect(shouldEscalate(turn, 'SyntaxError: Unexpected token')).toBe(false);
    expect(shouldEscalate(turn, 'unknown tool: missing')).toBe(true);
  });

  it('triggers when one output contains two errors', () => {
    const turn = newTurnState();
    const output = 'SyntaxError: Unexpected token }\nunknown tool: missing\n';
    expect(shouldEscalate(turn, output)).toBe(true);
  });

  it('does not re-trigger once a turn has already been escalated', () => {
    const turn = newTurnState();
    shouldEscalate(turn, 'SyntaxError: a\nunknown tool: b');
    turn.escalated = true;
    expect(shouldEscalate(turn, 'ZodError: invalid_type')).toBe(false);
  });

  it('a fresh turn starts with a clean counter — single-turn scope', () => {
    const turnA = newTurnState();
    shouldEscalate(turnA, 'SyntaxError: Unexpected token }\nunknown tool: foo');
    expect(turnA.errors.length).toBeGreaterThanOrEqual(2);

    const turnB = newTurnState();
    expect(shouldEscalate(turnB, 'SyntaxError: Unexpected token }')).toBe(false);
    expect(turnB.errors.length).toBe(1);
  });
});

describe('EscalationTracker — rolling-rate guardrail', () => {
  const policy: FallbackPolicy = {
    on_tool_error: 'escalate',
    escalate_to: { model: 'claude-sonnet-4-6', endpoint: 'anthropic' },
    escalation_window_issues: 10,
    escalation_error_threshold: 0.08,
    escalation_revert_ms: 24 * 60 * 60 * 1000,
  };

  it('does not revert until the full window has accumulated', () => {
    let now = 1_000_000;
    const tracker = new EscalationTracker({ now: () => now });
    for (let i = 0; i < 9; i++) {
      tracker.recordTurn({ stage: 'build', errored: true, escalated: true, windowSize: policy.escalation_window_issues });
    }
    expect(tracker.maybeTriggerRevert('build', policy)).toBe(false);
    expect(tracker.isStageReverted('build')).toBe(false);
  });

  it('reverts when error rate exceeds threshold within the window', () => {
    let now = 1_000_000;
    const tracker = new EscalationTracker({ now: () => now });
    // 2 errors out of 10 = 20% > 8%
    for (let i = 0; i < 8; i++) {
      tracker.recordTurn({ stage: 'build', errored: false, escalated: false, windowSize: policy.escalation_window_issues });
    }
    for (let i = 0; i < 2; i++) {
      tracker.recordTurn({ stage: 'build', errored: true, escalated: true, windowSize: policy.escalation_window_issues });
    }
    expect(tracker.maybeTriggerRevert('build', policy)).toBe(true);
    expect(tracker.isStageReverted('build')).toBe(true);
  });

  it('clears the revert after the 24h window expires', () => {
    let now = 1_000_000;
    const tracker = new EscalationTracker({ now: () => now });
    for (let i = 0; i < 8; i++) {
      tracker.recordTurn({ stage: 'build', errored: false, escalated: false, windowSize: 10 });
    }
    for (let i = 0; i < 2; i++) {
      tracker.recordTurn({ stage: 'build', errored: true, escalated: true, windowSize: 10 });
    }
    tracker.maybeTriggerRevert('build', policy);
    expect(tracker.isStageReverted('build')).toBe(true);

    // Still pinned 23h later
    now += 23 * 60 * 60 * 1000;
    expect(tracker.isStageReverted('build')).toBe(true);

    // Expired after 24h + 1ms
    now += 60 * 60 * 1000 + 1;
    expect(tracker.isStageReverted('build')).toBe(false);
  });

  it('recovers after the guardrail window — subsequent clean runs reset the rate', () => {
    let now = 1_000_000;
    const tracker = new EscalationTracker({ now: () => now });
    // Fill with failures
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn({ stage: 'build', errored: true, escalated: true, windowSize: 10 });
    }
    expect(tracker.errorRate('build')).toBe(1);
    expect(tracker.maybeTriggerRevert('build', policy)).toBe(true);

    // Let the revert expire.
    now += policy.escalation_revert_ms + 1;
    expect(tracker.isStageReverted('build')).toBe(false);

    // Add clean runs — rolling window shifts failures out.
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn({ stage: 'build', errored: false, escalated: false, windowSize: 10 });
    }
    expect(tracker.errorRate('build')).toBe(0);
    // New revert should NOT fire on clean data.
    expect(tracker.maybeTriggerRevert('build', policy)).toBe(false);
  });

  it('persists state to disk and reloads it across instances', () => {
    const statePath = join(tempDir, 'state.json');
    let now = 1_000_000;
    const t1 = new EscalationTracker({ statePath, now: () => now });
    for (let i = 0; i < 5; i++) {
      t1.recordTurn({ stage: 'review', errored: true, escalated: false, windowSize: 10 });
    }
    t1.markRevert('build', now + 1000);

    expect(existsSync(statePath)).toBe(true);

    // New instance reads the persisted state.
    const t2 = new EscalationTracker({ statePath, now: () => now });
    expect(t2.errorRate('review')).toBe(1);
    expect(t2.isStageReverted('build')).toBe(true);
  });

  it('tracks stages independently', () => {
    let now = 1_000_000;
    const tracker = new EscalationTracker({ now: () => now });
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn({ stage: 'build', errored: true, escalated: true, windowSize: 10 });
    }
    for (let i = 0; i < 10; i++) {
      tracker.recordTurn({ stage: 'plan', errored: false, escalated: false, windowSize: 10 });
    }
    expect(tracker.maybeTriggerRevert('build', policy)).toBe(true);
    expect(tracker.maybeTriggerRevert('plan', policy)).toBe(false);
    expect(tracker.isStageReverted('build')).toBe(true);
    expect(tracker.isStageReverted('plan')).toBe(false);
  });
});

describe('defaultEscalationStatePath', () => {
  it('places the state file under .alpha-loop/', () => {
    const p = defaultEscalationStatePath('/tmp/project');
    expect(p).toBe('/tmp/project/.alpha-loop/escalation-state.json');
  });
});

describe('appendEscalationEventToTrace', () => {
  it('appends each event as one ndjson line', () => {
    const runDir = join(tempDir, 'run');
    const event: EscalationEvent = {
      type: 'escalation',
      stage: 'build',
      from_model: 'qwen3-coder-30b-a3b',
      to_model: 'claude-sonnet-4-6',
      reason: 'json_parse',
      turn_index: 1,
      issue: 42,
      ts: '2026-04-23T12:00:00.000Z',
    };
    appendEscalationEventToTrace(runDir, event);
    appendEscalationEventToTrace(runDir, { ...event, turn_index: 2 });

    const raw = readFileSync(join(runDir, 'events.ndjson'), 'utf-8').trim();
    const lines = raw.split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toMatchObject({ type: 'escalation', turn_index: 1 });
    expect(JSON.parse(lines[1])).toMatchObject({ type: 'escalation', turn_index: 2 });
  });
});
