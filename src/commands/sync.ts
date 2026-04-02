/**
 * Sync Command — keep skills, sub-agents, and instructions in sync across coding harnesses.
 *
 * Source of truth: .alpha-loop/templates/
 *   skills/          → each harness's skillsDir
 *   agents/          → each harness's agentsDir (if defined)
 *   instructions.md  → each harness's instructionsFile (e.g., CLAUDE.md, AGENTS.md)
 *
 * Instructions files are only overwritten if they contain the "<!-- managed by alpha-loop -->"
 * marker. Existing hand-written CLAUDE.md/AGENTS.md files are never touched.
 *
 * Harnesses to sync are read from the `harnesses` array supplied by the caller
 * (typically loaded from .alpha-loop.yaml). Only harnesses that exist in the
 * HARNESS_REGISTRY are processed.
 */
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { log } from '../lib/logger.js';
import { loadConfig } from '../lib/config.js';

// ---------------------------------------------------------------------------
// Harness registry
// ---------------------------------------------------------------------------

export type HarnessConfig = {
  skillsDir: string;
  agentsDir?: string;
  instructionsFile?: string;
};

export const HARNESS_REGISTRY: Record<string, HarnessConfig> = {
  amp:            { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  antigravity:    { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  augment:        { skillsDir: '.augment/skills' },
  bob:            { skillsDir: '.bob/skills' },
  claude:         { skillsDir: '.claude/skills', agentsDir: '.claude/agents', instructionsFile: 'CLAUDE.md' },
  'claude-code':  { skillsDir: '.claude/skills', agentsDir: '.claude/agents', instructionsFile: 'CLAUDE.md' }, // legacy alias
  openclaw:       { skillsDir: 'skills' },
  cline:          { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  warp:           { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  codebuddy:      { skillsDir: '.codebuddy/skills' },
  codex:          { skillsDir: '.agents/skills', agentsDir: '.codex/agents', instructionsFile: 'AGENTS.md' },
  'command-code': { skillsDir: '.commandcode/skills' },
  continue:       { skillsDir: '.continue/skills' },
  cortex:         { skillsDir: '.cortex/skills' },
  crush:          { skillsDir: '.crush/skills' },
  cursor:         { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  deepagents:     { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  droid:          { skillsDir: '.factory/skills' },
  firebender:     { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  'gemini-cli':   { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  'github-copilot': { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  goose:          { skillsDir: '.goose/skills' },
  junie:          { skillsDir: '.junie/skills' },
  'iflow-cli':    { skillsDir: '.iflow/skills' },
  kilo:           { skillsDir: '.kilocode/skills' },
  'kimi-cli':     { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  'kiro-cli':     { skillsDir: '.kiro/skills' },
  kode:           { skillsDir: '.kode/skills' },
  mcpjam:         { skillsDir: '.mcpjam/skills' },
  'mistral-vibe': { skillsDir: '.vibe/skills' },
  mux:            { skillsDir: '.mux/skills' },
  opencode:       { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  openhands:      { skillsDir: '.openhands/skills' },
  pi:             { skillsDir: '.pi/skills' },
  qoder:          { skillsDir: '.qoder/skills' },
  'qwen-code':    { skillsDir: '.qwen/skills' },
  replit:         { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  roo:            { skillsDir: '.roo/skills' },
  trae:           { skillsDir: '.trae/skills' },
  'trae-cn':      { skillsDir: '.trae/skills' },
  universal:      { skillsDir: '.agents/skills', instructionsFile: 'AGENTS.md' },
  windsurf:       { skillsDir: '.windsurf/skills' },
  zencoder:       { skillsDir: '.zencoder/skills' },
  neovate:        { skillsDir: '.neovate/skills' },
  pochi:          { skillsDir: '.pochi/skills' },
  adal:           { skillsDir: '.adal/skills' },
};

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = '.alpha-loop/templates';
const TEMPLATE_SKILLS_SUBDIR = 'skills';
const TEMPLATE_AGENTS_SUBDIR = 'agents';
const TEMPLATE_INSTRUCTIONS_FILE = 'instructions.md';

/** Marker that identifies files managed by alpha-loop (safe to overwrite). */
export const MANAGED_MARKER = '<!-- managed by alpha-loop -->';

// Legacy root-level fallbacks
const LEGACY_SKILLS_DIR = 'skills';
const LEGACY_CLAUDE_AGENTS_DIR = '.claude/agents';

// ---------------------------------------------------------------------------
// Helper functions (kept exactly as before)
// ---------------------------------------------------------------------------

/**
 * Recursively copy a directory, deleting files in target that don't exist in source.
 */
function syncDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });

  const srcEntries = new Set(readdirSync(src));

  // Delete files in dest that don't exist in src
  if (existsSync(dest)) {
    for (const entry of readdirSync(dest)) {
      if (!srcEntries.has(entry)) {
        const destPath = join(dest, entry);
        rmSync(destPath, { recursive: true, force: true });
      }
    }
  }

  // Copy from src to dest
  for (const entry of srcEntries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      syncDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Check if two files have identical content.
 */
function filesMatch(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false;
  return readFileSync(a).equals(readFileSync(b));
}

/**
 * Recursively check if two directories have identical content.
 */
function dirsMatch(src: string, dest: string): boolean {
  if (!existsSync(src) || !existsSync(dest)) return false;

  const srcEntries = readdirSync(src).sort();
  const destEntries = readdirSync(dest).sort();

  if (srcEntries.length !== destEntries.length) return false;
  if (srcEntries.join(',') !== destEntries.join(',')) return false;

  for (const entry of srcEntries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      if (!dirsMatch(srcPath, destPath)) return false;
    } else {
      if (!filesMatch(srcPath, destPath)) return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Source resolution (templates dir vs. legacy root files)
// ---------------------------------------------------------------------------

type TemplateSources = {
  skillsDir: string;
  agentsDir: string;
  instructionsFile: string;
  isLegacy: boolean;
};

function resolveTemplateSources(projectDir: string): TemplateSources | null {
  const templatesBase = join(projectDir, TEMPLATES_DIR);
  const templateSkills = join(templatesBase, TEMPLATE_SKILLS_SUBDIR);
  const templateAgents = join(templatesBase, TEMPLATE_AGENTS_SUBDIR);
  const templateInstructions = join(templatesBase, TEMPLATE_INSTRUCTIONS_FILE);

  if (existsSync(templatesBase)) {
    return {
      skillsDir: templateSkills,
      agentsDir: templateAgents,
      instructionsFile: templateInstructions,
      isLegacy: false,
    };
  }

  // Fall back to legacy root-level files
  const legacySkills = join(projectDir, LEGACY_SKILLS_DIR);

  if (existsSync(legacySkills)) {
    log.warn(
      `Legacy layout detected (${LEGACY_SKILLS_DIR}/ at project root). ` +
      `Run "alpha-loop init" to migrate to ${TEMPLATES_DIR}/.`
    );
    return {
      skillsDir: legacySkills,
      agentsDir: join(projectDir, LEGACY_CLAUDE_AGENTS_DIR),
      instructionsFile: '', // No instructions in legacy layout
      isLegacy: true,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Agent → Harness mapping
// ---------------------------------------------------------------------------

/** Maps agent CLI names to their default harness names for syncing. */
const AGENT_HARNESS_MAP: Record<string, string[]> = {
  claude: ['claude'],
  codex: ['codex'],
  opencode: ['opencode'],
};

/**
 * Resolve harnesses to sync to. If explicit harnesses are provided, use those.
 * Otherwise, derive from the configured agent.
 */
export function resolveHarnesses(harnesses: string[], agent: string): string[] {
  if (harnesses.length > 0) return harnesses;
  return AGENT_HARNESS_MAP[agent] ?? [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SyncResult = {
  synced: boolean;
  docSynced: boolean;
  skillsDirs: string[];
};

/**
 * Sync agent assets from templates to each configured harness's paths.
 *
 * @param harnesses - list of harness names from .alpha-loop.yaml config
 * @param options   - check-only mode and project directory override
 */
export function syncAgentAssets(
  harnesses: string[],
  options: { check?: boolean; projectDir?: string } = {}
): SyncResult {
  const { check = false, projectDir = process.cwd() } = options;
  const result: SyncResult = { synced: false, docSynced: false, skillsDirs: [] };

  const sources = resolveTemplateSources(projectDir);
  if (!sources) {
    log.warn(`No template sources found. Create ${TEMPLATES_DIR}/ with skills/, agents/, and instructions.md.`);
    return result;
  }

  for (const harness of harnesses) {
    const config = HARNESS_REGISTRY[harness];
    if (!config) {
      log.warn(`Unknown harness "${harness}" — not in HARNESS_REGISTRY, skipping.`);
      continue;
    }

    // -- Skills dir --
    if (existsSync(sources.skillsDir)) {
      const targetSkills = join(projectDir, config.skillsDir);
      if (!dirsMatch(sources.skillsDir, targetSkills)) {
        if (check) {
          log.warn(`Drift [${harness}]: ${config.skillsDir} differs from template skills/`);
        } else {
          syncDir(sources.skillsDir, targetSkills);
          log.info(`Synced [${harness}] skills/ → ${config.skillsDir}`);
        }
        if (!result.skillsDirs.includes(config.skillsDir)) {
          result.skillsDirs.push(config.skillsDir);
        }
        result.synced = true;
      }
    }

    // -- Agents dir --
    if (config.agentsDir && existsSync(sources.agentsDir)) {
      const targetAgents = join(projectDir, config.agentsDir);
      if (!dirsMatch(sources.agentsDir, targetAgents)) {
        if (check) {
          log.warn(`Drift [${harness}]: ${config.agentsDir} differs from template agents/`);
        } else {
          syncDir(sources.agentsDir, targetAgents);
          log.info(`Synced [${harness}] agents/ → ${config.agentsDir}`);
        }
        result.synced = true;
      }
    }

    // -- Instructions file --
    if (config.instructionsFile && sources.instructionsFile && existsSync(sources.instructionsFile)) {
      const targetFile = join(projectDir, config.instructionsFile);
      if (!filesMatch(sources.instructionsFile, targetFile)) {
        // Safety: only overwrite if the target doesn't exist or contains the managed marker
        const targetExists = existsSync(targetFile);
        const targetManaged = targetExists &&
          readFileSync(targetFile, 'utf-8').startsWith(MANAGED_MARKER);

        if (!targetExists || targetManaged) {
          if (check) {
            log.warn(`Drift [${harness}]: ${config.instructionsFile} differs from template instructions.md`);
          } else {
            mkdirSync(join(targetFile, '..'), { recursive: true });
            copyFileSync(sources.instructionsFile, targetFile);
            log.info(`Synced [${harness}] instructions.md → ${config.instructionsFile}`);
          }
          result.docSynced = true;
          result.synced = true;
        } else {
          log.warn(
            `Skipping ${config.instructionsFile} — file exists without alpha-loop marker. ` +
            `Run "alpha-loop scan" to generate a managed instructions file.`
          );
        }
      }
    }

  }

  return result;
}

/**
 * Migrate legacy root-level assets to the canonical templates directory.
 *
 * Moves:
 *   skills/          → .alpha-loop/templates/skills/
 *   .claude/agents/  → .alpha-loop/templates/agents/
 *
 * Does NOT delete the originals — the next sync run will recreate them
 * from the new template location.
 */
export function migrateToTemplates(projectDir: string = process.cwd()): void {
  const templatesBase = join(projectDir, TEMPLATES_DIR);
  mkdirSync(templatesBase, { recursive: true });

  const moves: Array<{ src: string; dest: string; label: string }> = [
    {
      src: join(projectDir, LEGACY_SKILLS_DIR),
      dest: join(templatesBase, TEMPLATE_SKILLS_SUBDIR),
      label: `${LEGACY_SKILLS_DIR}/ → ${TEMPLATES_DIR}/skills/`,
    },
    {
      src: join(projectDir, LEGACY_CLAUDE_AGENTS_DIR),
      dest: join(templatesBase, TEMPLATE_AGENTS_SUBDIR),
      label: `${LEGACY_CLAUDE_AGENTS_DIR}/ → ${TEMPLATES_DIR}/agents/`,
    },
  ];

  let moved = false;
  for (const { src, dest, label } of moves) {
    if (!existsSync(src)) continue;
    if (existsSync(dest)) {
      log.warn(`Migration skipped (destination already exists): ${label}`);
      continue;
    }
    mkdirSync(join(dest, '..'), { recursive: true });
    renameSync(src, dest);
    log.info(`Migrated: ${label}`);
    moved = true;
  }

  if (!moved) {
    log.info('Nothing to migrate — no legacy assets found or all destinations already exist.');
  } else {
    log.info(
      `Migration complete. Re-run "alpha-loop sync" to propagate from ${TEMPLATES_DIR}/ to all configured harnesses.`
    );
  }
}

/**
 * CLI command handler for `alpha-loop sync`.
 *
 * Reads harness list from the caller-supplied options (populated from
 * .alpha-loop.yaml) and delegates to syncAgentAssets.
 */
export function syncCommand(options: { check?: boolean; harnesses?: string[] } = {}): void {
  const projectDir = process.cwd();

  // Load harnesses from options or fall back to config file, auto-deriving from agent if needed
  let harnesses = options.harnesses ?? [];
  if (harnesses.length === 0) {
    try {
      const config = loadConfig();
      harnesses = resolveHarnesses(config.harnesses, config.agent);
    } catch { /* config not available */ }
  }

  if (harnesses.length === 0) {
    log.warn('No harnesses configured. Set "agent" or add a "harnesses" list to .alpha-loop.yaml.');
    return;
  }

  const sources = resolveTemplateSources(projectDir);
  if (!sources) {
    log.warn(
      `No source assets found. Create ${TEMPLATES_DIR}/ with skills/ and agents/ subdirectories.`
    );
    return;
  }

  const result = syncAgentAssets(harnesses, { check: options.check, projectDir });

  if (!result.synced) {
    log.success('Agent assets are in sync.');
  } else if (options.check) {
    log.error('Drift detected. Run "alpha-loop sync" to resolve.');
    process.exit(1);
  } else {
    log.success('Agent assets synced.');
  }
}
