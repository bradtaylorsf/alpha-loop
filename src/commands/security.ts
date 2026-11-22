/**
 * Security selector: detect surfaces, checkbox oracle-backed techniques,
 * create milestones/issues with security-check (not ready), write the plan,
 * and set security_checks: true.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkbox, confirm } from '@inquirer/prompts';
import {
  loadConfig,
  writeSecurityChecks,
  type Config,
} from '../lib/config.js';
import { log } from '../lib/logger.js';
import {
  buildSecurityCatalog,
  distributionOraclesPath,
  loadOracleFile,
  selectableRows,
  type SecurityCatalogRow,
} from '../lib/security-catalog.js';
import {
  acceptWatchedSha,
  loadSecurityPlan,
  saveSecurityPlan,
  savedTechniqueIds,
} from '../lib/security-plan.js';
import {
  fetchWatchedPath,
  type SourceFetch,
  type WatchedSourceResult,
} from '../lib/security-sources.js';
import {
  detectSecuritySurfaces,
  surfacesForSelector,
  type SecuritySurface,
  type SurfaceDetectionResult,
} from '../lib/security-surfaces.js';
import {
  type SecurityPlan,
  type SecurityPlanCheck,
  type SecurityProfileConfig,
  type SecurityProfileName,
  type SecurityTarget,
} from '../lib/security-types.js';
import {
  commentIssue,
  createIssue,
  createLabel,
  createMilestone,
  listLabels,
  listMilestones,
} from '../lib/github.js';

const SECURITY_CHECK_LABEL = 'security-check';

export type SecurityCommandOptions = {
  dryRun?: boolean;
  yes?: boolean;
  projectDir?: string;
  /** Injected GitHub fetch for tests. */
  fetchImpl?: SourceFetch;
  /** Optional model JSON for application surfaces. Invalid JSON is discarded. */
  modelSurfaces?: unknown;
  /** Pre-built catalog rows for tests (skips network fetch). */
  catalogRows?: SecurityCatalogRow[];
  /** Pre-built profile fetch results for tests. */
  profileResults?: Partial<Record<SecurityProfileName, WatchedSourceResult>>;
};

export type TechniqueChoice = {
  id: string;
  name: string;
  techniqueId: string;
  surface: string;
  target: SecurityTarget;
  source: SecurityProfileName;
  row: SecurityCatalogRow;
  checked: boolean;
};

export type SecuritySelectorResult = {
  detection: SurfaceDetectionResult;
  plan: SecurityPlan;
  selected: TechniqueChoice[];
  created: Array<{ milestone: string; issueNum: number; techniqueId: string }>;
  dryRun: boolean;
};

/** Choice id used in the checkbox. Stable across surfaces. */
export function techniqueChoiceId(techniqueId: string, surface: string): string {
  return `${techniqueId}::${surface}`;
}

export function formatSurfaceReport(detection: SurfaceDetectionResult): string {
  const lines: string[] = ['Detected security surfaces:'];
  for (const signal of detection.signals) {
    const mark = signal.detected ? '[x]' : '[ ]';
    const detail = signal.signals.length > 0 ? signal.signals.join(', ') : 'none';
    lines.push(`  ${mark} ${signal.surface}: ${detail}`);
  }
  return lines.join('\n');
}

export function buildTechniqueChoices(
  rows: readonly SecurityCatalogRow[],
  surfaces: readonly SecuritySurface[],
  saved: readonly SecurityPlanCheck[],
): TechniqueChoice[] {
  const surfaceSet = new Set(surfaces);
  const savedSelected = new Set(
    saved
      .filter((check) => check.selected)
      .map((check) => techniqueChoiceId(check.techniqueId, check.surface)),
  );

  const choices: TechniqueChoice[] = [];
  for (const row of selectableRows(rows)) {
    if (!surfaceSet.has(row.check.surface as SecuritySurface)) continue;
    const source: SecurityProfileName = row.check.target === 'mcp-agent' ? 'agent' : 'application';
    const id = techniqueChoiceId(row.check.techniqueId, row.check.surface);
    choices.push({
      id,
      name: `${row.check.techniqueId} [${row.check.surface}] (${source})`,
      techniqueId: row.check.techniqueId,
      surface: row.check.surface,
      target: row.check.target,
      source,
      row,
      checked: savedSelected.has(id) || row.status === 'new',
    });
  }
  choices.sort((left, right) => left.id.localeCompare(right.id));
  return choices;
}

