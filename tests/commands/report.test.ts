import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reportRoutingCommand } from '../../src/commands/report';
import type { StageTelemetry } from '../../src/lib/telemetry';

function seedSession(
  projectDir: string,
  session: string,
  entries: StageTelemetry[],
  manifest: { shipped: number; failed?: number },
): void {
  // traces dir uses session with / replaced by -
  const traceName = session.replace(/\//g, '-');
  const traceDir = join(projectDir, '.alpha-loop', 'traces', traceName);
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(
    join(traceDir, 'stages.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  const learningsDir = join(projectDir, '.alpha-loop', 'learnings');
  mkdirSync(learningsDir, { recursive: true });
  const results = [];
  for (let i = 0; i < manifest.shipped; i++) {
    results.push({ issueNum: i + 1, status: 'success', filesChanged: 1 });
  }
  for (let i = 0; i < (manifest.failed ?? 0); i++) {
    results.push({ issueNum: 100 + i, status: 'failure', filesChanged: 0 });
  }
  writeFileSync(
    join(learningsDir, `session-${session.replace(/\//g, '-')}.json`),
    JSON.stringify({ name: session, results }),
  );
}

function entry(partial: Partial<StageTelemetry>): StageTelemetry {
  return {
    stage: 'plan',
    model: 'model',
    endpoint: 'default',
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: 0.01,
    wall_time_s: 1,
    tool_calls: 1,
    tool_errors: 0,
    stage_success: true,
    started_at: '2026-04-23T00:00:00.000Z',
    ...partial,
  };
}

describe('reportRoutingCommand', () => {
  let tmp: string;
  let logs: string[];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'report-test-'));
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('emits a friendly message when no telemetry exists (zero-arg default)', () => {
    reportRoutingCommand({ projectDir: tmp });
    expect(logs.join('\n')).toContain('No per-stage telemetry recorded yet');
  });

  it('runs with zero arguments and aggregates all sessions', () => {
    seedSession(tmp, 'session/A', [entry({ stage: 'implement', model: 'sonnet', cost_usd: 0.5 })], { shipped: 2 });
    seedSession(tmp, 'session/B', [entry({ stage: 'implement', model: 'sonnet', cost_usd: 0.5 })], { shipped: 2 });
    reportRoutingCommand({ projectDir: tmp });
    const output = logs.join('\n');
    expect(output).toContain('2 session(s)');
    expect(output).toContain('implement');
    expect(output).toContain('sonnet');
  });

  it('emits valid JSON matching the documented schema when --json set', () => {
    seedSession(tmp, 'session/A', [
      entry({ stage: 'plan', model: 'opus', cost_usd: 0.2 }),
      entry({ stage: 'implement', model: 'sonnet', cost_usd: 0.3, profile: 'hybrid-v1' }),
    ], { shipped: 3 });

    reportRoutingCommand({ projectDir: tmp, json: true });

    const output = logs.join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('cells');
    expect(parsed).toHaveProperty('total_sessions');
    expect(parsed).toHaveProperty('total_stages');
    expect(parsed).toHaveProperty('total_issues_shipped');
    expect(parsed).toHaveProperty('total_cost_usd');
    expect(parsed).toHaveProperty('filters');
    expect(parsed.filters.baseline).toBe('all-frontier');
    expect(Array.isArray(parsed.cells)).toBe(true);
    const implCell = parsed.cells.find((c: { stage: string }) => c.stage === 'implement');
    expect(implCell).toBeDefined();
    expect(implCell.cost_per_issue_shipped).toBeCloseTo(0.1, 4);
  });

  it('filters by --profile', () => {
    seedSession(tmp, 'session/A', [
      entry({ stage: 'implement', model: 'a', cost_usd: 0.1, profile: 'alpha' }),
      entry({ stage: 'implement', model: 'b', cost_usd: 0.2, profile: 'beta' }),
    ], { shipped: 1 });

    reportRoutingCommand({ projectDir: tmp, json: true, profile: 'alpha' });
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.cells).toHaveLength(1);
    expect(parsed.cells[0].model).toBe('a');
    expect(parsed.filters.profile).toBe('alpha');
  });

  it('filters by --since duration', () => {
    const nowIso = new Date().toISOString();
    const oldIso = '2020-01-01T00:00:00.000Z';
    seedSession(tmp, 'session/A', [
      entry({ stage: 'implement', model: 'old', started_at: oldIso }),
      entry({ stage: 'implement', model: 'new', started_at: nowIso }),
    ], { shipped: 1 });

    reportRoutingCommand({ projectDir: tmp, json: true, since: '30d' });
    const parsed = JSON.parse(logs.join('\n'));
    expect(parsed.cells.map((c: { model: string }) => c.model)).toEqual(['new']);
  });
});
