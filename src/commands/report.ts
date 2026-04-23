/**
 * `alpha-loop report routing` — aggregate per-stage telemetry across sessions.
 *
 * Scans `.alpha-loop/traces/<session>/stages.jsonl` and the session manifests
 * in `.alpha-loop/learnings/` to compute per (stage, model) cell metrics
 * (pipeline_success_rate, cost_per_issue_shipped, median_wall_time_s,
 * tool_error_rate) plus delta columns vs the highest-cost (frontier) baseline
 * per stage.
 */
import {
  aggregateRouting,
  formatRoutingReport,
  parseDuration,
  readAllStageTelemetry,
  readSessionManifests,
} from '../lib/telemetry.js';

export type ReportRoutingOptions = {
  profile?: string;
  since?: string;
  json?: boolean;
  projectDir?: string;
};

export function reportRoutingCommand(options: ReportRoutingOptions = {}): void {
  const projectDir = options.projectDir ?? process.cwd();
  const items = readAllStageTelemetry(projectDir);
  const manifests = readSessionManifests(projectDir);

  const sinceMs = options.since
    ? (() => {
        const dur = parseDuration(options.since);
        return dur ? Date.now() - dur : undefined;
      })()
    : undefined;

  const agg = aggregateRouting(items, manifests, {
    profile: options.profile,
    sinceMs,
  });

  console.log(formatRoutingReport(agg, { json: options.json }));
}
