import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildStageTelemetry,
  writeStageTelemetry,
  readStageTelemetry,
  readAllStageTelemetry,
  readSessionManifests,
  aggregateRouting,
  parseDuration,
  formatRoutingReport,
} from '../../src/lib/telemetry';
import type { StageTelemetry, SessionManifestLite } from '../../src/lib/telemetry';
import type { Config } from '../../src/lib/config';
import type { AgentResult } from '../../src/lib/agent';

function baseConfig(): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 1,
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    reviewModel: 'claude-opus-4-6',
    pollInterval: 60,
    dryRun: false,
    baseBranch: 'master',
    logDir: 'logs',
    labelReady: 'ready',
    maxTestRetries: 3,
    testCommand: 'pnpm test',
    devCommand: 'pnpm dev',
    skipTests: false,
    skipReview: false,
    skipInstall: false,
    skipPreflight: false,
    skipVerify: false,
    skipLearn: false,
    skipE2e: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    autoMerge: true,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    verbose: false,
    harnesses: [],
    setupCommand: '',
    evalDir: '.alpha-loop/evals',
    evalModel: '',
    skipEval: false,
    evalTimeout: 300,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {
      'claude-opus-4-6': { input: 15.0, output: 75.0 },
      'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
      'qwen3-coder-30b-a3b': { input: 0, output: 0 },
    },
    pipeline: {},
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    preferEpics: false,
  };
}

describe('buildStageTelemetry', () => {
  it('uses reported tokens and cost for frontier endpoints', () => {
    const cfg = baseConfig();
    const res: AgentResult = {
      exitCode: 0,
      output: 'ok',
      duration: 1234,
      costUsd: 0.0598,
      inputTokens: 10_000,
      outputTokens: 2_000,
      toolCalls: 5,
      toolErrors: 1,
      model: 'claude-sonnet-4-6',
    };
    const entry = buildStageTelemetry(res, 'implement', cfg, {
      endpoint: 'anthropic-prod',
      endpointType: 'anthropic',
      profile: 'hybrid-v1',
      issueNum: 42,
    });
    expect(entry.stage).toBe('implement');
    expect(entry.model).toBe('claude-sonnet-4-6');
    expect(entry.endpoint).toBe('anthropic-prod');
    expect(entry.endpoint_type).toBe('anthropic');
    expect(entry.tokens_in).toBe(10_000);
    expect(entry.tokens_out).toBe(2_000);
    expect(entry.cost_usd).toBe(0.0598);
    expect(entry.wall_time_s).toBe(1.234);
    expect(entry.tool_calls).toBe(5);
    expect(entry.tool_errors).toBe(1);
    expect(entry.stage_success).toBe(true);
    expect(entry.profile).toBe('hybrid-v1');
    expect(entry.issue_num).toBe(42);
  });

  it('zeroes cost for anthropic_compat (local LM Studio) endpoints', () => {
    const cfg = baseConfig();
    const res: AgentResult = {
      exitCode: 0,
      output: 'ok',
      duration: 5_000,
      costUsd: 0.12, // Agent reported a cost — should be ignored for local.
      inputTokens: 10_000,
      outputTokens: 2_000,
      model: 'qwen3-coder-30b-a3b',
    };
    const entry = buildStageTelemetry(res, 'implement', cfg, {
      endpoint: 'lmstudio',
      endpointType: 'anthropic_compat',
    });
    expect(entry.cost_usd).toBe(0);
    expect(entry.tokens_in).toBe(10_000);
    expect(entry.tokens_out).toBe(2_000);
  });

  it('zeroes cost for openai_compat (Ollama) endpoints', () => {
    const cfg = baseConfig();
    const res: AgentResult = {
      exitCode: 0,
      output: 'ok',
      duration: 5_000,
      model: 'qwen3-coder-30b-a3b',
    };
    const entry = buildStageTelemetry(res, 'implement', cfg, {
      endpoint: 'ollama',
      endpointType: 'openai_compat',
    });
    expect(entry.cost_usd).toBe(0);
  });

  it('falls back to estimated tokens from output length when agent lacks cost data', () => {
    const cfg = baseConfig();
    const res: AgentResult = {
      exitCode: 1,
      output: 'x'.repeat(400), // ~100 output tokens, 130 input tokens.
      duration: 1_000,
      model: 'claude-sonnet-4-6',
    };
    const entry = buildStageTelemetry(res, 'plan', cfg, {
      endpoint: 'anthropic',
      endpointType: 'anthropic',
    });
    expect(entry.tokens_out).toBeGreaterThan(0);
    expect(entry.tokens_in).toBeGreaterThan(0);
    expect(entry.cost_usd).toBeGreaterThan(0);
    expect(entry.stage_success).toBe(false);
  });

  it('defaults tool counts to 0 when agent result lacks them', () => {
    const cfg = baseConfig();
    const res: AgentResult = {
      exitCode: 0,
      output: '',
      duration: 500,
      model: 'claude-sonnet-4-6',
    };
    const entry = buildStageTelemetry(res, 'plan', cfg, {});
    expect(entry.tool_calls).toBe(0);
    expect(entry.tool_errors).toBe(0);
    expect(entry.endpoint).toBe('default');
  });
});

