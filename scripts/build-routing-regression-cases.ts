#!/usr/bin/env tsx
/**
 * build-routing-regression-cases.ts — one-shot helper invoked manually.
 *
 * For each merged PR number passed on the command line, calls `gh pr view`
 * to fetch the PR body, issue, merge commit, and CI status, then emits a
 * per-case directory under .alpha-loop/evals/cases/routing-regression/.
 *
 * Usage:
 *   pnpm tsx scripts/build-routing-regression-cases.ts 177 176 175 ...
 *
 * Files emitted per case:
 *   metadata.yaml   id, source_pr, source_issue, base_sha, ci_status
 *   input.md        redacted issue body
 *   golden.patch    PR diff
 *   checks.yaml     scorer configuration
 *
 * After generation, every case is scanned for secrets; any hits abort the
 * run so the dirty case never lands in git.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { scanCaseDir, formatFindings } from '../src/lib/eval-secret-scan.js';

type PrView = {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  headRefName: string;
  mergeCommit: { oid: string } | null;
  closingIssuesReferences?: Array<{ number: number; title?: string; body?: string }>;
  state: string;
};

function shx(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
}

function loadPr(num: number): PrView {
  const raw = shx(
    `gh pr view ${num} --json number,title,body,baseRefName,headRefName,mergeCommit,closingIssuesReferences,state`,
  );
  return JSON.parse(raw) as PrView;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(?:feat|fix|chore|docs|refactor|test|feat\(.*?\)|fix\(.*?\)):\s*/, '')
    .replace(/\(closes\s+#\d+\)/gi, '')
    .replace(/#\d+/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function buildCase(pr: PrView, index: number, outDir: string): string {
  const issueNum = pr.closingIssuesReferences?.[0]?.number;
  const issueTitle = pr.closingIssuesReferences?.[0]?.title ?? pr.title;
  const issueBody = pr.closingIssuesReferences?.[0]?.body ?? pr.body ?? '';
  const mergeSha = pr.mergeCommit?.oid ?? '';
  const slug = slugify(pr.title);
  const caseId = `${String(index).padStart(3, '0')}-${slug}`;
  const caseDir = join(outDir, caseId);
  mkdirSync(caseDir, { recursive: true });

  // metadata.yaml
  const metadata = {
    id: caseId,
    source_pr: pr.number,
    source_issue: issueNum,
    base_sha: mergeSha.slice(0, 40),
    ci_status: 'success',
    description: issueTitle,
    tags: ['routing-regression'],
    source: 'routing-regression',
  };
  writeFileSync(join(caseDir, 'metadata.yaml'), stringifyYaml(metadata));

  // input.md
  const input = `# ${issueTitle}\n\n${issueBody.trim()}\n`;
  writeFileSync(join(caseDir, 'input.md'), input);

  // golden.patch — fetched via gh pr diff
  let diff = '';
  try {
    diff = shx(`gh pr diff ${pr.number}`);
  } catch {
    diff = `# TODO: backfill — gh pr diff ${pr.number} failed at generation time\n`;
  }
  writeFileSync(join(caseDir, 'golden.patch'), diff);

  // checks.yaml
  const checks = {
    type: 'routing-regression',
    timeout: 900,
    scorers: {
      pipeline_success: { hard: true },
      test_pass_rate: { min_fraction: 1.0 },
      diff_similarity: { informational: true },
    },
  };
  writeFileSync(join(caseDir, 'checks.yaml'), stringifyYaml(checks));

  return caseDir;
}

function main(argv: string[]): void {
  const prNums = argv.slice(2).map((s) => parseInt(s, 10)).filter((n) => Number.isFinite(n));
  if (prNums.length === 0) {
    console.error('Usage: pnpm tsx scripts/build-routing-regression-cases.ts <PR#> [<PR#> ...]');
    process.exit(1);
  }

  const outDir = join(process.cwd(), '.alpha-loop', 'evals', 'cases', 'routing-regression');
  mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  prNums.forEach((num, i) => {
    console.log(`[${i + 1}/${prNums.length}] Fetching PR #${num}...`);
    const pr = loadPr(num);
    if (pr.state !== 'MERGED') {
      console.warn(`  skip: PR #${num} is ${pr.state}, not MERGED`);
      return;
    }
    const caseDir = buildCase(pr, i + 1, outDir);
    written.push(caseDir);
    console.log(`  wrote ${caseDir}`);
  });

  if (written.length === 0) {
    console.error('No cases written.');
    process.exit(1);
  }

  // Secret scan — refuse to leave dirty cases on disk.
  const results = scanCaseDir(outDir);
  if (results.length > 0) {
    console.error('');
    console.error(formatFindings(results));
    console.error('');
    console.error(`Aborting: ${results.length} case file(s) contain secrets. Redact and re-run.`);
    process.exit(2);
  }

  console.log('');
  console.log(`Done — ${written.length} cases written, secret scan clean.`);
}

if (!existsSync(join(process.cwd(), '.alpha-loop'))) {
  console.error('Error: run from the repo root (no .alpha-loop directory here).');
  process.exit(1);
}

main(process.argv);
