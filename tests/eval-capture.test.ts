import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  detectFailureStep,
  saveCapturedCase,
  loadUnannotatedCases,
  annotateCapturedCase,
  loadEvalCases,
  buildQualityRubric,
} from '../src/lib/eval.js';
import type { PipelineResult } from '../src/lib/pipeline.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-capture-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makePipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    issueNum: 47,
    title: 'Add health endpoint',
    status: 'failure',
    testsPassing: false,
    verifyPassing: false,
    verifySkipped: true,
    duration: 120,
    filesChanged: 0,
    ...overrides,
  };
}

describe('detectFailureStep', () => {
  it('returns "implement" when tests not passing and no files changed', () => {
    const result = makePipelineResult({ testsPassing: false, filesChanged: 0 });
    expect(detectFailureStep(result)).toBe('implement');
  });

  it('returns "implement" when tests not passing and 1 file changed', () => {
    const result = makePipelineResult({ testsPassing: false, filesChanged: 1 });
    expect(detectFailureStep(result)).toBe('implement');
  });

  it('returns "test-fix" when tests not passing and multiple files changed', () => {
    const result = makePipelineResult({ testsPassing: false, filesChanged: 3 });
    expect(detectFailureStep(result)).toBe('test-fix');
  });

  it('returns "verify" when tests pass but verify fails', () => {
    const result = makePipelineResult({
      testsPassing: true,
      verifyPassing: false,
      verifySkipped: false,
    });
    expect(detectFailureStep(result)).toBe('verify');
  });

  it('returns "review" when tests and verify pass (or verify skipped)', () => {
    const result = makePipelineResult({
      testsPassing: true,
      verifyPassing: false,
      verifySkipped: true,
    });
    expect(detectFailureStep(result)).toBe('review');
  });

  it('returns "review" when everything passes but status is failure', () => {
    const result = makePipelineResult({
      testsPassing: true,
      verifyPassing: true,
      verifySkipped: false,
    });
    expect(detectFailureStep(result)).toBe('review');
  });
});

