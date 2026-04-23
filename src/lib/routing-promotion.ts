/**
 * Routing promotion/demotion math — pure-functional rules for deciding when a
 * pipeline stage should be moved from a frontier model to a local model
 * (promotion) or reverted back to a frontier fallback (demotion).
 *
 * Thresholds match issue #163:
 *  - Promotion requires >=30 runs, pipeline_success_delta >= -0.03,
 *    cost_per_issue_delta <= -0.40 (>=40% savings), tool_error_rate < 0.02.
 *  - Demotion fires when rolling 10-issue tool_error_rate > 0.08 OR
 *    pipeline_success drops >10pts vs trailing 30-issue baseline.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { RoutingCell } from './telemetry.js';
import type { TurnRecord } from './escalation.js';
import type { RoutingEndpointType, RoutingStageConfig } from './config.js';

/** Promotion thresholds (exported for tests + documentation). */
export const PROMOTION_MIN_RUNS = 30;
export const PROMOTION_SUCCESS_DELTA_FLOOR = -0.03;
export const PROMOTION_COST_SAVINGS_MIN = 0.40;
export const PROMOTION_TOOL_ERROR_CEILING = 0.02;

/** Demotion thresholds. */
export const DEMOTION_WINDOW = 10;
export const DEMOTION_TOOL_ERROR_CEILING = 0.08;
export const DEMOTION_BASELINE_WINDOW = 30;
export const DEMOTION_SUCCESS_DROP_PTS = 0.10;

/** Endpoint protocols considered "local" for promotion purposes. */
const LOCAL_ENDPOINT_TYPES: readonly RoutingEndpointType[] = ['anthropic_compat', 'openai_compat'];

/** Supporting metrics captured alongside a promotion proposal. */
export type PromotionMetrics = {
  runs: number;
  pipelineSuccessDelta: number;
  costPerIssueDelta: number;
  costPerIssueSavingsPct: number;
  toolErrorRate: number;
  frontierCostPerIssue: number | null;
  candidateCostPerIssue: number | null;
};

/** A proposed stage-level promotion from a frontier cell to a local cell. */
export type PromotionProposal = {
  stage: string;
  from: { model: string; endpoint?: string };
  to: { model: string; endpoint?: string };
  metrics: PromotionMetrics;
};

/** Demotion decision — whether to fire and why. */
export type DemotionDecision = {
  fire: boolean;
  reason?: 'tool_error_rate' | 'pipeline_success_drop' | 'manual';
  stage: string;
  metrics?: {
    rollingToolErrorRate?: number;
    rollingWindow?: number;
    baselineSuccessRate?: number;
    currentSuccessRate?: number;
    successDrop?: number;
  };
};

/** Input for demotion evaluation: a per-stage slice of recent turn records. */
export type StageTurnHistory = {
  stage: string;
  /** Turns ordered oldest→newest. */
  turns: TurnRecord[];
};

/** Options for `evaluatePromotion`. Defaults match issue #163. */
export type EvaluatePromotionOptions = {
  minRuns?: number;
  successDeltaFloor?: number;
  costSavingsMin?: number;
  toolErrorCeiling?: number;
};

/**
 * For each stage with a frontier + local cell, return a PromotionProposal
 * when the local cell meets all thresholds. Stages with no eligible
 * frontier/local pair are simply skipped.
 */
