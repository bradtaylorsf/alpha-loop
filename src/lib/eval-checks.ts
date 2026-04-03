/**
 * Eval Check Executor — runs machine-checkable acceptance criteria.
 *
 * Check types:
 *   E2E: test_pass, file_exists, grep, http, diff_size
 *   Step: keyword_present, keyword_absent, llm_judge
 *
 * Each check returns { passed, score, detail }.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from './shell.js';
import { spawnAgent } from './agent.js';
import { log } from './logger.js';

/** Result of running a single check. */
export type CheckResult = {
  passed: boolean;
  score: number;
  detail: string;
};

/** Base check with a type discriminator. */
type BaseCheck = { type: string };

/** All tests must pass. */
export type TestPassCheck = BaseCheck & {
  type: 'test_pass';
};

/** A specific file must exist. */
export type FileExistsCheck = BaseCheck & {
  type: 'file_exists';
  path: string;
};

/** A pattern must exist in a file. */
export type GrepCheck = BaseCheck & {
  type: 'grep';
  file: string;
  pattern: string;
};

/** HTTP endpoint check. */
export type HttpCheck = BaseCheck & {
  type: 'http';
  method: string;
  path: string;
  port?: number;
  expect_status: number;
  expect_body_contains?: string;
};

/** Diff size limit check. */
export type DiffSizeCheck = BaseCheck & {
  type: 'diff_size';
  max_files?: number;
  max_lines?: number;
};

/** Keywords that must be present in output. */
export type KeywordPresentCheck = BaseCheck & {
  type: 'keyword_present';
  keywords: string[];
};

/** Keywords that must be absent from output. */
export type KeywordAbsentCheck = BaseCheck & {
  type: 'keyword_absent';
  keywords: string[];
};

/** LLM-judge evaluation. */
export type LlmJudgeCheck = BaseCheck & {
  type: 'llm_judge';
  model: string;
  rubric: string;
  min_score: number;
};

/** Contains any — pass if ANY value in the array is found (skill-creator compat). */
export type ContainsAnyCheck = BaseCheck & {
  type: 'contains_any';
  values: string[];
};

/** Not contains — fail if ANY forbidden keyword is found (skill-creator compat). */
export type NotContainsCheck = BaseCheck & {
  type: 'not_contains';
  values: string[];
};

/** Union of all check types. */
export type CheckDefinition =
  | TestPassCheck
  | FileExistsCheck
  | GrepCheck
  | HttpCheck
  | DiffSizeCheck
  | KeywordPresentCheck
  | KeywordAbsentCheck
  | LlmJudgeCheck
  | ContainsAnyCheck
  | NotContainsCheck;

/** Context passed to check runners. */
export type CheckContext = {
  /** Working directory (worktree root). */
  cwd: string;
  /** Test command to run. */
  testCommand?: string;
  /** Agent output (for step evals). */
  output?: string;
  /** Git diff of changes. */
  diff?: string;
  /** List of changed files. */
  filesChanged?: string[];
  /** Model to use for LLM judge (fallback). */
  judgeModel?: string;
};

/**
 * Run a single check against the given context.
 */
export async function runCheck(check: CheckDefinition, ctx: CheckContext): Promise<CheckResult> {
  switch (check.type) {
    case 'test_pass':
      return runTestPassCheck(check, ctx);
    case 'file_exists':
      return runFileExistsCheck(check, ctx);
    case 'grep':
      return runGrepCheck(check, ctx);
    case 'http':
      return runHttpCheck(check, ctx);
    case 'diff_size':
      return runDiffSizeCheck(check, ctx);
    case 'keyword_present':
      return runKeywordPresentCheck(check, ctx);
    case 'keyword_absent':
      return runKeywordAbsentCheck(check, ctx);
    case 'llm_judge':
      return runLlmJudgeCheck(check, ctx);
    case 'contains_any':
      return runContainsAnyCheck(check, ctx);
    case 'not_contains':
      return runNotContainsCheck(check, ctx);
    default:
      return { passed: false, score: 0, detail: `Unknown check type: ${(check as BaseCheck).type}` };
  }
}

/**
 * Run all checks and return aggregate results.
 */
