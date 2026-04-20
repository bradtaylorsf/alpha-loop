jest.mock('../../src/lib/vision', () => ({
  getVisionContext: jest.fn(),
}));

jest.mock('../../src/lib/context', () => ({
  getProjectContext: jest.fn(),
}));

jest.mock('../../src/lib/github', () => ({
  pollIssues: jest.fn(),
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
  },
}));

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractJsonFromResponse,
  formatIssueTable,
  formatTriageFindings,
  normalizeMilestoneTitles,
  normalizePlanMilestones,
  normalizeRoadmapMilestones,
  readSeedFiles,
  buildPlanningContext,
  savePlanDraft,
  type PlannedIssue,
  type PlannedMilestone,
  type TriageFinding,
  type PlanDraft,
} from '../../src/lib/planning';
import { getVisionContext } from '../../src/lib/vision';
import { getProjectContext } from '../../src/lib/context';
import { pollIssues } from '../../src/lib/github';
import type { Config } from '../../src/lib/config';

const mockGetVisionContext = getVisionContext as jest.MockedFunction<typeof getVisionContext>;
const mockGetProjectContext = getProjectContext as jest.MockedFunction<typeof getProjectContext>;
const mockPollIssues = pollIssues as jest.MockedFunction<typeof pollIssues>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── extractJsonFromResponse ──────────────────────────────────────────────────

describe('extractJsonFromResponse', () => {
  it('extracts JSON from ```json fenced block', () => {
    const response = `Here is the plan:

\`\`\`json
{"milestones": [{"title": "v1", "order": 1}]}
\`\`\`

That's the plan.`;

    const result = extractJsonFromResponse<{ milestones: Array<{ title: string; order: number }> }>(response);
    expect(result).toEqual({ milestones: [{ title: 'v1', order: 1 }] });
  });

  it('extracts unfenced raw JSON', () => {
    const result = extractJsonFromResponse<{ count: number }>(
      '{"count": 42}'
    );
    expect(result).toEqual({ count: 42 });
  });

  it('extracts JSON surrounded by markdown noise', () => {
    const response = `# Analysis

Some thoughts about the project...

{"issues": [{"id": 1, "title": "Fix bug"}]}

## Conclusion
That's all.`;

    const result = extractJsonFromResponse<{ issues: Array<{ id: number; title: string }> }>(response);
    expect(result).toEqual({ issues: [{ id: 1, title: 'Fix bug' }] });
  });

  it('throws on invalid JSON', () => {
    expect(() => extractJsonFromResponse('{not valid json}')).toThrow(
      'Could not extract valid JSON'
    );
  });

  it('throws on empty response', () => {
    expect(() => extractJsonFromResponse('')).toThrow('Empty response');
  });

  it('throws on whitespace-only response', () => {
    expect(() => extractJsonFromResponse('   \n  ')).toThrow('Empty response');
  });

  it('extracts JSON array from response', () => {
    const result = extractJsonFromResponse<number[]>('Here: [1, 2, 3] done');
    expect(result).toEqual([1, 2, 3]);
  });

  it('prefers fenced block over unfenced JSON', () => {
    const response = `{"wrong": true}

\`\`\`json
{"correct": true}
\`\`\``;

    const result = extractJsonFromResponse<{ correct: boolean }>(response);
    expect(result).toEqual({ correct: true });
  });
});

// ── formatIssueTable ─────────────────────────────────────────────────────────

describe('formatIssueTable', () => {
  const milestones: PlannedMilestone[] = [
    { title: 'v1.0', description: 'First release', dueOn: '2026-06-01', order: 1 },
    { title: 'v2.0', description: 'Second release', dueOn: null, order: 2 },
  ];

  it('renders issues grouped by milestone', () => {
    const issues: PlannedIssue[] = [
      {
        id: 1, title: 'Setup CI', body: '', labels: ['infra'],
        milestone: 'v1.0', priority: 'p0', complexity: 'small',
        dependsOn: [], selected: true,
      },
      {
        id: 2, title: 'Add tests', body: '', labels: ['testing'],
        milestone: 'v1.0', priority: 'p1', complexity: 'medium',
        dependsOn: [1], selected: false,
      },
      {
        id: 3, title: 'New feature', body: '', labels: ['feat'],
        milestone: 'v2.0', priority: 'p2', complexity: 'large',
        dependsOn: [], selected: true,
      },
    ];

    const output = formatIssueTable(issues, milestones);

    // Should contain both milestone headers
    expect(output).toContain('v1.0');
    expect(output).toContain('v2.0');
    // Should contain issue titles
    expect(output).toContain('Setup CI');
    expect(output).toContain('Add tests');
    expect(output).toContain('New feature');
    // Should show dependency
    expect(output).toContain('→ [1]');
    // Should show selection marks
    expect(output).toContain('[✓]');
    expect(output).toContain('[ ]');
    // Should show due date for v1.0
    expect(output).toContain('due 2026-06-01');
  });

  it('handles empty issue list', () => {
    const output = formatIssueTable([], milestones);
    expect(output).toContain('No issues to display');
  });

  it('handles issues with no milestone match', () => {
    const issues: PlannedIssue[] = [
      {
        id: 1, title: 'Orphan issue', body: '', labels: [],
        milestone: 'unknown', priority: 'p3', complexity: 'trivial',
        dependsOn: [], selected: false,
      },
    ];

    const output = formatIssueTable(issues, milestones);
    expect(output).toContain('unknown');
    expect(output).toContain('Orphan issue');
  });
});

