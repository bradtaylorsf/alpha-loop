import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VISION_FILE = join('.alpha-loop', 'vision.md');

/**
 * Get vision context for prompt injection.
 * Returns the contents of .alpha-loop/vision.md, or null if it doesn't exist.
 */
export function getVisionContext(projectDir: string = '.'): string | null {
  const filePath = join(projectDir, VISION_FILE);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * Check if vision has been set up.
 */
export function hasVision(projectDir: string = '.'): boolean {
  return existsSync(join(projectDir, VISION_FILE));
}
