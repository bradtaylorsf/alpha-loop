import {
  toSkillCreatorEval,
  fromSkillCreatorEval,
  fromSkillCreatorEvalAll,
} from '../src/lib/eval-skill-bridge.js';
import type { EvalCase } from '../src/lib/eval.js';
import type { SkillCreatorEval } from '../src/lib/eval-skill-bridge.js';

function makeEvalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: '001-test',
    description: 'Test case',
    type: 'step',
    step: 'skill',
    fixtureRepo: '',
    fixtureRef: 'main',
    issueTitle: 'Skill eval test',
    issueBody: 'Review this PR for security issues',
    expected: { success: true },
    tags: ['skill:code-review'],
    timeout: 60,
    source: 'manual',
    inputText: 'Review this PR for security issues',
    ...overrides,
  };
}

describe('toSkillCreatorEval', () => {
  it('converts a basic eval case to skill-creator format', () => {
    const evalCase = makeEvalCase();
    const result = toSkillCreatorEval(evalCase);

    expect(result.skill_name).toBe('code-review');
    expect(result.evals).toHaveLength(1);
    expect(result.evals[0].prompt).toBe('Review this PR for security issues');
    expect(result.evals[0].id).toBe(1);
  });

  it('extracts skill name from tags', () => {
    const evalCase = makeEvalCase({ tags: ['skill:testing-patterns', 'fast'] });
    const result = toSkillCreatorEval(evalCase);
    expect(result.skill_name).toBe('testing-patterns');
  });

  it('falls back to step name if no skill tag', () => {
    const evalCase = makeEvalCase({ tags: ['fast'], step: 'review' });
    const result = toSkillCreatorEval(evalCase);
    expect(result.skill_name).toBe('review');
  });

  it('converts keyword_present checks to contains assertions', () => {
    const evalCase = makeEvalCase({
      checks: [
        { type: 'keyword_present', keywords: ['SQL injection', 'parameterized'] },
      ],
    });
    const result = toSkillCreatorEval(evalCase);

    expect(result.evals[0].assertions).toHaveLength(1);
    expect(result.evals[0].assertions[0].type).toBe('contains');
    expect(result.evals[0].assertions[0].values).toEqual(['SQL injection', 'parameterized']);
  });

  it('converts keyword_absent checks to not_contains assertions', () => {
    const evalCase = makeEvalCase({
      checks: [
        { type: 'keyword_absent', keywords: ['LGTM'] },
      ],
    });
    const result = toSkillCreatorEval(evalCase);

    expect(result.evals[0].assertions).toHaveLength(1);
    expect(result.evals[0].assertions[0].type).toBe('not_contains');
    expect(result.evals[0].assertions[0].values).toEqual(['LGTM']);
  });

  it('converts contains_any checks to contains_any assertions', () => {
    const evalCase = makeEvalCase({
      checks: [
        { type: 'contains_any', values: ['option-a', 'option-b'] },
      ],
    });
    const result = toSkillCreatorEval(evalCase);

    expect(result.evals[0].assertions).toHaveLength(1);
    expect(result.evals[0].assertions[0].type).toBe('contains_any');
    expect(result.evals[0].assertions[0].values).toEqual(['option-a', 'option-b']);
  });

  it('converts llm_judge rubric to expected_output', () => {
    const evalCase = makeEvalCase({
      checks: [
        { type: 'llm_judge', model: 'claude-haiku-4-5', rubric: 'Check for security issues', min_score: 4 },
      ],
    });
    const result = toSkillCreatorEval(evalCase);

    expect(result.evals[0].expected_output).toBe('Check for security issues');
  });

  it('uses issueBody when no inputText', () => {
    const evalCase = makeEvalCase({ inputText: undefined, issueBody: 'Review the code' });
    const result = toSkillCreatorEval(evalCase);
    expect(result.evals[0].prompt).toBe('Review the code');
  });
});

