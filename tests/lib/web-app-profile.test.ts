import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../src/lib/config.js';

jest.mock('../../src/lib/shell.js', () => ({
  exec: jest.fn(),
}));

import {
  buildWebAppQaChecklist,
  collectWebAppVerificationSummary,
  normalizeWebAppProfile,
  resolveWebAppPreviewUrl,
} from '../../src/lib/web-app-profile.js';

const { exec } = jest.requireMock('../../src/lib/shell.js') as { exec: jest.Mock };

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    repo: 'owner/repo',
    repoOwner: 'owner',
    project: 1,
    agent: 'codex',
    model: 'gpt-5',
    reviewModel: 'gpt-5',
    pollInterval: 60,
    dryRun: false,
    baseBranch: 'main',
    logDir: 'logs',
    labelReady: 'ready',
    maxTestRetries: 3,
    testCommand: 'pnpm test',
    devCommand: 'pnpm dev',
    skipTests: false,
    skipReview: false,
    skipInstall: false,
    skipPreflight: false,
    skipVerify: false,
    skipLearn: false,
    skipE2e: false,
    maxIssues: 0,
    maxSessionDuration: 0,
    milestone: '',
    autoMerge: true,
    mergeTo: '',
    autoCleanup: true,
    runFull: false,
    verbose: false,
    harnesses: [],
    setupCommand: '',
    evalDir: '.alpha-loop/evals',
    evalModel: '',
    skipEval: false,
    evalTimeout: 300,
    autoCapture: true,
    skipPostSessionReview: false,
    skipPostSessionSecurity: false,
    batch: false,
    batchSize: 5,
    smokeTest: '',
    agentTimeout: 1800,
    pricing: {},
    pipeline: {},
    evalIncludeAgentPrompts: true,
    evalIncludeSkills: true,
    preferEpics: false,
    ...overrides,
  };
}

