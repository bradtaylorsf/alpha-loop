import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('seeded alpha-loop skills', () => {
  const repoRoot = process.cwd();

  it('includes alpha-loop-runner in distribution and repo-local templates', () => {
    const distSkillPath = join(repoRoot, 'templates', 'skills', 'alpha-loop-runner', 'SKILL.md');
    const projectSkillPath = join(repoRoot, '.alpha-loop', 'templates', 'skills', 'alpha-loop-runner', 'SKILL.md');

    expect(existsSync(distSkillPath)).toBe(true);
    expect(existsSync(projectSkillPath)).toBe(true);

    const distSkill = readFileSync(distSkillPath, 'utf-8');
    const projectSkill = readFileSync(projectSkillPath, 'utf-8');

    expect(projectSkill).toBe(distSkill);
    expect(distSkill).toMatch(/^name: alpha-loop-runner$/m);
    expect(distSkill).toMatch(/^description: .*run the loop.*run alpha-loop/m);
    expect(distSkill).toMatch(/^auto_load: true$/m);
    expect(distSkill).toMatch(/^priority: high$/m);
    expect(distSkill).toContain('## Trigger');
    expect(distSkill).toContain('## Command Resolution');
    expect(distSkill).toContain('## Pre-Flight Checks');
    expect(distSkill).toContain('## Skill Sync Source Of Truth');
    expect(distSkill).toContain('## Running An Epic');
    expect(distSkill).toContain('## Stop Conditions');
    expect(distSkill).toContain('## Learning-File Guarantee');
    expect(distSkill).toContain('## Completion Validation');
    expect(distSkill).toContain('## Repo-Specific Posture');
  });

  it('includes alpha-loop-setup in distribution and repo-local templates', () => {
    const distSkillPath = join(repoRoot, 'templates', 'skills', 'alpha-loop-setup', 'SKILL.md');
    const projectSkillPath = join(repoRoot, '.alpha-loop', 'templates', 'skills', 'alpha-loop-setup', 'SKILL.md');

    expect(existsSync(distSkillPath)).toBe(true);
    expect(existsSync(projectSkillPath)).toBe(true);

    const distSkill = readFileSync(distSkillPath, 'utf-8');
    const projectSkill = readFileSync(projectSkillPath, 'utf-8');

    expect(projectSkill).toBe(distSkill);
    expect(distSkill).toMatch(/^name: alpha-loop-setup$/m);
    expect(distSkill).toMatch(/^description: .*set up alpha-loop.*set up the loop/m);
    expect(distSkill).toMatch(/^auto_load: false$/m);
    expect(distSkill).toMatch(/^priority: medium$/m);
    expect(distSkill).toContain('## Trigger');
    expect(distSkill).toContain('## Detect Existing State');
    expect(distSkill).toContain('## Codebase Inspection');
    expect(distSkill).toContain('## Harness Sync Targets');
    expect(distSkill).toContain('## Skill Recommendations');
    expect(distSkill).toContain('## Vision File');
    expect(distSkill).toContain('## GitHub Authorization');
    expect(distSkill).toContain('## Apply');
    expect(distSkill).toContain('## Verify');
    expect(distSkill).toContain('## Hand-Off');
    expect(distSkill).toContain('which alpha-loop');
    expect(distSkill).toContain('npx @bradtaylorsf/alpha-loop --version');
    expect(distSkill).toContain('for cli in claude codex opencode cursor-agent gemini');
    expect(distSkill).toContain('git config --get remote.origin.url');
    expect(distSkill).toContain('git symbolic-ref --short refs/remotes/origin/HEAD');
    expect(distSkill).toContain('gh project list --owner <owner>');
    expect(distSkill).toContain('gh auth refresh -s project');
    expect(distSkill).toContain('<alpha-loop> run --dry-run --once');
    expect(distSkill).toContain('alpha-loop-runner');
    expect(distSkill).toContain('alpha-loop-issue-author');
    expect(distSkill).toContain('alpha-loop-learning-review');
    expect(distSkill).toContain('playwright-testing');
  });

  it('includes alpha-loop-issue-author in distribution and repo-local templates', () => {
    const distSkillPath = join(repoRoot, 'templates', 'skills', 'alpha-loop-issue-author', 'SKILL.md');
    const projectSkillPath = join(repoRoot, '.alpha-loop', 'templates', 'skills', 'alpha-loop-issue-author', 'SKILL.md');

    expect(existsSync(distSkillPath)).toBe(true);
    expect(existsSync(projectSkillPath)).toBe(true);

    const distSkill = readFileSync(distSkillPath, 'utf-8');
    const projectSkill = readFileSync(projectSkillPath, 'utf-8');

    expect(projectSkill).toBe(distSkill);
    expect(distSkill).toMatch(/^name: alpha-loop-issue-author$/m);
    expect(distSkill).toMatch(/^description: .*add a feature.*add an issue/m);
    expect(distSkill).toMatch(/^auto_load: true$/m);
    expect(distSkill).toMatch(/^priority: high$/m);
    expect(distSkill).toContain('## Trigger');
    expect(distSkill).toContain('## Search Before Creating');
    expect(distSkill).toContain('gh issue list --state open --search "<keywords>"');
    expect(distSkill).toContain('gh issue list --state open --label epic');
    expect(distSkill).toContain('gh issue list --state closed --search "<keywords>"');
    expect(distSkill).toContain('Do not create an issue unless the user has seen the search results');
    expect(distSkill).toContain('## Categorize');
    expect(distSkill).toContain('**Comment on existing issue**');
    expect(distSkill).toContain('**New standalone issue**');
    expect(distSkill).toContain('**New child of an existing epic**');
    expect(distSkill).toContain('**New epic**');
    expect(distSkill).toContain('## Issue Body Format');
    expect(distSkill).toContain('## Summary');
    expect(distSkill).toContain('## Problem');
    expect(distSkill).toContain('## Root cause');
    expect(distSkill).toContain('## Repro');
    expect(distSkill).toContain('## Acceptance criteria');
    expect(distSkill).toContain('## Out of scope');
    expect(distSkill).toContain('## Related');
    expect(distSkill).toContain('## Goal');
    expect(distSkill).toContain('## Non-Technical Summary');
    expect(distSkill).toContain('## Architecture Observations');
    expect(distSkill).toContain('## Ordered Sub-Issues');
    expect(distSkill).toContain('## Dependencies and Sequencing');
    expect(distSkill).toContain('## Verification Expectations');
    expect(distSkill).toContain('## Labels');
    expect(distSkill).toContain('## Dependencies & Batching');
    expect(distSkill).toContain('## Config Implications');
    expect(distSkill).toContain('## Epic Membership & Backlinks');
    expect(distSkill).toContain('Part of #<epic>');
    expect(distSkill).toContain('## Handoff');
  });

  it('includes alpha-loop-learning-review in distribution and repo-local templates', () => {
    const distSkillPath = join(repoRoot, 'templates', 'skills', 'alpha-loop-learning-review', 'SKILL.md');
    const projectSkillPath = join(repoRoot, '.alpha-loop', 'templates', 'skills', 'alpha-loop-learning-review', 'SKILL.md');

    expect(existsSync(distSkillPath)).toBe(true);
    expect(existsSync(projectSkillPath)).toBe(true);

    const distSkill = readFileSync(distSkillPath, 'utf-8');
    const projectSkill = readFileSync(projectSkillPath, 'utf-8');

    expect(projectSkill).toBe(distSkill);
    expect(distSkill).toMatch(/^name: alpha-loop-learning-review$/m);
    expect(distSkill).toMatch(/^description: Review accumulated alpha-loop learnings and propose skill\/agent improvements with independent harness research\./m);
    expect(distSkill).toMatch(/^auto_load: true$/m);
    expect(distSkill).toMatch(/^priority: high$/m);
    expect(distSkill).toContain('## Trigger');
    expect(distSkill).toContain('"review learnings"');
    expect(distSkill).toContain('"improve the loop"');
    expect(distSkill).toContain('"propose skill updates"');
    expect(distSkill).toContain('"evolve skills"');
    expect(distSkill).toContain('"run review"');
    expect(distSkill).toContain('"audit recent runs"');
    expect(distSkill).toContain('## Phase 1 - Run Alpha Loop Review Dry-Run');
    expect(distSkill).toContain('<alpha-loop> review --dry-run');
    expect(distSkill).toContain('.alpha-loop/learnings/proposed-updates/*-proposals.md');
    expect(distSkill).toContain('success-rate, failure-rate, retry, or trend metrics');
    expect(distSkill).toContain('The count of proposed changes');
    expect(distSkill).toContain('## Phase 2 - Independent Harness Research');
    expect(distSkill).toContain('Read at least the 10 most recent learning files');
    expect(distSkill).toContain('read at least `N + 5` recent learning files');
    expect(distSkill).toContain('gh pr view <N>');
    expect(distSkill).toContain('git log -- <file>');
    expect(distSkill).toContain('Counter-check for hallucinated, exaggerated, or truncated citations');
    expect(distSkill).toContain('The reasoning generalizes beyond a single issue');
    expect(distSkill).toContain('## Phase 3 - Walk The User Through Changes');
    expect(distSkill).toContain('**What**: <file path> - <section or behavior touched>');
    expect(distSkill).toContain('**Why (proposal)**: <verbatim rationale from the alpha-loop review proposal, or "N/A - harness-only">');
    expect(distSkill).toContain('**Why (harness)**: <your independent rationale, evidence checked, and any disagreement with the proposal>');
    expect(distSkill).toContain('**Risk**: <what could go wrong, what could be over-fit, and what to watch after applying>');
    expect(distSkill).toContain('**Recommendation**: <apply | apply-with-edits | defer | reject> - <reasoning>');
    expect(distSkill).toContain('harness-only');
    expect(distSkill).toContain('## Phase 4 - Apply Selectively');
    expect(distSkill).toContain('<alpha-loop> review --apply');
    expect(distSkill).toContain('<alpha-loop> sync');
    expect(distSkill).toContain('open a draft PR');
    expect(distSkill).toContain('## Phase 5 - Meta-Learning');
    expect(distSkill).toContain('.alpha-loop/learnings/review-cycles/<timestamp>.md');
    expect(distSkill).toContain('Proposal items applied');
    expect(distSkill).toContain('Harness-only additions applied');
    expect(distSkill).toContain('proposal hallucinated citations');
  });
});