export function buildPlanFromSelection(
  previous: SecurityPlan,
  selected: readonly TechniqueChoice[],
  pins: Partial<Record<SecurityProfileName, { url: string; ref: string; watch: string[]; acceptedSha: string }>>,
): SecurityPlan {
  const selectedIds = new Set(selected.map((choice) => choice.id));
  const previousById = new Map(
    previous.checks.map((check) => [techniqueChoiceId(check.techniqueId, check.surface), check]),
  );

  const checks: SecurityPlanCheck[] = [];
  const seen = new Set<string>();

  for (const choice of selected) {
    const prior = previousById.get(choice.id);
    const milestone = prior?.milestone ?? milestoneTitleFor(choice.techniqueId, choice.surface);
    checks.push({
      ...choice.row.check,
      selected: true,
      milestone,
    });
    seen.add(choice.id);
  }

  // Keep previously saved rows that were not selected (selected: false, milestone retained).
  for (const [id, check] of previousById) {
    if (seen.has(id)) continue;
    if (!selectedIds.has(id)) {
      checks.push({ ...check, selected: false });
    }
  }

  checks.sort((left, right) => {
    const byId = left.techniqueId.localeCompare(right.techniqueId);
    if (byId !== 0) return byId;
    return left.surface.localeCompare(right.surface);
  });

  let plan: SecurityPlan = {
    version: 1,
    profiles: { ...previous.profiles },
    checks,
  };

  for (const [profile, pin] of Object.entries(pins) as Array<[SecurityProfileName, typeof pins[SecurityProfileName]]>) {
    if (!pin) continue;
    plan = acceptWatchedSha(plan, profile, pin);
  }

  return plan;
}

export function milestoneTitleFor(techniqueId: string, surface: string): string {
  return `Security: ${techniqueId} (${surface})`;
}

export function issueBodyFor(check: SecurityPlanCheck): string {
  return [
    `## Security check`,
    '',
    `- Technique: \`${check.techniqueId}\``,
    `- Surface: \`${check.surface}\``,
    `- Target: \`${check.target}\``,
    `- Source: ${check.sourceUrl}`,
    `- Catalog revision: \`${check.catalogRevision}\``,
    '',
    '### Local oracle',
    '```',
    check.command,
    '```',
    '',
    `- Pass exit: ${check.passExit}`,
    `- Timeout: ${check.timeoutSec}s`,
    '',
    'This issue uses the `security-check` label. It does not receive `ready`.',
  ].join('\n');
}

export async function securityCommand(options: SecurityCommandOptions = {}): Promise<SecuritySelectorResult> {
  const projectDir = options.projectDir ?? process.cwd();
  const config = loadConfig({ dryRun: options.dryRun });

  if (!process.stdin.isTTY && !options.yes && !options.dryRun) {
    log.info('The security command requires an interactive terminal. Use --yes or --dry-run.');
    const detection = detectSecuritySurfaces({ projectDir, agent: config.agent, modelSurfaces: options.modelSurfaces });
    return {
      detection,
      plan: loadSecurityPlan(projectDir),
      selected: [],
      created: [],
      dryRun: Boolean(options.dryRun),
    };
  }

  const detection = detectSecuritySurfaces({
    projectDir,
    agent: config.agent,
    modelSurfaces: options.modelSurfaces,
  });

  console.log('');
  console.log(formatSurfaceReport(detection));
  console.log('');

  for (const signal of detection.signals) {
    if (!signal.detected) continue;
    if (signal.surface === 'mcp') {
      const agentProfile = config.securityProfiles.agent;
      log.info(`Agent profile: ${agentProfile.url} (watch: ${agentProfile.watch.join(', ')})`);
    }
  }

  let showUndetected = false;
  if (options.yes) {
    showUndetected = false;
    log.info('--yes: offering techniques for detected surfaces only');
  } else {
    showUndetected = await confirm({
      message: 'Show surfaces that were not detected',
      default: false,
    });
  }

  const offeredSurfaces = surfacesForSelector(detection, showUndetected);
  const previous = loadSecurityPlan(projectDir);

  const { rows, pins, profileMeta } = await loadCatalogRows({
    projectDir,
    config,
    detection,
    previous,
    offeredSurfaces,
    options,
  });

  for (const [profile, meta] of Object.entries(profileMeta) as Array<[SecurityProfileName, ProfileMeta]>) {
    if (!meta) continue;
    const pinNote = meta.shaChanged
      ? `watched SHA changed ${meta.acceptedSha ?? '(none)'} → ${meta.latestSha}`
      : `watched SHA ${meta.latestSha}`;
    log.info(`${profile} catalog: ${meta.url} (${pinNote})`);
    if (meta.delta) {
      log.info(
        `  delta: +${meta.delta.added.length} -${meta.delta.removed.length} ~${meta.delta.changed.length}`,
      );
    }
  }

  const choices = buildTechniqueChoices(rows, offeredSurfaces, previous.checks);
  if (choices.length === 0) {
    log.warn('No oracle-backed techniques for the offered surfaces.');
    const plan = buildPlanFromSelection(previous, [], pins);
    saveSecurityPlan(projectDir, plan);
    if (!options.dryRun) writeSecurityChecks(projectDir, true);
    return { detection, plan, selected: [], created: [], dryRun: Boolean(options.dryRun) };
  }

  let selectedIds: string[];
  if (options.yes) {
    selectedIds = choices.filter((choice) => choice.checked).map((choice) => choice.id);
    log.info(`--yes: selecting ${selectedIds.length} technique(s)`);
  } else {
    selectedIds = await checkbox({
      message: 'Select security techniques (oracle-backed only):',
      choices: choices.map((choice) => ({
        name: choice.name,
        value: choice.id,
        checked: choice.checked,
      })),
    });
  }

  const selected = choices.filter((choice) => selectedIds.includes(choice.id));
  const plan = buildPlanFromSelection(previous, selected, pins);
  saveSecurityPlan(projectDir, plan);

  if (options.dryRun) {
    log.dry(`Dry run — wrote ${join(projectDir, '.alpha-loop', 'security-plan.json')} only.`);
    return { detection, plan, selected, created: [], dryRun: true };
  }

  writeSecurityChecks(projectDir, true);

  if (selected.length === 0) {
    log.info('No techniques selected.');
    return { detection, plan, selected, created: [], dryRun: false };
  }

  if (!options.yes) {
    const proceed = await confirm({
      message: `Create ${selected.length} security milestone(s) and issue(s) on GitHub?`,
    });
    if (!proceed) {
      log.info('Cancelled after saving the security plan.');
      return { detection, plan, selected, created: [], dryRun: false };
    }
  }

  const created = await createSecurityResources(config, plan, selected);
  return { detection, plan, selected, created, dryRun: false };
}

