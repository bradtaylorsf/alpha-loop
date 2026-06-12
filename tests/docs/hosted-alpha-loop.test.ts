import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

import { loadConfig } from '../../src/lib/config.js';

const ROOT = join(__dirname, '..', '..');
const README_PATH = join(ROOT, 'README.md');
const GUIDE_PATH = join(ROOT, 'docs', 'hosted-alpha-loop.md');

const CONFIG_ENV_KEYS = [
  'REPO',
  'PROJECT',
  'AGENT',
  'MODEL',
  'REVIEW_MODEL',
  'POLL_INTERVAL',
  'DRY_RUN',
  'BASE_BRANCH',
  'LOG_DIR',
  'LABEL_READY',
  'MAX_TEST_RETRIES',
  'TEST_COMMAND',
  'DEV_COMMAND',
  'SKIP_TESTS',
  'SKIP_REVIEW',
  'SKIP_INSTALL',
  'SKIP_PREFLIGHT',
  'SKIP_VERIFY',
  'SKIP_LEARN',
  'SKIP_E2E',
  'MAX_ISSUES',
  'MAX_SESSION_DURATION',
  'MILESTONE',
  'AUTO_MERGE',
  'MERGE_TO',
  'AUTO_CLEANUP',
  'RUN_FULL',
  'VERBOSE',
  'SETUP_COMMAND',
  'EVAL_DIR',
  'EVAL_MODEL',
  'SKIP_EVAL',
  'EVAL_TIMEOUT',
  'AUTO_CAPTURE',
  'SKIP_POST_SESSION_REVIEW',
  'SKIP_POST_SESSION_SECURITY',
  'BATCH',
  'BATCH_SIZE',
  'SMOKE_TEST',
  'AGENT_TIMEOUT',
  'PREFER_EPICS',
  'SESSION_RETENTION_PAUSED_WORKTREE_DAYS',
  'SESSION_RETENTION_COMPLETED_WORKTREE_DAYS',
];

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

function extractStarterYaml(markdown: string): string {
  const match = markdown.match(/## Safe Starter `\.alpha-loop\.yaml`[\s\S]*?```yaml\n([\s\S]*?)```/);
  if (!match) {
    throw new Error('Could not find hosted starter YAML block');
  }
  return match[1]!;
}

function extractMarkdownLinks(markdown: string): string[] {
  const links: string[] = [];
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(markdown)) !== null) {
    links.push(match[1]!);
  }
  return links;
}

