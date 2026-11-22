import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

import { loadConfig } from '../../src/lib/config.js';
import {
  AGENT_PROFILE_URL,
  APPLICATION_PROFILE_URL,
} from '../../src/lib/security-types.js';

const DOC_PATH = join(__dirname, '..', '..', 'docs', 'security-profiles.md');

function extractYamlBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const fenceOpen = '```yaml\n';
  const fenceClose = '```';
  let i = 0;
  while (true) {
    const start = markdown.indexOf(fenceOpen, i);
    if (start === -1) break;
    const bodyStart = start + fenceOpen.length;
    const end = markdown.indexOf(fenceClose, bodyStart);
    if (end === -1) break;
    blocks.push(markdown.slice(bodyStart, end));
    i = end + fenceClose.length;
  }
  return blocks;
}

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-sec-docs-'));
  process.chdir(tempDir);
  (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(() => {
    throw new Error('not a git repo');
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('docs/security-profiles.md', () => {
  const markdown = readFileSync(DOC_PATH, 'utf-8');
  const blocks = extractYamlBlocks(markdown);

  it('names both default profile URLs and all three disable controls', () => {
    expect(markdown).toContain(APPLICATION_PROFILE_URL);
    expect(markdown).toContain(AGENT_PROFILE_URL);
    expect(markdown).toContain('enterprise-attack/enterprise-attack.json');
    expect(markdown).toContain('research/framework-model.yml');
    expect(markdown).toContain('security_checks: false');
    expect(markdown).toContain('security_profiles.application.enabled: false');
    expect(markdown).toContain('security_profiles.agent.enabled: false');
    expect(markdown).toContain('--skip-sec');
    expect(markdown).toContain('NOT_RUN');
    expect(markdown).toContain('SOC 2');
    expect(markdown).toContain('Newsletter demo');
    expect(markdown).toContain('newsletter-signup:template');
    expect(markdown).toContain('DEMO_REPO');
    expect(markdown).toContain('DEMO_FORK=1');
    expect(markdown).toContain('NOT_APPLICABLE');
    expect(markdown).toContain('test-security-e2e.sh');
  });

  it('declare YAML block loads with both profiles enabled at default URLs', () => {
    const declare = blocks.find((block) =>
      block.includes('security_checks: true')
      && block.includes('application:')
      && block.includes('agent:')
      && block.includes(APPLICATION_PROFILE_URL),
    );
    expect(declare).toBeDefined();

    const wrapped = [
      'repo: owner/repo',
      'label: ready',
      'base_branch: main',
      'test_command: pnpm test',
      declare,
    ].join('\n');
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), wrapped);
    const config = loadConfig();
    expect(config.securityChecks).toBe(true);
    expect(config.securityProfiles.application.enabled).toBe(true);
    expect(config.securityProfiles.agent.enabled).toBe(true);
    expect(config.securityProfiles.application.url).toBe(APPLICATION_PROFILE_URL);
    expect(config.securityProfiles.agent.url).toBe(AGENT_PROFILE_URL);
  });

  it('override YAML keeps agent on the default when only application is set', () => {
    const override = blocks.find((block) =>
      block.includes('my-attack-fork') && !block.includes('agent:'),
    );
    expect(override).toBeDefined();

    const wrapped = [
      'repo: owner/repo',
      'label: ready',
      'base_branch: main',
      'test_command: pnpm test',
      override,
    ].join('\n');
    writeFileSync(join(tempDir, '.alpha-loop.yaml'), wrapped);
    const config = loadConfig();
    expect(config.securityProfiles.application.url).toContain('my-attack-fork');
    expect(config.securityProfiles.agent.url).toBe(AGENT_PROFILE_URL);
  });
});
