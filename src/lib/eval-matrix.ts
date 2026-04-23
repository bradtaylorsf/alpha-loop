/**
 * eval-matrix — run every case under multiple routing profiles and
 * aggregate a side-by-side comparison.
 *
 * Profiles are loaded from YAML and deep-merged into a base Config before
 * each profile's run. Pipeline costs, wall time, tool error rate, and a
 * diff-similarity signal are aggregated per-case per-profile. Deltas are
 * computed against a designated baseline profile (defaults to
 * `all-frontier`).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Config, PipelineConfig, PipelineStepName, StepConfig, RoutingConfig } from './config.js';
import { loadConfig } from './config.js';
import type { EvalSuiteResult, EvalResult } from './eval.js';
import type { EvalCaseWithChecks, EvalRunOptions } from './eval-runner.js';
import { runEvalSuite } from './eval-runner.js';

/** Options the CLI accepts for the matrix run. */
export type MatrixOptions = {
  /** Paths / names of profile YAMLs. Names are resolved under .alpha-loop/evals/profiles/. */
  profiles: string[];
  /** Baseline profile name or path to use for delta computations. */
  baseline?: string;
  /** Output directory for markdown + CSV reports. */
  outDir?: string;
  /** Passed through to runEvalSuite (e.g. --verbose). */
  verbose?: boolean;
  /**
   * Skip actual pipeline execution; emit a structural report only.
   *
   * Why this exists: the current eval pipeline calls processIssue(), which
   * hits live GitHub (project board, labels, branches). A matrix run across
   * routing-regression cases would mutate real issues because the case IDs
   * ("001-…", "002-…") parse back to real issue numbers on the active repo.
   * Until proper fixture isolation lands (clean clone at source_pr's
   * base_sha, no GH mutations), dry-run is the safe default.
   */
  dryRun?: boolean;
};

/** Per-profile metrics for a single case. */
export type MatrixCaseEntry = {
  /** True if the case passed pipeline_success under this profile. */
  passed: boolean;
  partialCredit: number;
  costUsd: number;
  wallTimeS: number;
  toolErrorRate: number;
  /** Diff similarity vs golden.patch; null if not applicable / stub patch. */
  diffSimilarity: number | null;
  /** True when the run errored outright (crash, timeout). */
  errored: boolean;
  error?: string;
  /** True when the case was skipped because the matrix ran in dry-run mode. */
  skipped?: boolean;
};

/** Aggregated totals for one profile. */
export type MatrixProfileTotals = {
  profile: string;
  caseCount: number;
  passCount: number;
  passRate: number;
  totalCostUsd: number;
  meanWallTimeS: number;
  meanToolErrorRate: number;
};

/** The full matrix result returned by runMatrix. */
export type MatrixResult = {
  profiles: string[];
  baseline: string;
  cases: Array<{
    caseId: string;
    description: string;
    perProfile: Record<string, MatrixCaseEntry>;
  }>;
  totals: MatrixProfileTotals[];
  /** Per-profile deltas vs baseline: positive means "better than baseline". */
  deltas: Record<string, {
    pipelineSuccessDelta: number;
    costPerIssueDelta: number;
  }>;
  /** True when this report reflects a dry-run (no pipelines executed). */
  dryRun?: boolean;
};

/** Narrow Partial<Config> — only fields supported by profile YAMLs. */
export type ProfileOverrides = Partial<Pick<Config, 'agent' | 'model' | 'reviewModel' | 'pipeline' | 'routing'>>;

/**
 * Load a profile YAML and return the narrow override shape.
 * Accepts either a bare name ("hybrid-v1") or a full path.
 */
