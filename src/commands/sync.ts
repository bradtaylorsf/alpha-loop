/**
 * Sync Command — keep agent docs and skills in sync across CLI tool formats.
 *
 * Source of truth:
 *   - AGENTS.md       → copied to CLAUDE.md
 *   - skills/         → copied to .agents/skills/ and .claude/skills/
 *
 * This ensures both Claude and Codex (and any future agent) can find
 * the same instructions and skills in their native locations.
 */
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { log } from '../lib/logger.js';

const SOURCE_DOC = 'AGENTS.md';
const TARGET_DOC = 'CLAUDE.md';
const SOURCE_SKILLS = 'skills';
const TARGET_SKILL_DIRS = ['.agents/skills', '.claude/skills'];

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

export type SyncResult = {
  synced: boolean;
  docSynced: boolean;
  skillsDirs: string[];
};

/**
 * Sync agent assets: AGENTS.md → CLAUDE.md, skills/ → .agents/skills/ + .claude/skills/
 *
 * Returns what was synced. If check=true, only reports drift without writing.
 */
export function syncAgentAssets(options: { check?: boolean; projectDir?: string } = {}): SyncResult {
  const { check = false, projectDir = process.cwd() } = options;

  const sourceDoc = join(projectDir, SOURCE_DOC);
  const targetDoc = join(projectDir, TARGET_DOC);
  const sourceSkills = join(projectDir, SOURCE_SKILLS);

  const result: SyncResult = { synced: false, docSynced: false, skillsDirs: [] };

  // Sync AGENTS.md → CLAUDE.md
  if (existsSync(sourceDoc)) {
    if (!filesMatch(sourceDoc, targetDoc)) {
      if (check) {
        log.warn(`Drift: ${TARGET_DOC} differs from ${SOURCE_DOC}`);
      } else {
        copyFileSync(sourceDoc, targetDoc);
        log.info(`Synced ${SOURCE_DOC} → ${TARGET_DOC}`);
      }
      result.docSynced = true;
      result.synced = true;
    }
  }

  // Sync skills/ → target dirs
  if (existsSync(sourceSkills)) {
    for (const targetDir of TARGET_SKILL_DIRS) {
      const targetPath = join(projectDir, targetDir);
      if (!dirsMatch(sourceSkills, targetPath)) {
        if (check) {
          log.warn(`Drift: ${targetDir} differs from ${SOURCE_SKILLS}/`);
        } else {
          syncDir(sourceSkills, targetPath);
          log.info(`Synced ${SOURCE_SKILLS}/ → ${targetDir}/`);
        }
        result.skillsDirs.push(targetDir);
        result.synced = true;
      }
    }
  }

  return result;
}

/**
 * CLI command handler for `alpha-loop sync`.
 */
export function syncCommand(options: { check?: boolean } = {}): void {
  const projectDir = process.cwd();
  const sourceDoc = join(projectDir, SOURCE_DOC);
  const sourceSkills = join(projectDir, SOURCE_SKILLS);

  if (!existsSync(sourceDoc) && !existsSync(sourceSkills)) {
    log.warn(`No ${SOURCE_DOC} or ${SOURCE_SKILLS}/ found. Nothing to sync.`);
    log.info(`Create ${SOURCE_DOC} (agent instructions) and/or ${SOURCE_SKILLS}/ (skill definitions) first.`);
    return;
  }

  const result = syncAgentAssets({ check: options.check, projectDir });

  if (!result.synced) {
    log.success('Agent assets are in sync.');
  } else if (options.check) {
    log.error('Drift detected. Run "alpha-loop sync" to resolve.');
    process.exit(1);
  } else {
    log.success('Agent assets synced.');
  }
}