type ProfileMeta = {
  url: string;
  latestSha: string;
  acceptedSha: string | null;
  shaChanged: boolean;
  delta: WatchedSourceResult['delta'];
};

async function loadCatalogRows(input: {
  projectDir: string;
  config: Config;
  detection: SurfaceDetectionResult;
  previous: SecurityPlan;
  offeredSurfaces: readonly SecuritySurface[];
  options: SecurityCommandOptions;
}): Promise<{
  rows: SecurityCatalogRow[];
  pins: Partial<Record<SecurityProfileName, { url: string; ref: string; watch: string[]; acceptedSha: string }>>;
  profileMeta: Partial<Record<SecurityProfileName, ProfileMeta>>;
}> {
  if (input.options.catalogRows) {
    const pins: Partial<Record<SecurityProfileName, { url: string; ref: string; watch: string[]; acceptedSha: string }>> = {};
    for (const [name, result] of Object.entries(input.options.profileResults ?? {}) as Array<[SecurityProfileName, WatchedSourceResult]>) {
      pins[name] = {
        url: result.url,
        ref: result.ref,
        watch: [result.watchPath],
        acceptedSha: result.acceptedSha ?? result.latestSha,
      };
    }
    return { rows: [...input.options.catalogRows], pins, profileMeta: {} };
  }

  const oraclesPath = distributionOraclesPath(input.projectDir)
    ?? distributionOraclesPath(join(input.projectDir, '..'))
    ?? distributionOraclesPath();
  if (!oraclesPath || !existsSync(oraclesPath)) {
    throw new Error('Oracle file not found under templates/security-profiles/oracles.json');
  }
  const oracles = loadOracleFile(oraclesPath);
  const savedIds = savedTechniqueIds(input.previous);
  const rows: SecurityCatalogRow[] = [];
  const pins: Partial<Record<SecurityProfileName, { url: string; ref: string; watch: string[]; acceptedSha: string }>> = {};
  const profileMeta: Partial<Record<SecurityProfileName, ProfileMeta>> = {};

  const wantApplication = input.offeredSurfaces.some((surface) => surface !== 'mcp');
  const wantAgent = input.offeredSurfaces.includes('mcp') && input.detection.agentSurface;

  if (wantApplication && input.config.securityProfiles.application.enabled) {
    const result = await loadProfile({
      projectDir: input.projectDir,
      profile: 'application',
      config: input.config.securityProfiles.application,
      previous: input.previous,
      fetchImpl: input.options.fetchImpl,
      injected: input.options.profileResults?.application,
    });
    pins.application = {
      url: result.url,
      ref: result.ref,
      watch: [result.watchPath],
      acceptedSha: result.acceptedSha ?? result.latestSha,
    };
    profileMeta.application = {
      url: result.url,
      latestSha: result.latestSha,
      acceptedSha: result.acceptedSha,
      shaChanged: result.shaChanged,
      delta: result.delta,
    };
    rows.push(...buildSecurityCatalog({
      techniques: result.techniques,
      surfaces: input.offeredSurfaces.filter((surface) => surface !== 'mcp'),
      oracles,
      savedTechniqueIds: savedIds,
      source: 'application',
      sourceUrl: result.url,
      catalogRevision: pins.application.acceptedSha,
      target: 'application',
    }));
  }

  if (wantAgent && input.config.securityProfiles.agent.enabled) {
    const result = await loadProfile({
      projectDir: input.projectDir,
      profile: 'agent',
      config: input.config.securityProfiles.agent,
      previous: input.previous,
      fetchImpl: input.options.fetchImpl,
      injected: input.options.profileResults?.agent,
    });
    pins.agent = {
      url: result.url,
      ref: result.ref,
      watch: [result.watchPath],
      acceptedSha: result.acceptedSha ?? result.latestSha,
    };
    profileMeta.agent = {
      url: result.url,
      latestSha: result.latestSha,
      acceptedSha: result.acceptedSha,
      shaChanged: result.shaChanged,
      delta: result.delta,
    };
    rows.push(...buildSecurityCatalog({
      techniques: result.techniques,
      surfaces: ['mcp'],
      oracles,
      savedTechniqueIds: savedIds,
      source: 'agent',
      sourceUrl: result.url,
      catalogRevision: pins.agent.acceptedSha,
      target: 'mcp-agent',
    }));
  }

  return { rows, pins, profileMeta };
}

