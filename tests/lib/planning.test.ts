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
  parseTriageAnalysisResponse,
  normalizeTriageAnalysis,
  formatIssueTable,
  formatTriageFindings,
  formatEpicGroupProposals,
  formatEpicQueuePlan,
  formatRoadmapTable,
  normalizeMilestoneTitles,
  normalizePlanMilestones,
  normalizeRoadmapMilestones,
  normalizeRoadmapPlan,
  planEpicQueue,
  readSeedFiles,
  buildPlanningContext,
  savePlanDraft,
  type PlannedIssue,
  type PlannedMilestone,
  type TriageFinding,
  type ProposedEpicGroup,
  type PlanDraft,
} from '../../src/lib/planning';
import type { Issue, Milestone, RoadmapEpicContext } from '../../src/lib/github';
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

// ── triage analysis parsing ─────────────────────────────────────────────────

describe('parseTriageAnalysisResponse', () => {
  const finding: TriageFinding = {
    issueNum: 10,
    title: 'Old bug',
    category: 'stale',
    reason: 'Already implemented',
    action: 'close',
    selected: true,
  };

  const epicGroup: ProposedEpicGroup = {
    title: 'Epic: Settings reliability',
    goal: 'Make settings saves reliable.',
    rationale: 'The child issues all complete the same settings-save workflow.',
    orderedChildIssueNumbers: [12, 13, 14],
    acceptanceCriteria: [
      '- [ ] Settings save successfully',
      '- [ ] Users see error states',
    ],
    selected: true,
  };

  it('parses findings plus proposed epic groups from the new object shape', () => {
    const response = JSON.stringify({
      findings: [finding],
      epicGroups: [epicGroup],
    });

    const result = parseTriageAnalysisResponse(response);

    expect(result.findings).toEqual([finding]);
    expect(result.epicGroups).toEqual([epicGroup]);
  });

  it('accepts legacy finding arrays without epic groups', () => {
    const result = normalizeTriageAnalysis([finding]);

    expect(result).toEqual({
      findings: [finding],
      epicGroups: [],
    });
  });

  it('rejects malformed epic group fields', () => {
    expect(() => normalizeTriageAnalysis({
      findings: [],
      epicGroups: [{
        title: '',
        goal: 'Goal',
        rationale: 'Rationale',
        orderedChildIssueNumbers: [1, 2],
        acceptanceCriteria: ['- [ ] Done'],
        selected: true,
      }],
    })).toThrow('epicGroups[0].title');
  });

  it('rejects epic groups with fewer than two ordered children', () => {
    expect(() => normalizeTriageAnalysis({
      findings: [],
      epicGroups: [{
        title: 'Epic title',
        goal: 'Goal',
        rationale: 'Rationale',
        orderedChildIssueNumbers: [1],
        acceptanceCriteria: ['- [ ] Done'],
        selected: true,
      }],
    })).toThrow('at least two issue numbers');
  });

  it('normalizes missing epic group selected to false and null existing epic to undefined', () => {
    const result = normalizeTriageAnalysis({
      findings: [],
      epicGroups: [{
        title: 'Epic title',
        goal: 'Goal',
        rationale: 'Rationale',
        orderedChildIssueNumbers: [1, 2],
        acceptanceCriteria: ['- [ ] Done'],
        existingEpicIssueNum: null,
      }],
    });

    expect(result.epicGroups[0].selected).toBe(false);
    expect(result.epicGroups[0].existingEpicIssueNum).toBeUndefined();
  });

  it('rejects malformed epic group selected and existing epic issue number fields', () => {
    expect(() => normalizeTriageAnalysis({
      findings: [],
      epicGroups: [{
        title: 'Epic title',
        goal: 'Goal',
        rationale: 'Rationale',
        orderedChildIssueNumbers: [1, 2],
        acceptanceCriteria: ['- [ ] Done'],
        selected: 'yes',
      }],
    })).toThrow('epicGroups[0].selected');

    expect(() => normalizeTriageAnalysis({
      findings: [],
      epicGroups: [{
        title: 'Epic title',
        goal: 'Goal',
        rationale: 'Rationale',
        orderedChildIssueNumbers: [1, 2],
        acceptanceCriteria: ['- [ ] Done'],
        selected: true,
        existingEpicIssueNum: 0,
      }],
    })).toThrow('epicGroups[0].existingEpicIssueNum');
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

// ── formatEpicGroupProposals ────────────────────────────────────────────────

describe('formatEpicGroupProposals', () => {
  it('renders proposed epic groups with ordered children and acceptance criteria', () => {
    const groups: ProposedEpicGroup[] = [
      {
        title: 'Epic: Settings reliability',
        goal: 'Make settings saves reliable.',
        rationale: 'These issues form one settings-save deliverable.',
        orderedChildIssueNumbers: [12, 13, 14],
        acceptanceCriteria: [
          '- [ ] Settings save successfully',
          '- [ ] Regression coverage exists',
        ],
        selected: true,
      },
    ];

    const output = formatEpicGroupProposals(groups);

    expect(output).toContain('Proposed Epic Groups');
    expect(output).toContain('[✓] 1. Epic: Settings reliability (creates new epic)');
    expect(output).toContain('Epic: Settings reliability');
    expect(output).toContain('Goal: Make settings saves reliable.');
    expect(output).toContain('Rationale: These issues form one settings-save deliverable.');
    expect(output).toContain('Children: #12 -> #13 -> #14');
    expect(output).toContain('- [ ] Settings save successfully');
  });

  it('renders existing epic update targets', () => {
    const groups: ProposedEpicGroup[] = [
      {
        title: 'Epic: Settings reliability',
        goal: 'Make settings saves reliable.',
        rationale: 'These issues form one settings-save deliverable.',
        orderedChildIssueNumbers: [12, 13],
        acceptanceCriteria: ['- [ ] Settings save successfully'],
        selected: false,
        existingEpicIssueNum: 99,
      },
    ];

    const output = formatEpicGroupProposals(groups);

    expect(output).toContain('[ ] 1. Epic: Settings reliability (updates epic #99)');
  });

  it('handles empty proposal lists', () => {
    const output = formatEpicGroupProposals([]);
    expect(output).toContain('No proposed epic groups');
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

  it('normalizes milestone titles across epic and standalone assignments', () => {
    const milestones: PlannedMilestone[] = [
      { title: 'Core', description: '', dueOn: null, order: 1 },
      { title: 'Follow-up', description: '', dueOn: null, order: 2 },
    ];

    const result = normalizeRoadmapMilestones(milestones, {
      epicAssignments: [
        { issueNum: 195, title: 'Epic', milestone: 'Core', currentMilestone: '', selected: true },
      ],
      standaloneAssignments: [
        { issueNum: 15, title: 'Issue', milestone: 'Follow-up', currentMilestone: '', selected: true },
      ],
    });

    expect(result.epicAssignments[0].milestone).toBe('001 - Core');
    expect(result.standaloneAssignments[0].milestone).toBe('002 - Follow-up');
  });
});

// ── normalizeRoadmapPlan ────────────────────────────────────────────────────

describe('normalizeRoadmapPlan', () => {
  it('keeps legacy flat assignments as standalone assignments', () => {
    const result = normalizeRoadmapPlan({
      milestones: [{ title: 'Core', description: '', dueOn: null, order: 1 }],
      assignments: [
        { issueNum: 5, title: 'Issue', milestone: 'Core', currentMilestone: '', selected: true },
      ],
    });

    expect(result.epicAssignments).toEqual([]);
    expect(result.standaloneAssignments[0]).toEqual(expect.objectContaining({
      issueNum: 5,
      milestone: '001 - Core',
    }));
  });
});

// ── formatRoadmapTable ──────────────────────────────────────────────────────

describe('formatRoadmapTable', () => {
  it('renders epic assignments separately from standalone issue assignments', () => {
    const milestones: PlannedMilestone[] = [
      { title: '001 - Core', description: '', dueOn: null, order: 1 },
      { title: '002 - Follow-up', description: '', dueOn: null, order: 2 },
    ];

    const output = formatRoadmapTable(milestones, {
      epicAssignments: [
        { issueNum: 195, title: 'Epic: Scheduling', milestone: '001 - Core', currentMilestone: '', selected: true },
      ],
      standaloneAssignments: [
        { issueNum: 15, title: 'User dashboard', milestone: '002 - Follow-up', currentMilestone: '', selected: true },
      ],
    }, ['001 - Core']);

    expect(output).toContain('Epic Milestone Assignments (1)');
    expect(output).toContain('Standalone Issue Milestone Assignments (1)');
    expect(output.indexOf('#195  Epic: Scheduling')).toBeLessThan(output.indexOf('#15  User dashboard'));
    expect(output).toContain('[EXISTS]');
    expect(output).toContain('[NEW]');
  });
});

// ── epic queue planning ─────────────────────────────────────────────────────

const milestone = (title: string, number: number): Milestone => ({
  number,
  title,
  description: '',
  openIssues: 0,
  closedIssues: 0,
  dueOn: null,
  state: 'open',
});

const openIssue = (number: number, labels: string[] = ['ready']): Issue => ({
  number,
  title: `Issue ${number}`,
  body: '',
  labels,
  state: 'OPEN',
});

const epicContext = (overrides: Partial<RoadmapEpicContext> = {}): RoadmapEpicContext => ({
  issueNum: 100,
  title: 'Epic: Queue item',
  bodySummary: 'Ship queue work.',
  currentMilestone: '001 - Core',
  completedChildCount: 0,
  totalChildCount: 1,
  openChildCount: 1,
  children: [
    {
      issueNum: 10,
      title: 'Ready child',
      bodySummary: 'Implement `src/lib/queue.ts`.',
      checked: false,
      labels: ['ready'],
      state: 'OPEN',
      milestone: '001 - Core',
    },
  ],
  ...overrides,
});

describe('planEpicQueue', () => {
  it('handles no open epics', () => {
    const plan = planEpicQueue([], { labelReady: 'ready', openIssues: [] });

    expect(plan.orderedEpics).toEqual([]);
    expect(plan.blockedEpics).toEqual([]);
    expect(plan.command).toBeNull();
    expect(formatEpicQueuePlan(plan)).toContain('No open epics found');
  });

  it('recommends a single ready epic and emits the run command', () => {
    const plan = planEpicQueue([epicContext({ issueNum: 101 })], {
      labelReady: 'ready',
      openIssues: [openIssue(101, ['epic']), openIssue(10)],
    });

    expect(plan.orderedEpics.map((epic) => epic.issueNum)).toEqual([101]);
    expect(plan.blockedEpics).toEqual([]);
    expect(plan.command).toBe('alpha-loop run --epics 101');
    expect(plan.orderedEpics[0].rationale.join('\n')).toContain('Child readiness: 1 ready');
  });

  it('orders multiple independent epics by milestone order and reports file overlap risk', () => {
    const epics = [
      epicContext({
        issueNum: 205,
        title: 'Epic: Later',
        currentMilestone: '002 - UI',
        children: [{
          issueNum: 20,
          title: 'Later child',
          bodySummary: 'Update `src/lib/shared.ts`.',
          checked: false,
          labels: ['ready'],
          state: 'OPEN',
          milestone: '002 - UI',
        }],
      }),
      epicContext({
        issueNum: 166,
        title: 'Epic: Earlier',
        currentMilestone: '001 - Core',
        children: [{
          issueNum: 16,
          title: 'Earlier child',
          bodySummary: 'Update `src/lib/shared.ts`.',
          checked: false,
          labels: ['ready'],
          state: 'OPEN',
          milestone: '001 - Core',
        }],
      }),
    ];

    const plan = planEpicQueue(epics, {
      labelReady: 'ready',
      milestones: [milestone('001 - Core', 1), milestone('002 - UI', 2)],
      openIssues: [openIssue(205, ['epic']), openIssue(166, ['epic']), openIssue(20), openIssue(16)],
    });

    expect(plan.orderedEpics.map((epic) => epic.issueNum)).toEqual([166, 205]);
    expect(plan.command).toBe('alpha-loop run --epics 166,205');
    expect(plan.orderedEpics[0].risks.join('\n')).toContain('Likely file overlap with #205');
    expect(plan.orderedEpics[1].risks.join('\n')).toContain('Likely file overlap with #166');
  });

  it('orders explicit dependencies before dependents', () => {
    const plan = planEpicQueue([
      epicContext({ issueNum: 214, title: 'Epic: Dependent', bodySummary: 'Requires #205 first.' }),
      epicContext({ issueNum: 205, title: 'Epic: Foundation', bodySummary: 'Foundation work.' }),
    ], {
      labelReady: 'ready',
      openIssues: [openIssue(214, ['epic']), openIssue(205, ['epic']), openIssue(10)],
    });

    expect(plan.orderedEpics.map((epic) => epic.issueNum)).toEqual([205, 214]);
    expect(plan.orderedEpics.find((epic) => epic.issueNum === 214)?.queueDependencies).toEqual([205]);
    expect(plan.command).toBe('alpha-loop run --epics 205,214');
  });

  it('blocks epics with not-ready children or open dependencies outside the queue', () => {
    const notReady = epicContext({
      issueNum: 300,
      title: 'Epic: Needs child readiness',
      children: [{
        issueNum: 30,
        title: 'Missing ready label',
        bodySummary: 'Needs grooming.',
        checked: false,
        labels: ['triage'],
        state: 'OPEN',
        milestone: '001 - Core',
      }],
    });
    const externalDependency = epicContext({
      issueNum: 301,
      title: 'Epic: Needs outside dependency',
      bodySummary: 'Depends on #999 before this can run.',
    });

    const plan = planEpicQueue([notReady, externalDependency], {
      labelReady: 'ready',
      openIssues: [openIssue(300, ['epic']), openIssue(301, ['epic']), openIssue(30, ['triage']), openIssue(999)],
    });

    expect(plan.orderedEpics).toEqual([]);
    expect(plan.command).toBeNull();
    expect(plan.blockedEpics.map((epic) => epic.issueNum).sort()).toEqual([300, 301]);
    expect(plan.blockedEpics.find((epic) => epic.issueNum === 300)?.blockers.join('\n')).toContain("Missing 'ready' label");
    expect(plan.blockedEpics.find((epic) => epic.issueNum === 301)?.blockers.join('\n')).toContain('Open dependency #999 is outside');
  });

  it('filters queue planning to a requested milestone', () => {
    const plan = planEpicQueue([
      epicContext({ issueNum: 400, currentMilestone: '001 - Core' }),
      epicContext({ issueNum: 401, currentMilestone: '002 - Later' }),
    ], {
      labelReady: 'ready',
      milestone: '002 - Later',
      openIssues: [openIssue(400, ['epic']), openIssue(401, ['epic']), openIssue(10)],
    });

    expect(plan.milestoneFilter).toBe('002 - Later');
    expect(plan.consideredEpicCount).toBe(1);
    expect(plan.orderedEpics.map((epic) => epic.issueNum)).toEqual([401]);
    expect(formatEpicQueuePlan(plan)).toContain('Scope: milestone "002 - Later"');
  });
});