describe('writeStageTelemetry / readStageTelemetry', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'telemetry-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('appends jsonl and reads back entries in order', () => {
    const entry1: StageTelemetry = {
      stage: 'plan', model: 'a', endpoint: 'x',
      tokens_in: 1, tokens_out: 2, cost_usd: 0.1,
      wall_time_s: 1, tool_calls: 0, tool_errors: 0,
      stage_success: true, started_at: '2026-04-23T00:00:00.000Z',
    };
    const entry2: StageTelemetry = { ...entry1, stage: 'implement', model: 'b' };
    writeStageTelemetry(tmp, entry1);
    writeStageTelemetry(tmp, entry2);
    const entries = readStageTelemetry(tmp);
    expect(entries).toHaveLength(2);
    expect(entries[0].stage).toBe('plan');
    expect(entries[1].model).toBe('b');
  });

  it('returns empty array for missing file', () => {
    expect(readStageTelemetry(join(tmp, 'does-not-exist'))).toEqual([]);
  });

  it('skips malformed lines without crashing', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'stages.jsonl'), 'not valid json\n{"stage":"ok","model":"m","endpoint":"e","tokens_in":0,"tokens_out":0,"cost_usd":0,"wall_time_s":0,"tool_calls":0,"tool_errors":0,"stage_success":true,"started_at":"x"}\n');
    const entries = readStageTelemetry(tmp);
    expect(entries).toHaveLength(1);
    expect(entries[0].stage).toBe('ok');
  });
});

