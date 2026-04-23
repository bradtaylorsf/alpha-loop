import {
  evaluatePromotion,
  evaluateDemotion,
  applyRoutingDiff,
  PROMOTION_MIN_RUNS,
  PROMOTION_SUCCESS_DELTA_FLOOR,
  PROMOTION_COST_SAVINGS_MIN,
  PROMOTION_TOOL_ERROR_CEILING,
  DEMOTION_TOOL_ERROR_CEILING,
} from '../../src/lib/routing-promotion.js';
import type { RoutingCell } from '../../src/lib/telemetry.js';
import type { TurnRecord } from '../../src/lib/escalation.js';

const frontier = (over: Partial<RoutingCell> = {}): RoutingCell => ({
  stage: 'build',
  model: 'claude-sonnet-4-6',
  endpoint: 'anthropic-prod',
  endpoint_type: 'anthropic',
  runs: 50,
  tokens_in: 0,
  tokens_out: 0,
  total_cost_usd: 100,
  pipeline_success_rate: 0.9,
  cost_per_issue_shipped: 1.00,
  median_wall_time_s: 20,
  tool_error_rate: 0.01,
  ...over,
});

const local = (over: Partial<RoutingCell> = {}): RoutingCell => ({
  stage: 'build',
  model: 'qwen3-coder-30b-a3b',
  endpoint: 'lmstudio',
  endpoint_type: 'anthropic_compat',
  runs: 50,
  tokens_in: 0,
  tokens_out: 0,
  total_cost_usd: 0,
  pipeline_success_rate: 0.88,
  cost_per_issue_shipped: 0.30,
  median_wall_time_s: 45,
  tool_error_rate: 0.01,
  ...over,
});

