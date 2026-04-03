/**
 * Eval Skill Bridge — convert between AlphaLoop eval format (checks.yaml)
 * and skill-creator eval format (evals.json).
 *
 * The skill-creator skill (.claude/skills/skill-creator/) uses its own eval format
 * with assertions, grading agents, and benchmarking. This bridge allows:
 *   - Captured eval cases to be converted to skill-creator format for skill testing
 *   - Skill-creator evals to be loaded as AlphaLoop step-level cases
 */
import type { EvalCase } from './eval.js';
import type { CheckDefinition } from './eval-checks.js';

/** A single assertion in skill-creator format. */
export type SkillCreatorAssertion = {
  type: 'contains' | 'contains_any' | 'not_contains' | 'output_contains';
  value?: string;
  values?: string[];
};

/** A single eval case in skill-creator format. */
export type SkillCreatorEvalCase = {
  id: number;
  prompt: string;
  expected_output: string;
  assertions: SkillCreatorAssertion[];
  files: string[];
};

/** The top-level skill-creator eval format (evals.json). */
export type SkillCreatorEval = {
  skill_name: string;
  evals: SkillCreatorEvalCase[];
};

/**
 * Convert an AlphaLoop EvalCase to skill-creator eval format.
 *
 * Maps:
 *   - keyword_present checks → contains assertions
 *   - keyword_absent checks → not_contains assertions
 *   - contains_any checks → contains_any assertions
 *   - llm_judge rubric → expected_output description
 */
export function toSkillCreatorEval(evalCase: EvalCase): SkillCreatorEval {
  const skillName = evalCase.tags.find((t) => t.startsWith('skill:'))?.slice(6)
    ?? evalCase.step
    ?? 'unknown';

  const assertions: SkillCreatorAssertion[] = [];
  let expectedOutput = evalCase.description;

  if (evalCase.checks) {
    for (const check of evalCase.checks) {
      switch (check.type) {
        case 'keyword_present':
          assertions.push({ type: 'contains', values: check.keywords });
          break;
        case 'keyword_absent':
          assertions.push({ type: 'not_contains', values: check.keywords });
          break;
        case 'contains_any':
          assertions.push({ type: 'contains_any', values: check.values });
          break;
        case 'llm_judge':
          expectedOutput = check.rubric;
          break;
      }
    }
  }

  return {
    skill_name: skillName,
    evals: [{
      id: parseInt(evalCase.id.replace(/\D/g, '')) || 1,
      prompt: evalCase.inputText ?? evalCase.issueBody,
      expected_output: expectedOutput,
      assertions,
      files: [],
    }],
  };
}

/**
 * Convert a skill-creator eval back to an AlphaLoop EvalCase.
 *
 * Maps:
 *   - contains/output_contains assertions → keyword_present checks
 *   - contains_any assertions → contains_any checks
 *   - not_contains assertions → keyword_absent checks
 *   - expected_output → llm_judge rubric
 */
export function fromSkillCreatorEval(
  skillEval: SkillCreatorEval,
  caseIndex?: number,
): EvalCase {
  const evalEntry = skillEval.evals[caseIndex ?? 0];
  if (!evalEntry) {
    throw new Error(`No eval case at index ${caseIndex ?? 0} in skill ${skillEval.skill_name}`);
  }

  const checks: CheckDefinition[] = [];

  for (const assertion of evalEntry.assertions) {
    switch (assertion.type) {
      case 'contains':
      case 'output_contains': {
        const keywords = assertion.values
          ?? (assertion.value ? [assertion.value] : []);
        if (keywords.length > 0) {
          checks.push({ type: 'keyword_present', keywords });
        }
        break;
      }
      case 'contains_any': {
        const values = assertion.values
          ?? (assertion.value ? [assertion.value] : []);
        if (values.length > 0) {
          checks.push({ type: 'contains_any', values });
        }
        break;
      }
      case 'not_contains': {
        const keywords = assertion.values
          ?? (assertion.value ? [assertion.value] : []);
        if (keywords.length > 0) {
          checks.push({ type: 'keyword_absent', keywords });
        }
        break;
      }
    }
  }

  // Add llm_judge if there's an expected_output description
  if (evalEntry.expected_output) {
    checks.push({
      type: 'llm_judge',
      model: 'claude-haiku-4-5',
      rubric: `Does the output match this expectation?\n\n${evalEntry.expected_output}\n\n5 = Fully matches\n3 = Partially matches\n1 = Does not match`,
      min_score: 4,
    });
  }

  return {
    id: `skill-${skillEval.skill_name}-${evalEntry.id}`,
    description: evalEntry.expected_output.slice(0, 100),
    type: 'step',
    step: 'skill',
    fixtureRepo: '',
    fixtureRef: 'main',
    issueTitle: `Skill eval: ${skillEval.skill_name}`,
    issueBody: evalEntry.prompt,
    expected: { success: true },
    tags: [`skill:${skillEval.skill_name}`],
    timeout: 60,
    source: 'skill-creator',
    checks,
    inputText: evalEntry.prompt,
  };
}

/**
 * Convert multiple skill-creator eval cases to AlphaLoop format.
 */
export function fromSkillCreatorEvalAll(skillEval: SkillCreatorEval): EvalCase[] {
  return skillEval.evals.map((_, i) => fromSkillCreatorEval(skillEval, i));
}
