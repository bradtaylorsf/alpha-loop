/**
 * Epic verification pass — runs after all sub-issues of an epic have shipped.
 *
 * The agent is given the epic body (with its acceptance criteria), each
 * sub-issue body (with its own AC checklist), and the merged PR diffs.
 * It emits a structured {@link EpicVerdict} JSON block rating each
 * sub-issue's AC against what actually landed.
 *
 * Permissive `--verify-only` mode: sub-issues without a merged PR are reported
 * as `skipped` in the comment; the overall verdict caps at `partial` in that
 * case (we can't declare `pass` without full coverage).
 */
import { spawnAgent } from './agent.js';
import { log } from './logger.js';
import { ghExec } from './rate-limit.js';
import type { Config } from './config.js';
import type { Issue } from './github.js';

/** Max chars of a single PR diff to include in the prompt. Mirrors pipeline.ts. */
const MAX_DIFF_CHARS = 10_000;

export type EpicFindingVerdict = 'met' | 'partial' | 'missing' | 'unclear';
export type EpicOverallVerdict = 'pass' | 'partial' | 'fail';

export type EpicFinding = {
  issueNum: number;
  criterion: string;
  verdict: EpicFindingVerdict;
  notes?: string;
};

export type EpicVerdict = {
  verdict: EpicOverallVerdict;
  summary: string;
  findings: EpicFinding[];
};

export type VerifyEpicInput = {
  epic: Issue;
  subIssues: Issue[];
  /** Parallel to subIssues — null entries indicate sub-issues without a merged PR. */
  mergedPRUrls: Array<string | null>;
};

export type VerifyEpicResult = {
  verdict: EpicOverallVerdict;
  comment: string;
  parsed: EpicVerdict;
};

const DEFAULT_VERDICT: EpicVerdict = {
  verdict: 'partial',
  summary: 'Verification output could not be parsed; defaulting to partial.',
  findings: [],
};

/**
 * Extract a pr number from a github PR URL like
 * `https://github.com/owner/repo/pull/42`.
 */
function prNumberFromUrl(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)(?:\D|$)/);
  return m ? parseInt(m[1], 10) : null;
}

function fetchPRDiff(repo: string, prUrl: string): string {
  const prNum = prNumberFromUrl(prUrl);
  if (prNum === null) return '';
  const result = ghExec(`gh pr diff ${prNum} --repo "${repo}"`);
  if (result.exitCode !== 0) return '';
  const diff = result.stdout;
  return diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + '\n\n... (diff truncated)'
    : diff;
}

/** Extract the last fenced ```json block from agent output, or a trailing JSON object. */
function extractJsonBlock(output: string): string | null {
  const fence = /```json\s*([\s\S]*?)\s*```/gi;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(output)) !== null) lastMatch = m;
  if (lastMatch) return lastMatch[1];

  const trailing = output.match(/\{[\s\S]*\}\s*$/);
  return trailing ? trailing[0] : null;
}

function parseVerdict(output: string): EpicVerdict {
  const block = extractJsonBlock(output);
  if (!block) return DEFAULT_VERDICT;
  try {
    const parsed = JSON.parse(block) as Record<string, unknown>;
    const rawVerdict = String(parsed.verdict ?? '').toLowerCase();
    const verdict: EpicOverallVerdict = (['pass', 'partial', 'fail'] as const).includes(
      rawVerdict as EpicOverallVerdict,
    )
      ? (rawVerdict as EpicOverallVerdict)
      : 'partial';
    const findings = Array.isArray(parsed.findings)
      ? (parsed.findings as Array<Record<string, unknown>>).flatMap((f): EpicFinding[] => {
          const issueNum = Number(f.issueNum ?? f.issue ?? 0);
          if (!Number.isFinite(issueNum) || issueNum <= 0) return [];
          const rawFindingVerdict = String(f.verdict ?? '').toLowerCase();
          const findingVerdict: EpicFindingVerdict = (
            ['met', 'partial', 'missing', 'unclear'] as const
          ).includes(rawFindingVerdict as EpicFindingVerdict)
            ? (rawFindingVerdict as EpicFindingVerdict)
            : 'unclear';
          return [
            {
              issueNum,
              criterion: String(f.criterion ?? ''),
              verdict: findingVerdict,
              notes: f.notes ? String(f.notes) : undefined,
            },
          ];
        })
      : [];
    return {
      verdict,
      summary: String(parsed.summary ?? ''),
      findings,
    };
  } catch {
    return DEFAULT_VERDICT;
  }
}

