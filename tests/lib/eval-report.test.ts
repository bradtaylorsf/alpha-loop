import { renderMatrixMarkdown, renderMatrixCsv } from '../../src/lib/eval-report.js';
import type { MatrixResult } from '../../src/lib/eval-matrix.js';

const fixture: MatrixResult = {
  profiles: ['all-frontier', 'hybrid-v1'],
  baseline: 'all-frontier',
  cases: [
    {
      caseId: '001-foo',
      description: 'First case',
      perProfile: {
        'all-frontier': { passed: true, partialCredit: 1, costUsd: 1.50, wallTimeS: 20, toolErrorRate: 0, diffSimilarity: 0.9, errored: false },
        'hybrid-v1': { passed: true, partialCredit: 1, costUsd: 0.40, wallTimeS: 45, toolErrorRate: 0.01, diffSimilarity: 0.7, errored: false },
      },
    },
    {
      caseId: '002-bar',
      description: 'Second case',
      perProfile: {
        'all-frontier': { passed: true, partialCredit: 1, costUsd: 1.60, wallTimeS: 22, toolErrorRate: 0, diffSimilarity: 1.0, errored: false },
        'hybrid-v1': { passed: false, partialCredit: 0.5, costUsd: 0.35, wallTimeS: 52, toolErrorRate: 0.05, diffSimilarity: 0.2, errored: false },
      },
    },
    {
      caseId: '003-baz',
      description: 'Third case',
      perProfile: {
        'all-frontier': { passed: true, partialCredit: 1, costUsd: 1.40, wallTimeS: 18, toolErrorRate: 0, diffSimilarity: null, errored: false },
        'hybrid-v1': { passed: true, partialCredit: 1, costUsd: 0.45, wallTimeS: 40, toolErrorRate: 0, diffSimilarity: null, errored: false },
      },
    },
  ],
  totals: [
    { profile: 'all-frontier', caseCount: 3, passCount: 3, passRate: 1, totalCostUsd: 4.5, meanWallTimeS: 20, meanToolErrorRate: 0 },
    { profile: 'hybrid-v1', caseCount: 3, passCount: 2, passRate: 2 / 3, totalCostUsd: 1.2, meanWallTimeS: 45.66, meanToolErrorRate: 0.02 },
  ],
  deltas: {
    'all-frontier': { pipelineSuccessDelta: 0, costPerIssueDelta: 0 },
    'hybrid-v1': { pipelineSuccessDelta: -1 / 3, costPerIssueDelta: -1.1 },
  },
};

describe('renderMatrixMarkdown', () => {
  it('renders a per-profile summary table', () => {
    const md = renderMatrixMarkdown(fixture, '# Test matrix');
    expect(md).toContain('# Test matrix');
    expect(md).toContain('## Per-profile summary');
    expect(md).toContain('| `all-frontier` | 3/3 | 100.0% |');
    expect(md).toContain('| `hybrid-v1` |');
    expect(md).toContain('66.7%');
  });

  it('renders a per-case grid with one column per profile', () => {
    const md = renderMatrixMarkdown(fixture);
    expect(md).toContain('## Per-case results');
    expect(md).toContain('| Case | all-frontier | hybrid-v1 |');
    expect(md).toContain('| 001-foo |');
    expect(md).toContain('PASS ($1.50)');
    expect(md).toContain('FAIL ($0.35)');
  });

  it('renders deltas vs baseline with correct signs', () => {
    const md = renderMatrixMarkdown(fixture);
    expect(md).toContain('## Deltas vs `all-frontier`');
    expect(md).toContain('-33.3 pp');
    expect(md).toContain('-$1.10');
  });

  it('defaults heading to date when title omitted', () => {
    const md = renderMatrixMarkdown(fixture);
    expect(md).toMatch(/^# Routing regression — \d{4}-\d{2}-\d{2}/);
  });
});

describe('renderMatrixCsv', () => {
  it('emits a header row and one row per (case, profile)', () => {
    const csv = renderMatrixCsv(fixture);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('case_id,profile,passed,partial_credit,cost_usd,wall_time_s,tool_error_rate,diff_similarity,errored');
    // 3 cases × 2 profiles = 6 data rows
    expect(lines).toHaveLength(1 + 6);
    expect(lines).toContain('001-foo,all-frontier,1,1.000,1.5000,20.0,0.000,0.900,0');
    expect(lines).toContain('002-bar,hybrid-v1,0,0.500,0.3500,52.0,0.050,0.200,0');
  });

  it('leaves diff_similarity empty when null', () => {
    const csv = renderMatrixCsv(fixture);
    // Row for case 003 + hybrid-v1 should have empty diff_similarity cell.
    const target = csv.split('\n').find((l) => l.startsWith('003-baz,hybrid-v1'));
    expect(target).toBeDefined();
    const fields = target!.split(',');
    // diff_similarity is index 7 (0-based)
    expect(fields[7]).toBe('');
  });

  it('escapes commas and quotes in case ids', () => {
    const tricky: MatrixResult = {
      ...fixture,
      cases: [
        {
          caseId: 'case,with,commas',
          description: 'Tricky',
          perProfile: fixture.cases[0].perProfile,
        },
      ],
      totals: fixture.totals,
    };
    const csv = renderMatrixCsv(tricky);
    expect(csv).toContain('"case,with,commas"');
  });
});
