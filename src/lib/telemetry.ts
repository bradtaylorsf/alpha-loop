/**
 * Per-Stage Telemetry — granular metrics per pipeline stage invocation.
 *
 * Session-level cost logs hide which stage burned the tokens. For A/B routing
 * analysis we need apples-to-apples metrics per (stage, model) cell across many
 * issues. This module defines the StageTelemetry record, persistence helpers
 * (stages.jsonl in the trace dir), and aggregation math for the
 * `alpha-loop report routing` command.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateCost } from './config.js';
import type { Config, RoutingEndpointType } from './config.js';
import type { AgentResult } from './agent.js';

/** One per-stage telemetry record. Written once per agent invocation. */
export type StageTelemetry = {
  /** Pipeline stage name (plan, implement, test_fix, review, verify, assumptions, batch-*). */
  stage: string;
  /** Model used for the invocation. */
  model: string;
  /** Named routing endpoint the stage hit (or 'default' if routing wasn't used). */
  endpoint: string;
  /** Protocol shape of the endpoint — used to identify local vs frontier. */
  endpoint_type?: RoutingEndpointType;
  /** Input tokens consumed. */
  tokens_in: number;
  /** Output tokens generated. */
  tokens_out: number;
  /** Cost in USD. Local-endpoint invocations record 0. */
  cost_usd: number;
  /** Wall-clock time in seconds (float). */
  wall_time_s: number;
  /** Count of tool_use blocks emitted by the agent. */
  tool_calls: number;
  /** Count of tool_result blocks flagged is_error. */
  tool_errors: number;
  /** Whether the stage invocation succeeded (exit code 0). */
  stage_success: boolean;
  /** ISO timestamp at start of invocation. */
  started_at: string;
  /** Routing profile that was active for this invocation, if any. */
  profile?: string;
  /** Issue number this stage was processing. */
  issue_num?: number;
};

/** A session manifest reference loaded by the reporter. */
export type SessionManifestLite = {
  name: string;
  completed?: string;
  results?: Array<{
    issueNum: number;
    status: 'success' | 'failure';
    filesChanged?: number;
    prUrl?: string;
  }>;
  stages?: StageTelemetry[];
};

/** Aggregated per-cell metrics, grouped by (stage, model). */
export type RoutingCell = {
  stage: string;
  model: string;
  endpoint?: string;
  endpoint_type?: RoutingEndpointType;
  profile?: string;
  runs: number;
  tokens_in: number;
  tokens_out: number;
  total_cost_usd: number;
  pipeline_success_rate: number;
  cost_per_issue_shipped: number | null;
  median_wall_time_s: number;
  tool_error_rate: number;
  delta_cost_per_issue_shipped_vs_baseline?: number | null;
  delta_median_wall_time_s_vs_baseline?: number | null;
  delta_tool_error_rate_vs_baseline?: number | null;
  delta_pipeline_success_rate_vs_baseline?: number | null;
};

/** Aggregation result, grouped by (stage, model), plus global totals. */
export type RoutingAggregation = {
  cells: RoutingCell[];
  total_sessions: number;
  total_stages: number;
  total_issues_shipped: number;
  total_cost_usd: number;
  filters: {
    profile?: string;
    since_ms?: number;
    baseline: string;
  };
};

/**
 * Build a StageTelemetry record from an AgentResult and stage context.
 *
 * Uses the agent's reported cost/tokens when present. Falls back to the
 * pricing table (0 for local endpoints since pricing entries are 0/0).
 */
