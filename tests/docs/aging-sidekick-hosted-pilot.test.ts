import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const README_PATH = join(ROOT, 'README.md');
const BLUEPRINT_PATH = join(ROOT, 'docs', 'aging-sidekick-hosted-pilot.md');

function read(path: string): string {
  return readFileSync(path, 'utf-8');
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

describe('docs/aging-sidekick-hosted-pilot.md', () => {
  const blueprint = read(BLUEPRINT_PATH);
  const readme = read(README_PATH);

  it('is linked from README and the hosted setup guide', () => {
    expect(readme).toContain('[Aging Sidekick Hosted Pilot Blueprint](docs/aging-sidekick-hosted-pilot.md)');
    expect(read(join(ROOT, 'docs', 'hosted-alpha-loop.md'))).toContain('[Aging Sidekick Hosted Pilot Blueprint](aging-sidekick-hosted-pilot.md)');
  });

  it('keeps local markdown references resolvable', () => {
    expectLocalLinksToResolve(blueprint, BLUEPRINT_PATH);
  });

  it('documents the complete request-to-PR-to-feedback workflow', () => {
    for (const requiredText of [
      'Slack or a website form',
      'creates a GitHub issue',
      'triage automation applies labels',
      'checks automation policy',
      'opens a PR',
      'emits a `qa.requested` event',
      'calls `alpha-loop feedback ingest`',
      'alpha-loop resume --issue <N>',
      'pnpm exec alpha-loop run --issue 42',
      'pnpm exec alpha-loop resume --issue 42',
    ]) {
      expect(blueprint).toContain(requiredText);
    }
  });

  it('includes labels, issue template fields, policy, event destinations, and feedback examples', () => {
    for (const requiredText of [
      '`ready`',
      '`needs-human-input`',
      '`do-not-automate`',
      '`blocked`',
      '`content`',
      '`copy`',
      '`SEO`',
      '`visual-polish`',
      '`generated-image`',
      '`minor-astro`',
      '`sanity-content`',
      '`human-gated`',
      'Co-founder website request',
      'Acceptance criteria',
      'Page or route',
      'Assets and copy source',
      'QA notes',
      'Risk Flags',
      'automation_policy:',
      'block_labels: [do-not-automate, needs-human-input, blocked, human-gated]',
      'slack_qa:',
      'website_events:',
      '"type": "qa.requested"',
      '"source": "slack"',
      '"source": "website-form"',
      '## Alpha Loop Feedback Received',
      'feedback_poll_command: ./scripts/poll-aging-sidekick-feedback.sh',
    ]) {
      expect(blueprint).toContain(requiredText);
    }
  });

  it('separates safe automation scope, human-gated scope, and core versus downstream ownership', () => {
    for (const requiredText of [
      'Safe initial automation scope',
      'Copy updates',
      'Generated marketing images',
      'SEO title',
      'Visual fixes',
      'Minor Astro changes',
      'Human-gated scope',
      'Sanity schema changes',
      'Auth, permissions',
      'Analytics, tracking pixels',
      'Dependency upgrades',
      'Secrets, credentials',
      'Production deploys',
      'Major redesigns',
      'Reusable Alpha Loop capabilities',
      'Aging Sidekick downstream setup',
      '`alpha-loop run --issue <N>` targeted execution',
      'Slack shortcut, Slack app, or website form',
    ]) {
      expect(blueprint).toContain(requiredText);
    }
  });
});
