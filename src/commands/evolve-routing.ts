/**
 * `alpha-loop evolve routing` — promote/demote routing stages as draft PRs.
 *
 * Reads recent per-stage telemetry and aggregates it into routing cells
 * (same code path as `alpha-loop report routing`). When a local cell beats
 * the frontier on thresholds defined in issue #163, a draft PR is opened
 * with the `.alpha-loop.yaml` diff + supporting metrics + a one-click
 * rollback snippet. Manual demotions (`--demote <stage>`) bypass the eval
 * freshness gate and produce the same draft-PR flow.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../lib/logger.js';
import { loadConfig, getFallbackPolicy } from '../lib/config.js';
import { exec, formatTimestamp } from '../lib/shell.js';
import { createPR } from '../lib/github.js';
import {
  aggregateRouting,
  readAllStageTelemetry,
  readSessionManifests,
} from '../lib/telemetry.js';
import {
  evaluatePromotion,
  applyRoutingDiff,
  buildDemotionYaml,
} from '../lib/routing-promotion.js';
import type { PromotionProposal } from '../lib/routing-promotion.js';
import { appendRoutingHistory, latestMatrixRunTime, MATRIX_FRESHNESS_WINDOW_MS } from '../lib/routing-history.js';
import type { RoutingHistoryEntry } from '../lib/routing-history.js';
import type { Config } from '../lib/config.js';

export type EvolveRoutingOptions = {
  dryRun?: boolean;
  demote?: string;
  projectDir?: string;
  baseBranch?: string;
  /** Injectable for tests. */
  createPR?: typeof createPR;
  /** Injectable for tests. */
  exec?: typeof exec;
  /** Injectable for tests — epoch ms. */
  nowMs?: number;
};

/** Result returned so callers (tests, CLI) can assert on the outcome. */
export type EvolveRoutingResult = {
  status: 'promoted' | 'demoted' | 'no-proposals' | 'stale-matrix' | 'no-config' | 'dry-run' | 'error';
  proposals?: PromotionProposal[];
  branch?: string;
  prUrl?: string;
  message?: string;
};

const DEFAULT_CONFIG_PATH = '.alpha-loop.yaml';

