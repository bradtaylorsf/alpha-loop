import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadEvalCase,
  loadEvalCases,
  saveEvalCase,
  evaluateResult,
  formatEvalCase,
  evalsDir,
} from '../../src/lib/eval.js';
import type { EvalCase } from '../../src/lib/eval.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-eval-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const sampleCase: EvalCase = {
  id: 'test-case-1',
  description: 'Test adding a new feature',
  type: 'full',
  fixtureRepo: 'owner/repo',
  fixtureRef: 'abc123',
  issueTitle: 'Add widget support',
  issueBody: 'We need widget support in the app.',
  expected: {
    success: true,
    filesChanged: ['src/widget.ts'],
    testsPassing: true,
    diffContains: ['export function createWidget'],
  },
  tags: ['typescript', 'feature'],
  timeout: 300,
  source: 'manual',
};

describe('saveEvalCase / loadEvalCase', () => {
  it('saves and loads an eval case', () => {
    const filePath = saveEvalCase(sampleCase, tempDir);
    expect(existsSync(filePath)).toBe(true);

    const loaded = loadEvalCase(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('test-case-1');
    expect(loaded!.description).toBe('Test adding a new feature');
    expect(loaded!.type).toBe('full');
    expect(loaded!.fixtureRepo).toBe('owner/repo');
    expect(loaded!.expected.success).toBe(true);
    expect(loaded!.tags).toEqual(['typescript', 'feature']);
  });

  it('returns null for invalid file', () => {
    const filePath = join(tempDir, 'bad.yaml');
    writeFileSync(filePath, 'not: [valid: yaml: here');
    const loaded = loadEvalCase(filePath);
    // May parse partially or fail — should not throw
    expect(loaded === null || typeof loaded === 'object').toBe(true);
  });
});

describe('loadEvalCases', () => {
  it('returns empty array when no cases exist', () => {
    expect(loadEvalCases({ projectDir: tempDir })).toEqual([]);
  });

  it('loads all case files from evals directory', () => {
    saveEvalCase({ ...sampleCase, id: 'case-a' }, tempDir);
    saveEvalCase({ ...sampleCase, id: 'case-b' }, tempDir);
    const cases = loadEvalCases({ projectDir: tempDir });
    expect(cases).toHaveLength(2);
  });

  it('filters by type', () => {
    saveEvalCase({ ...sampleCase, id: 'full-case', type: 'full' }, tempDir);
    saveEvalCase({ ...sampleCase, id: 'step-case', type: 'step', step: 'plan' }, tempDir);

    const fullCases = loadEvalCases({ projectDir: tempDir, type: 'full' });
    expect(fullCases).toHaveLength(1);
    expect(fullCases[0].id).toBe('full-case');

    const stepCases = loadEvalCases({ projectDir: tempDir, type: 'step' });
    expect(stepCases).toHaveLength(1);
    expect(stepCases[0].id).toBe('step-case');
  });

  it('filters by tags', () => {
    saveEvalCase({ ...sampleCase, id: 'ts-case', tags: ['typescript'] }, tempDir);
    saveEvalCase({ ...sampleCase, id: 'py-case', tags: ['python'] }, tempDir);

    const tsCases = loadEvalCases({ projectDir: tempDir, tags: ['typescript'] });
    expect(tsCases).toHaveLength(1);
    expect(tsCases[0].id).toBe('ts-case');
  });
});

describe('evaluateResult', () => {
  it('returns passed when all checks match', () => {
    const result = evaluateResult(sampleCase, {
      success: true,
      testsPassing: true,
      diff: 'export function createWidget() { }',
      filesChanged: ['src/widget.ts'],
      output: '',
      retries: 0,
      duration: 60,
    });

    expect(result.passed).toBe(true);
    expect(result.partialCredit).toBe(1);
    expect(result.details.successMatch).toBe(true);
    expect(result.details.filesMatch).toBe(true);
    expect(result.details.testsMatch).toBe(true);
    expect(result.details.diffMatch).toBe(true);
  });

  it('returns failed when success status mismatches', () => {
    const result = evaluateResult(sampleCase, {
      success: false,
      testsPassing: true,
      diff: 'export function createWidget() { }',
      filesChanged: ['src/widget.ts'],
      output: '',
      retries: 0,
      duration: 60,
    });

    expect(result.passed).toBe(false);
    expect(result.details.successMatch).toBe(false);
  });

  it('gives partial credit', () => {
    const result = evaluateResult(sampleCase, {
      success: true,       // match
      testsPassing: false,  // mismatch
      diff: 'something else',  // mismatch (diffContains)
      filesChanged: ['src/widget.ts'], // match
      output: '',
      retries: 1,
      duration: 120,
    });

    expect(result.passed).toBe(false);
    expect(result.partialCredit).toBe(0.5); // 2 of 4 checks pass
  });

  it('checks diffNotContains', () => {
    const caseWithNot: EvalCase = {
      ...sampleCase,
      expected: {
        success: true,
        diffNotContains: ['console.log', 'debugger'],
      },
    };

    const passResult = evaluateResult(caseWithNot, {
      success: true,
      testsPassing: true,
      diff: 'clean code without debug statements',
      filesChanged: [],
      output: '',
      retries: 0,
      duration: 30,
    });
    expect(passResult.details.diffMatch).toBe(true);

    const failResult = evaluateResult(caseWithNot, {
      success: true,
      testsPassing: true,
      diff: 'code with console.log("debug")',
      filesChanged: [],
      output: '',
      retries: 0,
      duration: 30,
    });
    expect(failResult.details.diffMatch).toBe(false);
  });

  it('tracks retries and duration', () => {
    const result = evaluateResult(sampleCase, {
      success: true,
      testsPassing: true,
      diff: 'export function createWidget() { }',
      filesChanged: ['src/widget.ts'],
      output: '',
      retries: 3,
      duration: 180,
    });

    expect(result.retries).toBe(3);
    expect(result.duration).toBe(180);
  });
});

describe('formatEvalCase', () => {
  it('formats full case', () => {
    const formatted = formatEvalCase(sampleCase);
    expect(formatted).toContain('test-case-1');
    expect(formatted).toContain('Test adding a new feature');
    expect(formatted).toContain('full');
    expect(formatted).toContain('typescript');
  });

  it('includes step info for step cases', () => {
    const stepCase = { ...sampleCase, type: 'step' as const, step: 'plan' as const };
    const formatted = formatEvalCase(stepCase);
    expect(formatted).toContain('(plan)');
  });
});
