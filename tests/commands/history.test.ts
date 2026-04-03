import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { historyList, historyDetail, historyQa, historyClean } from '../../src/commands/history';

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