describe('web app profile', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-web-app-'));
    process.chdir(tempDir);
    exec.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates Astro-friendly screenshot plans from an empty web_app profile', () => {
    const worktree = join(tempDir, 'worktree');
    const sessionDir = join(tempDir, '.alpha-loop', 'sessions', 'session', 'test');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'package.json'), JSON.stringify({
      packageManager: 'pnpm@9.0.0',
      scripts: { dev: 'astro dev', build: 'astro build', test: 'vitest' },
      dependencies: { astro: '^5.0.0' },
    }));

    const profile = normalizeWebAppProfile(makeConfig({
      webApp: {
        setupCommand: '',
        buildCommand: '',
        testCommand: '',
        devCommand: '',
        devUrl: '',
        smokeTest: '',
        screenshots: [],
        preview: { url: '', command: '', required: false },
      },
    }), { worktree, sessionDir, issueNum: 290 });

    expect(profile).toEqual(expect.objectContaining({
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      devCommand: 'pnpm dev',
      devUrl: 'http://localhost:4321',
    }));
    expect(profile?.screenshots).toEqual([
      expect.objectContaining({
        name: 'home-desktop',
        fullUrl: 'http://localhost:4321/',
        viewport: { preset: 'desktop', width: 1440, height: 1000 },
        relativePath: expect.stringContaining('home-desktop.png'),
      }),
      expect.objectContaining({
        name: 'home-mobile',
        viewport: { preset: 'mobile', width: 390, height: 844 },
        relativePath: expect.stringContaining('home-mobile.png'),
      }),
    ]);
  });

  it('resolves provider-agnostic preview URLs from a static URL or command output', () => {
    const staticProfile = normalizeWebAppProfile(makeConfig({
      webApp: {
        setupCommand: '',
        buildCommand: 'pnpm build',
        testCommand: 'pnpm test',
        devCommand: 'pnpm dev',
        devUrl: 'http://localhost:4321',
        smokeTest: '',
        screenshots: [{ name: 'home', url: '/', viewport: 'desktop' }],
        preview: { url: 'https://static-preview.example.test', command: './ignored.sh', required: true },
      },
    }), { worktree: tempDir, sessionDir: tempDir, issueNum: 1 })!;
    expect(resolveWebAppPreviewUrl(staticProfile, tempDir)).toEqual({
      url: 'https://static-preview.example.test',
      source: 'url',
      required: true,
    });

    const profile = normalizeWebAppProfile(makeConfig({
      webApp: {
        setupCommand: '',
        buildCommand: 'pnpm build',
        testCommand: 'pnpm test',
        devCommand: 'pnpm dev',
        devUrl: 'http://localhost:4321',
        smokeTest: '',
        screenshots: [{ name: 'home', url: '/', viewport: 'desktop' }],
        preview: { url: '', command: './preview.sh', required: false },
      },
    }), { worktree: tempDir, sessionDir: tempDir, issueNum: 1 })!;
    exec.mockReturnValue({ exitCode: 0, stdout: 'Preview: https://preview.example.test', stderr: '' });

    const result = resolveWebAppPreviewUrl(profile, tempDir, { prUrl: 'https://github.com/owner/repo/pull/1' });

    expect(result).toEqual(expect.objectContaining({
      url: 'https://preview.example.test',
      source: 'command',
      command: './preview.sh',
      exitCode: 0,
    }));
    expect(exec).toHaveBeenCalledWith('./preview.sh', expect.objectContaining({
      cwd: tempDir,
      env: { ALPHA_LOOP_PR_URL: 'https://github.com/owner/repo/pull/1' },
    }));
  });

  it('surfaces required preview command failures without hard-coding a provider', () => {
    const profile = normalizeWebAppProfile(makeConfig({
      webApp: {
        setupCommand: '',
        buildCommand: '',
        testCommand: '',
        devCommand: 'pnpm dev',
        devUrl: 'http://localhost:3000',
        smokeTest: '',
        screenshots: [],
        preview: { url: '', command: './preview.sh', required: true },
      },
    }), { worktree: tempDir, sessionDir: tempDir, issueNum: 1 })!;
    exec.mockReturnValue({ exitCode: 2, stdout: '', stderr: 'not ready' });

    const result = resolveWebAppPreviewUrl(profile, tempDir);

    expect(result.url).toBeNull();
    expect(result.required).toBe(true);
    expect(result.error).toContain('exit code 2');
    expect(result.output).toBe('not ready');
  });

  it('writes fallback browser artifacts and generates human QA checklist items', () => {
    const profile = normalizeWebAppProfile(makeConfig({
      webApp: {
        setupCommand: '',
        buildCommand: '',
        testCommand: '',
        devCommand: 'pnpm dev',
        devUrl: 'http://localhost:4321',
        smokeTest: '',
        screenshots: [{ name: 'home-desktop', url: '/', viewport: 'desktop' }],
        preview: { url: 'https://preview.example.test', command: '', required: false },
      },
    }), { worktree: tempDir, sessionDir: tempDir, issueNum: 290 })!;

    const summary = collectWebAppVerificationSummary(profile, {
      issueNum: 290,
      passed: true,
      skipped: false,
      output: '### Status: PASS',
      previewUrl: 'https://preview.example.test',
    });
    const checklist = buildWebAppQaChecklist({
      issueNum: 290,
      profile,
      verification: summary,
      planChecklist: ['Confirm headline copy is correct.'],
    });

    expect(summary.artifactPath).toContain('web-app-verification/issue-290.json');
    expect(summary.screenshots[0]).toContain('home-desktop.png');
    expect(JSON.parse(readFileSync(profile.artifactPath, 'utf-8'))).toEqual(expect.objectContaining({
      issueNum: 290,
      previewUrl: 'https://preview.example.test',
    }));
    expect(checklist).toEqual(expect.arrayContaining([
      'Open https://preview.example.test and confirm issue #290 works in the browser.',
      expect.stringContaining('Review home-desktop at desktop viewport'),
      'Confirm headline copy is correct.',
    ]));
  });
});