export async function evolveRoutingCommand(
  options: EvolveRoutingOptions = {},
): Promise<EvolveRoutingResult> {
  const projectDir = options.projectDir ?? process.cwd();
  const configPath = join(projectDir, DEFAULT_CONFIG_PATH);
  const config = loadConfig();
  const baseBranch = options.baseBranch ?? config.baseBranch;
  const nowMs = options.nowMs ?? Date.now();
  const prCreator = options.createPR ?? createPR;
  const shellExec = options.exec ?? exec;

  if (!existsSync(configPath)) {
    log.error(`No ${DEFAULT_CONFIG_PATH} found at ${configPath}`);
    return { status: 'no-config', message: 'missing .alpha-loop.yaml' };
  }

  // Manual demotion short-circuits before the promotion path. No matrix
  // freshness gate — demotion is always safe to trigger by hand.
  if (options.demote) {
    return demoteManually(options.demote, {
      projectDir,
      configPath,
      config,
      baseBranch,
      dryRun: options.dryRun,
      prCreator,
      shellExec,
    });
  }

  // Freshness gate: promotion must not fire without a recent matrix run.
  const latestMs = latestMatrixRunTime(projectDir);
  if (latestMs == null || nowMs - latestMs > MATRIX_FRESHNESS_WINDOW_MS) {
    const age = latestMs == null ? 'never run' : `${Math.round((nowMs - latestMs) / (24 * 60 * 60 * 1000))} days ago`;
    log.error(`Matrix eval is stale (last run: ${age}). Run \`alpha-loop eval --matrix --execute\` within the last 7 days first.`);
    return { status: 'stale-matrix', message: `matrix eval last run: ${age}` };
  }

  // Aggregate cells from the same telemetry path that `alpha-loop report routing` uses.
  const items = readAllStageTelemetry(projectDir);
  const manifests = readSessionManifests(projectDir);
  const agg = aggregateRouting(items, manifests);

  const proposals = evaluatePromotion(agg.cells);
  if (proposals.length === 0) {
    log.info('No promotions meet the thresholds (>=30 runs, cost savings >=40%, success delta >= -3%, tool error < 2%).');
    return { status: 'no-proposals', proposals: [] };
  }

  log.step(`Proposing ${proposals.length} promotion(s):`);
  for (const p of proposals) {
    console.log(`  - ${p.stage}: ${p.from.model} → ${p.to.model}  (savings ${(p.metrics.costPerIssueSavingsPct * 100).toFixed(1)}%, Δsuccess ${(p.metrics.pipelineSuccessDelta * 100).toFixed(1)}pp, err ${(p.metrics.toolErrorRate * 100).toFixed(2)}%)`);
  }

  const yamlBefore = readFileSync(configPath, 'utf-8');
  const { yaml: yamlAfter, diff } = applyRoutingDiff(yamlBefore, proposals);

  if (options.dryRun) {
    log.dry('Would write new .alpha-loop.yaml:');
    console.log(diff);
    log.dry('Would open draft PR on branch routing/promote-<ts>.');
    return { status: 'dry-run', proposals };
  }

  const timestamp = formatTimestamp(new Date(nowMs));
  const branch = `routing/promote-${timestamp}`;

  try {
    writeFileSync(configPath, yamlAfter, 'utf-8');

    const branchRes = shellExec(`git checkout -b "${branch}"`, { cwd: projectDir });
    if (branchRes.exitCode !== 0) {
      throw new Error(`Failed to create branch ${branch}: ${branchRes.stderr || branchRes.stdout}`);
    }

    const addRes = shellExec(`git add "${DEFAULT_CONFIG_PATH}"`, { cwd: projectDir });
    if (addRes.exitCode !== 0) {
      throw new Error(`Failed to stage config: ${addRes.stderr}`);
    }

    const commitMsg = `evolve(routing): promote ${proposals.map((p) => p.stage).join(', ')}`;
    const commitRes = shellExec(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: projectDir });
    if (commitRes.exitCode !== 0) {
      throw new Error(`Failed to commit: ${commitRes.stderr || commitRes.stdout}`);
    }

    const commitSha = shellExec('git rev-parse HEAD', { cwd: projectDir }).stdout.trim().slice(0, 12);

    const prBody = renderPromotionPrBody(proposals, yamlBefore, diff, commitSha);

    if (!config.repo) {
      log.warn('No repo configured — skipping PR creation. Commit was made locally.');
      return { status: 'promoted', branch, proposals, message: 'no repo configured; branch created locally' };
    }

    const prUrl = prCreator({
      repo: config.repo,
      base: baseBranch,
      head: branch,
      title: `routing: promote ${proposals.map((p) => p.stage).join(', ')}`,
      body: prBody,
      cwd: projectDir,
    });
    log.success(`Draft PR opened: ${prUrl}`);

    for (const p of proposals) {
      const entry: RoutingHistoryEntry = {
        timestamp,
        action: 'promote',
        stage: p.stage,
        from: p.from,
        to: p.to,
        reason: `cost savings ${(p.metrics.costPerIssueSavingsPct * 100).toFixed(1)}%, pipeline_success_delta ${(p.metrics.pipelineSuccessDelta * 100).toFixed(1)}pp`,
        metrics: {
          runs: p.metrics.runs,
          pipeline_success_delta: p.metrics.pipelineSuccessDelta,
          cost_per_issue_delta: p.metrics.costPerIssueDelta,
          tool_error_rate: p.metrics.toolErrorRate,
        },
        prUrl,
      };
      appendRoutingHistory(entry, projectDir);
    }

    return { status: 'promoted', proposals, branch, prUrl };
  } catch (err) {
    // Best-effort rollback of the yaml write so the worktree isn't left dirty.
    try {
      writeFileSync(configPath, yamlBefore, 'utf-8');
    } catch {
      /* ignore */
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Promotion failed: ${msg}`);
    return { status: 'error', message: msg };
  }
}

type DemoteCtx = {
  projectDir: string;
  configPath: string;
  config: Config;
  baseBranch: string;
  dryRun?: boolean;
  prCreator: typeof createPR;
  shellExec: typeof exec;
};

async function demoteManually(stage: string, ctx: DemoteCtx): Promise<EvolveRoutingResult> {
  const policy = getFallbackPolicy(ctx.config);
  if (!policy?.escalate_to) {
    log.error(`No routing.fallback.escalate_to configured — cannot demote stage ${stage}.`);
    return { status: 'error', message: 'missing routing.fallback.escalate_to' };
  }

  const yamlBefore = readFileSync(ctx.configPath, 'utf-8');
  const stages = (ctx.config.routing?.stages ?? {}) as Record<string, { model: string; endpoint: string } | undefined>;
  const currentStage = stages[stage];
  const { yaml: yamlAfter, diff } = buildDemotionYaml(yamlBefore, stage, policy.escalate_to);

  log.step(`Manual demotion: ${stage} → ${policy.escalate_to.model} @ ${policy.escalate_to.endpoint}`);

  if (ctx.dryRun) {
    log.dry('Would write new .alpha-loop.yaml:');
    console.log(diff);
    return {
      status: 'dry-run',
      proposals: [
        {
          stage,
          from: currentStage ? { model: currentStage.model, endpoint: currentStage.endpoint } : { model: 'current' },
          to: { model: policy.escalate_to.model, endpoint: policy.escalate_to.endpoint },
          metrics: {
            runs: 0,
            pipelineSuccessDelta: 0,
            costPerIssueDelta: 0,
            costPerIssueSavingsPct: 0,
            toolErrorRate: 0,
            frontierCostPerIssue: null,
            candidateCostPerIssue: null,
          },
        },
      ],
    };
  }

  const timestamp = formatTimestamp(new Date());
  const branch = `routing/demote-${stage}-${timestamp}`;

  try {
    writeFileSync(ctx.configPath, yamlAfter, 'utf-8');

    const branchRes = ctx.shellExec(`git checkout -b "${branch}"`, { cwd: ctx.projectDir });
    if (branchRes.exitCode !== 0) {
      throw new Error(`Failed to create branch: ${branchRes.stderr || branchRes.stdout}`);
    }

    const addRes = ctx.shellExec(`git add "${DEFAULT_CONFIG_PATH}"`, { cwd: ctx.projectDir });
    if (addRes.exitCode !== 0) {
      throw new Error(`Failed to stage: ${addRes.stderr}`);
    }

    const commitMsg = `evolve(routing): manual demotion of ${stage}`;
    const commitRes = ctx.shellExec(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd: ctx.projectDir });
    if (commitRes.exitCode !== 0) {
      throw new Error(`Failed to commit: ${commitRes.stderr || commitRes.stdout}`);
    }

    const commitSha = ctx.shellExec('git rev-parse HEAD', { cwd: ctx.projectDir }).stdout.trim().slice(0, 12);

    const prBody = renderDemotionPrBody(stage, currentStage, policy.escalate_to, diff, commitSha, 'manual');

    let prUrl: string | undefined;
    if (ctx.config.repo) {
      prUrl = ctx.prCreator({
        repo: ctx.config.repo,
        base: ctx.baseBranch,
        head: branch,
        title: `routing: demote ${stage}`,
        body: prBody,
        cwd: ctx.projectDir,
      });
      log.success(`Draft PR opened: ${prUrl}`);
    } else {
      log.warn('No repo configured — skipping PR creation.');
    }

    const entry: RoutingHistoryEntry = {
      timestamp,
      action: 'manual_demote',
      stage,
      from: currentStage ? { model: currentStage.model, endpoint: currentStage.endpoint } : { model: 'unknown' },
      to: { model: policy.escalate_to.model, endpoint: policy.escalate_to.endpoint },
      reason: 'manual demotion via --demote flag',
      prUrl,
    };
    appendRoutingHistory(entry, ctx.projectDir);

    return {
      status: 'demoted',
      branch,
      prUrl,
      proposals: [
        {
          stage,
          from: currentStage ? { model: currentStage.model, endpoint: currentStage.endpoint } : { model: 'current' },
          to: { model: policy.escalate_to.model, endpoint: policy.escalate_to.endpoint },
          metrics: {
            runs: 0,
            pipelineSuccessDelta: 0,
            costPerIssueDelta: 0,
            costPerIssueSavingsPct: 0,
            toolErrorRate: 0,
            frontierCostPerIssue: null,
            candidateCostPerIssue: null,
          },
        },
      ],
    };
  } catch (err) {
    try {
      writeFileSync(ctx.configPath, yamlBefore, 'utf-8');
    } catch {
      /* ignore */
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Demotion failed: ${msg}`);
    return { status: 'error', message: msg };
  }
}