export function loadProfileOverrides(profileNameOrPath: string, projectDir: string = process.cwd()): ProfileOverrides {
  const path = resolveProfilePath(profileNameOrPath, projectDir);
  if (!existsSync(path)) {
    throw new Error(`Profile file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return {};

  const result: ProfileOverrides = {};
  if (typeof parsed.agent === 'string') result.agent = parsed.agent as Config['agent'];
  if (typeof parsed.model === 'string') result.model = parsed.model;
  if (typeof parsed.review_model === 'string') result.reviewModel = parsed.review_model;

  if (parsed.pipeline && typeof parsed.pipeline === 'object') {
    const pipelineRaw = parsed.pipeline as Record<string, unknown>;
    const pipeline: PipelineConfig = {};
    const validSteps: PipelineStepName[] = ['plan', 'implement', 'test_fix', 'review', 'verify', 'learn'];
    for (const step of validSteps) {
      const entry = pipelineRaw[step];
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        const stepCfg: StepConfig = {};
        if (typeof e.agent === 'string') stepCfg.agent = e.agent;
        if (typeof e.model === 'string') stepCfg.model = e.model;
        if (Object.keys(stepCfg).length > 0) pipeline[step] = stepCfg;
      }
    }
    if (Object.keys(pipeline).length > 0) result.pipeline = pipeline;
  }

  if (parsed.routing && typeof parsed.routing === 'object') {
    // Re-use loadConfig's routing parser by round-tripping through a fake
    // config. Keeps the validation logic single-sourced.
    const fake = loadConfig({ routing: parsed.routing as unknown as RoutingConfig });
    if (fake.routing) result.routing = fake.routing;
  }

  return result;
}

/** Resolve a bare profile name to its path, or pass a real path through. */
export function resolveProfilePath(nameOrPath: string, projectDir: string): string {
  if (nameOrPath.includes('/') || nameOrPath.endsWith('.yaml') || nameOrPath.endsWith('.yml')) {
    return nameOrPath;
  }
  return join(projectDir, '.alpha-loop', 'evals', 'profiles', `${nameOrPath}.yaml`);
}

/** Human-friendly profile name for reports — always just the base. */
export function profileDisplayName(nameOrPath: string): string {
  if (!nameOrPath.endsWith('.yaml') && !nameOrPath.endsWith('.yml') && !nameOrPath.includes('/')) {
    return nameOrPath;
  }
  return basename(nameOrPath, extname(nameOrPath));
}

/** Compose profile overrides onto a base config. Pipeline merges per-step. */
export function applyProfileToConfig(base: Config, overrides: ProfileOverrides): Config {
  const mergedPipeline: PipelineConfig = { ...base.pipeline };
  for (const [step, stepCfg] of Object.entries(overrides.pipeline ?? {}) as Array<[PipelineStepName, StepConfig]>) {
    mergedPipeline[step] = { ...(mergedPipeline[step] ?? {}), ...stepCfg };
  }
  return {
    ...base,
    ...(overrides.agent ? { agent: overrides.agent } : {}),
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.reviewModel ? { reviewModel: overrides.reviewModel } : {}),
    pipeline: mergedPipeline,
    ...(overrides.routing ? { routing: overrides.routing } : {}),
  };
}

/**
 * Compute a rough similarity score between a produced diff and the golden
 * patch. Line-set Jaccard over non-empty, non-header lines — cheap and
 * stable enough to flag drift, not meant to replace a proper diff compare.
 */
export function diffSimilarity(produced: string, golden: string): number {
  const extract = (s: string): Set<string> => {
    const lines = s.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.startsWith('diff --git'))
      .filter((l) => !l.startsWith('index '))
      .filter((l) => !l.startsWith('---') && !l.startsWith('+++'))
      .filter((l) => !l.startsWith('@@'))
      .filter((l) => !l.startsWith('#'));
    return new Set(lines);
  };
  const a = extract(produced);
  const b = extract(golden);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const line of a) if (b.has(line)) intersect++;
  const unionSize = a.size + b.size - intersect;
  return unionSize === 0 ? 1 : intersect / unionSize;
}

/**
 * Detect whether a golden.patch file is a stub (no real diff to compare).
 * Stubs start with "# TODO" or contain only comment/blank lines.
 */
export function isStubPatch(content: string): boolean {
  const nonCommentLines = content.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  return nonCommentLines.length === 0;
}

/**
 * Extract per-case matrix entries from an EvalSuiteResult, plus the supplied
 * per-case diff comparisons (if any).
 */
export function toMatrixEntries(
  result: EvalSuiteResult,
  diffLookup?: Map<string, number | null>,
): Record<string, MatrixCaseEntry> {
  const entries: Record<string, MatrixCaseEntry> = {};
  for (const r of result.cases) {
    entries[r.caseId] = buildCaseEntry(r, diffLookup?.get(r.caseId) ?? null);
  }
  return entries;
}

function buildCaseEntry(r: EvalResult, diffSim: number | null): MatrixCaseEntry {
  return {
    passed: r.passed,
    partialCredit: r.partialCredit,
    costUsd: r.costUsd ?? 0,
    wallTimeS: r.duration,
    // Tool error rate isn't persisted on EvalResult today; keep 0 for now,
    // the plumbing is here so #161's telemetry can back-fill without a
    // downstream signature change.
    toolErrorRate: 0,
    diffSimilarity: diffSim,
    errored: Boolean(r.error),
    error: r.error,
  };
}

/** Aggregate per-profile totals from per-case entries. */
export function aggregateTotals(
  profile: string,
  entries: Record<string, MatrixCaseEntry>,
): MatrixProfileTotals {
  const values = Object.values(entries);
  const caseCount = values.length;
  const passCount = values.filter((v) => v.passed).length;
  const totalCostUsd = values.reduce((s, v) => s + v.costUsd, 0);
  const meanWallTimeS = caseCount === 0 ? 0 : values.reduce((s, v) => s + v.wallTimeS, 0) / caseCount;
  const meanToolErrorRate = caseCount === 0 ? 0 : values.reduce((s, v) => s + v.toolErrorRate, 0) / caseCount;
  return {
    profile,
    caseCount,
    passCount,
    passRate: caseCount === 0 ? 0 : passCount / caseCount,
    totalCostUsd,
    meanWallTimeS,
    meanToolErrorRate,
  };
}

/** Compute deltas for each profile vs the baseline. */
export function computeDeltas(
  totals: MatrixProfileTotals[],
  baseline: string,
): Record<string, { pipelineSuccessDelta: number; costPerIssueDelta: number }> {
  const byProfile = new Map(totals.map((t) => [t.profile, t]));
  const base = byProfile.get(baseline);
  const result: Record<string, { pipelineSuccessDelta: number; costPerIssueDelta: number }> = {};
  if (!base) return result;
  const baseCostPerIssue = base.caseCount === 0 ? 0 : base.totalCostUsd / base.caseCount;
  for (const t of totals) {
    const costPerIssue = t.caseCount === 0 ? 0 : t.totalCostUsd / t.caseCount;
    result[t.profile] = {
      pipelineSuccessDelta: t.passRate - base.passRate,
      costPerIssueDelta: costPerIssue - baseCostPerIssue,
    };
  }
  return result;
}

/**
 * Run the full matrix: every profile × every case. Each profile gets a
 * fresh config built by deep-merging its overrides onto `baseConfig`.
 *
 * `runner` is injectable for tests — defaults to the real `runEvalSuite`.
 */
export async function runMatrix(
  cases: EvalCaseWithChecks[],
  opts: MatrixOptions,
  baseConfig: Config,
  runner: (
    cases: EvalCaseWithChecks[],
    config: Config,
    options?: EvalRunOptions,
  ) => Promise<EvalSuiteResult> = runEvalSuite,
): Promise<MatrixResult> {
  if (opts.profiles.length === 0) {
    throw new Error('runMatrix: at least one profile is required');
  }

  const profileNames = opts.profiles.map(profileDisplayName);
  const baselineName = profileDisplayName(opts.baseline ?? 'all-frontier');

  const perProfileEntries = new Map<string, Record<string, MatrixCaseEntry>>();
  const perProfileTotals: MatrixProfileTotals[] = [];

  for (let i = 0; i < opts.profiles.length; i++) {
    const profilePathOrName = opts.profiles[i];
    const displayName = profileNames[i];
    const overrides = loadProfileOverrides(profilePathOrName);
    // Resolve the merged config so validation surfaces bad profile YAML even
    // in dry-run mode. In execute mode the same merged config is what the
    // runner receives.
    const mergedConfig = applyProfileToConfig(baseConfig, overrides);

    let entries: Record<string, MatrixCaseEntry>;
    if (opts.dryRun) {
      entries = buildSkippedEntries(cases);
    } else {
      const result = await runner(cases, mergedConfig, { verbose: opts.verbose });
      const diffLookup = new Map<string, number | null>();
      // Placeholder diff similarities: real diff comes from the run's worktree
      // output, which lives inside runEvalSuite. For now we mark all as null
      // unless a golden stub tells us to skip — downstream reports treat null
      // as "informational, not scored".
      for (const c of cases) diffLookup.set(c.id, null);
      entries = toMatrixEntries(result, diffLookup);
    }
    perProfileEntries.set(displayName, entries);
    perProfileTotals.push(aggregateTotals(displayName, entries));
  }

  // Flatten per-case table: iterate cases once, attach per-profile entries.
  const flatCases = cases.map((c) => {
    const perProfile: Record<string, MatrixCaseEntry> = {};
    for (const name of profileNames) {
      const entries = perProfileEntries.get(name)!;
      perProfile[name] = entries[c.id] ?? {
        passed: false,
        partialCredit: 0,
        costUsd: 0,
        wallTimeS: 0,
        toolErrorRate: 0,
        diffSimilarity: null,
        errored: true,
        error: 'missing result',
      };
    }
    return { caseId: c.id, description: c.description, perProfile };
  });

  return {
    profiles: profileNames,
    baseline: baselineName,
    cases: flatCases,
    totals: perProfileTotals,
    deltas: computeDeltas(perProfileTotals, baselineName),
    ...(opts.dryRun ? { dryRun: true } : {}),
  };
}

/**
 * Locate the most recent matrix report, returning its mtime (epoch ms) and
 * path. Used by `alpha-loop evolve routing` to enforce a freshness gate on
 * promotion proposals — promotion must not fire without a recent matrix run.
 *
 * Checks the default `eval/reports/` directory first, then
 * `.alpha-loop/evals/reports/` (where older runs land). Returns null when
 * neither directory contains a `routing-*.{md,csv}` file.
 */
export function latestMatrixRun(
  projectDir: string = process.cwd(),
): { timestampMs: number; summaryPath: string } | null {
  const candidates = [
    join(projectDir, 'eval', 'reports'),
    join(projectDir, '.alpha-loop', 'evals', 'reports'),
  ];
  let best: { timestampMs: number; summaryPath: string } | null = null;
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('routing-')) continue;
      if (!name.endsWith('.md') && !name.endsWith('.csv')) continue;
      try {
        const full = join(dir, name);
        const stat = statSync(full);
        const ms = stat.mtimeMs;
        if (!best || ms > best.timestampMs) {
          best = { timestampMs: ms, summaryPath: full };
        }
      } catch {
        /* ignore unreadable entry */
      }
    }
  }
  return best;
}

/** Stub entries for a dry-run: every case marked skipped under every profile. */
function buildSkippedEntries(cases: EvalCaseWithChecks[]): Record<string, MatrixCaseEntry> {
  const entries: Record<string, MatrixCaseEntry> = {};
  for (const c of cases) {
    entries[c.id] = {
      passed: false,
      partialCredit: 0,
      costUsd: 0,
      wallTimeS: 0,
      toolErrorRate: 0,
      diffSimilarity: null,
      errored: false,
      skipped: true,
    };
  }
  return entries;
}
