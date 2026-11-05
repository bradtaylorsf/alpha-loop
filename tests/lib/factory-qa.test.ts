import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_FACTORY_CONFIG } from '../../src/lib/config.js';
import { shouldRunQa, formatQaBugIdea, qaFailureFingerprint, runQa, readQaState, cleanupQaWorktree, isQaResult, type QaResult } from '../../src/lib/factory-qa.js';
import { exec, shellQuote } from '../../src/lib/shell.js';
import { appendTaggedIdea, readInbox, updateIdea } from '../../src/lib/factory-inbox.js';

const now = new Date('2026-11-05T12:00:00Z');
const sha = 'a'.repeat(40);
const green = 'b'.repeat(40);
const config = DEFAULT_FACTORY_CONFIG.qa;
function failure(output = 'Error: broken'): QaResult {
  return { version: 1, status: 'failure', baseBranch: 'feat/factory', testedSha: sha, lastGreenSha: green,
    startedAt: now.toISOString(), completedAt: now.toISOString(), failure: { command: 'pnpm build', exitCode: 2, output },
    commits: [`${sha} regression`], historyKind: 'since-green', cleanupErrors: [] };
}

describe('QA scheduling and evidence', () => {
  it('runs an initial baseline and either inclusive threshold, but never when disabled', () => {
    const check = (mergesSinceLastQa: number, lastQaAt: string | null, at = now) => shouldRunQa({ mergesSinceLastQa, lastQaAt, now: at, config });
    expect(check(0, null)).toBe(true);
    expect(check(4, now.toISOString())).toBe(false);
    expect(check(5, now.toISOString())).toBe(true);
    expect(check(0, new Date(now.getTime() - 30 * 60_000).toISOString())).toBe(true);
    expect(check(0, new Date(now.getTime() - 30 * 60_000 + 1).toISOString())).toBe(false);
    expect(check(0, new Date(now.getTime() + 60_000).toISOString())).toBe(false);
    expect(shouldRunQa({ mergesSinceLastQa: 100, lastQaAt: null, now, config: { ...config, enabled: false } })).toBe(false);
  });

  it('keeps the first error fingerprint even when it falls outside the last 60 lines', () => {
    const result = failure(`banner\n\u001b[31mError: broken\u001b[0m\r\n${Array.from({ length: 70 }, (_, n) => `line ${n}`).join('\n')}`);
    expect(qaFailureFingerprint(result.failure!)).toBe(qaFailureFingerprint(failure().failure!));
    const idea = formatQaBugIdea(result);
    expect(idea).toContain('Bug:');
    expect(idea).toContain('pnpm build');
    expect(idea).toContain(green);
    expect(idea).toContain('line 10\n');
    expect(idea).not.toContain('line 9\n');
    expect(idea).toContain(`${sha} regression`);
    expect(qaFailureFingerprint({ command: 'pnpm test', output: 'Error: broken' })).not.toBe(qaFailureFingerprint(result.failure!));
    expect(qaFailureFingerprint({ command: ' pnpm  build ', output: '' })).toBe(qaFailureFingerprint({ command: 'pnpm build', output: '\r\n' }));
  });

  it('ignores echoed scripts and lifecycle summaries when a diagnostic is available', () => {
    const output = '> fixture@1.0.0 smoke /tmp/qa-worktrees/qa-one\n> node check-error.cjs\n'
      + 'ELIFECYCLE Command failed with exit code 1.\nError: database unavailable';
    const fingerprint = qaFailureFingerprint({ command: 'pnpm smoke', output });
    expect(fingerprint).toBe(qaFailureFingerprint({ command: 'pnpm smoke', output: 'Error: database unavailable' }));
    expect(fingerprint).not.toBe(qaFailureFingerprint({ command: 'pnpm smoke', output: output.replace('database unavailable', 'invalid response') }));
  });
});