export async function runChecks(checks: CheckDefinition[], ctx: CheckContext): Promise<{
  results: CheckResult[];
  allPassed: boolean;
  avgScore: number;
}> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    try {
      const result = await runCheck(check, ctx);
      results.push(result);
    } catch (err) {
      results.push({
        passed: false,
        score: 0,
        detail: `Check ${check.type} threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const allPassed = results.every((r) => r.passed);
  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0;

  return { results, allPassed, avgScore };
}

// --- Individual check runners ---

async function runTestPassCheck(_check: TestPassCheck, ctx: CheckContext): Promise<CheckResult> {
  const cmd = ctx.testCommand ?? 'npm test';
  const result = exec(cmd, { cwd: ctx.cwd, timeout: 120_000 });
  const passed = result.exitCode === 0;
  return {
    passed,
    score: passed ? 1 : 0,
    detail: passed ? 'All tests passed' : `Tests failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
  };
}

async function runFileExistsCheck(check: FileExistsCheck, ctx: CheckContext): Promise<CheckResult> {
  const fullPath = join(ctx.cwd, check.path);
  const passed = existsSync(fullPath);
  return {
    passed,
    score: passed ? 1 : 0,
    detail: passed ? `File exists: ${check.path}` : `File not found: ${check.path}`,
  };
}

async function runGrepCheck(check: GrepCheck, ctx: CheckContext): Promise<CheckResult> {
  const fullPath = join(ctx.cwd, check.file);
  if (!existsSync(fullPath)) {
    return { passed: false, score: 0, detail: `File not found: ${check.file}` };
  }
  const content = readFileSync(fullPath, 'utf-8');
  const regex = new RegExp(check.pattern);
  const passed = regex.test(content);
  return {
    passed,
    score: passed ? 1 : 0,
    detail: passed ? `Pattern "${check.pattern}" found in ${check.file}` : `Pattern "${check.pattern}" not found in ${check.file}`,
  };
}

async function runHttpCheck(check: HttpCheck, ctx: CheckContext): Promise<CheckResult> {
  try {
    const url = `http://localhost:${check.port ?? 3000}${check.path}`;
    const response = await fetch(url, { method: check.method, signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    const statusMatch = response.status === check.expect_status;
    const bodyMatch = check.expect_body_contains ? body.includes(check.expect_body_contains) : true;
    const passed = statusMatch && bodyMatch;
    return {
      passed,
      score: passed ? 1 : 0,
      detail: passed
        ? `HTTP ${check.method} ${check.path} returned ${response.status}`
        : `HTTP check failed: status=${response.status} (expected ${check.expect_status}), body match=${bodyMatch}`,
    };
  } catch (err) {
    return {
      passed: false,
      score: 0,
      detail: `HTTP check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runDiffSizeCheck(check: DiffSizeCheck, ctx: CheckContext): Promise<CheckResult> {
  const filesCount = ctx.filesChanged?.length ?? 0;
  const diff = ctx.diff ?? '';
  const lineCount = diff.split('\n').filter((l) => l.startsWith('+') || l.startsWith('-')).length;

  const fileOk = check.max_files == null || filesCount <= check.max_files;
  const lineOk = check.max_lines == null || lineCount <= check.max_lines;
  const passed = fileOk && lineOk;

  return {
    passed,
    score: passed ? 1 : 0,
    detail: `Diff: ${filesCount} files, ${lineCount} lines` +
      (!fileOk ? ` (max ${check.max_files} files exceeded)` : '') +
      (!lineOk ? ` (max ${check.max_lines} lines exceeded)` : ''),
  };
}

async function runKeywordPresentCheck(check: KeywordPresentCheck, ctx: CheckContext): Promise<CheckResult> {
  const output = ctx.output ?? '';
  const found = check.keywords.filter((kw) => output.includes(kw));
  const missing = check.keywords.filter((kw) => !output.includes(kw));
  const passed = missing.length === 0;
  return {
    passed,
    score: check.keywords.length > 0 ? found.length / check.keywords.length : 1,
    detail: passed
      ? `All keywords found: ${check.keywords.join(', ')}`
      : `Missing keywords: ${missing.join(', ')}`,
  };
}

async function runKeywordAbsentCheck(check: KeywordAbsentCheck, ctx: CheckContext): Promise<CheckResult> {
  const output = ctx.output ?? '';
  const present = check.keywords.filter((kw) => output.includes(kw));
  const passed = present.length === 0;
  return {
    passed,
    score: passed ? 1 : 0,
    detail: passed
      ? `No forbidden keywords found`
      : `Forbidden keywords present: ${present.join(', ')}`,
  };
}

async function runLlmJudgeCheck(check: LlmJudgeCheck, ctx: CheckContext): Promise<CheckResult> {
  const model = check.model || ctx.judgeModel || 'claude-haiku-4-5';
  const prompt = `You are an evaluation judge. Score the following output on a scale of 1-5 based on this rubric.

## Rubric
${check.rubric}

## Output to evaluate
${(ctx.output ?? '').slice(0, 8000)}

Respond with ONLY a single number (1-5) on the first line, followed by a brief explanation.`;

  try {
    const result = await spawnAgent({
      agent: 'claude',
      model,
      prompt,
      cwd: ctx.cwd,
      timeout: 60_000,
      maxTurns: 1,
    });

    const scoreMatch = result.output.match(/^(\d)/m);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
    const normalizedScore = Math.max(0, Math.min(5, score));
    const passed = normalizedScore >= check.min_score;

    return {
      passed,
      score: normalizedScore / 5,
      detail: `LLM judge score: ${normalizedScore}/5 (min: ${check.min_score}). ${result.output.slice(0, 200)}`,
    };
  } catch (err) {
    log.warn(`LLM judge check failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      passed: false,
      score: 0,
      detail: `LLM judge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runContainsAnyCheck(check: ContainsAnyCheck, ctx: CheckContext): Promise<CheckResult> {
  const output = ctx.output ?? '';
  const found = check.values.filter((v) => output.includes(v));
  const passed = found.length > 0;
  return {
    passed,
    score: passed ? 1 : 0,
    detail: passed
      ? `Found matching value(s): ${found.join(', ')}`
      : `None of the expected values found: ${check.values.join(', ')}`,
  };
}

async function runNotContainsCheck(check: NotContainsCheck, ctx: CheckContext): Promise<CheckResult> {
  const output = ctx.output ?? '';
  const present = check.values.filter((v) => output.includes(v));
  const passed = present.length === 0;
  return {
    passed,
    score: passed ? 1 : 0,
    detail: passed
      ? `No forbidden values found`
      : `Forbidden values present: ${present.join(', ')}`,
  };
}

/**
 * Parse check definitions from a checks.yaml object.
 */
export function parseChecks(raw: unknown): CheckDefinition[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const checks = Array.isArray(obj.checks) ? obj.checks : [];

  return checks.map((c: Record<string, unknown>) => {
    const type = String(c.type ?? '');
    switch (type) {
      case 'test_pass':
        return { type: 'test_pass' } as TestPassCheck;
      case 'file_exists':
        return { type: 'file_exists', path: String(c.path ?? '') } as FileExistsCheck;
      case 'grep':
        return { type: 'grep', file: String(c.file ?? ''), pattern: String(c.pattern ?? '') } as GrepCheck;
      case 'http':
        return {
          type: 'http',
          method: String(c.method ?? 'GET'),
          path: String(c.path ?? '/'),
          port: c.port != null ? Number(c.port) : undefined,
          expect_status: Number(c.expect_status ?? 200),
          expect_body_contains: c.expect_body_contains ? String(c.expect_body_contains) : undefined,
        } as HttpCheck;
      case 'diff_size':
        return {
          type: 'diff_size',
          max_files: c.max_files != null ? Number(c.max_files) : undefined,
          max_lines: c.max_lines != null ? Number(c.max_lines) : undefined,
        } as DiffSizeCheck;
      case 'keyword_present':
        return {
          type: 'keyword_present',
          keywords: Array.isArray(c.keywords) ? c.keywords.map(String) : [],
        } as KeywordPresentCheck;
      case 'keyword_absent':
        return {
          type: 'keyword_absent',
          keywords: Array.isArray(c.keywords) ? c.keywords.map(String) : [],
        } as KeywordAbsentCheck;
      case 'llm_judge':
        return {
          type: 'llm_judge',
          model: String(c.model ?? ''),
          rubric: String(c.rubric ?? ''),
          min_score: Number(c.min_score ?? 3),
        } as LlmJudgeCheck;
      case 'contains_any':
        return {
          type: 'contains_any',
          values: Array.isArray(c.values) ? c.values.map(String) : [],
        } as ContainsAnyCheck;
      case 'not_contains':
        return {
          type: 'not_contains',
          values: Array.isArray(c.values) ? c.values.map(String) : [],
        } as NotContainsCheck;
      default:
        return { type } as BaseCheck as CheckDefinition;
    }
  });
}
