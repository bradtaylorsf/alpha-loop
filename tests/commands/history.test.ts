import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { historyList, historyDetail, historyQa, historyClean } from '../../src/commands/history';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'history-test-'));
}

function createSession(
  sessionsDir: string,
  name: string,
  yaml: string,
): void {
  const dir = path.join(sessionsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.yaml'), yaml);
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
      historyList(path.join(tmpDir, 'nonexistent'));
      expect(consoleSpy).toHaveBeenCalledWith('No sessions found.');
    });

    it('shows message when sessions directory is empty', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      fs.mkdirSync(sessionsDir);
      historyList(sessionsDir);
      expect(consoleSpy).toHaveBeenCalledWith('No sessions found.');
    });

    it('lists sessions sorted by date descending', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      createSession(sessionsDir, 'older', `
name: older-session
started: "2025-01-10T10:00:00Z"
duration: 120
issues:
  - number: 1
    status: success
`);
      createSession(sessionsDir, 'newer', `
name: newer-session
started: "2025-01-15T10:00:00Z"
duration: 60
issues:
  - number: 2
    status: failed
`);

      historyList(sessionsDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Sessions:');
      expect(output).toContain('newer-session');
      expect(output).toContain('older-session');
      // newer should appear before older
      const newerIdx = output.indexOf('newer-session');
      const olderIdx = output.indexOf('older-session');
      expect(newerIdx).toBeLessThan(olderIdx);
    });

    it('formats issue counts and status symbols', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      createSession(sessionsDir, 'mixed', `
name: mixed-session
started: "2025-01-15T10:00:00Z"
duration: 300
issues:
  - number: 1
    status: success
    pr_url: https://github.com/owner/repo/pull/5
  - number: 2
    status: failed
    error: test failure
`);

      historyList(sessionsDir);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('2 issues');
      expect(output).toContain('\u2713');
      expect(output).toContain('\u2717');
      expect(output).toContain('5m 00s');
    });
  });

  describe('historyDetail', () => {
    it('shows session detail with header and issues', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      createSession(sessionsDir, 'test-session', `
name: test-session
repo: owner/repo
started: "2025-01-15T10:30:00Z"
duration: 120
model: opus
issues:
  - number: 1
    status: success
    pr_url: https://github.com/owner/repo/pull/5
    duration: 60
  - number: 2
    status: failed
    error: test timeout
    duration: 60
`);

      historyDetail(sessionsDir, 'test-session');

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Session: test-session');
      expect(output).toContain('Date:    2025-01-15 10:30');
      expect(output).toContain('Repo:    owner/repo');
      expect(output).toContain('Model:   opus');
      expect(output).toContain('Duration: 2m 00s');
      expect(output).toContain('PR #5');
      expect(output).toContain('FAILED');
      expect(output).toContain('test timeout');
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
      const sessionDir = path.join(sessionsDir, 'test-session');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, 'qa-checklist.md'), '# QA Checklist\n- [ ] Tests pass');

      historyQa(sessionsDir, 'test-session');

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('# QA Checklist');
      expect(output).toContain('Tests pass');
    });

    it('shows error when QA file is missing', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      const sessionsDir = path.join(tmpDir, 'sessions');
      fs.mkdirSync(path.join(sessionsDir, 'test-session'), { recursive: true });

      historyQa(sessionsDir, 'test-session');

      const errorOutput = errorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(errorOutput).toContain('QA checklist not found');
      errorSpy.mockRestore();
    });
  });

  describe('historyClean', () => {
    it('removes sessions older than 30 days', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const newDate = new Date().toISOString();

      createSession(sessionsDir, 'old-session', `
name: old-session
started: "${oldDate}"
duration: 60
issues: []
`);
      createSession(sessionsDir, 'new-session', `
name: new-session
started: "${newDate}"
duration: 60
issues: []
`);

      historyClean(sessionsDir);

      expect(fs.existsSync(path.join(sessionsDir, 'old-session'))).toBe(false);
      expect(fs.existsSync(path.join(sessionsDir, 'new-session'))).toBe(true);

      const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
      expect(output).toContain('Removed: old-session');
      expect(output).toContain('Removed 1 session(s).');
    });

    it('shows message when no old sessions exist', () => {
      const sessionsDir = path.join(tmpDir, 'sessions');
      const newDate = new Date().toISOString();

      createSession(sessionsDir, 'recent', `
name: recent
started: "${newDate}"
duration: 60
issues: []
`);

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