export function evaluatePromotion(
  cells: RoutingCell[],
  opts: EvaluatePromotionOptions = {},
): PromotionProposal[] {
  const minRuns = opts.minRuns ?? PROMOTION_MIN_RUNS;
  const successDeltaFloor = opts.successDeltaFloor ?? PROMOTION_SUCCESS_DELTA_FLOOR;
  const costSavingsMin = opts.costSavingsMin ?? PROMOTION_COST_SAVINGS_MIN;
  const toolErrorCeiling = opts.toolErrorCeiling ?? PROMOTION_TOOL_ERROR_CEILING;

  const byStage = new Map<string, RoutingCell[]>();
  for (const cell of cells) {
    const list = byStage.get(cell.stage);
    if (list) list.push(cell);
    else byStage.set(cell.stage, [cell]);
  }

  const proposals: PromotionProposal[] = [];
  for (const [stage, stageCells] of byStage) {
    const frontier = pickFrontier(stageCells);
    if (!frontier) continue;

    const candidates = stageCells.filter((c) => c !== frontier && isLocalCell(c));
    for (const candidate of candidates) {
      if (candidate.runs < minRuns) continue;

      // Require a successful baseline to compute meaningful deltas.
      if (
        frontier.cost_per_issue_shipped == null ||
        candidate.cost_per_issue_shipped == null ||
        frontier.cost_per_issue_shipped <= 0
      ) {
        continue;
      }

      // Round on compute so float-precision noise doesn't knock edge cases
      // off the inclusive boundaries defined in the spec.
      const pipelineSuccessDelta = round3(candidate.pipeline_success_rate - frontier.pipeline_success_rate);
      const costPerIssueDelta = round4(candidate.cost_per_issue_shipped - frontier.cost_per_issue_shipped);
      const costSavingsPct = round3(-costPerIssueDelta / frontier.cost_per_issue_shipped);

      // Tie on cost (no savings) blocks — costSavingsMin is strictly required.
      if (pipelineSuccessDelta < successDeltaFloor) continue;
      if (costSavingsPct < costSavingsMin) continue;
      if (candidate.tool_error_rate >= toolErrorCeiling) continue;

      proposals.push({
        stage,
        from: { model: frontier.model, endpoint: frontier.endpoint },
        to: { model: candidate.model, endpoint: candidate.endpoint },
        metrics: {
          runs: candidate.runs,
          pipelineSuccessDelta,
          costPerIssueDelta,
          costPerIssueSavingsPct: costSavingsPct,
          toolErrorRate: candidate.tool_error_rate,
          frontierCostPerIssue: frontier.cost_per_issue_shipped,
          candidateCostPerIssue: candidate.cost_per_issue_shipped,
        },
      });
    }
  }
  return proposals;
}

/**
 * Decide whether the stage should be demoted based on recent turn records and
 * the trailing-30 success baseline computed from aggregated cells.
 *
 * `recentTurns` is oldest→newest; only the last `DEMOTION_WINDOW` turns are
 * inspected for the tool-error guardrail, and the last
 * `DEMOTION_BASELINE_WINDOW` turns (excluding the most recent 10) provide the
 * success baseline.
 */
export function evaluateDemotion(
  recentTurns: TurnRecord[],
  cells: RoutingCell[],
  stage: string,
): DemotionDecision {
  const windowed = recentTurns.slice(-DEMOTION_WINDOW);

  // Short windows never trigger — we don't have enough signal yet.
  if (windowed.length >= DEMOTION_WINDOW) {
    const errs = windowed.filter((t) => t.errored).length;
    const rate = errs / windowed.length;
    if (rate > DEMOTION_TOOL_ERROR_CEILING) {
      return {
        fire: true,
        reason: 'tool_error_rate',
        stage,
        metrics: {
          rollingToolErrorRate: round4(rate),
          rollingWindow: windowed.length,
        },
      };
    }
  }

  // Pipeline-success drop check — uses trailing 30-run baseline from the
  // aggregated cells for the stage. Prefer the highest-run cell as the
  // reference point for the baseline.
  const stageCells = cells.filter((c) => c.stage === stage && c.runs > 0);
  if (stageCells.length > 0) {
    const trailing = [...stageCells].sort((a, b) => b.runs - a.runs)[0];
    if (trailing.runs >= DEMOTION_BASELINE_WINDOW) {
      // Current success = rate over the rolling window. Derived from turn
      // records (a turn is "successful" when not errored, matching how
      // pipeline_success_rate aggregates at the session level).
      if (windowed.length >= DEMOTION_WINDOW) {
        const currentSuccess = windowed.filter((t) => !t.errored).length / windowed.length;
        const drop = trailing.pipeline_success_rate - currentSuccess;
        if (drop > DEMOTION_SUCCESS_DROP_PTS) {
          return {
            fire: true,
            reason: 'pipeline_success_drop',
            stage,
            metrics: {
              baselineSuccessRate: trailing.pipeline_success_rate,
              currentSuccessRate: round3(currentSuccess),
              successDrop: round3(drop),
              rollingWindow: windowed.length,
            },
          };
        }
      }
    }
  }

  return { fire: false, stage };
}

