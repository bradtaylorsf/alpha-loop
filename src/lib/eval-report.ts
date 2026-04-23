/**
 * eval-report — render matrix results as Markdown or CSV.
 *
 * The markdown form is what's posted to the tracking epic by the nightly
 * workflow. The CSV form is what downstream spreadsheets / Grafana /
 * analytic scripts consume.
 */
import type { MatrixResult } from './eval-matrix.js';

/** Render a matrix result as Markdown suitable for a GitHub comment. */
export function renderMatrixMarkdown(result: MatrixResult, title?: string): string {
  const lines: string[] = [];
  const heading = title ?? `# Routing regression — ${new Date().toISOString().slice(0, 10)}`;
  lines.push(heading);
  lines.push('');
  lines.push(`Baseline: \`${result.baseline}\` · ${result.cases.length} case(s) · ${result.profiles.length} profile(s)`);
  lines.push('');

  // Per-profile summary table
  lines.push('## Per-profile summary');
  lines.push('');
  lines.push('| Profile | Pass | Pass rate | Total cost | Mean wall time | Mean tool-error rate |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const t of result.totals) {
    lines.push(
      `| \`${t.profile}\` | ${t.passCount}/${t.caseCount} | ${percent(t.passRate)} | ${usd(t.totalCostUsd)} | ${seconds(t.meanWallTimeS)} | ${percent(t.meanToolErrorRate)} |`,
    );
  }
  lines.push('');

  // Per-case grid
  lines.push('## Per-case results');
  lines.push('');
  const header = ['Case', ...result.profiles];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const c of result.cases) {
    const cells = [c.caseId];
    for (const profile of result.profiles) {
      const entry = c.perProfile[profile];
      cells.push(formatCaseCell(entry));
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');

  // Deltas vs baseline
  lines.push(`## Deltas vs \`${result.baseline}\``);
  lines.push('');
  lines.push('| Profile | Δ pipeline_success | Δ cost_per_issue |');
  lines.push('| --- | --- | --- |');
  for (const t of result.totals) {
    const d = result.deltas[t.profile];
    if (!d) continue;
    lines.push(`| \`${t.profile}\` | ${deltaPct(d.pipelineSuccessDelta)} | ${deltaUsd(d.costPerIssueDelta)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

/** Render a matrix result as CSV. One row per (case, profile). */
export function renderMatrixCsv(result: MatrixResult): string {
  const header = [
    'case_id',
    'profile',
    'passed',
    'partial_credit',
    'cost_usd',
    'wall_time_s',
    'tool_error_rate',
    'diff_similarity',
    'errored',
  ];
  const rows: string[] = [header.join(',')];
  for (const c of result.cases) {
    for (const profile of result.profiles) {
      const entry = c.perProfile[profile];
      rows.push([
        csvField(c.caseId),
        csvField(profile),
        entry.passed ? '1' : '0',
        entry.partialCredit.toFixed(3),
        entry.costUsd.toFixed(4),
        entry.wallTimeS.toFixed(1),
        entry.toolErrorRate.toFixed(3),
        entry.diffSimilarity === null ? '' : entry.diffSimilarity.toFixed(3),
        entry.errored ? '1' : '0',
      ].join(','));
    }
  }
  return rows.join('\n') + '\n';
}

/** Format a single per-case cell in the markdown grid. */
function formatCaseCell(entry: { passed: boolean; errored: boolean; costUsd: number } | undefined): string {
  if (!entry) return '—';
  if (entry.errored) return 'ERR';
  const tag = entry.passed ? 'PASS' : 'FAIL';
  return `${tag} (${usd(entry.costUsd)})`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function seconds(value: number): string {
  return `${value.toFixed(0)}s`;
}

function deltaPct(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)} pp`;
}

function deltaUsd(value: number): string {
  if (value >= 0) return `+$${value.toFixed(2)}`;
  return `-$${Math.abs(value).toFixed(2)}`;
}

/** Escape a CSV field if it contains commas, quotes, or newlines. */
function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
