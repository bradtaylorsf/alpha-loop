import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewCommand } from '../../src/commands/review';
import { loadConfig } from '../../src/lib/config';
import { spawnAgent } from '../../src/lib/agent';
import { exec } from '../../src/lib/shell';
import { createPR } from '../../src/lib/github';

jest.mock('../../src/lib/config', () => ({
  loadConfig: jest.fn(),
}));

jest.mock('../../src/lib/agent', () => ({
  spawnAgent: jest.fn(),
}));

jest.mock('../../src/lib/shell', () => ({
  exec: jest.fn(),
  formatTimestamp: jest.fn(() => '2026-05-26-120000'),
}));

jest.mock('../../src/lib/github', () => ({
  createPR: jest.fn(),
}));

jest.mock('../../src/lib/templates', () => ({
  findDistributionTemplatesDir: jest.fn(() => null),
  diffSkills: jest.fn(() => []),
  diffAgents: jest.fn(() => []),
}));

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

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockSpawnAgent = spawnAgent as jest.MockedFunction<typeof spawnAgent>;
const mockExec = exec as jest.MockedFunction<typeof exec>;
const mockCreatePR = createPR as jest.MockedFunction<typeof createPR>;

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), 'alpha-loop-review-sync-'));
}

describe('reviewCommand', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    jest.spyOn(process, 'cwd').mockReturnValue(projectDir);
    jest.clearAllMocks();

    mockLoadConfig.mockReturnValue({
      repo: 'owner/repo',
      baseBranch: 'master',
      model: 'gpt-test',
      reviewModel: 'gpt-review',
      harnesses: ['claude-code'],
    } as ReturnType<typeof loadConfig>);
    mockExec.mockReturnValue({ stdout: '', stderr: '', exitCode: 0 });
    mockCreatePR.mockReturnValue('https://github.com/owner/repo/pull/1');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('keeps harness-only files when review apply syncs templates', async () => {
    const learningsDir = join(projectDir, '.alpha-loop', 'learnings');
    mkdirSync(learningsDir, { recursive: true });
    writeFileSync(
      join(learningsDir, 'session-test.md'),
      [
        '---',
        'status: success',
        'retries: 0',
        'duration: 5',
        '---',
        '## What Worked',
        'Sync should be additive.',
      ].join('\n'),
    );

    const templateSkillDir = join(projectDir, '.alpha-loop', 'templates', 'skills', 'safe-sync');
    mkdirSync(templateSkillDir, { recursive: true });
    writeFileSync(join(templateSkillDir, 'SKILL.md'), '# Safe Sync v1');

    const harnessOnlySkillDir = join(projectDir, '.claude', 'skills', 'harness-only');
    mkdirSync(harnessOnlySkillDir, { recursive: true });
    writeFileSync(join(harnessOnlySkillDir, 'SKILL.md'), '# Harness Only');

    mockSpawnAgent.mockResolvedValue({
      exitCode: 0,
      output: JSON.stringify([
        {
          path: '.alpha-loop/templates/skills/safe-sync/SKILL.md',
          content: '# Safe Sync v2',
          reason: 'Keep sync additive by default.',
          category: 'skill',
        },
      ]),
      duration: 1,
    });

    await reviewCommand({ apply: true });

    expect(readFileSync(join(harnessOnlySkillDir, 'SKILL.md'), 'utf-8')).toBe('# Harness Only');
    expect(readFileSync(join(projectDir, '.claude', 'skills', 'safe-sync', 'SKILL.md'), 'utf-8')).toBe('# Safe Sync v2');
  });
});
