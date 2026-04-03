import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { loadEvalCases } from '../src/lib/eval.js';
import type { PipelineStep } from '../src/lib/eval.js';

const PROJECT_DIR = join(__dirname, '..');

describe('step-level eval cases', () => {
  const stepDirs = ['plan', 'implement', 'test', 'review', 'learn', 'skill', 'test-fix'];

  it('has at least 5 cases per step', () => {
    for (const step of stepDirs) {
      const stepPath = join(PROJECT_DIR, '.alpha-loop', 'evals', 'cases', 'step', step);
      if (!existsSync(stepPath)) {
        fail(`Step directory missing: ${step}`);
      }
      const cases = readdirSync(stepPath, { withFileTypes: true })
        .filter((d) => d.isDirectory());
      expect(cases.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('loads at least 35 total step-level cases', () => {
    const cases = loadEvalCases({ projectDir: PROJECT_DIR, type: 'step' });
    expect(cases.length).toBeGreaterThanOrEqual(35);
  });

  it('each case has metadata.yaml, checks.yaml, and input.md', () => {
    for (const step of stepDirs) {
      const stepPath = join(PROJECT_DIR, '.alpha-loop', 'evals', 'cases', 'step', step);
      if (!existsSync(stepPath)) continue;

      const caseDirs = readdirSync(stepPath, { withFileTypes: true })
        .filter((d) => d.isDirectory());

      for (const caseDir of caseDirs) {
        const casePath = join(stepPath, caseDir.name);
        expect(existsSync(join(casePath, 'metadata.yaml'))).toBe(true);
        expect(existsSync(join(casePath, 'checks.yaml'))).toBe(true);
        expect(existsSync(join(casePath, 'input.md'))).toBe(true);
      }
    }
  });

  it('all cases have status: ready', () => {
    const cases = loadEvalCases({ projectDir: PROJECT_DIR, type: 'step' });
    for (const evalCase of cases) {
      expect(evalCase.captureStatus).not.toBe('needs-annotation');
    }
  });

  it('cases load with correct step values', () => {
    const cases = loadEvalCases({ projectDir: PROJECT_DIR, type: 'step' });

    const steps = new Set(cases.map((c) => c.step));
    expect(steps).toContain('plan');
    expect(steps).toContain('implement');
    expect(steps).toContain('test');
    expect(steps).toContain('review');
    expect(steps).toContain('learn');
    expect(steps).toContain('skill');
    expect(steps).toContain('test-fix');
  });

  it('filters by step correctly', () => {
    for (const step of stepDirs) {
      const cases = loadEvalCases({
        projectDir: PROJECT_DIR,
        type: 'step',
        step: step as PipelineStep,
      });
      expect(cases.length).toBeGreaterThanOrEqual(5);
      for (const c of cases) {
        expect(c.step).toBe(step);
      }
    }
  });

  it('all cases have at least one check defined', () => {
    const cases = loadEvalCases({ projectDir: PROJECT_DIR, type: 'step' });
    for (const evalCase of cases) {
      expect(evalCase.checks?.length).toBeGreaterThan(0);
    }
  });

  it('all cases have non-empty input text', () => {
    const cases = loadEvalCases({ projectDir: PROJECT_DIR, type: 'step' });
    for (const evalCase of cases) {
      const input = evalCase.inputText ?? evalCase.issueBody;
      expect(input.length).toBeGreaterThan(10);
    }
  });

  it('skill cases use contains_any or not_contains checks', () => {
    const cases = loadEvalCases({
      projectDir: PROJECT_DIR,
      type: 'step',
      step: 'skill',
    });

    const hasSkillChecks = cases.some((c) =>
      c.checks?.some((check) =>
        check.type === 'contains_any' || check.type === 'not_contains'
      )
    );
    expect(hasSkillChecks).toBe(true);
  });

  it('review cases have diff-like content in input', () => {
    const cases = loadEvalCases({
      projectDir: PROJECT_DIR,
      type: 'step',
      step: 'review',
    });

    for (const evalCase of cases) {
      const input = evalCase.inputText ?? evalCase.issueBody;
      // Review inputs should contain diff markers
      expect(input).toMatch(/diff|---|\+\+\+|@@/);
    }
  });
});
