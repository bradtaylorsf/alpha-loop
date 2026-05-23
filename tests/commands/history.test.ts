import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { historyList, historyDetail, historyQa, historyClean, historyTelemetry } from '../../src/commands/history';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
}

/**
 * Create a session with result-*.json files matching the real directory structure.
 * Structure: sessionsDir/session/<timestamp>/result-<N>.json
 */
function createSession(
  sessionsDir: string,
  timestamp: string,
  results: Array<{ issueNum: number; title: string; status: string; prUrl?: string; duration: number }>,
): void {
  const dir = path.join(sessionsDir, 'session', timestamp);
  fs.mkdirSync(dir, { recursive: true });
  for (const r of results) {
    fs.writeFileSync(
      path.join(dir, `result-${r.issueNum}.json`),
      JSON.stringify({
        issueNum: r.issueNum,
        title: r.title,
        status: r.status,
        prUrl: r.prUrl,
        testsPassing: r.status === 'success',
        verifyPassing: r.status === 'success',
        duration: r.duration,
        filesChanged: 1,
      }, null, 2),
    );
  }
}

function createQueueManifest(sessionsDir: string): void {
  const queueDir = path.join(sessionsDir, 'queue-20260521T101112Z');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(
    path.join(queueDir, 'queue.json'),
    JSON.stringify({
      queueId: 'queue-20260521T101112Z',
      epicIds: [205, 166, 214],
      branchAncestryMode: 'stacked',
      status: 'stopped',
      startedAt: '2026-05-21T10:11:12.000Z',
      endedAt: '2026-05-21T10:45:00.000Z',
      stopReason: 'Epic #166 stopped: transient-agent-stop',
      epics: [
        {
          epicNumber: 205,
          title: 'First Epic',
          queueIndex: 1,
          queueTotal: 3,
          previousEpic: null,
          nextEpic: { number: 166, title: 'Second Epic' },
          status: 'success',
          sessionName: 'session/epic-205-first-epic',
          sessionBranch: 'session/epic-205-first-epic',
          sessionPrUrl: 'https://github.com/owner/repo/pull/205',
          nextSessionBranch: 'session/epic-166-second-epic',
          nextSessionPrUrl: null,
          branchAncestryMode: 'stacked',
          branchedFromBranch: 'master',
          dependsOnSessionBranch: null,
          dependsOnSessionPrUrl: null,
          rebaseOntoBranch: null,
          dependencyWarnings: ['Later queued epic #166 declares a dependency on this epic.'],
          overlapWarnings: [],
          startedAt: '2026-05-21T10:11:12.000Z',
          endedAt: '2026-05-21T10:30:00.000Z',
          failures: [],
        },
        {
          epicNumber: 166,
          title: 'Second Epic',
          queueIndex: 2,
          queueTotal: 3,
          previousEpic: { number: 205, title: 'First Epic', sessionPrUrl: 'https://github.com/owner/repo/pull/205' },
          nextEpic: { number: 214, title: 'Third Epic' },
          status: 'failure',
          sessionName: 'session/epic-166-second-epic',
          sessionBranch: 'session/epic-166-second-epic',
          sessionPrUrl: 'https://github.com/owner/repo/pull/166',
          nextSessionBranch: null,
          nextSessionPrUrl: null,
          branchAncestryMode: 'stacked',
          branchedFromBranch: 'session/epic-205-first-epic',
          dependsOnSessionBranch: 'session/epic-205-first-epic',
          dependsOnSessionPrUrl: 'https://github.com/owner/repo/pull/205',
          rebaseOntoBranch: 'master',
          dependencyWarnings: ['Epic #166 declares a dependency on queued epic #205.'],
          overlapWarnings: ['Epics #166 and #214 both mention src/lib/session.ts.'],
          startedAt: '2026-05-21T10:30:00.000Z',
          endedAt: '2026-05-21T10:45:00.000Z',
          failures: [{ code: 'transient-stop', message: 'Agent rate limit', issueNum: 266 }],
        },
        {
          epicNumber: 214,
          title: 'Third Epic',
          queueIndex: 3,
          queueTotal: 3,
          previousEpic: { number: 166, title: 'Second Epic' },
          nextEpic: null,
          status: 'pending',
          sessionName: null,
          sessionBranch: null,
          sessionPrUrl: null,
          nextSessionBranch: null,
          nextSessionPrUrl: null,
          branchAncestryMode: 'stacked',
          branchedFromBranch: null,
          dependsOnSessionBranch: null,
          dependsOnSessionPrUrl: null,
          rebaseOntoBranch: null,
          dependencyWarnings: [],
          overlapWarnings: [],
          startedAt: null,
          endedAt: null,
          failures: [],
        },
      ],
    }, null, 2),
  );
}