describe('runQa', () => {
  let root: string;
  let calls: Array<{ cmd: string; cwd?: string; timeout?: number }>;
  let execute: jest.MockedFunction<typeof exec>;
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-qa-'));
    calls = [];
    execute = jest.fn((cmd, opts) => {
      calls.push({ cmd, ...opts });
      if (cmd.startsWith('git rev-parse')) return { ...ok, stdout: sha };
      if (cmd.startsWith('git log')) return { ...ok, stdout: `${sha} regression` };
      return ok;
    });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const run = (options = {}) => runQa({ projectDir: root, stateDir: join(root, 'state'), baseBranch: 'feat/factory',
    smokeTest: 'pnpm smoke', testCommand: 'pnpm test', setupCommand: '', timeoutMinutes: 2, exec: execute, now: () => now, ...options });

  it('tests the exact fetched SHA with explicit cwd and saves a green baseline', () => {
    const result = run({ setupCommand: 'pnpm setup' });
    expect(result.status).toBe('success');
    expect(calls.map(c => c.cmd)).toEqual(expect.arrayContaining([
      "git fetch --no-tags origin '+refs/heads/feat/factory:refs/remotes/origin/feat/factory'",
      "git rev-parse --verify 'refs/remotes/origin/feat/factory^{commit}'",
      'pnpm install --frozen-lockfile', 'pnpm setup', 'pnpm build', 'pnpm smoke',
    ]));
    expect(calls.find(c => c.cmd.startsWith('git worktree add'))?.cmd).toContain(`'${sha}'`);
    const checkCalls = calls.filter(c => c.cmd.startsWith('pnpm'));
    expect(checkCalls.map(c => c.cmd)).toEqual(['pnpm install --frozen-lockfile', 'pnpm setup', 'pnpm build', 'pnpm smoke']);
    expect(checkCalls.every(c => c.cwd?.includes('qa-worktrees/qa-') && c.timeout! > 0)).toBe(true);
    expect(calls.filter(c => c.cmd.startsWith('git')).every(c => c.cwd === root)).toBe(true);
    expect(calls.at(-1)?.cmd).toMatch(/^git worktree remove/);
    expect(readQaState(join(root, 'state'), 'feat/factory').lastGreenSha).toBe(sha);
    expect(readQaState(join(root, 'state'), 'different').lastGreenSha).toBeNull();
  });

  it.each(['pnpm install --frozen-lockfile', 'pnpm setup', 'pnpm build', 'pnpm test'])('cleans up and preserves the last green on %s failure', command => {
    mkdirSync(join(root, 'state'));
    writeFileSync(join(root, 'state/qa.json'), JSON.stringify({ version: 1, baseBranch: 'feat/factory', lastGreenSha: green, lastQaAt: now.toISOString() }));
    const original = execute.getMockImplementation()!;
    execute.mockImplementation((cmd, opts) => cmd === command ? { stdout: 'Error: broken', stderr: '', exitCode: 2 } : original(cmd, opts));
    const result = run({ setupCommand: 'pnpm setup', smokeTest: '  ' });
    expect(result.failure).toEqual({ command, output: 'Error: broken', exitCode: 2 });
    expect(result.historyKind).toBe('since-green');
    expect(calls.some(c => c.cmd.includes(`--first-parent '${green}..${sha}'`))).toBe(true);
    expect(calls.at(-1)?.cmd).toMatch(/^git worktree remove/);
    expect(readQaState(join(root, 'state'), 'feat/factory').lastGreenSha).toBe(green);
  });

  it('handles thrown exec, partial worktree creation and failed cleanup without hiding the failure', () => {
    execute.mockImplementation((cmd) => {
      if (cmd.startsWith('git rev-parse')) return { ...ok, stdout: sha };
      if (cmd.startsWith('git worktree add')) throw new Error('partial creation');
      if (cmd.startsWith('git worktree remove') || cmd === 'git worktree prune') throw new Error('cleanup failed');
      return ok;
    });
    const result = run();
    expect(result.failure?.command).toMatch(/^git worktree add/);
    expect(result.failure?.output).toContain('partial creation');
    expect(result.cleanupErrors.join('\n')).toContain('cleanup failed');
    expect(execute).toHaveBeenCalledWith('git worktree prune', expect.objectContaining({ cwd: root }));
    expect(readQaState(join(root, 'state'), 'feat/factory').lastGreenSha).toBeNull();
  });

  it('never falls back to a local branch after a failed fetch', () => {
    const original = execute.getMockImplementation()!;
    execute.mockImplementation((cmd, opts) => cmd.startsWith('git fetch') ? { ...ok, exitCode: 1, stderr: 'remote unavailable' } : original(cmd, opts));
    const result = run();
    expect(result.testedSha).toBeNull();
    expect(result.failure?.output).toBe('remote unavailable');
    expect(execute.mock.calls.some(([cmd]) => cmd.startsWith('git worktree add') || cmd.startsWith('pnpm'))).toBe(false);
  });

  it('labels bounded history when the saved baseline is no longer an ancestor', () => {
    mkdirSync(join(root, 'state'));
    writeFileSync(join(root, 'state/qa.json'), JSON.stringify({ version: 1, baseBranch: 'feat/factory', lastGreenSha: green }));
    const original = execute.getMockImplementation()!;
    execute.mockImplementation((cmd, opts) => cmd === 'pnpm build' || cmd.startsWith('git merge-base')
      ? { ...ok, exitCode: 1, stderr: 'Error: failed' } : original(cmd, opts));
    const result = run();
    expect(result.historyKind).toBe('recent');
    expect(formatQaBugIdea(result)).toContain('at most 60 commits');
    expect(execute.mock.calls.some(([cmd]) => cmd === `git log --format='%H %s' --first-parent '${sha}' -60`)).toBe(true);
    expect(execute.mock.calls.some(([cmd]) => cmd === 'pnpm smoke')).toBe(false);
  });

  it('removes a partial directory and prunes if git worktree remove fails', () => {
    const path = join(root, 'state/qa-worktrees/qa-partial');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'partial'), 'leftover');
    execute.mockImplementation(cmd => cmd.startsWith('git worktree remove') ? { ...ok, exitCode: 1, stderr: 'not registered' } : ok);
    expect(cleanupQaWorktree({ projectDir: root, stateDir: join(root, 'state'), worktreePath: path, exec: execute })).toHaveLength(1);
    expect(() => readFileSync(join(path, 'partial'))).toThrow();
    expect(execute).toHaveBeenLastCalledWith('git worktree prune', { cwd: root, timeout: 120_000 });
    expect(() => cleanupQaWorktree({ projectDir: root, stateDir: join(root, 'state'), worktreePath: root, exec: execute })).toThrow();
  });

  it('fails a missing smoke command instead of advancing the baseline', () => {
    const result = run({ smokeTest: '', testCommand: '' });
    expect(result.status).toBe('failure');
    expect(result.failure?.output).toContain('No smoke_test or test_command');
    expect(readQaState(join(root, 'state'), 'feat/factory').lastGreenSha).toBeNull();
  });

  it('stops before executing another command when the total budget expires', () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(120_001);
    try {
      const result = run();
      expect(result.failure?.exitCode).toBe(124);
      expect(execute).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('validates worker results before they reach the inbox', () => {
    expect(isQaResult(failure())).toBe(true);
    for (const invalid of [null, {}, { ...failure(), testedSha: 'main' }, { ...failure(), status: 'success' },
      { ...failure(), failure: { command: 'build', exitCode: 0, output: 'bad' } }, { ...failure(), commits: [7] }]) {
      expect(isQaResult(invalid)).toBe(false);
    }
  });

  it('reports an unavailable baseline and tolerates corrupt state', () => {
    mkdirSync(join(root, 'state'));
    writeFileSync(join(root, 'state/qa.json'), '{');
    const original = execute.getMockImplementation()!;
    execute.mockImplementation((cmd, opts) => cmd === 'pnpm build' ? { ...ok, exitCode: 1 } : original(cmd, opts));
    const result = run();
    expect(formatQaBugIdea(result)).toContain('baseline unavailable');
    expect(result.historyKind).toBe('recent');
    expect(JSON.parse(readFileSync(join(root, 'state/qa.json'), 'utf8')).lastQaAt).toBe(now.toISOString());
  });
});