describe('saveCapturedCase', () => {
  it('creates the correct directory structure', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    expect(existsSync(casePath)).toBe(true);
    expect(existsSync(join(casePath, 'metadata.yaml'))).toBe(true);
    expect(existsSync(join(casePath, 'checks.yaml'))).toBe(true);
    expect(existsSync(join(casePath, 'issue.md'))).toBe(true);
  });

  it('writes correct metadata.yaml', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      tags: ['typescript', 'api'],
      projectDir: tempDir,
    });

    const metadata = parseYaml(readFileSync(join(casePath, 'metadata.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(metadata.source).toBe('auto-captured');
    expect(metadata.tags).toEqual(['typescript', 'api']);
    expect((metadata.captured_from as Record<string, unknown>).issue).toBe(47);
    expect((metadata.captured_from as Record<string, unknown>).session).toBe('session/20260401-120000');
  });

  it('writes checks.yaml with needs-annotation status', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(checks.type).toBe('step');
    expect(checks.step).toBe('implement');
    expect(checks.status).toBe('needs-annotation');
    expect(checks.eval_method).toBe('pending');
    expect(checks.checks).toEqual([]);
  });

  it('writes issue.md with title and body', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      issueBody: 'We need a GET /health route.',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    const issueContent = readFileSync(join(casePath, 'issue.md'), 'utf-8');
    expect(issueContent).toContain('# Add health endpoint');
    expect(issueContent).toContain('We need a GET /health route.');
  });

  it('creates correct directory path under step/{stepName}/', () => {
    const casePath = saveCapturedCase({
      issueNum: 52,
      title: 'Fix CSV parser',
      step: 'test-fix',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    expect(casePath).toContain(join('cases', 'step', 'test-fix'));
    expect(casePath).toContain('captured-052');
  });

  it('pads issue number to 3 digits', () => {
    const casePath = saveCapturedCase({
      issueNum: 5,
      title: 'Small fix',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    expect(casePath).toContain('captured-005');
  });
});

describe('loadUnannotatedCases', () => {
  it('returns empty when no cases exist', () => {
    expect(loadUnannotatedCases(tempDir)).toEqual([]);
  });

  it('finds needs-annotation cases', () => {
    saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    saveCapturedCase({
      issueNum: 52,
      title: 'Fix CSV parser',
      step: 'test-fix',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    const unannotated = loadUnannotatedCases(tempDir);
    expect(unannotated).toHaveLength(2);
    expect(unannotated[0].evalCase.captureStatus).toBe('needs-annotation');
    expect(unannotated[1].evalCase.captureStatus).toBe('needs-annotation');
  });

  it('excludes annotated cases', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    // Annotate it
    annotateCapturedCase(casePath, {
      whatWentWrong: 'Agent used wrong imports',
      whatShouldHaveHappened: 'Check package.json type field',
    });

    const unannotated = loadUnannotatedCases(tempDir);
    expect(unannotated).toHaveLength(0);
  });
});

describe('annotateCapturedCase', () => {
  it('updates status to ready', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    annotateCapturedCase(casePath, {
      whatWentWrong: 'Agent wrote ESM imports but project uses CommonJS',
      whatShouldHaveHappened: 'Check package.json type field and tsconfig before writing imports',
    });

    const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(checks.status).toBe('ready');
    expect(checks.eval_method).toBe('annotated');
    expect(checks.failure_description).toBe('Agent wrote ESM imports but project uses CommonJS');
    expect(checks.expected_behavior).toBe('Check package.json type field and tsconfig before writing imports');
  });

  it('adds keyword_present checks from annotation', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    annotateCapturedCase(casePath, {
      whatWentWrong: 'Wrong format',
      whatShouldHaveHappened: 'Check package.json type field and tsconfig before writing imports',
    });

    const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
    const checksList = checks.checks as Array<Record<string, unknown>>;
    expect(checksList.length).toBeGreaterThan(0);
    expect(checksList[0].type).toBe('keyword_present');
  });

  it('updates tags in metadata when provided', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      tags: ['existing'],
      projectDir: tempDir,
    });

    annotateCapturedCase(casePath, {
      whatWentWrong: 'Wrong imports',
      whatShouldHaveHappened: 'Check tsconfig',
      tags: ['typescript', 'imports'],
    });

    const metadata = parseYaml(readFileSync(join(casePath, 'metadata.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(metadata.tags).toEqual(expect.arrayContaining(['existing', 'typescript', 'imports']));
  });

  it('throws when casePath has no checks.yaml', () => {
    const fakePath = join(tempDir, 'nonexistent');
    mkdirSync(fakePath, { recursive: true });

    expect(() =>
      annotateCapturedCase(fakePath, {
        whatWentWrong: 'test',
        whatShouldHaveHappened: 'test',
      }),
    ).toThrow('No checks.yaml found');
  });
});

describe('loadEvalCases — unannotated filtering', () => {
  it('excludes needs-annotation cases by default', () => {
    saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    const cases = loadEvalCases({ projectDir: tempDir });
    expect(cases).toHaveLength(0);
  });

  it('includes needs-annotation cases when includeUnannotated is true', () => {
    saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    const cases = loadEvalCases({ projectDir: tempDir, includeUnannotated: true });
    expect(cases).toHaveLength(1);
    expect(cases[0].captureStatus).toBe('needs-annotation');
  });

  it('includes annotated captured cases in normal eval runs', () => {
    const casePath = saveCapturedCase({
      issueNum: 47,
      title: 'Add health endpoint',
      step: 'implement',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    annotateCapturedCase(casePath, {
      whatWentWrong: 'Wrong imports',
      whatShouldHaveHappened: 'Check tsconfig',
    });

    const cases = loadEvalCases({ projectDir: tempDir });
    expect(cases).toHaveLength(1);
    expect(cases[0].captureStatus).toBe('ready');
  });
});

describe('auto-capture integration', () => {
  it('saveCapturedCase + annotateCapturedCase produces a runnable case', () => {
    // Simulate auto-capture
    const casePath = saveCapturedCase({
      issueNum: 58,
      title: 'Add dark mode toggle',
      step: 'verify',
      session: 'session/20260401-120000',
      projectDir: tempDir,
    });

    // Verify skeleton
    let checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(checks.status).toBe('needs-annotation');
    expect(checks.checks).toEqual([]);

    // Simulate annotation
    annotateCapturedCase(casePath, {
      whatWentWrong: 'Dark mode toggle did not persist across page reload',
      whatShouldHaveHappened: 'Toggle state should be saved to localStorage',
      tags: ['ui', 'persistence'],
    });

    // Verify annotated state
    checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(checks.status).toBe('ready');
    expect(checks.failure_description).toContain('persist');
    expect(checks.expected_behavior).toContain('localStorage');

    // Should now appear in normal eval case loading
    const cases = loadEvalCases({ projectDir: tempDir });
    expect(cases).toHaveLength(1);
    expect(cases[0].id).toContain('captured-058');
    expect(cases[0].step).toBe('verify');
  });
});

describe('quality capture mode', () => {
  describe('buildQualityRubric', () => {
    it('generates a rubric from failure description', () => {
      const rubric = buildQualityRubric(
        'ArtifactRepo never injected into services',
        'Review should flag missing DI wiring',
      );

      expect(rubric).toContain('Score 1-5');
      expect(rubric).toContain('ArtifactRepo never injected');
      expect(rubric).toContain('Review should flag missing DI wiring');
      expect(rubric).toContain('5 =');
      expect(rubric).toContain('1 =');
    });
  });

  describe('saveCapturedCase with source', () => {
    it('uses custom source when provided', () => {
      const casePath = saveCapturedCase({
        issueNum: 190,
        title: 'Add artifact repository',
        step: 'review',
        session: 'layer-7-5-simulation-validation',
        tags: ['quality-failure', 'wiring'],
        source: 'quality-capture',
        projectDir: tempDir,
      });

      const metadata = parseYaml(readFileSync(join(casePath, 'metadata.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(metadata.source).toBe('quality-capture');

      const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(checks.source).toBe('quality-capture');
    });

    it('defaults source to auto-captured when not provided', () => {
      const casePath = saveCapturedCase({
        issueNum: 47,
        title: 'Add health endpoint',
        step: 'implement',
        session: 'session/20260401-120000',
        projectDir: tempDir,
      });

      const metadata = parseYaml(readFileSync(join(casePath, 'metadata.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(metadata.source).toBe('auto-captured');
    });
  });

  describe('annotateCapturedCase with qualityRubric', () => {
    it('uses llm-judge eval method when qualityRubric is provided', () => {
      const casePath = saveCapturedCase({
        issueNum: 190,
        title: 'Add artifact repository',
        step: 'review',
        session: 'layer-7-5-simulation-validation',
        source: 'quality-capture',
        projectDir: tempDir,
      });

      const rubric = buildQualityRubric(
        'ArtifactRepo never injected',
        'Review should flag missing DI',
      );

      annotateCapturedCase(casePath, {
        whatWentWrong: 'ArtifactRepo never injected',
        whatShouldHaveHappened: 'Review should flag missing DI',
        tags: ['quality-failure'],
        qualityRubric: rubric,
      });

      const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
      expect(checks.status).toBe('ready');
      expect(checks.eval_method).toBe('llm-judge');

      const checksList = checks.checks as Array<Record<string, unknown>>;
      expect(checksList.length).toBeGreaterThanOrEqual(1);

      const llmJudge = checksList.find((c) => c.type === 'llm_judge');
      expect(llmJudge).toBeDefined();
      expect(llmJudge!.rubric).toContain('ArtifactRepo never injected');
      expect(llmJudge!.min_score).toBe(4);
    });

    it('includes both llm_judge and keyword_present checks', () => {
      const casePath = saveCapturedCase({
        issueNum: 190,
        title: 'Add artifact repository',
        step: 'review',
        session: 'session/test',
        source: 'quality-capture',
        projectDir: tempDir,
      });

      annotateCapturedCase(casePath, {
        whatWentWrong: 'Service never wired',
        whatShouldHaveHappened: 'Review should detect missing dependency injection wiring',
        qualityRubric: buildQualityRubric('Service never wired', 'Review should detect missing dependency injection wiring'),
      });

      const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
      const checksList = checks.checks as Array<Record<string, unknown>>;

      const types = checksList.map((c) => c.type);
      expect(types).toContain('llm_judge');
      expect(types).toContain('keyword_present');
    });
  });

  describe('quality capture end-to-end', () => {
    it('produces a runnable quality-capture case', () => {
      const casePath = saveCapturedCase({
        issueNum: 192,
        title: 'Wire tool executor service',
        step: 'review',
        session: 'layer-7-5-simulation-validation',
        tags: ['quality-failure', 'wiring'],
        source: 'quality-capture',
        projectDir: tempDir,
      });

      const rubric = buildQualityRubric(
        'ToolExecutor created but never added to service container',
        'Review should flag services created but not registered in bootstrap',
      );

      annotateCapturedCase(casePath, {
        whatWentWrong: 'ToolExecutor created but never added to service container',
        whatShouldHaveHappened: 'Review should flag services created but not registered in bootstrap',
        tags: ['quality-failure', 'wiring'],
        qualityRubric: rubric,
      });

      // Should appear in normal eval case loading
      const cases = loadEvalCases({ projectDir: tempDir });
      expect(cases).toHaveLength(1);
      expect(cases[0].source).toBe('quality-capture');
      expect(cases[0].tags).toContain('quality-failure');
      expect(cases[0].step).toBe('review');
      expect(cases[0].captureStatus).toBe('ready');

      // Verify checks include LLM judge
      expect(cases[0].checks).toBeDefined();
      const llmCheck = cases[0].checks!.find((c) => c.type === 'llm_judge');
      expect(llmCheck).toBeDefined();
    });
  });
});