describe('fromSkillCreatorEval', () => {
  const skillEval: SkillCreatorEval = {
    skill_name: 'code-review',
    evals: [
      {
        id: 1,
        prompt: 'Review this PR for SQL injection',
        expected_output: 'Should identify SQL injection and suggest parameterized queries',
        assertions: [
          { type: 'contains_any', values: ['SQL injection', 'parameterized'] },
          { type: 'not_contains', values: ['LGTM'] },
          { type: 'output_contains', value: 'vulnerability' },
        ],
        files: [],
      },
      {
        id: 2,
        prompt: 'Review this clean diff',
        expected_output: 'Should approve without false positives',
        assertions: [],
        files: [],
      },
    ],
  };

  it('converts first eval case by default', () => {
    const result = fromSkillCreatorEval(skillEval);
    expect(result.id).toBe('skill-code-review-1');
    expect(result.step).toBe('skill');
    expect(result.inputText).toBe('Review this PR for SQL injection');
    expect(result.source).toBe('skill-creator');
  });

  it('converts contains_any assertions to contains_any checks', () => {
    const result = fromSkillCreatorEval(skillEval);
    const containsAny = result.checks?.find((c) => c.type === 'contains_any');
    expect(containsAny).toBeDefined();
    if (containsAny?.type === 'contains_any') {
      expect(containsAny.values).toEqual(['SQL injection', 'parameterized']);
    }
  });

  it('converts not_contains assertions to keyword_absent checks', () => {
    const result = fromSkillCreatorEval(skillEval);
    const absent = result.checks?.find((c) => c.type === 'keyword_absent');
    expect(absent).toBeDefined();
    if (absent?.type === 'keyword_absent') {
      expect(absent.keywords).toEqual(['LGTM']);
    }
  });

  it('converts output_contains to keyword_present', () => {
    const result = fromSkillCreatorEval(skillEval);
    const present = result.checks?.find((c) => c.type === 'keyword_present');
    expect(present).toBeDefined();
    if (present?.type === 'keyword_present') {
      expect(present.keywords).toEqual(['vulnerability']);
    }
  });

  it('adds llm_judge from expected_output', () => {
    const result = fromSkillCreatorEval(skillEval);
    const judge = result.checks?.find((c) => c.type === 'llm_judge');
    expect(judge).toBeDefined();
    if (judge?.type === 'llm_judge') {
      expect(judge.model).toBe('claude-haiku-4-5');
      expect(judge.rubric).toContain('SQL injection');
      expect(judge.min_score).toBe(4);
    }
  });

  it('converts specific case by index', () => {
    const result = fromSkillCreatorEval(skillEval, 1);
    expect(result.id).toBe('skill-code-review-2');
    expect(result.inputText).toBe('Review this clean diff');
  });

  it('throws for invalid index', () => {
    expect(() => fromSkillCreatorEval(skillEval, 5)).toThrow('No eval case at index 5');
  });

  it('tags with skill name', () => {
    const result = fromSkillCreatorEval(skillEval);
    expect(result.tags).toContain('skill:code-review');
  });
});

describe('fromSkillCreatorEvalAll', () => {
  it('converts all eval cases', () => {
    const skillEval: SkillCreatorEval = {
      skill_name: 'testing',
      evals: [
        { id: 1, prompt: 'Test A', expected_output: 'Result A', assertions: [], files: [] },
        { id: 2, prompt: 'Test B', expected_output: 'Result B', assertions: [], files: [] },
        { id: 3, prompt: 'Test C', expected_output: 'Result C', assertions: [], files: [] },
      ],
    };

    const results = fromSkillCreatorEvalAll(skillEval);
    expect(results).toHaveLength(3);
    expect(results[0].id).toBe('skill-testing-1');
    expect(results[1].id).toBe('skill-testing-2');
    expect(results[2].id).toBe('skill-testing-3');
  });
});
