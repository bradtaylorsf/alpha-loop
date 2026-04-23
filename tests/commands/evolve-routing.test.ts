import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evolveRoutingCommand } from '../../src/commands/evolve-routing.js';
import { ROUTING_HISTORY_PATH } from '../../src/lib/routing-history.js';

// Silence the logger during tests.
jest.mock('../../src/lib/logger', () => ({
  log: {
    info: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    step: jest.fn(),
    dry: jest.fn(),
    debug: jest.fn(),
    rate: jest.fn(),
  },
}));

const ORIGINAL_CWD = process.cwd();

const BASE_CONFIG_YAML = [
  'repo: test/repo',
  'agent: claude',
  'base_branch: master',
  'routing:',
  '  endpoints:',
  '    anthropic-prod:',
  '      type: anthropic',
  '      base_url: https://api.anthropic.com',
  '    lmstudio:',
  '      type: anthropic_compat',
  '      base_url: http://localhost:1234',
  '  stages:',
  '    build:',
  '      model: claude-sonnet-4-6',
  '      endpoint: anthropic-prod',
  '  fallback:',
  '    on_tool_error: escalate',
  '    escalate_to:',
  '      model: claude-sonnet-4-6',
  '      endpoint: anthropic-prod',
  '',
].join('\n');

type SetupOpts = {
  matrixFreshnessDaysAgo?: number;
  telemetry?: Record<string, unknown>[];
  sessionManifest?: Record<string, unknown>;
};

function setupTempProject(opts: SetupOpts = {}): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-evolve-routing-'));
  writeFileSync(join(tempDir, '.alpha-loop.yaml'), BASE_CONFIG_YAML);

  if (opts.matrixFreshnessDaysAgo != null) {
    const reportsDir = join(tempDir, 'eval', 'reports');
    mkdirSync(reportsDir, { recursive: true });
    const reportPath = join(reportsDir, 'routing-2026-04-15.md');
    writeFileSync(reportPath, '# matrix report');
    // Set mtime N days ago.
    const ms = Date.now() - opts.matrixFreshnessDaysAgo * 24 * 60 * 60 * 1000;
    require('node:fs').utimesSync(reportPath, ms / 1000, ms / 1000);
  }

  if (opts.telemetry) {
    const tracesDir = join(tempDir, '.alpha-loop', 'traces', 'session-test');
    mkdirSync(tracesDir, { recursive: true });
    const lines = opts.telemetry.map((t) => JSON.stringify(t)).join('\n');
    writeFileSync(join(tracesDir, 'stages.jsonl'), lines);
  }

  if (opts.sessionManifest) {
    const learningsDir = join(tempDir, '.alpha-loop', 'learnings');
    mkdirSync(learningsDir, { recursive: true });
    writeFileSync(
      join(learningsDir, 'session-test.json'),
      JSON.stringify({
        name: 'session/test',
        completed: new Date().toISOString(),
        results: [],
        ...opts.sessionManifest,
      }),
    );
  }

  process.chdir(tempDir);
  return tempDir;
}