function renderPromotionPrBody(
  proposals: PromotionProposal[],
  yamlBefore: string,
  diff: string,
  commitSha: string,
): string {
  const lines: string[] = [];
  lines.push('## Routing Promotion');
  lines.push('');
  lines.push('This PR was generated automatically by `alpha-loop evolve routing` after the matrix eval crossed the promotion thresholds.');
  lines.push('');
  lines.push('**Thresholds (issue #163):**');
  lines.push('- >= 30 runs');
  lines.push('- pipeline_success_delta >= -3%');
  lines.push('- cost_per_issue_delta <= -40% (>=40% savings)');
  lines.push('- tool_error_rate < 2%');
  lines.push('');
  lines.push('## Proposed Changes');
  lines.push('');
  lines.push('| Stage | From | To | Runs | ΔSuccess | Savings | Err rate |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: |');
  for (const p of proposals) {
    lines.push(
      `| \`${p.stage}\` | \`${p.from.model}\` | \`${p.to.model}\` | ${p.metrics.runs} | ${(p.metrics.pipelineSuccessDelta * 100).toFixed(1)}pp | ${(p.metrics.costPerIssueSavingsPct * 100).toFixed(1)}% | ${(p.metrics.toolErrorRate * 100).toFixed(2)}% |`,
    );
  }
  lines.push('');
  lines.push('## Config Diff');
  lines.push('');
  lines.push('```yaml');
  lines.push(diff || '(no diff computed)');
  lines.push('```');
  lines.push('');
  lines.push('## Rollback');
  lines.push('');
  lines.push('To revert this change:');
  lines.push('');
  lines.push('```bash');
  lines.push(`git revert ${commitSha}`);
  lines.push('```');
  lines.push('');
  lines.push('Or restore the previous `.alpha-loop.yaml` snippet manually:');
  lines.push('');
  lines.push('```yaml');
  lines.push(extractRoutingStages(yamlBefore));
  lines.push('```');
  return lines.join('\n');
}

