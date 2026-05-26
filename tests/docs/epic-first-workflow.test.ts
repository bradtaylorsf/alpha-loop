import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('epic-first workflow docs and help text', () => {
  const read = (path: string) => readFileSync(join(root, path), 'utf-8');

  it('README documents triage -> roadmap -> run --epic as the recommended flow', () => {
    const readme = read('README.md');

    expect(readme).toContain('### Recommended Epic-First Flow');
    expect(readme).toContain('`alpha-loop triage` reviews open issues, proposes cleanup, and groups related ready issues into parent epics');
    expect(readme).toContain('`alpha-loop roadmap` schedules parent epic issues into milestones');
    expect(readme).toContain('`alpha-loop run --epic <N>` ships the epic\'s child issues in checklist order');
    expect(readme).toContain('Agents working on each child issue receive the parent epic goal, acceptance criteria, and sibling checklist as context');
    expect(readme).toContain('`alpha-loop roadmap --queue` recommends the next ordered epic queue');
    expect(readme).toContain('`alpha-loop run --epics <A,B,C>` runs several parent epics back-to-back');
  });

  it('docs/epics.md explains milestone scheduling and parent context for child agents', () => {
    const epicsDoc = read('docs/epics.md');

    expect(epicsDoc).toContain('## Milestones + Epics');
    expect(epicsDoc).toContain('`alpha-loop triage` groups related open issues into parent epics');
    expect(epicsDoc).toContain('`alpha-loop roadmap` schedules the parent epic issue into a milestone');
    expect(epicsDoc).toContain('does not assign those child issues separately as standalone roadmap items');
    expect(epicsDoc).toContain('prompts include parent epic context');
    expect(epicsDoc).toContain('the parent goal/body summary, parent acceptance criteria, and the full ordered sibling checklist');
  });

  it('documents multi-epic queue behavior and inspection workflow', () => {
    const readme = read('README.md');
    const epicsDoc = read('docs/epics.md');

    expect(readme).toContain('`alpha-loop run --epics <ids>`');
    expect(readme).toContain('`alpha-loop roadmap --queue`');
    expect(readme).toContain('`alpha-loop history queue-<timestamp>`');
    expect(readme).toContain('`.alpha-loop/sessions/queue-<timestamp>/queue.json`');

    expect(epicsDoc).toContain('## Multi-Epic Queues');
    expect(epicsDoc).toContain('Use one epic when the work has one integrated goal');
    expect(epicsDoc).toContain('Use a multi-epic queue when you want a long unattended run');
    expect(epicsDoc).toContain('alpha-loop roadmap --queue');
    expect(epicsDoc).toContain('alpha-loop run --epics 205,166,214');
    expect(epicsDoc).toContain('Queue execution is fail-stop by default');
    expect(epicsDoc).toContain('`stacked`');
    expect(epicsDoc).toContain('`independent`');
    expect(epicsDoc).toContain('rebase the next stacked session branch onto the base branch');
    expect(epicsDoc).toContain('alpha-loop history queue-<timestamp>');
  });

  it('documents excluding alpha-loop worktrees from custom test configs', () => {
    const epicsDoc = read('docs/epics.md');

    expect(epicsDoc).toContain('### Test Discovery');
    expect(epicsDoc).toContain('custom Jest, Vitest, Mocha, or other test-runner config');
    expect(epicsDoc).toContain('exclude `.worktrees/` from test discovery');
  });

  it('CLI descriptions mention epic grouping and epic-aware roadmap scheduling', () => {
    const cli = read('src/cli.ts');

    expect(cli).toContain('Analyze open issues, clean up backlog noise, and propose/apply epic groups');
    expect(cli).toContain('Display cleanup findings and epic proposals without making changes');
    expect(cli).toContain('Schedule parent epics and standalone issues into milestones using AI analysis');
    expect(cli).toContain('Recommend the next ordered epic run queue without making changes');
    expect(cli).toContain('Display proposed epic/standalone milestone assignments without making changes');
    expect(cli).toContain('Process multiple epics in order (comma-separated issue numbers)');
    expect(cli).toContain('Branch mode for --epics: stacked or independent');
    expect(cli).toContain('View session and queue history');
  });
});
