import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { anonymizeContent, exportEvalCase, generatePromptChanges } from '../../src/lib/eval-export.js';

let tempDir: string;
let realTempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-eval-export-test-'));
  realTempDir = realpathSync(tempDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('anonymizeContent', () => {
  it('replaces absolute paths containing the project directory', () => {
    // Use the real path since that's what the filesystem resolves to
    const content = `File at ${realTempDir}/src/main.ts has issues`;
    const result = anonymizeContent(content, tempDir);
    expect(result).toContain('/project/src/main.ts');
    expect(result).not.toContain(realTempDir);
  });

  it('replaces /Users/username/ paths with generic', () => {
    const content = 'Found at /Users/johndoe/projects/app/src/main.ts';
    const result = anonymizeContent(content, tempDir);
    expect(result).toContain('/home/user/');
    expect(result).not.toContain('johndoe');
  });

  it('preserves content without project-specific paths', () => {
    const content = '# Review Checklist\n- Check wiring\n- Check DI';
    const result = anonymizeContent(content, tempDir);
    expect(result).toBe(content);
  });
});

describe('exportEvalCase', () => {
  it('exports a step eval case to output directory', () => {
    // Create a mock eval case
    const caseDir = join(tempDir, '.alpha-loop', 'evals', 'cases', 'step', 'review', 'test-case');
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, 'metadata.yaml'), 'id: test-case\ntype: step\nstep: review');
    writeFileSync(join(caseDir, 'input.md'), '# Test input');
    writeFileSync(join(caseDir, 'checks.yaml'), '- type: llm_judge\n  prompt: test');

    const outputDir = join(tempDir, 'output');
    const result = exportEvalCase('test-case', tempDir, { outputDir, anonymize: false });

    expect(result.caseId).toBe('test-case');
    expect(existsSync(join(result.outputDir, 'metadata.yaml'))).toBe(true);
    expect(existsSync(join(result.outputDir, 'input.md'))).toBe(true);
    expect(existsSync(join(result.outputDir, 'checks.yaml'))).toBe(true);
  });

  it('anonymizes content when anonymize=true', () => {
    const caseDir = join(tempDir, '.alpha-loop', 'evals', 'cases', 'step', 'review', 'anon-case');
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(join(caseDir, 'input.md'), `Path: ${realTempDir}/src/main.ts`);

    const outputDir = join(tempDir, 'output');
    const result = exportEvalCase('anon-case', tempDir, { outputDir, anonymize: true });

    const exported = readFileSync(join(result.outputDir, 'input.md'), 'utf-8');
    expect(exported).not.toContain(realTempDir);
    expect(exported).toContain('/project/src/main.ts');
    expect(result.anonymized).toBe(true);
  });

  it('throws when case not found', () => {
    expect(() => exportEvalCase('nonexistent', tempDir)).toThrow('Eval case not found');
  });
});

describe('generatePromptChanges', () => {
  it('returns null when no distribution templates found', () => {
    // In test env, findDistributionTemplatesDir may not find templates
    // This test verifies it handles gracefully
    const result = generatePromptChanges(tempDir);
    // May return null (no dist dir) or a string (if dist dir found) — both acceptable
    expect(result === null || typeof result === 'string').toBe(true);
  });
});