describe('history', () => {
  let tmpDir: string;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    tmpDir = createTempDir();
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('historyList', () => {
    it('shows message when sessions directory does not exist', () => {
      historyList(path.join(tmpDir, 'nonexistent'), tmpDir);
      expect(consoleSpy).toHaveBeenCalledWith('No sessions found.');
    });

    it('shows message when sessions directory is empty', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      fs.mkdirSync(sessionsDir);
      historyList(sessionsDir, tmpDir);
      expect(consoleSpy).toHaveBeenCalledWith('No sessions found.');
    });

    it('lists sessions sorted by date descending', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      createSession(sessionsDir, '20250110-100000', [
        { issueNum: 1, title: 'Older issue', status: 'success', duration: 120 },
      ]);
      createSession(sessionsDir, '20250115-100000', [
        { issueNum: 2, title: 'Newer issue', status: 'failure', duration: 60 },
      ]);

      historyList(sessionsDir, tmpDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Sessions:');
      expect(output).toContain('20250115');
      expect(output).toContain('20250110');
      // newer should appear before older
      const newerIdx = output.indexOf('20250115');
      const olderIdx = output.indexOf('20250110');
      expect(newerIdx).toBeLessThan(olderIdx);
    });

    it('formats issue counts and status symbols', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      createSession(sessionsDir, '20250115-100000', [
        { issueNum: 1, title: 'Good issue', status: 'success', prUrl: 'https://github.com/owner/repo/pull/5', duration: 180 },
        { issueNum: 2, title: 'Bad issue', status: 'failure', duration: 120 },
      ]);

      historyList(sessionsDir, tmpDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('2 issues');
      expect(output).toContain('\u2713');
      expect(output).toContain('\u2717');
      expect(output).toContain('5m 00s');
    });

    it('lists multi-epic queue manifests with status and pending counts', () => {
      const sessionsDir = path.join(tmpDir, '.alpha-loop', 'sessions');
      createQueueManifest(sessionsDir);

      historyList(sessionsDir, tmpDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Queues:');
      expect(output).toContain('queue-20260521T101112Z');
      expect(output).toContain('3 epics');
      expect(output).toContain('1 ok, 1 failed, 1 pending');
      expect(output).toContain('Epic #166 stopped: transient-agent-stop');
    });
  });

  describe('historyDetail', () => {
    it('shows session detail with issues', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      createSession(sessionsDir, '20250115-103000', [
        { issueNum: 1, title: 'Feature A', status: 'success', prUrl: 'https://github.com/owner/repo/pull/5', duration: 60 },
        { issueNum: 2, title: 'Feature B', status: 'failure', duration: 60 },
      ]);

      historyDetail(sessionsDir, 'session/20250115-103000');

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Session:');
      expect(output).toContain('Issues:');
      expect(output).toContain('PR #5');
      expect(output).toContain('Feature A');
      expect(output).toContain('Feature B');
      expect(output).toContain('2m 00s');
    });

    it('shows error for non-existent session', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      historyDetail(path.join(tmpDir, 'sessions'), 'nonexistent');
      const errorOutput = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(errorOutput).toContain('Session not found');
      errorSpy.mockRestore();
    });

    it('shows queue manifest detail for stopped multi-epic queues', () => {
      const sessionsDir = path.join(tmpDir, '.alpha-loop', 'sessions');
      createQueueManifest(sessionsDir);

      historyDetail(sessionsDir, 'queue-20260521T101112Z', tmpDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Queue:       queue-20260521T101112Z');
      expect(output).toContain('Status:      stopped');
      expect(output).toContain('Branch mode: stacked');
      expect(output).toContain('Manifest:    .alpha-loop/sessions/queue-20260521T101112Z/queue.json');
      expect(output).toContain('Stop reason: Epic #166 stopped: transient-agent-stop');
      expect(output).toContain('2/3 #166 Second Epic');
      expect(output).toContain('Depends: session/epic-205-first-epic (https://github.com/owner/repo/pull/205)');
      expect(output).toContain('Rebase:  session/epic-166-second-epic onto master after the dependency PR lands');
      expect(output).toContain('Dependency: Epic #166 declares a dependency on queued epic #205.');
      expect(output).toContain('File overlap: Epics #166 and #214 both mention src/lib/session.ts.');
      expect(output).toContain('Failure: transient-stop');
      expect(output).toContain('3/3 #214 Third Epic');
      expect(output).toContain('pending');
    });

    it('shows queue metadata from checked-in session manifests', () => {
      const sessionsDir = path.join(tmpDir, '.alpha-loop', 'sessions');
      const learningsDir = path.join(tmpDir, '.alpha-loop', 'learnings');
      fs.mkdirSync(learningsDir, { recursive: true });
      fs.writeFileSync(
        path.join(learningsDir, 'session-session-epic-166-second-epic.json'),
        JSON.stringify({
          name: 'session/epic-166-second-epic',
          branch: 'session/epic-166-second-epic',
          completed: '2026-05-21T10:45:00.000Z',
          results: [{
            issueNum: 266,
            title: 'Second child',
            status: 'success',
            testsPassing: true,
            verifyPassing: true,
            duration: 60,
            filesChanged: 2,
          }],
          queue: {
            queueId: 'queue-20260521T101112Z',
            queueIndex: 2,
            queueTotal: 3,
            currentEpic: { number: 166, title: 'Second Epic' },
            previousEpic: { number: 205, title: 'First Epic' },
            nextEpic: { number: 214, title: 'Third Epic' },
            previousSessionBranch: 'session/epic-205-first-epic',
            previousSessionPrUrl: 'https://github.com/owner/repo/pull/205',
            branchAncestryMode: 'stacked',
            branchedFromBranch: 'session/epic-205-first-epic',
            dependsOnSessionBranch: 'session/epic-205-first-epic',
            dependsOnSessionPrUrl: 'https://github.com/owner/repo/pull/205',
            rebaseOntoBranch: 'master',
            dependencyWarnings: [],
            overlapWarnings: [],
          },
        }, null, 2),
      );

      historyDetail(sessionsDir, 'session/epic-166-second-epic', tmpDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Session:  session/epic-166-second-epic');
      expect(output).toContain('Queue:');
      expect(output).toContain('ID:        queue-20260521T101112Z');
      expect(output).toContain('Position:  2 of 3');
      expect(output).toContain('Depends:   session/epic-205-first-epic (https://github.com/owner/repo/pull/205)');
      expect(output).toContain('Rebase:    onto master after the dependency PR lands');
    });
  });

  describe('historyQa', () => {
    it('prints QA checklist contents', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const sessionDir = path.join(sessionsDir, 'session', '20250115-100000');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'qa-checklist.md'), '# QA Checklist\n- [ ] Tests pass');

      historyQa(sessionsDir, 'session/20250115-100000');

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('# QA Checklist');
      expect(output).toContain('Tests pass');
    });

    it('shows error when QA file is missing', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      const sessionsDir = path.join(tmpDir, 'sessions');
      fs.mkdirSync(path.join(sessionsDir, 'session', '20250115-100000'), { recursive: true });

      historyQa(sessionsDir, 'session/20250115-100000');

      const errorOutput = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(errorOutput).toContain('QA checklist not found');
      errorSpy.mockRestore();
    });
  });

  describe('historyTelemetry', () => {
    it('prints a table of stage telemetry entries from stages.jsonl', () => {
      const tracesDir = path.join(tmpDir, '.alpha-loop', 'traces', 'session-20260423-120000');
      fs.mkdirSync(tracesDir, { recursive: true });
      const entries = [
        {
          stage: 'plan', model: 'sonnet', endpoint: 'anthropic-prod',
          tokens_in: 1000, tokens_out: 500, cost_usd: 0.015,
          wall_time_s: 5.5, tool_calls: 3, tool_errors: 0,
          stage_success: true, started_at: '2026-04-23T12:00:00.000Z',
        },
        {
          stage: 'implement', model: 'qwen', endpoint: 'lmstudio',
          tokens_in: 5000, tokens_out: 1500, cost_usd: 0,
          wall_time_s: 40, tool_calls: 12, tool_errors: 2,
          stage_success: true, started_at: '2026-04-23T12:05:00.000Z',
        },
      ];
      fs.writeFileSync(
        path.join(tracesDir, 'stages.jsonl'),
        entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
      );

      historyTelemetry('session/20260423-120000', tmpDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Stage telemetry');
      expect(output).toContain('plan');
      expect(output).toContain('implement');
      expect(output).toContain('sonnet');
      expect(output).toContain('qwen');
      expect(output).toContain('lmstudio');
      expect(output).toContain('Totals: 2 stage(s)');
    });

    it('prints graceful message when no telemetry exists (legacy session)', () => {
      historyTelemetry('session/missing', tmpDir);
      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('No per-stage telemetry recorded for this session.');
    });

    it('falls back to manifest.stages when stages.jsonl is missing', () => {
      const learningsDir = path.join(tmpDir, '.alpha-loop', 'learnings');
      fs.mkdirSync(learningsDir, { recursive: true });
      fs.writeFileSync(
        path.join(learningsDir, 'session-session-20260423-000000.json'),
        JSON.stringify({
          name: 'session/20260423-000000',
          results: [],
          stages: [{
            stage: 'plan', model: 'sonnet', endpoint: 'anthropic',
            tokens_in: 10, tokens_out: 5, cost_usd: 0.001,
            wall_time_s: 1, tool_calls: 0, tool_errors: 0,
            stage_success: true, started_at: '2026-04-23T00:00:00.000Z',
          }],
        }),
      );
      historyTelemetry('session/20260423-000000', tmpDir);
      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('plan');
      expect(output).toContain('sonnet');
    });
  });

  describe('historyClean', () => {
    it('removes sessions older than 30 days', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');

      // Create old session (40 days ago)
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      const oldTs = `${oldDate.getFullYear()}${String(oldDate.getMonth() + 1).padStart(2, '0')}${String(oldDate.getDate()).padStart(2, '0')}-100000`;

      // Create new session (today)
      const now = new Date();
      const newTs = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-100000`;

      createSession(sessionsDir, oldTs, [
        { issueNum: 1, title: 'Old issue', status: 'success', duration: 60 },
      ]);
      createSession(sessionsDir, newTs, [
        { issueNum: 2, title: 'New issue', status: 'success', duration: 60 },
      ]);

      historyClean(sessionsDir);

      expect(fs.existsSync(path.join(sessionsDir, 'session', oldTs))).toBe(false);
      expect(fs.existsSync(path.join(sessionsDir, 'session', newTs))).toBe(true);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Removed');
      expect(output).toContain('1 session(s)');
    });

    it('shows message when no old sessions exist', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const now = new Date();
      const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-100000`;
      createSession(sessionsDir, ts, [
        { issueNum: 1, title: 'Recent', status: 'success', duration: 60 },
      ]);

      historyClean(sessionsDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('No sessions older than 30 days found.');
    });

    it('shows message when sessions directory does not exist', () => {
      historyClean(path.join(tmpDir, 'nonexistent'));
      expect(consoleSpy).toHaveBeenCalledWith('No sessions found.');
    });
  });
});
