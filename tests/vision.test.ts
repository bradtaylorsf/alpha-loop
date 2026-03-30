import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getVisionContext, hasVision } from '../src/lib/vision.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vision-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('getVisionContext', () => {
  it('returns content when vision.md exists', () => {
    const visionDir = join(tempDir, '.alpha-loop');
    mkdirSync(visionDir, { recursive: true });
    writeFileSync(join(visionDir, 'vision.md'), 'Build the best loop', 'utf-8');

    expect(getVisionContext(tempDir)).toBe('Build the best loop');
  });

  it('returns null when vision.md does not exist', () => {
    expect(getVisionContext(tempDir)).toBeNull();
  });
});

describe('hasVision', () => {
  it('returns true when vision.md exists', () => {
    const visionDir = join(tempDir, '.alpha-loop');
    mkdirSync(visionDir, { recursive: true });
    writeFileSync(join(visionDir, 'vision.md'), 'content', 'utf-8');

    expect(hasVision(tempDir)).toBe(true);
  });

  it('returns false when vision.md does not exist', () => {
    expect(hasVision(tempDir)).toBe(false);
  });
});