function makeTelemetry(overrides: {
  stage?: string;
  model?: string;
  endpoint?: string;
  endpoint_type?: 'anthropic' | 'anthropic_compat' | 'openai_compat';
  cost_usd?: number;
  tool_errors?: number;
}): Record<string, unknown> {
  return {
    stage: overrides.stage ?? 'build',
    model: overrides.model ?? 'claude-sonnet-4-6',
    endpoint: overrides.endpoint ?? 'anthropic-prod',
    endpoint_type: overrides.endpoint_type ?? 'anthropic',
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: overrides.cost_usd ?? 1.0,
    wall_time_s: 10,
    tool_calls: 5,
    tool_errors: overrides.tool_errors ?? 0,
    stage_success: true,
    started_at: new Date().toISOString(),
    issue_num: 1,
  };
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

describe('evolveRoutingCommand', () => {
  it('returns stale-matrix when the matrix eval is older than 7 days', async () => {
    const tempDir = setupTempProject({ matrixFreshnessDaysAgo: 10 });
    try {
      const result = await evolveRoutingCommand({
        projectDir: tempDir,
        exec: jest.fn(),
        createPR: jest.fn(),
      });
      expect(result.status).toBe('stale-matrix');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns stale-matrix when no matrix report exists', async () => {
    const tempDir = setupTempProject({});
    try {
      const result = await evolveRoutingCommand({
        projectDir: tempDir,
        exec: jest.fn(),
        createPR: jest.fn(),
      });
      expect(result.status).toBe('stale-matrix');
      expect(result.message).toContain('never run');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns no-proposals when no cells cross the thresholds', async () => {
    const tempDir = setupTempProject({
      matrixFreshnessDaysAgo: 1,
      // Only a single frontier cell — no local cell, so no promotion possible.
      telemetry: Array.from({ length: 30 }, () => makeTelemetry({})),
      sessionManifest: {
        results: [{ issueNum: 1, status: 'success', filesChanged: 5 }],
      },
    });
    try {
      const result = await evolveRoutingCommand({
        projectDir: tempDir,
        exec: jest.fn(),
        createPR: jest.fn(),
      });
      expect(result.status).toBe('no-proposals');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('dry-run does not mutate the config yaml when proposals exist', async () => {
    const tempDir = setupTempProject({
      matrixFreshnessDaysAgo: 1,
      telemetry: [
        // Frontier cell — 30 runs, cost ~$1/issue
        ...Array.from({ length: 30 }, () => makeTelemetry({ cost_usd: 1.0 })),
        // Local cell — 30 runs, $0.10/issue (90% savings), 0% tool errors
        ...Array.from({ length: 30 }, () =>
          makeTelemetry({
            model: 'qwen3-coder-30b-a3b',
            endpoint: 'lmstudio',
            endpoint_type: 'anthropic_compat',
            cost_usd: 0.1,
          }),
        ),
      ],
      sessionManifest: {
        results: [
          // 1 shipped issue to anchor cost_per_issue_shipped in the aggregator.
          { issueNum: 1, status: 'success', filesChanged: 5 },
        ],
      },
    });
    try {
      const before = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
      const result = await evolveRoutingCommand({
        projectDir: tempDir,
        dryRun: true,
        exec: jest.fn(),
        createPR: jest.fn(),
      });
      expect(result.status).toBe('dry-run');
      expect(result.proposals?.length ?? 0).toBeGreaterThan(0);
      const after = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('manual --demote writes history, creates a PR, and updates config', async () => {
    const tempDir = setupTempProject({ matrixFreshnessDaysAgo: 999 });
    try {
      const execMock = jest.fn().mockImplementation((cmd: string) => {
        if (cmd.startsWith('git rev-parse')) {
          return { stdout: 'abc123def456', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const createPRMock = jest.fn().mockReturnValue('https://github.com/test/repo/pull/99');

      const result = await evolveRoutingCommand({
        projectDir: tempDir,
        demote: 'build',
        exec: execMock,
        createPR: createPRMock,
      });

      expect(result.status).toBe('demoted');
      expect(result.prUrl).toContain('pull/99');
      expect(createPRMock).toHaveBeenCalledTimes(1);
      const callArg = createPRMock.mock.calls[0][0];
      expect(callArg.head).toMatch(/^routing\/demote-build-/);
      expect(callArg.title).toContain('demote build');
      expect(callArg.body).toContain('Routing Demotion');
      expect(callArg.body).toContain('git revert');

      const historyPath = join(tempDir, ROUTING_HISTORY_PATH);
      expect(existsSync(historyPath)).toBe(true);
      const history = readFileSync(historyPath, 'utf-8');
      expect(history).toContain('manual_demote build');
      expect(history).toContain('pull/99');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('manual --demote fails cleanly when no fallback.escalate_to is configured', async () => {
    const tempDir = setupTempProject({});
    // Overwrite yaml with one that has no escalate_to.
    writeFileSync(
      join(tempDir, '.alpha-loop.yaml'),
      [
        'repo: test/repo',
        'agent: claude',
        'routing:',
        '  endpoints:',
        '    anthropic-prod:',
        '      type: anthropic',
        '      base_url: https://api.anthropic.com',
        '  stages:',
        '    build:',
        '      model: claude-sonnet-4-6',
        '      endpoint: anthropic-prod',
        '',
      ].join('\n'),
    );
    try {
      const result = await evolveRoutingCommand({
        projectDir: tempDir,
        demote: 'build',
        exec: jest.fn(),
        createPR: jest.fn(),
      });
      expect(result.status).toBe('error');
      expect(result.message).toContain('escalate_to');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
