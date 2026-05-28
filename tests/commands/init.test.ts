import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

// Silence all logger output during tests
jest.mock('../../src/lib/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn(), step: jest.fn(), dry: jest.fn(), rate: jest.fn(), debug: jest.fn() },
}));

// Mock rate-limit — ghExec delegates to the shell mock so existing assertions still work
jest.mock('../../src/lib/rate-limit', () => {
  const shell = require('../../src/lib/shell');
  return {
    ghExec: jest.fn((cmd: string) => shell.exec(cmd)),
    getRateLimitStatus: jest.fn(() => ({ remaining: 5000, limit: 5000, used: 0, resetAt: 0, ratio: 1 })),
    getProjectCache: jest.fn(() => null),
    setProjectCache: jest.fn(),
    clearProjectCache: jest.fn(),
    resetRateLimitState: jest.fn(),
    parseRateLimitHeaders: jest.fn(() => null),
    stripDebugOutput: jest.fn((s: string) => s),
  };
});

// Mock shell exec so init steps that shell out (scan, sync, git) don't run real commands
jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn().mockReturnValue({ exitCode: 1, stdout: '', stderr: '' }),
  shellQuote: (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`,
  formatTimestamp: jest.fn().mockReturnValue('20260401-100000'),
}));

// Mock scan so Step 7 doesn't spawn Claude
jest.mock('../../src/commands/scan', () => ({
  scanCommand: jest.fn(),
  generateInstructions: jest.fn(),
}));

// Mock sync so Step 8 doesn't do real file operations
jest.mock('../../src/commands/sync', () => ({
  syncAgentAssets: jest.fn().mockReturnValue({ synced: false, docSynced: false, skillsDirs: [] }),
  migrateToTemplates: jest.fn(),
  resolveHarnesses: jest.fn((harnesses: string[], _agent: string) => harnesses.length > 0 ? harnesses : ['claude']),
}));

// Mock vision helpers
jest.mock('../../src/lib/vision', () => ({
  hasVision: jest.fn().mockReturnValue(true),
}));

// Mock templates finder (no distribution templates in test)
jest.mock('../../src/lib/templates', () => ({
  findDistributionTemplatesDir: jest.fn().mockReturnValue(null),
}));

// Mock hardware detection — default to non-Apple-Silicon so the hardware prompt
// doesn't fire in most tests. Specific tests override to exercise the prompt path.
jest.mock('../../src/lib/hardware', () => ({
  shouldOfferLocalMode: jest.fn().mockReturnValue(false),
  getTotalMemoryGB: jest.fn().mockReturnValue(16),
  detectAppleSilicon: jest.fn().mockReturnValue(false),
}));

// Mock readline so interactive prompts (label creation, project statuses) don't block tests
// Default: answer 'y' so label/status creation tests work. Override in specific tests if needed.
jest.mock('node:readline', () => ({
  createInterface: jest.fn().mockReturnValue({
    question: jest.fn((_prompt: string, cb: (answer: string) => void) => cb('y')),
    close: jest.fn(),
  }),
}));

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;
const { findDistributionTemplatesDir: mockedFindDistributionTemplatesDir } = jest.requireMock('../../src/lib/templates') as {
  findDistributionTemplatesDir: jest.Mock;
};
const { exec: mockExec } = jest.requireMock('../../src/lib/shell') as { exec: jest.Mock };

// Mock process.exit to prevent Jest from actually exiting
const mockExit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
  throw new Error(`process.exit(${code})`);
}) as () => never);

import { initCommand, ensureLabels, ensureProjectStatuses } from '../../src/commands/init.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-init-'));
  process.chdir(tempDir);
  mockedExecSync.mockImplementation(() => {
    throw new Error('not a git repo');
  });
  mockedFindDistributionTemplatesDir.mockReturnValue(null);
  mockExec.mockReset();
  mockExec.mockReturnValue({ exitCode: 1, stdout: '', stderr: '' });
  mockExit.mockClear();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

function mockRecursiveCopyExec(): void {
  mockExec.mockImplementation((cmd: string) => {
    const match = cmd.match(/^cp -R "(.+)\/"\* "(.+)\/" 2>\/dev\/null \|\| true$/);
    if (!match) {
      return { exitCode: 1, stdout: '', stderr: '' };
    }

    const [, src, dest] = match;
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) {
      cpSync(join(src, entry), join(dest, entry), { recursive: true });
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

describe('ensureLabels', () => {
  it('skips creation when all labels exist', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh label list')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { name: 'ready' },
            { name: 'in-progress' },
            { name: 'in-review' },
            { name: 'failed' },
            { name: 'epic' },
            { name: 'needs-human-input' },
          ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ensureLabels('owner/repo', 'ready');
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining('gh label create'));
  });

  it('creates missing labels', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh label list')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ name: 'ready' }]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ensureLabels('owner/repo', 'ready');
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh label create "in-progress"'));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh label create "in-review"'));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh label create "failed"'));
  });

  it('uses configured label name instead of default "ready"', async () => {
    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh label list')) {
        return { exitCode: 0, stdout: JSON.stringify([]), stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ensureLabels('owner/repo', 'todo');
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh label create "todo"'));
    expect(mockExec).not.toHaveBeenCalledWith(expect.stringContaining('gh label create "ready"'));
  });

  it('handles gh CLI failure gracefully', async () => {
    mockExec.mockReturnValue({ exitCode: 1, stdout: '', stderr: 'error' });
    await ensureLabels('owner/repo', 'ready');
    // Should not throw, just warn
  });
});

describe('ensureProjectStatuses', () => {
  it('updates project status options through GraphQL variables and dedupes names case-insensitively', async () => {
    let graphqlPayload: any = null;

    mockExec.mockImplementation((cmd: string) => {
      if (cmd.includes('gh project view')) {
        return { exitCode: 0, stdout: JSON.stringify({ id: 'PVT_project' }), stderr: '' };
      }
      if (cmd.includes('gh project field-list')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            fields: [{
              id: 'PVTSSF_status',
              name: 'Status',
              options: [
                { id: 'todo-id', name: 'Todo', color: 'GRAY', description: 'Existing todo' },
                { id: 'progress-id', name: 'In Progress', color: 'YELLOW', description: 'Existing progress' },
                { id: 'done-id', name: 'Done', color: 'GREEN', description: 'Existing done' },
              ],
            }],
          }),
          stderr: '',
        };
      }
      if (cmd.includes('gh api graphql --input')) {
        const inputFile = cmd.match(/--input '([^']+)'/)?.[1];
        graphqlPayload = JSON.parse(readFileSync(inputFile!, 'utf-8'));
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await ensureProjectStatuses('owner', 1);

    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining('gh api graphql --input'));
    expect(graphqlPayload.query).toContain('mutation($projectId: ID!, $fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!)');
    expect(graphqlPayload.query).toContain('singleSelectOptions: $options');
    expect(graphqlPayload.query).not.toContain('singleSelectOptions: [{"name"');
    expect(graphqlPayload.variables).toEqual(expect.objectContaining({
      projectId: 'PVT_project',
      fieldId: 'PVTSSF_status',
    }));
    expect(graphqlPayload.variables.options.map((option: any) => option.name)).toEqual([
      'Todo',
      'In Progress',
      'Done',
      'In Review',
    ]);
    expect(graphqlPayload.variables.options.at(-1)).toEqual({
      name: 'In Review',
      color: 'PURPLE',
      description: 'Alpha Loop status',
    });
  });
});

describe('init command', () => {
  it('creates .alpha-loop.yaml with auto-detected repo', async () => {
    mockedExecSync.mockReturnValue('https://github.com/myorg/myrepo.git\n');

    await initCommand();

    const configPath = join(tempDir, '.alpha-loop.yaml');
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('repo: myorg/myrepo');
    expect(content).toContain('agent: claude');
    // No package.json in tempDir, so package manager is 'unknown' -> 'npm run test'
    expect(content).toMatch(/^test_command: npm run test$/m);
    expect(content).toContain('harnesses:');
  });

  it('creates config with placeholder when no git remote', async () => {
    await initCommand();

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('repo: owner/repo');
  });

  it('skips config creation when config already exists', async () => {
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), 'repo: existing/repo\n');

    await initCommand();

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('repo: existing/repo');
  });

  it('creates .gitignore with correct entries', async () => {
    await initCommand();

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.alpha-loop/sessions/');
    expect(gitignore).toContain('.alpha-loop/auth/');
    expect(gitignore).toContain('.worktrees/');
    expect(gitignore).toContain('plugins/');
    expect(gitignore).toContain('.alpha-loop/templates/*.bak');
  });

  it('removes stale learnings gitignore entry', async () => {
    writeFileSync(join(tempDir, '.gitignore'), '.alpha-loop/learnings/\n');

    await initCommand();

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).not.toContain('.alpha-loop/learnings/');
  });

  it('creates agent-ready and epic issue templates on fresh init', async () => {
    await initCommand({ yes: true });

    expect(existsSync(join(tempDir, '.github', 'ISSUE_TEMPLATE', 'agent-ready.yml'))).toBe(true);
    expect(existsSync(join(tempDir, '.github', 'ISSUE_TEMPLATE', 'epic.yml'))).toBe(true);
  });

  it('creates an epic template with the required label and sections', async () => {
    await initCommand({ yes: true });

    const epicTemplate = readFileSync(join(tempDir, '.github', 'ISSUE_TEMPLATE', 'epic.yml'), 'utf-8');
    expect(epicTemplate).toContain('labels: ["epic"]');
    expect(epicTemplate).toContain('The `epic` label is required');
    expect(epicTemplate).toContain('label: Goal');
    expect(epicTemplate).toContain('label: Sub-issues');
    expect(epicTemplate).toContain('label: Acceptance Criteria');
    expect(epicTemplate).toContain('label: Dependencies');
    expect(epicTemplate).toContain('label: Sequencing Notes');
    expect(epicTemplate).toContain('label: Verification Expectations');
    expect(epicTemplate).toContain('- [ ] #123 First agent-ready task');
  });

  it('preserves an existing epic issue template', async () => {
    const templateDir = join(tempDir, '.github', 'ISSUE_TEMPLATE');
    const epicTemplatePath = join(templateDir, 'epic.yml');
    const customEpicTemplate = 'name: Custom Epic\nlabels: ["custom"]\n';
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(epicTemplatePath, customEpicTemplate);

    await initCommand({ yes: true });

    expect(readFileSync(epicTemplatePath, 'utf-8')).toBe(customEpicTemplate);
    expect(existsSync(join(templateDir, 'agent-ready.yml'))).toBe(true);
  });

  it('seeds alpha-loop-runner from distribution templates', async () => {
    const distTemplatesDir = join(tempDir, 'dist-templates');
    const distSkillDir = join(distTemplatesDir, 'skills', 'alpha-loop-runner');
    const skillContent = [
      '---',
      'name: alpha-loop-runner',
      'auto_load: true',
      'priority: high',
      '---',
      '# Alpha Loop Runner',
      '',
    ].join('\n');
    mkdirSync(distSkillDir, { recursive: true });
    writeFileSync(join(distSkillDir, 'SKILL.md'), skillContent);
    mockedFindDistributionTemplatesDir.mockReturnValue(distTemplatesDir);
    mockRecursiveCopyExec();

    await initCommand({ yes: true });

    const installedSkill = readFileSync(
      join(tempDir, '.alpha-loop', 'templates', 'skills', 'alpha-loop-runner', 'SKILL.md'),
      'utf-8',
    );
    expect(installedSkill).toBe(skillContent);
  });

  it('seeds alpha-loop-setup from distribution templates', async () => {
    const distTemplatesDir = join(tempDir, 'dist-templates');
    const distSkillDir = join(distTemplatesDir, 'skills', 'alpha-loop-setup');
    const skillContent = [
      '---',
      'name: alpha-loop-setup',
      'auto_load: false',
      'priority: medium',
      '---',
      '# Alpha Loop Setup',
      '',
    ].join('\n');
    mkdirSync(distSkillDir, { recursive: true });
    writeFileSync(join(distSkillDir, 'SKILL.md'), skillContent);
    mockedFindDistributionTemplatesDir.mockReturnValue(distTemplatesDir);
    mockRecursiveCopyExec();

    await initCommand({ yes: true });

    const installedSkill = readFileSync(
      join(tempDir, '.alpha-loop', 'templates', 'skills', 'alpha-loop-setup', 'SKILL.md'),
      'utf-8',
    );
    expect(installedSkill).toBe(skillContent);
  });

  it('seeds alpha-loop-issue-author from distribution templates', async () => {
    const distTemplatesDir = join(tempDir, 'dist-templates');
    const distSkillDir = join(distTemplatesDir, 'skills', 'alpha-loop-issue-author');
    const skillContent = [
      '---',
      'name: alpha-loop-issue-author',
      'auto_load: true',
      'priority: high',
      '---',
      '# Alpha Loop Issue Author',
      '',
    ].join('\n');
    mkdirSync(distSkillDir, { recursive: true });
    writeFileSync(join(distSkillDir, 'SKILL.md'), skillContent);
    mockedFindDistributionTemplatesDir.mockReturnValue(distTemplatesDir);
    mockRecursiveCopyExec();

    await initCommand({ yes: true });

    const installedSkill = readFileSync(
      join(tempDir, '.alpha-loop', 'templates', 'skills', 'alpha-loop-issue-author', 'SKILL.md'),
      'utf-8',
    );
    expect(installedSkill).toBe(skillContent);
  });

  it('seeds alpha-loop-learning-review from distribution templates', async () => {
    const distTemplatesDir = join(tempDir, 'dist-templates');
    const distSkillDir = join(distTemplatesDir, 'skills', 'alpha-loop-learning-review');
    const skillContent = [
      '---',
      'name: alpha-loop-learning-review',
      'auto_load: true',
      'priority: high',
      '---',
      '# Alpha Loop Learning Review',
      '',
    ].join('\n');
    mkdirSync(distSkillDir, { recursive: true });
    writeFileSync(join(distSkillDir, 'SKILL.md'), skillContent);
    mockedFindDistributionTemplatesDir.mockReturnValue(distTemplatesDir);
    mockRecursiveCopyExec();

    await initCommand({ yes: true });

    const installedSkill = readFileSync(
      join(tempDir, '.alpha-loop', 'templates', 'skills', 'alpha-loop-learning-review', 'SKILL.md'),
      'utf-8',
    );
    expect(installedSkill).toBe(skillContent);
  });

  it('does not overwrite a customized alpha-loop-learning-review skill during init', async () => {
    const distTemplatesDir = join(tempDir, 'dist-templates');
    const distSkillDir = join(distTemplatesDir, 'skills', 'alpha-loop-learning-review');
    const projectSkillDir = join(tempDir, '.alpha-loop', 'templates', 'skills', 'alpha-loop-learning-review');
    const customContent = '# Custom Learning Review\n';
    mkdirSync(distSkillDir, { recursive: true });
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(join(distSkillDir, 'SKILL.md'), '# Distribution Learning Review\n');
    writeFileSync(join(projectSkillDir, 'SKILL.md'), customContent);
    mockedFindDistributionTemplatesDir.mockReturnValue(distTemplatesDir);
    mockRecursiveCopyExec();

    await initCommand({ yes: true });

    expect(readFileSync(join(projectSkillDir, 'SKILL.md'), 'utf-8')).toBe(customContent);
  });

  it('does not overwrite a customized alpha-loop-issue-author skill during init', async () => {
    const distTemplatesDir = join(tempDir, 'dist-templates');
    const distSkillDir = join(distTemplatesDir, 'skills', 'alpha-loop-issue-author');
    const projectSkillDir = join(tempDir, '.alpha-loop', 'templates', 'skills', 'alpha-loop-issue-author');
    const customContent = '# Custom Issue Author\n';
    mkdirSync(distSkillDir, { recursive: true });
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(join(distSkillDir, 'SKILL.md'), '# Distribution Issue Author\n');
    writeFileSync(join(projectSkillDir, 'SKILL.md'), customContent);
    mockedFindDistributionTemplatesDir.mockReturnValue(distTemplatesDir);
    mockRecursiveCopyExec();

    await initCommand({ yes: true });

    expect(readFileSync(join(projectSkillDir, 'SKILL.md'), 'utf-8')).toBe(customContent);
  });

  it('does not overwrite a customized alpha-loop-runner skill during init', async () => {
    const distTemplatesDir = join(tempDir, 'dist-templates');
    const distSkillDir = join(distTemplatesDir, 'skills', 'alpha-loop-runner');
    const projectSkillDir = join(tempDir, '.alpha-loop', 'templates', 'skills', 'alpha-loop-runner');
    const customContent = '# Custom Runner\n';
    mkdirSync(distSkillDir, { recursive: true });
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(join(distSkillDir, 'SKILL.md'), '# Distribution Runner\n');
    writeFileSync(join(projectSkillDir, 'SKILL.md'), customContent);
    mockedFindDistributionTemplatesDir.mockReturnValue(distTemplatesDir);
    mockRecursiveCopyExec();

    await initCommand({ yes: true });

    expect(readFileSync(join(projectSkillDir, 'SKILL.md'), 'utf-8')).toBe(customContent);
  });

  it('does not overwrite a customized alpha-loop-setup skill during init', async () => {
    const distTemplatesDir = join(tempDir, 'dist-templates');
    const distSkillDir = join(distTemplatesDir, 'skills', 'alpha-loop-setup');
    const projectSkillDir = join(tempDir, '.alpha-loop', 'templates', 'skills', 'alpha-loop-setup');
    const customContent = '# Custom Setup\n';
    mkdirSync(distSkillDir, { recursive: true });
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(join(distSkillDir, 'SKILL.md'), '# Distribution Setup\n');
    writeFileSync(join(projectSkillDir, 'SKILL.md'), customContent);
    mockedFindDistributionTemplatesDir.mockReturnValue(distTemplatesDir);
    mockRecursiveCopyExec();

    await initCommand({ yes: true });

    expect(readFileSync(join(projectSkillDir, 'SKILL.md'), 'utf-8')).toBe(customContent);
  });
});

describe('hardware-aware local mode prompt', () => {
  const hardware = jest.requireMock('../../src/lib/hardware') as {
    shouldOfferLocalMode: jest.Mock;
    getTotalMemoryGB: jest.Mock;
    detectAppleSilicon: jest.Mock;
  };
  const readline = jest.requireMock('node:readline') as {
    createInterface: jest.Mock;
  };

  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    hardware.shouldOfferLocalMode.mockReturnValue(false);
    hardware.getTotalMemoryGB.mockReturnValue(16);
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    // Restore stdin.isTTY exactly as we found it
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  }

  it('does not prompt when hardware does not qualify', async () => {
    hardware.shouldOfferLocalMode.mockReturnValue(false);
    setTTY(true);

    // Capture only questions asked from within maybeOfferLocalMode — other
    // interactive prompts (label creation) use the same mock, so inspect prompts.
    const questions: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        questions.push(prompt);
        cb('y');
      }),
      close: jest.fn(),
    });

    await initCommand();

    expect(questions.every((q) => !q.includes('Apple Silicon'))).toBe(true);
  });

  it('does not prompt when not running in a TTY, even on qualifying hardware', async () => {
    hardware.shouldOfferLocalMode.mockReturnValue(true);
    hardware.getTotalMemoryGB.mockReturnValue(128);
    setTTY(false);

    const questions: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        questions.push(prompt);
        cb('y');
      }),
      close: jest.fn(),
    });

    await initCommand();

    expect(questions.every((q) => !q.includes('Apple Silicon'))).toBe(true);
  });

  it('prompts on qualifying hardware + TTY and leaves YAML untouched on yes', async () => {
    hardware.shouldOfferLocalMode.mockReturnValue(true);
    hardware.getTotalMemoryGB.mockReturnValue(128);
    setTTY(true);

    const questions: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        questions.push(prompt);
        // First prompt (hardware) says yes; subsequent prompts (labels/statuses)
        // also say yes via default.
        cb('y');
      }),
      close: jest.fn(),
    });

    await initCommand();

    // Hardware prompt was asked
    expect(questions.some((q) => q.includes('Apple Silicon'))).toBe(true);

    // YAML is the untouched default template — hardware prompt does not modify it
    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('agent: claude');
    // Commented hint is fine; assert no *active* (uncommented) routing line
    expect(content.split('\n').some((line) => /^routing:/.test(line))).toBe(false);
  });

  it('prompts on qualifying hardware but also leaves YAML untouched on no', async () => {
    hardware.shouldOfferLocalMode.mockReturnValue(true);
    hardware.getTotalMemoryGB.mockReturnValue(64);
    setTTY(true);

    const questions: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        questions.push(prompt);
        // Decline the hardware prompt; other prompts (labels) get 'n' too but
        // shell mock returns exitCode 1 for gh so they're skipped harmlessly.
        cb('n');
      }),
      close: jest.fn(),
    });

    await initCommand();

    expect(questions.some((q) => q.includes('Apple Silicon'))).toBe(true);
    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('agent: claude');
    // Commented hint is fine; assert no *active* (uncommented) routing line
    expect(content.split('\n').some((line) => /^routing:/.test(line))).toBe(false);
  });
});

describe('init wizard', () => {
  const readline = jest.requireMock('node:readline') as { createInterface: jest.Mock };

  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  }

  it('skips prompts and uses scan defaults when --yes is set', async () => {
    setTTY(true);
    // Lay down a pnpm project so the scan picks up sensible defaults
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      scripts: { test: 'jest', dev: 'tsx watch' },
    }));

    const askedPrompts: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        askedPrompts.push(prompt);
        cb('y');
      }),
      close: jest.fn(),
    });

    await initCommand({ yes: true });

    // Wizard should not have asked anything (label/status creation may still prompt)
    expect(askedPrompts.every((p) => !p.includes('Test command'))).toBe(true);
    expect(askedPrompts.every((p) => !p.includes('AI agent'))).toBe(true);

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toMatch(/^test_command: pnpm test$/m);
    expect(content).toMatch(/^dev_command: pnpm dev$/m);
    expect(content).toMatch(/^agent: claude$/m);
  });

  it('skips prompts silently when not in a TTY', async () => {
    setTTY(false);

    const askedPrompts: string[] = [];
    readline.createInterface.mockReturnValue({
      question: jest.fn((prompt: string, cb: (answer: string) => void) => {
        askedPrompts.push(prompt);
        cb('');
      }),
      close: jest.fn(),
    });

    await initCommand();

    expect(askedPrompts.every((p) => !p.includes('AI agent'))).toBe(true);
    expect(askedPrompts.every((p) => !p.includes('Base branch'))).toBe(true);
  });

  it('honors empty answers (Enter) by falling back to scan defaults', async () => {
    setTTY(true);
    writeFileSync(join(tempDir, 'package-lock.json'), '');
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      scripts: { test: 'mocha', dev: 'node server.js' },
    }));

    readline.createInterface.mockReturnValue({
      // Press Enter for every prompt -> defaults
      question: jest.fn((_prompt: string, cb: (answer: string) => void) => cb('')),
      close: jest.fn(),
    });

    await initCommand();

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    // npm-detected lockfile -> "npm run test"
    expect(content).toMatch(/^test_command: npm run test$/m);
    // Defaults retained (lines may have trailing comments)
    expect(content).toMatch(/^agent: claude\b/m);
    expect(content).toMatch(/^auto_merge: true\b/m);
    expect(content).toMatch(/^max_issues: 20\b/m);
  });

  it('falls back to "claude" when wizard receives an unknown agent name', async () => {
    setTTY(true);
    const answers = ['totallynotanagent', '', '', '', '', ''];
    let i = 0;
    readline.createInterface.mockReturnValue({
      question: jest.fn((_prompt: string, cb: (answer: string) => void) => {
        cb(answers[i++] ?? '');
      }),
      close: jest.fn(),
    });

    await initCommand();

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toMatch(/^agent: claude$/m);
  });

  it('uses configured agent to pick a matching harness', async () => {
    setTTY(true);
    const answers = ['codex', '', '', '', '', ''];
    let i = 0;
    readline.createInterface.mockReturnValue({
      question: jest.fn((_prompt: string, cb: (answer: string) => void) => {
        cb(answers[i++] ?? '');
      }),
      close: jest.fn(),
    });

    await initCommand();

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toMatch(/^agent: codex$/m);
    expect(content).toMatch(/^ {2}- codex$/m);
  });
});

describe('init merge logic for existing config', () => {
  it('does not overwrite user values', async () => {
    const userConfig = `repo: my/repo\nagent: codex\nlabel: todo\nmax_issues: 5\n`;
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), userConfig);

    await initCommand({ yes: true });

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('repo: my/repo');
    expect(content).toContain('agent: codex');
    expect(content).toContain('label: todo');
    expect(content).toContain('max_issues: 5');
  });

  it('appends commented-out blocks for newly available settings', async () => {
    // User has only the bare minimum. Many keys (test_command, dev_command,
    // base_branch, etc.) are missing — merge should expose them as commented
    // hints at the bottom of the file.
    const userConfig = `repo: my/repo\nagent: claude\n`;
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), userConfig);

    await initCommand({ yes: true });

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).toContain('# === Added by alpha-loop init (new settings) ===');
    // The commented appendix should mention some missing keys
    expect(content).toMatch(/# test_command:/);
    expect(content).toMatch(/# base_branch:/);
  });

  it('is a no-op when all top-level keys are already present', async () => {
    // Config already covers every key the fresh template produces — merge
    // should leave the file alone.
    const fullConfig = [
      'repo: my/repo',
      'agent: claude',
      'base_branch: main',
      'label: ready',
      'auto_merge: true',
      'test_command: pnpm test',
      'dev_command: pnpm dev',
      'max_issues: 20',
      'max_session_duration: 7200',
      'harnesses:',
      '  - claude-code',
      '',
    ].join('\n');
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), fullConfig);

    await initCommand({ yes: true });

    const content = readFileSync(join(tempDir, '.alpha-loop.yaml'), 'utf-8');
    expect(content).not.toContain('# === Added by alpha-loop init');
  });
});
