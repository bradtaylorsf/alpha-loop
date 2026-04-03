import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeTrace,
  writeTraceMetadata,
  writeTraceToSubdir,
  writeRunManifest,
  writeConfigSnapshot,
  writeScores,
  writeCosts,
  computeScores,
  computeCosts,
  readTrace,
  readTraceMetadata,
  listTraceSessions,
  listTraceIssues,
  listTraces,
  getTraceFiles,
  traceDir,
  runDir,
} from '../../src/lib/traces.js';
import type {
  TraceMetadata,
  RunManifest,
  ScoresJson,
  CostsJson,
  StepCost,
  PipelineResultForScores,
} from '../../src/lib/traces.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-trace-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const sampleMetadata: TraceMetadata = {
  issueNum: 42,
  title: 'Fix the widget',
  status: 'success',
  duration: 120,
  retries: 1,
  testsPassing: true,
  verifyPassing: true,
  verifySkipped: false,
  filesChanged: 3,
  prUrl: 'https://github.com/test/repo/pull/10',
  timestamp: '2026-04-01T12:00:00.000Z',
  agent: 'claude',
  model: 'opus',
};

describe('writeTrace / readTrace', () => {
  it('writes and reads a trace file', () => {
    writeTrace('session-20260401-120000', 42, 'test-output.txt', 'All tests passed', tempDir);
    const content = readTrace('session-20260401-120000', 42, 'test-output.txt', tempDir);
    expect(content).toBe('All tests passed');
  });

  it('returns null for non-existent trace', () => {
    const content = readTrace('nonexistent', 999, 'test-output.txt', tempDir);
    expect(content).toBeNull();
  });

  it('creates directory structure automatically', () => {
    writeTrace('session-20260401-120000', 42, 'diff.patch', 'diff content', tempDir);
    const dir = traceDir('session-20260401-120000', 42, tempDir);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('writeTraceMetadata / readTraceMetadata', () => {
  it('writes and reads metadata', () => {
    writeTraceMetadata('session-20260401-120000', 42, sampleMetadata, tempDir);
    const metadata = readTraceMetadata('session-20260401-120000', 42, tempDir);
    expect(metadata).toEqual(sampleMetadata);
  });

  it('returns null for non-existent metadata', () => {
    expect(readTraceMetadata('nonexistent', 999, tempDir)).toBeNull();
  });
});

describe('writeTraceToSubdir', () => {
  it('writes a file into a named subdirectory', () => {
    writeTraceToSubdir('session-20260401-120000', 'prompts', 'issue-42-plan.md', 'plan prompt', tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'prompts', 'issue-42-plan.md');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('plan prompt');
  });

  it('writes to outputs subdirectory', () => {
    writeTraceToSubdir('session-20260401-120000', 'outputs', 'issue-42-implement.log', 'agent output', tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'outputs', 'issue-42-implement.log');
    expect(readFileSync(filePath, 'utf-8')).toBe('agent output');
  });

  it('writes to diffs subdirectory', () => {
    writeTraceToSubdir('session-20260401-120000', 'diffs', 'issue-42-implement.patch', 'diff content', tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'diffs', 'issue-42-implement.patch');
    expect(readFileSync(filePath, 'utf-8')).toBe('diff content');
  });

  it('writes to tests subdirectory', () => {
    writeTraceToSubdir('session-20260401-120000', 'tests', 'issue-42-test-1.txt', 'test output', tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'tests', 'issue-42-test-1.txt');
    expect(readFileSync(filePath, 'utf-8')).toBe('test output');
  });

  it('writes to verify subdirectory', () => {
    writeTraceToSubdir('session-20260401-120000', 'verify', 'issue-42-verify-1.txt', 'verify output', tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'verify', 'issue-42-verify-1.txt');
    expect(readFileSync(filePath, 'utf-8')).toBe('verify output');
  });
});

describe('writeRunManifest', () => {
  it('writes manifest.json at run level', () => {
    const manifest: RunManifest = {
      runId: 'session-20260401-120000',
      startedAt: '2026-04-01T12:00:00.000Z',
      completedAt: '2026-04-01T12:30:00.000Z',
      issues: [42, 43],
      config: {
        agent: 'claude',
        model: 'opus',
        reviewModel: 'haiku',
        testCommand: 'pnpm test',
        baseBranch: 'master',
      },
      gitState: {
        branch: 'master',
        commit: 'abc123',
      },
      totalDuration: 1800,
    };

    writeRunManifest('session-20260401-120000', manifest, tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'manifest.json');
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.runId).toBe('session-20260401-120000');
    expect(parsed.issues).toEqual([42, 43]);
  });
});

describe('writeConfigSnapshot', () => {
  it('writes config.snapshot.yaml at run level', () => {
    writeConfigSnapshot('session-20260401-120000', 'repo: test/repo\nagent: claude\n', tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'config.snapshot.yaml');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('repo: test/repo\nagent: claude\n');
  });
});

describe('writeScores', () => {
  it('writes scores.json at run level', () => {
    const scores: ScoresJson = {
      composite_score: 80,
      issues: {
        '42': {
          status: 'success',
          tests_passed: true,
          verify_passed: true,
          retries: 0,
          duration_seconds: 120,
          files_changed: 3,
          steps_completed: ['plan', 'implement', 'test', 'review', 'pr'],
        },
      },
      aggregate: {
        pass_rate: 1.0,
        avg_retries: 0,
        avg_duration: 120,
        total_issues: 1,
        issues_passed: 1,
      },
    };

    writeScores('session-20260401-120000', scores, tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'scores.json');
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.composite_score).toBe(80);
    expect(parsed.issues['42'].status).toBe('success');
  });
});

describe('writeCosts', () => {
  it('writes costs.json at run level', () => {
    const costs: CostsJson = {
      total_cost_usd: 2.0,
      by_step: {
        implement: { model: 'opus', input_tokens: 10000, output_tokens: 5000, cost_usd: 1.5 },
        review: { model: 'haiku', input_tokens: 5000, output_tokens: 2000, cost_usd: 0.5 },
      },
      by_issue: {
        '42': { cost_usd: 2.0 },
      },
    };

    writeCosts('session-20260401-120000', costs, tempDir);
    const filePath = join(runDir('session-20260401-120000', tempDir), 'costs.json');
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.total_cost_usd).toBe(2.0);
    expect(parsed.by_step.implement.cost_usd).toBe(1.5);
  });
});

describe('computeScores', () => {
  it('computes correct scores from results', () => {
    const results: PipelineResultForScores[] = [
      {
        issueNum: 42,
        status: 'success',
        testsPassing: true,
        verifyPassing: true,
        verifySkipped: false,
        retries: 1,
        duration: 300,
        filesChanged: 5,
        stepsCompleted: ['plan', 'implement', 'test', 'fix-1', 'review', 'verify', 'pr'],
      },
      {
        issueNum: 43,
        status: 'failure',
        testsPassing: false,
        verifyPassing: false,
        verifySkipped: false,
        retries: 3,
        duration: 600,
        filesChanged: 2,
        stepsCompleted: ['plan', 'implement', 'test'],
      },
    ];

    const scores = computeScores(results);
    expect(scores.aggregate.total_issues).toBe(2);
    expect(scores.aggregate.issues_passed).toBe(1);
    expect(scores.aggregate.pass_rate).toBe(0.5);
    expect(scores.aggregate.avg_retries).toBe(2);
    expect(scores.aggregate.avg_duration).toBe(450);
    expect(scores.issues['42'].status).toBe('success');
    expect(scores.issues['42'].steps_completed).toContain('plan');
    expect(scores.issues['43'].status).toBe('failure');
    expect(scores.composite_score).toBeGreaterThan(0);
  });

  it('handles empty results', () => {
    const scores = computeScores([]);
    expect(scores.aggregate.total_issues).toBe(0);
    expect(scores.aggregate.pass_rate).toBe(0);
    expect(scores.composite_score).toBe(0);
  });

  it('handles all-success results', () => {
    const results: PipelineResultForScores[] = [
      {
        issueNum: 1,
        status: 'success',
        testsPassing: true,
        verifyPassing: true,
        verifySkipped: false,
        retries: 0,
        duration: 100,
        filesChanged: 1,
        stepsCompleted: ['plan', 'implement', 'test', 'review', 'pr'],
      },
    ];

    const scores = computeScores(results);
    expect(scores.aggregate.pass_rate).toBe(1);
    // score.ts formula: (1/1)*100 - 0.1*0 - 0.01*100 = 99
    expect(scores.composite_score).toBe(99);
  });
});

describe('computeCosts', () => {
  it('computes correct costs from step entries', () => {
    const stepCosts: StepCost[] = [
      { step: 'plan', issueNum: 42, model: 'opus', input_tokens: 10000, output_tokens: 3000, cost_usd: 0.15 },
      { step: 'implement', issueNum: 42, model: 'opus', input_tokens: 45000, output_tokens: 15000, cost_usd: 1.80 },
      { step: 'review', issueNum: 42, model: 'haiku', input_tokens: 20000, output_tokens: 4000, cost_usd: 0.05 },
      { step: 'plan', issueNum: 43, model: 'opus', input_tokens: 8000, output_tokens: 2000, cost_usd: 0.12 },
    ];

    const costs = computeCosts(stepCosts);
    expect(costs.total_cost_usd).toBeCloseTo(2.12, 2);
    expect(costs.by_step.plan.input_tokens).toBe(18000);
    expect(costs.by_step.plan.output_tokens).toBe(5000);
    expect(costs.by_step.implement.model).toBe('opus');
    expect(costs.by_issue['42'].cost_usd).toBeCloseTo(2.0, 2);
    expect(costs.by_issue['43'].cost_usd).toBeCloseTo(0.12, 2);
  });

  it('handles empty step costs', () => {
    const costs = computeCosts([]);
    expect(costs.total_cost_usd).toBe(0);
    expect(Object.keys(costs.by_step)).toHaveLength(0);
    expect(Object.keys(costs.by_issue)).toHaveLength(0);
  });
});

describe('listTraceSessions', () => {
  it('returns empty array when no traces exist', () => {
    expect(listTraceSessions(tempDir)).toEqual([]);
  });

  it('lists session directories', () => {
    writeTrace('session-20260401-120000', 1, 'metadata.json', '{}', tempDir);
    writeTrace('session-20260402-120000', 2, 'metadata.json', '{}', tempDir);
    const sessions = listTraceSessions(tempDir);
    expect(sessions).toEqual(['session-20260401-120000', 'session-20260402-120000']);
  });
});

describe('listTraceIssues', () => {
  it('returns empty array for non-existent session', () => {
    expect(listTraceIssues('nonexistent', tempDir)).toEqual([]);
  });

  it('lists issue numbers in a session', () => {
    writeTrace('session-20260401-120000', 10, 'metadata.json', '{}', tempDir);
    writeTrace('session-20260401-120000', 20, 'metadata.json', '{}', tempDir);
    const issues = listTraceIssues('session-20260401-120000', tempDir);
    expect(issues).toEqual([10, 20]);
  });

  it('ignores non-numeric directories (like prompts, outputs)', () => {
    writeTrace('session-20260401-120000', 10, 'metadata.json', '{}', tempDir);
    writeTraceToSubdir('session-20260401-120000', 'prompts', 'issue-10-plan.md', 'prompt', tempDir);
    const issues = listTraceIssues('session-20260401-120000', tempDir);
    expect(issues).toEqual([10]);
  });
});

describe('listTraces', () => {
  it('returns all traces newest-first', () => {
    writeTraceMetadata('session-20260401-120000', 1, { ...sampleMetadata, issueNum: 1 }, tempDir);
    writeTraceMetadata('session-20260402-120000', 2, { ...sampleMetadata, issueNum: 2 }, tempDir);
    const traces = listTraces(tempDir);
    expect(traces).toHaveLength(2);
    expect(traces[0].session).toBe('session-20260402-120000');
    expect(traces[1].session).toBe('session-20260401-120000');
  });
});

describe('getTraceFiles', () => {
  it('returns empty array for non-existent trace', () => {
    expect(getTraceFiles('nonexistent', 999, tempDir)).toEqual([]);
  });

  it('lists trace files with sizes', () => {
    writeTrace('session-20260401-120000', 42, 'test-output.txt', 'test output', tempDir);
    writeTrace('session-20260401-120000', 42, 'diff.patch', 'diff content', tempDir);
    const files = getTraceFiles('session-20260401-120000', 42, tempDir);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.file)).toContain('test-output.txt');
    expect(files.map((f) => f.file)).toContain('diff.patch');
  });
});

describe('session name with slashes', () => {
  it('replaces slashes with dashes in directory names', () => {
    writeTrace('session/20260401-120000', 42, 'test-output.txt', 'content', tempDir);
    const dir = traceDir('session/20260401-120000', 42, tempDir);
    expect(dir).toContain('session-20260401-120000');
    expect(existsSync(dir)).toBe(true);
  });
});