export function buildStageTelemetry(
  agentResult: AgentResult,
  stage: string,
  config: Config,
  ctx: {
    endpoint?: string;
    endpointType?: RoutingEndpointType;
    profile?: string;
    issueNum?: number;
    startedAt?: string;
  },
): StageTelemetry {
  const model = agentResult.model || config.model;
  const endpointName = ctx.endpoint ?? 'default';
  const isLocal = ctx.endpointType === 'anthropic_compat' || ctx.endpointType === 'openai_compat';

  let tokensIn: number;
  let tokensOut: number;
  let costUsd: number;

  if (
    agentResult.costUsd != null &&
    agentResult.inputTokens != null &&
    agentResult.outputTokens != null
  ) {
    tokensIn = agentResult.inputTokens;
    tokensOut = agentResult.outputTokens;
    costUsd = isLocal ? 0 : agentResult.costUsd;
  } else {
    // Estimate tokens from output length (chars / 4 ≈ tokens).
    tokensOut = Math.round(agentResult.output.length / 4);
    tokensIn = Math.round(tokensOut * 1.3);
    costUsd = isLocal ? 0 : estimateCost(model, tokensIn, tokensOut, config.pricing);
  }

  return {
    stage,
    model,
    endpoint: endpointName,
    endpoint_type: ctx.endpointType,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
    wall_time_s: Math.round((agentResult.duration / 1000) * 1000) / 1000,
    tool_calls: agentResult.toolCalls ?? 0,
    tool_errors: agentResult.toolErrors ?? 0,
    stage_success: agentResult.exitCode === 0,
    started_at: ctx.startedAt ?? new Date(Date.now() - agentResult.duration).toISOString(),
    profile: ctx.profile,
    issue_num: ctx.issueNum,
  };
}

function stagesJsonlPath(runDirPath: string): string {
  return join(runDirPath, 'stages.jsonl');
}

/**
 * Append a stage telemetry entry to the run's stages.jsonl file.
 * Creates the file and parent directory when needed.
 */
export function writeStageTelemetry(runDirPath: string, entry: StageTelemetry): void {
  mkdirSync(runDirPath, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  appendFileSync(stagesJsonlPath(runDirPath), line);
}

/**
 * Read all stage telemetry entries for a single run.
 * Returns an empty array if the file doesn't exist or has parse errors.
 */
export function readStageTelemetry(runDirPath: string): StageTelemetry[] {
  const filePath = stagesJsonlPath(runDirPath);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');
  const entries: StageTelemetry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as StageTelemetry);
    } catch {
      /* skip invalid line */
    }
  }
  return entries;
}

/**
 * Scan `.alpha-loop/traces/` under the given project dir and return all
 * stage telemetry entries across all runs, each tagged with its session name.
 */
export function readAllStageTelemetry(
  projectDir?: string,
): Array<{ session: string; entries: StageTelemetry[] }> {
  const root = join(projectDir ?? process.cwd(), '.alpha-loop', 'traces');
  if (!existsSync(root)) return [];
  const out: Array<{ session: string; entries: StageTelemetry[] }> = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const entries = readStageTelemetry(dir);
    if (entries.length > 0) {
      out.push({ session: name, entries });
    }
  }
  return out;
}

/**
 * Load session manifests written to `.alpha-loop/learnings/` by finalizeSession.
 * Used by the reporter to join cost data with shipped-issue counts.
 */