// ── formatTriageFindings ─────────────────────────────────────────────────────

describe('formatTriageFindings', () => {
  it('groups findings by category', () => {
    const findings: TriageFinding[] = [
      {
        issueNum: 10, title: 'Old bug', category: 'stale',
        reason: 'No activity for 6 months', action: 'close', selected: true,
      },
      {
        issueNum: 20, title: 'Vague request', category: 'unclear',
        reason: 'No acceptance criteria', action: 'rewrite', selected: false,
      },
      {
        issueNum: 30, title: 'Same as #10', category: 'duplicate',
        reason: 'Covers same scope', action: 'merge', duplicateOf: 10, selected: true,
      },
    ];

    const output = formatTriageFindings(findings);

    expect(output).toContain('Stale Issues');
    expect(output).toContain('Unclear Issues');
    expect(output).toContain('Duplicates');
    expect(output).toContain('Old bug');
    expect(output).toContain('No activity for 6 months');
    expect(output).toContain('Duplicate of #10');
  });

  it('handles empty findings', () => {
    const output = formatTriageFindings([]);
    expect(output).toContain('No triage findings');
  });

  it('shows split info for too_large findings', () => {
    const findings: TriageFinding[] = [
      {
        issueNum: 5, title: 'Huge epic', category: 'too_large',
        reason: 'Too many acceptance criteria', action: 'split',
        splitInto: ['Part A', 'Part B', 'Part C'], selected: false,
      },
    ];

    const output = formatTriageFindings(findings);
    expect(output).toContain('Too Large');
    expect(output).toContain('Part A, Part B, Part C');
  });
});

// ── readSeedFiles ────────────────────────────────────────────────────────────

describe('readSeedFiles', () => {
  it('reads files matching patterns from a temp directory', () => {
    const tmpDir = join(__dirname, '..', '..', '.test-seed-' + Date.now());
    const subDir = join(tmpDir, 'src');

    try {
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(tmpDir, 'README.md'), '# Hello');
      writeFileSync(join(subDir, 'index.ts'), 'export {}');
      writeFileSync(join(subDir, 'utils.ts'), 'export const x = 1');

      const results = readSeedFiles(['src/*.ts'], tmpDir);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.path).sort()).toEqual(['src/index.ts', 'src/utils.ts']);
      expect(results[0].content).toBeTruthy();
    } finally {
      // Cleanup
      try {
        const { execSync } = require('node:child_process');
        execSync(`rm -rf "${tmpDir}"`);
      } catch {
        // Best effort cleanup
      }
    }
  });

  it('returns empty array when no files match', () => {
    const tmpDir = join(__dirname, '..', '..', '.test-seed-empty-' + Date.now());
    try {
      mkdirSync(tmpDir, { recursive: true });
      const results = readSeedFiles(['**/*.xyz'], tmpDir);
      expect(results).toEqual([]);
    } finally {
      try {
        const { execSync } = require('node:child_process');
        execSync(`rm -rf "${tmpDir}"`);
      } catch {
        // Best effort cleanup
      }
    }
  });

  it('deduplicates files matched by multiple patterns', () => {
    const tmpDir = join(__dirname, '..', '..', '.test-seed-dedup-' + Date.now());
    try {
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(join(tmpDir, 'file.ts'), 'content');

      const results = readSeedFiles(['*.ts', '**/*.ts'], tmpDir);
      expect(results).toHaveLength(1);
    } finally {
      try {
        const { execSync } = require('node:child_process');
        execSync(`rm -rf "${tmpDir}"`);
      } catch {
        // Best effort cleanup
      }
    }
  });
});

// ── buildPlanningContext ─────────────────────────────────────────────────────