function buildPrompt(input: VerifyEpicInput, diffs: Map<number, string>): string {
  const lines: string[] = [
    `You are verifying that epic #${input.epic.number} ("${input.epic.title}") has been met by its merged sub-issue PRs.`,
    '',
    `For each sub-issue, evaluate each acceptance-criterion checklist item against the merged PR diff.`,
    `Return ONLY a JSON object (wrapped in a \`\`\`json code fence) matching this shape:`,
    '',
    '```json',
    '{',
    '  "verdict": "pass" | "partial" | "fail",',
    '  "summary": "one-paragraph overall assessment",',
    '  "findings": [',
    '    { "issueNum": 123, "criterion": "quoted AC text", "verdict": "met" | "partial" | "missing" | "unclear", "notes": "why" }',
    '  ]',
    '}',
    '```',
    '',
    'Rules:',
    '- `pass` only if every criterion on every evaluated sub-issue is `met`.',
    '- `partial` if some are met and some are `partial`/`missing`/`unclear`.',
    '- `fail` if a majority are `missing` or `unclear`.',
    '- Sub-issues marked as "not yet merged" in the input are out of scope — do not include findings for them.',
    '',
    '---',
    '',
    `## Epic #${input.epic.number}: ${input.epic.title}`,
    '',
    input.epic.body.slice(0, 4000),
    '',
    '## Sub-issues',
    '',
  ];

  for (let i = 0; i < input.subIssues.length; i++) {
    const sub = input.subIssues[i];
    const prUrl = input.mergedPRUrls[i];
    lines.push(`### #${sub.number}: ${sub.title}`);
    if (!prUrl) {
      lines.push('*Not yet merged — skipped in this pass.*', '');
      continue;
    }
    lines.push(`Merged PR: ${prUrl}`, '');
    lines.push('#### Issue body');
    lines.push(sub.body.slice(0, 3000), '');
    const diff = diffs.get(sub.number) ?? '';
    if (diff) {
      lines.push('#### Merged diff');
      lines.push('```diff');
      lines.push(diff);
      lines.push('```', '');
    } else {
      lines.push('*(diff unavailable)*', '');
    }
  }

  return lines.join('\n');
}

function formatComment(input: VerifyEpicInput, parsed: EpicVerdict, capped: boolean): string {
  const lines: string[] = [
    '## Epic Verification',
    '',
    `**Overall:** ${parsed.verdict.toUpperCase()}${capped ? ' (capped — some sub-issues not yet merged)' : ''}`,
    '',
  ];
  if (parsed.summary) {
    lines.push(parsed.summary, '');
  }

  lines.push('| Sub-issue | PR | Status |', '|---|---|---|');
  for (let i = 0; i < input.subIssues.length; i++) {
    const sub = input.subIssues[i];
    const prUrl = input.mergedPRUrls[i];
    if (!prUrl) {
      lines.push(`| #${sub.number} ${sub.title} | — | not yet merged |`);
      continue;
    }
    const subFindings = parsed.findings.filter((f) => f.issueNum === sub.number);
    const met = subFindings.filter((f) => f.verdict === 'met').length;
    const total = subFindings.length;
    const status = total === 0
      ? 'evaluated'
      : met === total
        ? `pass (${met}/${total})`
        : `partial (${met}/${total})`;
    lines.push(`| #${sub.number} ${sub.title} | [PR](${prUrl}) | ${status} |`);
  }
  lines.push('');

  if (parsed.findings.length > 0) {
    lines.push('<details>', `<summary>Per-criterion findings (${parsed.findings.length})</summary>`, '');
    for (const f of parsed.findings) {
      const notes = f.notes ? ` — ${f.notes}` : '';
      lines.push(`- #${f.issueNum} • **${f.verdict}** — ${f.criterion}${notes}`);
    }
    lines.push('', '</details>', '');
  }

  lines.push('---', '*Verified by alpha-loop*');
  return lines.join('\n');
}

/**
 * Run the verification pass. If any sub-issue has no merged PR, the overall
 * verdict is capped at `partial`.
 */
export async function verifyEpic(
  input: VerifyEpicInput,
  config: Config,
  logsDir: string,
): Promise<VerifyEpicResult> {
  // Fetch diffs for every sub-issue that has a merged PR.
  const diffs = new Map<number, string>();
  for (let i = 0; i < input.subIssues.length; i++) {
    const sub = input.subIssues[i];
    const url = input.mergedPRUrls[i];
    if (!url) continue;
    try {
      diffs.set(sub.number, fetchPRDiff(config.repo, url));
    } catch (err) {
      log.warn(`Could not fetch diff for sub-issue #${sub.number}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const prompt = buildPrompt(input, diffs);
  const model = config.reviewModel || config.model;

  log.step(`Verifying epic #${input.epic.number} (${input.subIssues.filter((_, i) => input.mergedPRUrls[i]).length}/${input.subIssues.length} sub-issues merged)`);

  let parsed: EpicVerdict;
  try {
    const result = await spawnAgent({
      agent: config.agent,
      model,
      prompt,
      cwd: process.cwd(),
      logFile: `${logsDir}/epic-${input.epic.number}-verify.log`,
      verbose: config.verbose,
      timeout: config.agentTimeout * 1000,
    });
    parsed = parseVerdict(result.output);
  } catch (err) {
    log.warn(`Epic verification agent call failed: ${err instanceof Error ? err.message : err}`);
    parsed = DEFAULT_VERDICT;
  }

  const hasUnmerged = input.mergedPRUrls.some((u) => !u);
  let verdict = parsed.verdict;
  if (hasUnmerged && verdict === 'pass') {
    verdict = 'partial';
  }

  const comment = formatComment(input, { ...parsed, verdict }, hasUnmerged && parsed.verdict === 'pass');
  return { verdict, comment, parsed: { ...parsed, verdict } };
}