function expectLocalLinksToResolve(markdown: string, sourcePath: string): void {
  for (const rawLink of extractMarkdownLinks(markdown)) {
    if (/^(https?:|mailto:|#)/.test(rawLink)) continue;
    const [target] = rawLink.split('#');
    if (!target) continue;
    expect(existsSync(join(dirname(sourcePath), target))).toBe(true);
  }
}

describe('docs/hosted-alpha-loop.md', () => {
  const guide = read(GUIDE_PATH);
  const readme = read(README_PATH);

  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-hosted-docs-'));
    process.chdir(tempDir);
    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key];
    }
    (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(() => {
      throw new Error('not a git repo');
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('is linked from README', () => {
    expect(readme).toContain('[Hosted Alpha Loop Setup Guide](docs/hosted-alpha-loop.md)');
    expect(existsSync(GUIDE_PATH)).toBe(true);
  });

  it('covers hosted setup, policy, destinations, feedback, QA, and operations', () => {
    for (const section of [
      '## Recommended Install Shape',
      '## Prerequisites',
      '## Server Filesystem Layout',
      '## GitHub Setup',
      '## Safe Starter `.alpha-loop.yaml`',
      '### Marketing Site Variant',
      '## First Run Workflow',
      '## Automation Policy and Human Gates',
      '## Event Destinations',
      '### Slack',
      '### Microsoft Teams',
      '### Discord',
      '### Email Via Script',
      '### Custom Webhook',
      '## Feedback Ingestion and Resume',
      '## Human QA Handoff',
      '## Running the Daemon',
      '### systemd Example',
      '### Docker Example',
      '## Logs, Health Checks, and History',
      '## Pausing, Cleanup, and Budgets',
      '## Troubleshooting',
    ]) {
      expect(guide).toContain(section);
    }

    for (const requiredText of [
      'GitHub comments are the canonical feedback source',
      'Humans should apply `ready` only after',
      '`do-not-automate`',
      '`needs-human-input`',
      '`blocked`',
      'pnpm exec alpha-loop resume --issue 42',
      'Paused worktrees are intentionally retained',
      'Human QA should check the PR diff, preview URL, screenshots',
      'daemon.health',
      'max_session_cost_usd',
      'alpha-loop history --clean',
    ]) {
      expect(guide).toContain(requiredText);
    }
  });

  it('keeps local markdown references resolvable', () => {
    expectLocalLinksToResolve(guide, GUIDE_PATH);
    expect(existsSync(join(ROOT, 'docs', 'hosted-alpha-loop.md'))).toBe(true);
  });

  it('has a starter YAML config that loads with hosted keys populated', () => {
    const starterYaml = extractStarterYaml(guide);
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), starterYaml);

    const config = loadConfig();

    expect(config.repo).toBe('owner/repo');
    expect(config.agent).toBe('codex');
    expect(config.baseBranch).toBe('main');
    expect(config.labelReady).toBe('ready');
    expect(config.autoMerge).toBe(false);

    expect(config.webApp).toEqual(expect.objectContaining({
      setupCommand: 'pnpm install --frozen-lockfile',
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      devCommand: 'pnpm dev',
      devUrl: 'http://localhost:4321',
      smokeTest: 'pnpm build',
      preview: {
        url: '',
        command: './scripts/get-preview-url.sh',
        required: false,
      },
    }));
    expect(config.webApp?.screenshots).toEqual([
      { name: 'home-desktop', url: '/', viewport: 'desktop' },
      { name: 'home-mobile', url: '/', viewport: 'mobile', width: 390, height: 844 },
    ]);

    expect(config.automationPolicy).toEqual(expect.objectContaining({
      requireLabels: ['ready'],
      blockLabels: ['do-not-automate', 'needs-human-input', 'blocked'],
      maxActiveSessions: 1,
      maxPausedSessions: 20,
      maxIssuesPerSession: 1,
      maxSessionMinutes: 90,
      maxSessionCostUsd: 30,
      maxIssueCostUsd: 10,
      allowedCommands: [
        'pnpm install',
        'pnpm install --frozen-lockfile',
        'pnpm test',
        'pnpm build',
        'pnpm dev',
        './scripts/get-preview-url.sh',
      ],
      requireHumanFor: [
        'auth',
        'billing',
        'production-deploy',
        'dependency-upgrade',
        'sanity-schema',
        'secrets',
        'migrations',
        'destructive-content',
        'ambiguous',
      ],
    }));
    expect(config.automationPolicy?.allowedPaths).toEqual(expect.arrayContaining([
      'src/**',
      'app/**',
      'content/**',
      'public/**',
      'tests/**',
    ]));
    expect(config.automationPolicy?.protectedPaths).toEqual(expect.arrayContaining([
      'package.json',
      'pnpm-lock.yaml',
      '.github/workflows/**',
      '.env*',
    ]));

    expect(config.daemon).toEqual(expect.objectContaining({
      mode: 'full',
      triageIntervalSeconds: 900,
      feedbackIntervalSeconds: 60,
      runIntervalSeconds: 120,
      healthIntervalSeconds: 300,
      idleSleepSeconds: 30,
      feedbackPollCommand: '',
      lock: {
        enabled: true,
        staleAfterSeconds: 86400,
        path: '',
      },
    }));
    expect(config.sessionRetention).toEqual({
      pausedWorktreeDays: 0,
      completedWorktreeDays: 30,
    });
    expect(config.events).toEqual(expect.objectContaining({
      includePromptText: false,
      redact: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'SANITY_TOKEN'],
    }));
    expect(config.events?.destinations.audit_log).toEqual(expect.objectContaining({
      type: 'log',
      events: ['*'],
      format: 'json',
    }));
    expect(config.events?.destinations.slack_qa).toEqual(expect.objectContaining({
      type: 'webhook',
      events: ['qa.requested', 'human_input.requested', 'session.failed'],
      urlEnv: 'SLACK_WEBHOOK_URL',
      format: 'slack',
      retries: 1,
      timeout: 10,
      required: false,
    }));
  });
});