describe('aggregateRouting', () => {
  function entry(
    stage: string,
    model: string,
    cost: number,
    wall: number,
    toolCalls: number,
    toolErrors: number,
    profile?: string,
    started?: string,
  ): StageTelemetry {
    return {
      stage, model, endpoint: 'e',
      tokens_in: 100, tokens_out: 50, cost_usd: cost,
      wall_time_s: wall, tool_calls: toolCalls, tool_errors: toolErrors,
      stage_success: true,
      started_at: started ?? '2026-04-23T00:00:00.000Z',
      profile,
    };
  }

  function manifest(name: string, shipped: number, failed = 0): SessionManifestLite {
    const results = [];
    for (let i = 0; i < shipped; i++) {
      results.push({ issueNum: i + 1, status: 'success' as const, filesChanged: 3, prUrl: `url/${i}` });
    }
    for (let i = 0; i < failed; i++) {
      results.push({ issueNum: 100 + i, status: 'failure' as const, filesChanged: 0 });
    }
    return { name, completed: '2026-04-23T00:00:00.000Z', results };
  }

  it('computes cost_per_issue_shipped from cost/shipped', () => {
    const items = [
      { session: 'session-20260423-000000', entries: [entry('implement', 'sonnet', 1.0, 10, 10, 1)] },
    ];
    const manifests = [manifest('session/20260423-000000', 4)]; // 4 shipped issues.
    const agg = aggregateRouting(items, manifests, { baseline: 'all-frontier' });
    expect(agg.cells).toHaveLength(1);
    expect(agg.cells[0].cost_per_issue_shipped).toBeCloseTo(0.25, 4);
  });

  it('groups multi-model sessions correctly and sums cost across stages', () => {
    const items = [
      {
        session: 'session-A',
        entries: [
          entry('plan', 'opus', 0.5, 5, 5, 0),
          entry('implement', 'sonnet', 0.3, 30, 20, 1),
          entry('implement', 'sonnet', 0.2, 20, 15, 0),
        ],
      },
    ];
    const manifests = [manifest('session/A', 2)];
    const agg = aggregateRouting(items, manifests);
    expect(agg.total_cost_usd).toBeCloseTo(1.0, 4);
    const implementCell = agg.cells.find((c) => c.stage === 'implement')!;
    expect(implementCell.runs).toBe(2);
    expect(implementCell.total_cost_usd).toBeCloseTo(0.5, 4);
    expect(implementCell.cost_per_issue_shipped).toBeCloseTo(0.25, 4);
  });

  it('computes median wall time across invocations', () => {
    const items = [
      {
        session: 'S',
        entries: [
          entry('implement', 'm', 0.1, 10, 1, 0),
          entry('implement', 'm', 0.1, 30, 1, 0),
          entry('implement', 'm', 0.1, 50, 1, 0),
        ],
      },
    ];
    const agg = aggregateRouting(items, [manifest('S', 1)]);
    expect(agg.cells[0].median_wall_time_s).toBe(30);
  });

  it('computes tool_error_rate from error/call ratio', () => {
    const items = [
      {
        session: 'S',
        entries: [entry('implement', 'm', 0.1, 10, 100, 8)],
      },
    ];
    const agg = aggregateRouting(items, [manifest('S', 1)]);
    expect(agg.cells[0].tool_error_rate).toBeCloseTo(0.08, 4);
  });

  it('computes delta vs all-frontier baseline (highest-cost cell per stage)', () => {
    const items = [
      {
        session: 'S1',
        entries: [
          entry('implement', 'opus', 2.0, 40, 10, 0),      // Frontier baseline (costly).
          entry('implement', 'qwen-local', 0.0, 30, 10, 2), // Local cell.
        ],
      },
    ];
    const manifests = [manifest('S1', 1)];
    const agg = aggregateRouting(items, manifests);
    const local = agg.cells.find((c) => c.model === 'qwen-local')!;
    const frontier = agg.cells.find((c) => c.model === 'opus')!;
    expect(frontier.delta_cost_per_issue_shipped_vs_baseline).toBeNull();
    expect(local.delta_cost_per_issue_shipped_vs_baseline).toBeLessThan(0); // Cheaper.
    expect(local.delta_median_wall_time_s_vs_baseline).toBe(-10);
    expect(local.delta_tool_error_rate_vs_baseline).toBeCloseTo(0.2 - 0, 4);
  });

  it('filters by profile', () => {
    const items = [
      {
        session: 'S',
        entries: [
          entry('implement', 'a', 0.1, 10, 1, 0, 'alpha'),
          entry('implement', 'b', 0.2, 20, 1, 0, 'beta'),
        ],
      },
    ];
    const agg = aggregateRouting(items, [manifest('S', 1)], { profile: 'alpha' });
    expect(agg.cells).toHaveLength(1);
    expect(agg.cells[0].model).toBe('a');
  });

  it('filters by sinceMs', () => {
    const oldTs = '2020-01-01T00:00:00.000Z';
    const newTs = '2026-06-01T00:00:00.000Z';
    const items = [
      {
        session: 'S',
        entries: [
          entry('implement', 'old', 0.1, 10, 1, 0, undefined, oldTs),
          entry('implement', 'new', 0.2, 20, 1, 0, undefined, newTs),
        ],
      },
    ];
    const cutoff = new Date('2025-01-01T00:00:00.000Z').getTime();
    const agg = aggregateRouting(items, [manifest('S', 1)], { sinceMs: cutoff });
    expect(agg.cells.map((c) => c.model)).toEqual(['new']);
  });

  it('returns cost_per_issue_shipped=null when no shipped issues', () => {
    const items = [
      { session: 'S', entries: [entry('implement', 'm', 0.5, 10, 1, 0)] },
    ];
    const agg = aggregateRouting(items, [manifest('S', 0, 1)]);
    expect(agg.cells[0].cost_per_issue_shipped).toBeNull();
  });

  it('handles sessions without a matching manifest gracefully', () => {
    const items = [
      { session: 'S', entries: [entry('implement', 'm', 0.5, 10, 1, 0)] },
    ];
    const agg = aggregateRouting(items, []);
    expect(agg.cells).toHaveLength(1);
    expect(agg.cells[0].cost_per_issue_shipped).toBeNull();
    expect(agg.total_issues_shipped).toBe(0);
  });
});