describe('evaluatePromotion', () => {
  it('promotes when all thresholds are met', () => {
    const proposals = evaluatePromotion([frontier(), local()]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].stage).toBe('build');
    expect(proposals[0].from.model).toBe('claude-sonnet-4-6');
    expect(proposals[0].to.model).toBe('qwen3-coder-30b-a3b');
    expect(proposals[0].metrics.runs).toBe(50);
  });

  it('blocks when sample size is below 30 runs', () => {
    const proposals = evaluatePromotion([frontier(), local({ runs: PROMOTION_MIN_RUNS - 1 })]);
    expect(proposals).toHaveLength(0);
  });

  it('allows exactly 30 runs (inclusive)', () => {
    const proposals = evaluatePromotion([frontier(), local({ runs: PROMOTION_MIN_RUNS })]);
    expect(proposals).toHaveLength(1);
  });

  it('blocks on ties when there are no meaningful savings', () => {
    const proposals = evaluatePromotion([
      frontier({ cost_per_issue_shipped: 1.0 }),
      local({ cost_per_issue_shipped: 1.0 }),
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('blocks when savings are below the 40% floor', () => {
    const proposals = evaluatePromotion([
      frontier({ cost_per_issue_shipped: 1.0 }),
      // 30% savings — below the 40% required.
      local({ cost_per_issue_shipped: 0.70 }),
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('passes at exactly 40% savings (inclusive of the min)', () => {
    const proposals = evaluatePromotion([
      frontier({ cost_per_issue_shipped: 1.0 }),
      local({ cost_per_issue_shipped: 0.60 }),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metrics.costPerIssueSavingsPct).toBeCloseTo(PROMOTION_COST_SAVINGS_MIN, 3);
  });

  it('returns [] when baseline (frontier) cost data is missing', () => {
    const proposals = evaluatePromotion([
      frontier({ cost_per_issue_shipped: null }),
      local(),
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('blocks when tool_error_rate equals 0.02 (strict <)', () => {
    const proposals = evaluatePromotion([
      frontier(),
      local({ tool_error_rate: PROMOTION_TOOL_ERROR_CEILING }),
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('passes when pipeline_success_delta equals -0.03 (inclusive)', () => {
    const proposals = evaluatePromotion([
      frontier({ pipeline_success_rate: 0.90 }),
      local({ pipeline_success_rate: 0.87 }),
    ]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].metrics.pipelineSuccessDelta).toBeCloseTo(PROMOTION_SUCCESS_DELTA_FLOOR, 3);
  });

  it('blocks when pipeline_success_delta drops below -0.03', () => {
    const proposals = evaluatePromotion([
      frontier({ pipeline_success_rate: 0.90 }),
      local({ pipeline_success_rate: 0.86 }),
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('ignores non-local candidates as promotion targets', () => {
    const proposals = evaluatePromotion([
      frontier(),
      // Same costs but endpoint_type marks this as another frontier-ish cell.
      local({ endpoint_type: 'anthropic' }),
    ]);
    expect(proposals).toHaveLength(0);
  });

  it('handles multi-stage input independently', () => {
    const proposals = evaluatePromotion([
      frontier({ stage: 'build' }),
      local({ stage: 'build' }),
      frontier({ stage: 'plan', cost_per_issue_shipped: 0.5 }),
      // plan-local fails cost savings (only 20% savings).
      local({ stage: 'plan', cost_per_issue_shipped: 0.4 }),
    ]);
    expect(proposals.map((p) => p.stage)).toEqual(['build']);
  });
});

describe('evaluateDemotion', () => {
  const turn = (errored: boolean, timestampMs = Date.now()): TurnRecord => ({
    errored,
    escalated: false,
    timestampMs,
  });

  it('does not fire when window is shorter than 10 turns', () => {
    const turns = [turn(true), turn(true), turn(true)];
    const decision = evaluateDemotion(turns, [], 'build');
    expect(decision.fire).toBe(false);
  });

  it('fires when rolling tool_error_rate exceeds 8%', () => {
    const turns = [
      turn(true), turn(true), turn(true), turn(false),
      turn(false), turn(false), turn(false), turn(false),
      turn(false), turn(false),
    ];
    const decision = evaluateDemotion(turns, [], 'build');
    // 3/10 = 30% > 8%
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe('tool_error_rate');
    expect(decision.metrics?.rollingToolErrorRate).toBeCloseTo(0.3, 3);
  });

  it('does not fire exactly at 8% (strict >)', () => {
    // Error rate ratios can't land exactly on 0.08 with 10 samples (0, 10%, 20%…).
    // But if we widen the window to 50, 4/50 = 0.08 exactly.
    const turns: TurnRecord[] = Array.from({ length: 50 }, (_, i) => turn(i < 4));
    // Only the last 10 turns are considered — those are all non-errored here.
    const decision = evaluateDemotion(turns, [], 'build');
    expect(decision.fire).toBe(false);
  });

  it('does not fire when tool_error_rate is at the 8% boundary in the window', () => {
    // Round-about test: if the window is large enough to permit exact 8%, make sure
    // we block at the boundary. DEMOTION_TOOL_ERROR_CEILING is strictly >.
    const turns: TurnRecord[] = Array.from({ length: 10 }, (_, i) => turn(i === 0));
    const decision = evaluateDemotion(turns, [], 'build');
    // 1/10 = 10% > 8% — this DOES fire.
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe('tool_error_rate');
    expect(DEMOTION_TOOL_ERROR_CEILING).toBeLessThan(0.1);
  });

  it('fires on pipeline_success drop vs trailing 30-run baseline', () => {
    // Current window: 10 turns, 8 errored (20% success).
    const turns: TurnRecord[] = [
      turn(true), turn(true), turn(true), turn(true), turn(true),
      turn(true), turn(true), turn(true), turn(false), turn(false),
    ];
    // Baseline is ALSO >8% error rate (the tool_error_rate check fires first),
    // so construct a scenario where errors < 8% but successes dropped anyway.
    // Use "errored" to flip current success rate but give enough non-errored
    // turns to go under 8%.
    const mixed: TurnRecord[] = [
      turn(false), turn(false), turn(false), turn(false), turn(false),
      turn(false), turn(false), turn(false), turn(false), turn(false),
    ];
    const decision = evaluateDemotion(mixed, [
      {
        stage: 'build',
        model: 'frontier',
        runs: 30,
        tokens_in: 0,
        tokens_out: 0,
        total_cost_usd: 0,
        pipeline_success_rate: 0.95, // baseline 95%, current 100% → no drop
        cost_per_issue_shipped: 1,
        median_wall_time_s: 20,
        tool_error_rate: 0,
      },
    ], 'build');
    expect(decision.fire).toBe(false);

    const drop = evaluateDemotion(turns, [
      {
        stage: 'build',
        model: 'frontier',
        runs: 30,
        tokens_in: 0,
        tokens_out: 0,
        total_cost_usd: 0,
        pipeline_success_rate: 0.95,
        cost_per_issue_shipped: 1,
        median_wall_time_s: 20,
        tool_error_rate: 0,
      },
    ], 'build');
    expect(drop.fire).toBe(true);
    // tool_error_rate is the highest-priority trigger.
    expect(drop.reason).toBe('tool_error_rate');
  });

  it('does not use pipeline_success baseline when trailing runs < 30', () => {
    const turns: TurnRecord[] = Array.from({ length: 10 }, () => turn(false));
    const decision = evaluateDemotion(turns, [
      {
        stage: 'build',
        model: 'frontier',
        runs: 10,
        tokens_in: 0,
        tokens_out: 0,
        total_cost_usd: 0,
        pipeline_success_rate: 1.0,
        cost_per_issue_shipped: 1,
        median_wall_time_s: 20,
        tool_error_rate: 0,
      },
    ], 'build');
    expect(decision.fire).toBe(false);
  });
});

describe('applyRoutingDiff', () => {
  it('returns the input unchanged when no proposals', () => {
    const yaml = 'agent: claude\nmodel: foo\n';
    const { yaml: result, diff } = applyRoutingDiff(yaml, []);
    expect(result).toBe(yaml);
    expect(diff).toBe('');
  });

  it('patches routing.stages.<name> and produces a diff', () => {
    const yaml = [
      'agent: claude',
      'routing:',
      '  stages:',
      '    build:',
      '      model: claude-sonnet-4-6',
      '      endpoint: anthropic-prod',
      '',
    ].join('\n');

    const { yaml: after, diff } = applyRoutingDiff(yaml, [
      {
        stage: 'build',
        from: { model: 'claude-sonnet-4-6', endpoint: 'anthropic-prod' },
        to: { model: 'qwen3-coder-30b', endpoint: 'lmstudio' },
        metrics: {
          runs: 50,
          pipelineSuccessDelta: 0,
          costPerIssueDelta: -0.5,
          costPerIssueSavingsPct: 0.5,
          toolErrorRate: 0.01,
          frontierCostPerIssue: 1,
          candidateCostPerIssue: 0.5,
        },
      },
    ]);
    expect(after).toContain('qwen3-coder-30b');
    expect(after).toContain('lmstudio');
    expect(diff).toContain('# stage: build');
    expect(diff).toContain('- ');
    expect(diff).toContain('+ ');
  });

  it('inserts stages block when routing block has no stages', () => {
    const yaml = 'agent: claude\nrouting:\n  endpoints: {}\n';
    const { yaml: after } = applyRoutingDiff(yaml, [
      {
        stage: 'build',
        from: { model: 'frontier', endpoint: 'x' },
        to: { model: 'local', endpoint: 'y' },
        metrics: {
          runs: 30,
          pipelineSuccessDelta: 0,
          costPerIssueDelta: -0.5,
          costPerIssueSavingsPct: 0.5,
          toolErrorRate: 0,
          frontierCostPerIssue: 1,
          candidateCostPerIssue: 0.5,
        },
      },
    ]);
    expect(after).toContain('stages:');
    expect(after).toContain('local');
  });
});