async function loadProfile(input: {
  projectDir: string;
  profile: SecurityProfileName;
  config: SecurityProfileConfig;
  previous: SecurityPlan;
  fetchImpl?: SourceFetch;
  injected?: WatchedSourceResult;
}): Promise<WatchedSourceResult> {
  if (input.injected) return input.injected;
  const watchPath = input.config.watch[0];
  if (!watchPath) {
    throw new Error(`security_profiles.${input.profile}.watch must include at least one path`);
  }
  const acceptedSha = input.previous.profiles[input.profile]?.acceptedSha ?? null;
  return fetchWatchedPath({
    projectDir: input.projectDir,
    url: input.config.url,
    ref: input.config.ref,
    watchPath,
    acceptedSha,
    fetchImpl: input.fetchImpl,
  });
}

async function createSecurityResources(
  config: Config,
  plan: SecurityPlan,
  selected: readonly TechniqueChoice[],
): Promise<Array<{ milestone: string; issueNum: number; techniqueId: string }>> {
  ensureSecurityCheckLabel(config.repo);

  const existing = new Map(
    listMilestones(config.repo).map((milestone) => [milestone.title.toLowerCase(), milestone]),
  );
  const created: Array<{ milestone: string; issueNum: number; techniqueId: string }> = [];
  const failures: string[] = [];

  for (const choice of selected) {
    const check = plan.checks.find(
      (row) => row.techniqueId === choice.techniqueId && row.surface === choice.surface,
    );
    if (!check) continue;
    const milestoneTitle = check.milestone ?? milestoneTitleFor(check.techniqueId, check.surface);

    try {
      if (!existing.has(milestoneTitle.toLowerCase())) {
        const msNum = createMilestone(
          config.repo,
          milestoneTitle,
          `Security check for ${check.techniqueId} on surface ${check.surface}.`,
        );
        if (msNum > 0) {
          existing.set(milestoneTitle.toLowerCase(), {
            number: msNum,
            title: milestoneTitle,
            description: '',
            openIssues: 0,
            closedIssues: 0,
            dueOn: null,
            state: 'open',
          });
          log.success(`Created milestone: ${milestoneTitle}`);
        } else {
          failures.push(`Milestone "${milestoneTitle}": creation returned 0`);
          continue;
        }
      } else {
        log.info(`Reusing milestone: ${milestoneTitle}`);
      }

      const issueNum = createIssue(
        config.repo,
        `${check.techniqueId}: ${check.surface}`,
        issueBodyFor(check),
        [SECURITY_CHECK_LABEL],
        milestoneTitle,
      );
      if (issueNum > 0) {
        commentIssue(
          config.repo,
          issueNum,
          `Security check registered. Label: \`${SECURITY_CHECK_LABEL}\`. Not queued for implementation (\`ready\` omitted). Command: \`${check.command}\`.`,
        );
        created.push({ milestone: milestoneTitle, issueNum, techniqueId: check.techniqueId });
        log.success(`Created issue #${issueNum}: ${check.techniqueId} [${check.surface}]`);
      } else {
        failures.push(`Issue for ${check.techniqueId}: creation returned 0`);
      }
    } catch (error) {
      failures.push(`${choice.id}: ${(error as Error).message}`);
    }
  }

  if (failures.length > 0) {
    log.warn(`Security resource creation had ${failures.length} failure(s):`);
    for (const failure of failures) log.warn(`  - ${failure}`);
  }

  return created;
}

function ensureSecurityCheckLabel(repo: string): void {
  const labels = listLabels(repo);
  if (labels.includes(SECURITY_CHECK_LABEL)) return;
  createLabel(repo, SECURITY_CHECK_LABEL, 'B60205');
}