describe('parseDuration', () => {
  it('parses seconds/minutes/hours/days', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('3d')).toBe(3 * 86_400_000);
  });
  it('returns undefined for invalid input', () => {
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('abc')).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
  });
});

describe('formatRoutingReport', () => {
  it('returns JSON when json option set', () => {
    const agg = aggregateRouting(
      [{ session: 'S', entries: [{ stage: 'plan', model: 'm', endpoint: 'e', tokens_in: 1, tokens_out: 1, cost_usd: 0.1, wall_time_s: 1, tool_calls: 1, tool_errors: 0, stage_success: true, started_at: '2026-04-23T00:00:00.000Z' }] }],
      [{ name: 'session/S', results: [{ issueNum: 1, status: 'success', filesChanged: 3 }] }],
    );
    const str = formatRoutingReport(agg, { json: true });
    const parsed = JSON.parse(str);
    expect(parsed.cells).toBeDefined();
    expect(parsed.filters.baseline).toBe('all-frontier');
  });

  it('shows friendly message when no cells', () => {
    const agg = aggregateRouting([], []);
    const str = formatRoutingReport(agg);
    expect(str).toContain('No per-stage telemetry recorded yet');
  });
});

describe('readAllStageTelemetry / readSessionManifests', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'telemetry-fs-test-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('scans traces dir and returns per-session entries', () => {
    const sessionDir = join(tmp, '.alpha-loop', 'traces', 'session-A');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, 'stages.jsonl'),
      JSON.stringify({ stage: 'plan', model: 'm', endpoint: 'e', tokens_in: 0, tokens_out: 0, cost_usd: 0, wall_time_s: 0, tool_calls: 0, tool_errors: 0, stage_success: true, started_at: 'x' }) + '\n',
    );
    const items = readAllStageTelemetry(tmp);
    expect(items).toHaveLength(1);
    expect(items[0].session).toBe('session-A');
    expect(items[0].entries).toHaveLength(1);
  });

  it('reads session manifests from learnings dir', () => {
    const learningsDir = join(tmp, '.alpha-loop', 'learnings');
    mkdirSync(learningsDir, { recursive: true });
    writeFileSync(
      join(learningsDir, 'session-session-A.json'),
      JSON.stringify({ name: 'session/A', results: [{ issueNum: 1, status: 'success', filesChanged: 3 }] }),
    );
    const manifests = readSessionManifests(tmp);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].name).toBe('session/A');
  });

  it('returns empty arrays when dirs do not exist', () => {
    expect(readAllStageTelemetry(tmp)).toEqual([]);
    expect(readSessionManifests(tmp)).toEqual([]);
  });

  it('ignores sessions that have only an empty stages.jsonl', () => {
    const sessionDir = join(tmp, '.alpha-loop', 'traces', 'session-empty');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'stages.jsonl'), '\n');
    expect(existsSync(join(sessionDir, 'stages.jsonl'))).toBe(true);
    expect(readAllStageTelemetry(tmp)).toHaveLength(0);
  });
});
