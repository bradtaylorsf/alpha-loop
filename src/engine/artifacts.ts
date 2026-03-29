import { readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { execSync } from "node:child_process";

// --- Types ---

export interface ArtifactInfo {
  screenshots: string[];
  videos: string[];
  artifactsDir: string;
}

export interface PlaywrightFlags {
  flags: string[];
  outputDir: string;
}

// --- Playwright detection ---

export function isPlaywrightInstalled(cwd: string): boolean {
  try {
    execSync("pnpm exec playwright --version", {
      cwd,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

// --- Build Playwright CLI flags for artifact capture ---

export function buildPlaywrightFlags(
  sessionName: string,
  issueNumber: number,
  baseDir: string = process.cwd(),
): PlaywrightFlags {
  const outputDir = join(baseDir, "sessions", sessionName, "artifacts", `issue-${issueNumber}`);
  mkdirSync(outputDir, { recursive: true });

  return {
    flags: [
      "--screenshot", "on",
      "--video", "on",
      "--output", outputDir,
    ],
    outputDir,
  };
}

// --- Collect artifacts from output directory ---

const SCREENSHOT_EXTS = new Set([".png", ".jpg", ".jpeg"]);
const VIDEO_EXTS = new Set([".webm", ".mp4"]);

export function collectArtifacts(artifactsDir: string): ArtifactInfo {
  const result: ArtifactInfo = {
    screenshots: [],
    videos: [],
    artifactsDir,
  };

  if (!existsSync(artifactsDir)) {
    return result;
  }

  collectFromDir(artifactsDir, result);
  return result;
}

function collectFromDir(dir: string, result: ArtifactInfo): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        collectFromDir(fullPath, result);
      } else {
        const ext = extname(entry).toLowerCase();
        if (SCREENSHOT_EXTS.has(ext)) {
          result.screenshots.push(fullPath);
        } else if (VIDEO_EXTS.has(ext)) {
          result.videos.push(fullPath);
        }
      }
    } catch {
      // Skip files we can't stat
    }
  }
}

// --- Format artifact summary for post-run display ---

export function formatArtifactCounts(artifacts: ArtifactInfo): string {
  const parts: string[] = [];
  if (artifacts.screenshots.length > 0) {
    parts.push(`\u{1F4F8} ${artifacts.screenshots.length} screenshot${artifacts.screenshots.length === 1 ? "" : "s"}`);
  }
  if (artifacts.videos.length > 0) {
    parts.push(`\u{1F3A5} ${artifacts.videos.length} video${artifacts.videos.length === 1 ? "" : "s"}`);
  }
  return parts.join("  ");
}

// --- Format artifact links for QA checklist ---

export function formatArtifactLinks(artifacts: ArtifactInfo): string[] {
  const lines: string[] = [];
  for (const screenshot of artifacts.screenshots) {
    lines.push(`  \u{1F4F8} Screenshot: ${screenshot}`);
  }
  for (const video of artifacts.videos) {
    lines.push(`  \u{1F3A5} Video: ${video}`);
  }
  return lines;
}