describe('QA runtime smoke against a local origin', () => {
  it('passes, detects a regression twice as one idea, then advances the baseline on recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-qa-runtime-'));
    const project = join(root, 'project');
    const stateDir = join(root, 'state');
    const origin = join(root, 'origin.git');
    mkdirSync(project);
    const run = (command: string) => {
      const r = exec(command, { cwd: project, timeout: 30_000 });
      if (r.exitCode !== 0) throw new Error(`${command}: ${r.stdout}\n${r.stderr}`);
      return r.stdout;
    };
    try {
      run(`git init --bare ${shellQuote(origin)}`);
      run('git init');
      run('git config user.name QA');
      run('git config user.email qa@example.invalid');
      run('git checkout -b feat/qa-smoke');
      run(`git remote add origin ${shellQuote(origin)}`);
      writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'qa-smoke-fixture', private: true,
        scripts: { build: 'node -e "process.exit(0)"', smoke: 'node check.cjs', test: 'node -e "process.exit(99)"' } }));
      writeFileSync(join(project, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\nimporters:\n  .: {}\n");
      writeFileSync(join(project, 'check.cjs'), "console.log('smoke passed')\n");
      run('git add .');
      run('git commit -m baseline');
      run('git push origin HEAD');
      const opts = { projectDir: project, stateDir, baseBranch: 'feat/qa-smoke', smokeTest: 'pnpm smoke', testCommand: 'pnpm test', setupCommand: '', timeoutMinutes: 1 };
      const first = runQa(opts);
      expect(first.status).toBe('success');
      const baseline = first.testedSha;
      expect(readQaState(stateDir, opts.baseBranch).lastGreenSha).toBe(baseline);
      writeFileSync(join(project, 'check.cjs'), "console.error('Error: smoke regression'); process.exit(7);\n");
      run('git add check.cjs');
      run('git commit -m regression');
      run('git push origin HEAD');
      const regression = run('git rev-parse HEAD');
      const inbox = join(stateDir, 'inbox.md');
      for (let n = 0; n < 2; n++) {
        const result = runQa(opts);
        expect(result.status).toBe('failure');
        expect(result.failure?.command).toBe('pnpm smoke');
        expect(result.failure?.output).toContain('Error: smoke regression');
        expect(result.testedSha).toBe(regression);
        expect(result.commits).toEqual([`${regression} regression`]);
        const appended = appendTaggedIdea(inbox, formatQaBugIdea(result), { source: 'qa', fingerprint: qaFailureFingerprint(result.failure!) });
        expect(appended.created).toBe(n === 0);
        updateIdea(inbox, appended.idea.id, { status: 'done', note: '#451' });
        expect(readQaState(stateDir, opts.baseBranch).lastGreenSha).toBe(baseline);
      }
      expect(readInbox(inbox)).toHaveLength(1);
      expect(readInbox(inbox)[0].text).toContain(`${regression} regression`);

      // A different stderr failure with the same command and exit code must file
      // a new idea. Its later stdout must remain at the end of the evidence.
      writeFileSync(join(project, 'check.cjs'), [
        "const { writeSync } = require('node:fs');",
        "writeSync(2, 'Error: a different regression\\n');",
        "for (let n = 0; n < 70; n++) writeSync(1, `diagnostic ${n}\\n`);",
        'process.exit(7);',
      ].join('\n'));
      run('git add check.cjs');
      run('git commit -m another-regression');
      run('git push origin HEAD');
      const different = runQa(opts);
      expect(different.failure?.output.indexOf('Error: a different regression')).toBeLessThan(different.failure!.output.indexOf('diagnostic 0'));
      const differentIdea = formatQaBugIdea(different);
      expect(differentIdea).toContain('diagnostic 69');
      expect(differentIdea).not.toContain('Error: a different regression');
      expect(appendTaggedIdea(inbox, differentIdea, {
        source: 'qa', fingerprint: qaFailureFingerprint(different.failure!),
      }).created).toBe(true);
      expect(readInbox(inbox)).toHaveLength(2);

      writeFileSync(join(project, 'check.cjs'), "console.log('fixed')\n");
      run('git add check.cjs');
      run('git commit -m recovered');
      run('git push origin HEAD');
      const recovered = runQa(opts);
      expect(recovered.status).toBe('success');
      expect(readQaState(stateDir, opts.baseBranch).lastGreenSha).toBe(recovered.testedSha);
      expect(recovered.testedSha).not.toBe(baseline);
      expect(run('git worktree list --porcelain')).not.toContain('qa-worktrees');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
