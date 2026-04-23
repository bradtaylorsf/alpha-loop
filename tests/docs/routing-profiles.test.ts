import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

jest.mock('node:child_process', () => ({
  execSync: jest.fn(),
}));

import { loadConfig } from '../../src/lib/config.js';

const DOC_PATH = join(__dirname, '..', '..', 'docs', 'routing-profiles.md');
const EXPECTED_PROFILES = ['all-frontier', 'hybrid-v1', 'all-local', 'budget-hawk'];
const EXPECTED_STAGES = ['plan', 'build', 'test_write', 'test_exec', 'review', 'summary'];

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
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-docs-'));
  process.chdir(tempDir);
  (execSync as jest.MockedFunction<typeof execSync>).mockImplementation(() => {
    throw new Error('not a git repo');
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('docs/routing-profiles.md', () => {
  const markdown = readFileSync(DOC_PATH, 'utf-8');
  const blocks = extractYamlBlocks(markdown);

  it('contains one YAML block per documented profile', () => {
    expect(blocks.length).toBe(EXPECTED_PROFILES.length);
  });

  it.each(EXPECTED_PROFILES.map((name, idx) => [idx, name]))(
    'block %i (%s) validates via loadConfig with all 6 stages and resolved endpoints',
    (idx, profileName) => {
      const block = blocks[idx]!;
      const wrapped = [
        'repo: owner/repo',
        'label: ready',
        'base_branch: main',
        'test_command: pnpm test',
        block,
      ].join('\n');

      writeFileSync(join(tempDir, '.alpha-loop.yaml'), wrapped);
      const config = loadConfig();

      expect(config.routing).toBeDefined();
      expect(config.routing!.profile).toBe(profileName);

      const stageNames = Object.keys(config.routing!.stages ?? {});
      for (const s of EXPECTED_STAGES) {
        expect(stageNames).toContain(s);
      }

      const endpointNames = Object.keys(config.routing!.endpoints ?? {});
      for (const [sn, sv] of Object.entries(config.routing!.stages!)) {
        expect(endpointNames).toContain(sv!.endpoint);
        expect(typeof sv!.model).toBe('string');
        expect(sv!.model.length).toBeGreaterThan(0);
      }

      const escalateTo = config.routing!.fallback?.escalate_to;
      if (escalateTo) {
        expect(endpointNames).toContain(escalateTo.endpoint);
      }
    },
  );
});