export function readSessionManifests(projectDir?: string): SessionManifestLite[] {
  const dir = join(projectDir ?? process.cwd(), '.alpha-loop', 'learnings');
  if (!existsSync(dir)) return [];
  const out: SessionManifestLite[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith('session-') || !file.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const parsed = JSON.parse(raw) as SessionManifestLite;
      if (parsed.name) out.push(parsed);
    } catch {
      /* skip invalid */
    }
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Aggregate stage telemetry across sessions into per (stage, model) cells.
 *
 * - `pipeline_success_rate`: fraction of parent sessions that shipped a
 *   successful issue while this (stage, model) cell was active.
 * - `cost_per_issue_shipped`: total cost across this cell divided by the
 *   number of shipped (status=success, filesChanged>0) issues in the sessions
 *   where this cell ran.
 * - `median_wall_time_s`: median wall_time_s across invocations.
 * - `tool_error_rate`: sum(tool_errors) / sum(tool_calls || runs).
 * - Delta columns compare each cell against the cell at the same `stage` with
 *   `model` matching the baseline. When `baseline` is 'all-frontier' (default)
 *   we pick the highest-cost cell per stage as the baseline (frontier).
 */
export function aggregateRouting(
  items: Array<{ session: string; entries: StageTelemetry[] }>,
  manifests: SessionManifestLite[],
  opts: { profile?: string; sinceMs?: number; baseline?: string } = {},
): RoutingAggregation {
  const baseline = opts.baseline ?? 'all-frontier';
  const manifestByName = new Map<string, SessionManifestLite>();
  for (const m of manifests) manifestByName.set(m.name, m);

  type Bucket = {
    stage: string;
    model: string;
    endpoint?: string;
    endpoint_type?: RoutingEndpointType;
    profile?: string;
    runs: number;
    tokens_in: number;
    tokens_out: number;
    total_cost_usd: number;
    wall_times: number[];
    tool_calls: number;
    tool_errors: number;
    sessions: Set<string>;
  };

  const buckets = new Map<string, Bucket>();
  const sessionShipped = new Map<string, number>();
  const sessionsSeen = new Set<string>();
  let totalStages = 0;

  for (const { session, entries } of items) {
    const sessionName = deriveSessionName(session);
    const manifest = manifestByName.get(sessionName) ?? manifestByName.get(session);
    // Count shipped issues per session (success + filesChanged > 0).
    if (manifest && !sessionShipped.has(session)) {
      const shipped = (manifest.results ?? []).filter(
        (r) => r.status === 'success' && (r.filesChanged ?? 0) > 0,
      ).length;
      sessionShipped.set(session, shipped);
    }

    for (const e of entries) {
      if (opts.profile && e.profile !== opts.profile) continue;
      if (opts.sinceMs && new Date(e.started_at).getTime() < opts.sinceMs) continue;

      sessionsSeen.add(session);
      totalStages++;

      const key = `${e.stage}::${e.model}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          stage: e.stage,
          model: e.model,
          endpoint: e.endpoint,
          endpoint_type: e.endpoint_type,
          profile: e.profile,
          runs: 0,
          tokens_in: 0,
          tokens_out: 0,
          total_cost_usd: 0,
          wall_times: [],
          tool_calls: 0,
          tool_errors: 0,
          sessions: new Set(),
        };
        buckets.set(key, bucket);
      }
      bucket.runs++;
      bucket.tokens_in += e.tokens_in;
      bucket.tokens_out += e.tokens_out;
      bucket.total_cost_usd += e.cost_usd;
      bucket.wall_times.push(e.wall_time_s);
      bucket.tool_calls += e.tool_calls;
      bucket.tool_errors += e.tool_errors;
      bucket.sessions.add(session);
    }
  }

  let totalCost = 0;
  let totalIssuesShipped = 0;
  for (const s of sessionsSeen) totalIssuesShipped += sessionShipped.get(s) ?? 0;

  const cells: RoutingCell[] = [];
  for (const b of buckets.values()) {
    totalCost += b.total_cost_usd;

    // Shipped issues among sessions that ran this (stage, model).
    let shipped = 0;
    let successfulSessions = 0;
    for (const s of b.sessions) {
      const perSession = sessionShipped.get(s) ?? 0;
      shipped += perSession;
      if (perSession > 0) successfulSessions++;
    }
    const pipeline_success_rate = b.sessions.size > 0 ? successfulSessions / b.sessions.size : 0;
    const cost_per_issue_shipped = shipped > 0 ? b.total_cost_usd / shipped : null;
    const tool_error_rate = b.tool_calls > 0 ? b.tool_errors / b.tool_calls : (b.runs > 0 ? b.tool_errors / b.runs : 0);

    cells.push({
      stage: b.stage,
      model: b.model,
      endpoint: b.endpoint,
      endpoint_type: b.endpoint_type,
      profile: b.profile,
      runs: b.runs,
      tokens_in: b.tokens_in,
      tokens_out: b.tokens_out,
      total_cost_usd: Math.round(b.total_cost_usd * 10000) / 10000,
      pipeline_success_rate: Math.round(pipeline_success_rate * 1000) / 1000,
      cost_per_issue_shipped: cost_per_issue_shipped != null ? Math.round(cost_per_issue_shipped * 10000) / 10000 : null,
      median_wall_time_s: Math.round(median(b.wall_times) * 1000) / 1000,
      tool_error_rate: Math.round(tool_error_rate * 10000) / 10000,
    });
  }

  // Pick per-stage baseline: the cell with the highest total_cost_usd
  // (treats frontier models as the reference point). Stable for ties: first seen wins.
  const baselineByStage = new Map<string, RoutingCell>();
  for (const cell of cells) {
    const current = baselineByStage.get(cell.stage);
    if (!current || cell.total_cost_usd > current.total_cost_usd) {
      baselineByStage.set(cell.stage, cell);
    }
  }

  for (const cell of cells) {
    const b = baselineByStage.get(cell.stage);
    if (!b || b === cell) {
      cell.delta_cost_per_issue_shipped_vs_baseline = null;
      cell.delta_median_wall_time_s_vs_baseline = null;
      cell.delta_tool_error_rate_vs_baseline = null;
      cell.delta_pipeline_success_rate_vs_baseline = null;
      continue;
    }
    cell.delta_cost_per_issue_shipped_vs_baseline =
      cell.cost_per_issue_shipped != null && b.cost_per_issue_shipped != null
        ? Math.round((cell.cost_per_issue_shipped - b.cost_per_issue_shipped) * 10000) / 10000
        : null;
    cell.delta_median_wall_time_s_vs_baseline =
      Math.round((cell.median_wall_time_s - b.median_wall_time_s) * 1000) / 1000;
    cell.delta_tool_error_rate_vs_baseline =
      Math.round((cell.tool_error_rate - b.tool_error_rate) * 10000) / 10000;
    cell.delta_pipeline_success_rate_vs_baseline =
      Math.round((cell.pipeline_success_rate - b.pipeline_success_rate) * 1000) / 1000;
  }

  cells.sort((a, b) => (a.stage.localeCompare(b.stage) || a.model.localeCompare(b.model)));

  return {
    cells,
    total_sessions: sessionsSeen.size,
    total_stages: totalStages,
    total_issues_shipped: totalIssuesShipped,
    total_cost_usd: Math.round(totalCost * 10000) / 10000,
    filters: {
      profile: opts.profile,
      since_ms: opts.sinceMs,
      baseline,
    },
  };
}

/**
 * Trace directory names stored on disk include a replaced slash (e.g.
 * `session-20260401-120000`). Session manifests reference the original
 * `session/20260401-120000` form. This helper mirrors `traces.ts:runDir`.
 */
function deriveSessionName(dirName: string): string {
  if (dirName.startsWith('session-')) {
    return dirName.replace(/^session-/, 'session/');
  }
  return dirName;
}

/**
 * Format an aggregation as a human-readable table or JSON string.
 */
export function formatRoutingReport(agg: RoutingAggregation, opts: { json?: boolean } = {}): string {
  if (opts.json) {
    return JSON.stringify(agg, null, 2);
  }

  if (agg.cells.length === 0) {
    return 'No per-stage telemetry recorded yet. Run alpha-loop with `routing:` configured to populate stages.jsonl.';
  }

  const lines: string[] = [];
  lines.push(`Routing report — ${agg.total_sessions} session(s), ${agg.total_stages} stage invocation(s), ${agg.total_issues_shipped} shipped`);
  if (agg.filters.profile) lines.push(`  Profile: ${agg.filters.profile}`);
  if (agg.filters.since_ms) lines.push(`  Since: ${new Date(agg.filters.since_ms).toISOString()}`);
  lines.push(`  Baseline: ${agg.filters.baseline} (highest-cost cell per stage)`);
  lines.push('');

  const header = ['stage', 'model', 'runs', 'tok_in', 'tok_out', 'cost_usd', 'cost/issue', 'wall_s', 'err_rate', 'Δcost/issue'];
  lines.push(header.join('\t'));
  for (const c of agg.cells) {
    const costPerIssue = c.cost_per_issue_shipped != null ? `$${c.cost_per_issue_shipped.toFixed(4)}` : 'n/a';
    const delta = c.delta_cost_per_issue_shipped_vs_baseline;
    const deltaStr = delta == null ? '—' : (delta >= 0 ? `+$${delta.toFixed(4)}` : `-$${Math.abs(delta).toFixed(4)}`);
    lines.push([
      c.stage,
      c.model,
      String(c.runs),
      String(c.tokens_in),
      String(c.tokens_out),
      `$${c.total_cost_usd.toFixed(4)}`,
      costPerIssue,
      c.median_wall_time_s.toFixed(2),
      c.tool_error_rate.toFixed(4),
      deltaStr,
    ].join('\t'));
  }
  lines.push('');
  lines.push(`Total cost: $${agg.total_cost_usd.toFixed(4)}`);
  return lines.join('\n');
}

/**
 * Parse a duration string like "30d", "12h", "45m", "90s" into milliseconds.
 * Returns undefined when the input is empty or unparseable.
 */
export function parseDuration(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const match = /^(\d+)([smhd])$/.exec(input.trim());
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}