function renderDemotionPrBody(
  stage: string,
  current: { model: string; endpoint: string } | undefined,
  fallback: { model: string; endpoint: string },
  diff: string,
  commitSha: string,
  kind: 'manual' | 'auto',
): string {
  const lines: string[] = [];
  lines.push('## Routing Demotion');
  lines.push('');
  lines.push(`This ${kind === 'manual' ? 'manual' : 'automatic'} demotion reverts stage \`${stage}\` to the configured fallback.`);
  lines.push('');
  lines.push(`- **Stage:** \`${stage}\``);
  lines.push(`- **From:** ${current ? `\`${current.model}\` @ \`${current.endpoint}\`` : '(unset)'}`);
  lines.push(`- **To:** \`${fallback.model}\` @ \`${fallback.endpoint}\``);
  lines.push('');
  lines.push('## Config Diff');
  lines.push('');
  lines.push('```yaml');
  lines.push(diff);
  lines.push('```');
  lines.push('');
  lines.push('## Rollback');
  lines.push('');
  lines.push('```bash');
  lines.push(`git revert ${commitSha}`);
  lines.push('```');
  return lines.join('\n');
}

/** Extract just the `routing.stages:` block from the previous yaml for the PR body. */
function extractRoutingStages(yamlBefore: string): string {
  const match = yamlBefore.match(/^routing:[\s\S]*?(?=^\S|\Z)/m);
  return match ? match[0].trimEnd() : '(no routing block in previous config)';
}