/**
 * Apply a set of promotion proposals to a YAML document, patching the
 * `routing.stages.<name>` block for each. Returns the new YAML string plus a
 * unified-style diff that's easy to drop into a PR body.
 */
export function applyRoutingDiff(
  yaml: string,
  proposals: PromotionProposal[],
): { yaml: string; diff: string } {
  if (proposals.length === 0) return { yaml, diff: '' };

  const parsed = (parseYaml(yaml) as Record<string, unknown> | null) ?? {};
  const routing = (parsed.routing && typeof parsed.routing === 'object'
    ? parsed.routing
    : {}) as Record<string, unknown>;
  const stages = (routing.stages && typeof routing.stages === 'object'
    ? routing.stages
    : {}) as Record<string, unknown>;

  const diffLines: string[] = [];
  for (const p of proposals) {
    const before = stages[p.stage] as Record<string, unknown> | undefined;
    const beforeFrag = before
      ? stringifyYaml({ [p.stage]: before }).trimEnd()
      : `${p.stage}: (unset)`;
    const newStage: Record<string, unknown> = { model: p.to.model };
    if (p.to.endpoint) newStage.endpoint = p.to.endpoint;
    stages[p.stage] = newStage;
    const afterFrag = stringifyYaml({ [p.stage]: newStage }).trimEnd();

    diffLines.push(`# stage: ${p.stage}`);
    for (const line of beforeFrag.split('\n')) diffLines.push(`- ${line}`);
    for (const line of afterFrag.split('\n')) diffLines.push(`+ ${line}`);
    diffLines.push('');
  }
  routing.stages = stages;
  parsed.routing = routing;

  const newYaml = stringifyYaml(parsed);
  return { yaml: newYaml, diff: diffLines.join('\n').trimEnd() };
}

/**
 * Build the YAML patch that reverts a stage to the routing.fallback.escalate_to
 * target. Shared by manual demotions and automated guardrail trips.
 */
export function buildDemotionYaml(
  yaml: string,
  stage: string,
  fallback: RoutingStageConfig,
): { yaml: string; diff: string } {
  const proposal: PromotionProposal = {
    stage,
    from: { model: 'current', endpoint: undefined },
    to: { model: fallback.model, endpoint: fallback.endpoint },
    metrics: {
      runs: 0,
      pipelineSuccessDelta: 0,
      costPerIssueDelta: 0,
      costPerIssueSavingsPct: 0,
      toolErrorRate: 0,
      frontierCostPerIssue: null,
      candidateCostPerIssue: null,
    },
  };
  return applyRoutingDiff(yaml, [proposal]);
}

function pickFrontier(cells: RoutingCell[]): RoutingCell | null {
  // Highest total cost = frontier, mirroring telemetry.aggregateRouting's
  // baseline choice. Break ties by higher cost_per_issue so we don't promote
  // against a volume-heavy local cell that happens to lead on total spend.
  const eligible = cells.filter((c) => !isLocalCell(c));
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => {
    if (b.total_cost_usd !== a.total_cost_usd) return b.total_cost_usd - a.total_cost_usd;
    const ac = a.cost_per_issue_shipped ?? 0;
    const bc = b.cost_per_issue_shipped ?? 0;
    return bc - ac;
  })[0];
}

function isLocalCell(cell: RoutingCell): boolean {
  return cell.endpoint_type != null && LOCAL_ENDPOINT_TYPES.includes(cell.endpoint_type);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