describe('buildPlanningContext', () => {
  it('loads vision, project context, and issues', () => {
    mockGetVisionContext.mockReturnValue('# Vision');
    mockGetProjectContext.mockReturnValue('# Context');
    mockPollIssues.mockReturnValue([
      { number: 1, title: 'Issue 1', body: 'body', labels: ['ready'] },
    ]);

    const config = {
      repo: 'owner/repo',
      labelReady: 'ready',
      repoOwner: 'owner',
      milestone: '',
    } as Config;

    const result = buildPlanningContext(config);

    expect(result.visionContext).toBe('# Vision');
    expect(result.projectContext).toBe('# Context');
    expect(result.existingIssues).toHaveLength(1);
    expect(mockPollIssues).toHaveBeenCalledWith('owner/repo', 'ready', 100, {
      repoOwner: 'owner',
      milestone: '',
    });
  });

  it('returns nulls when context files are missing', () => {
    mockGetVisionContext.mockReturnValue(null);
    mockGetProjectContext.mockReturnValue(null);
    mockPollIssues.mockReturnValue([]);

    const config = {
      repo: 'owner/repo',
      labelReady: 'ready',
      repoOwner: 'owner',
      milestone: '',
    } as Config;

    const result = buildPlanningContext(config);

    expect(result.visionContext).toBeNull();
    expect(result.projectContext).toBeNull();
    expect(result.existingIssues).toEqual([]);
  });
});

// ── savePlanDraft ────────────────────────────────────────────────────────────

describe('savePlanDraft', () => {
  it('saves draft to .alpha-loop/plan.json', () => {
    const tmpDir = join(__dirname, '..', '..', '.test-draft-' + Date.now());

    try {
      mkdirSync(tmpDir, { recursive: true });

      const draft: PlanDraft = {
        vision: 'Build something great',
        milestones: [{ title: 'v1', description: 'First', dueOn: '2026-06-01', order: 1 }],
        issues: [],
        projectBoard: null,
      };

      savePlanDraft(draft, tmpDir);

      const saved = JSON.parse(readFileSync(join(tmpDir, '.alpha-loop', 'plan.json'), 'utf-8'));
      expect(saved.vision).toBe('Build something great');
      expect(saved.milestones).toHaveLength(1);
    } finally {
      try {
        const { execSync } = require('node:child_process');
        execSync(`rm -rf "${tmpDir}"`);
      } catch {
        // Best effort cleanup
      }
    }
  });
});

// ── normalizeMilestoneTitles ────────────────────────────────────────────────

describe('normalizeMilestoneTitles', () => {
  it('adds 3-digit prefix based on order', () => {
    const milestones: PlannedMilestone[] = [
      { title: 'Foundation', description: '', dueOn: null, order: 1 },
      { title: 'Features', description: '', dueOn: null, order: 2 },
      { title: 'Polish', description: '', dueOn: null, order: 10 },
    ];

    const result = normalizeMilestoneTitles(milestones);
    expect(result[0].title).toBe('001 - Foundation');
    expect(result[1].title).toBe('002 - Features');
    expect(result[2].title).toBe('010 - Polish');
  });

  it('skips milestones that already have a 3-digit prefix', () => {
    const milestones: PlannedMilestone[] = [
      { title: '001 - Foundation', description: '', dueOn: null, order: 1 },
      { title: 'New Scope', description: '', dueOn: null, order: 2 },
    ];

    const result = normalizeMilestoneTitles(milestones);
    expect(result[0].title).toBe('001 - Foundation');
    expect(result[1].title).toBe('002 - New Scope');
  });
});

// ── normalizePlanMilestones ─────────────────────────────────────────────────

describe('normalizePlanMilestones', () => {
  it('normalizes milestone titles and updates issue references', () => {
    const draft: PlanDraft = {
      vision: null,
      milestones: [
        { title: 'MVP', description: 'Core', dueOn: null, order: 1 },
        { title: 'Polish', description: 'Refinement', dueOn: null, order: 2 },
      ],
      issues: [
        { id: 1, title: 'Login', body: '', labels: [], milestone: 'MVP', priority: 'p1', complexity: 'medium', dependsOn: [], selected: true },
        { id: 2, title: 'Animations', body: '', labels: [], milestone: 'Polish', priority: 'p2', complexity: 'small', dependsOn: [], selected: true },
      ],
      projectBoard: null,
    };

    const result = normalizePlanMilestones(draft);
    expect(result.milestones[0].title).toBe('001 - MVP');
    expect(result.milestones[1].title).toBe('002 - Polish');
    expect(result.issues[0].milestone).toBe('001 - MVP');
    expect(result.issues[1].milestone).toBe('002 - Polish');
  });
});

// ── normalizeRoadmapMilestones ──────────────────────────────────────────────

describe('normalizeRoadmapMilestones', () => {
  it('normalizes milestone titles and updates assignment references', () => {
    const milestones: PlannedMilestone[] = [
      { title: 'Core', description: '', dueOn: null, order: 1 },
    ];
    const assignments = [
      { issueNum: 5, title: 'Issue', milestone: 'Core', currentMilestone: '', selected: true },
    ];

    const result = normalizeRoadmapMilestones(milestones, assignments);
    expect(result.milestones[0].title).toBe('001 - Core');
    expect(result.assignments[0].milestone).toBe('001 - Core');
  });
});
