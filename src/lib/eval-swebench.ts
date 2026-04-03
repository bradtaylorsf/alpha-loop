/**
 * SWE-bench Importer — download and convert SWE-bench entries to eval cases.
 *
 * SWE-bench provides real GitHub issues from real Python repos, frozen at the
 * exact commit where the bug existed. Each entry includes a validated fix (patch)
 * and tests that verify the fix (FAIL_TO_PASS).
 *
 * Supported datasets:
 *   - princeton-nlp/SWE-bench_Lite (300 curated issues)
 *   - princeton-nlp/SWE-bench_Verified (500 human-verified issues)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { exec } from './shell.js';
import { log } from './logger.js';
import { evalsDir } from './eval.js';
import { loadEvalConfig } from './eval-fixtures.js';
import type { EvalConfig, SwebenchRepoConfig } from './eval-fixtures.js';

/** Raw SWE-bench entry as provided by HuggingFace datasets. */
export type SwebenchEntry = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
  test_patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
  version: string;
  environment_setup_commit?: string;
};

/** Options for importing SWE-bench entries. */
export type ImportOptions = {
  /** Path to a downloaded JSONL file. If not provided, auto-downloads. */
  dataset?: string;
  /** HuggingFace dataset ID (default: princeton-nlp/SWE-bench_Lite). */
  datasetId?: string;
  /** Maximum number of entries to import. */
  count?: number;
  /** Filter by repo (e.g. 'django/django'). */
  repo?: string;
  /** Import specific instance IDs (comma-separated). */
  ids?: string;
  /** Pipeline step to target (default: 'implement'). */
  step?: string;
  /** Project directory. */
  projectDir?: string;
  /** Eval directory override. */
  evalDir?: string;
};

/**
 * Download a SWE-bench dataset from HuggingFace and save as JSONL.
 * Requires Python with the `datasets` library installed.
 */
export function downloadDataset(datasetId: string, outputPath: string): void {
  const dir = join(outputPath, '..');
  mkdirSync(dir, { recursive: true });

  const script = `
import json
from datasets import load_dataset
ds = load_dataset('${datasetId}', split='test')
with open('${outputPath}', 'w') as f:
    for entry in ds:
        f.write(json.dumps(entry) + '\\n')
print(f'Downloaded {len(ds)} entries to ${outputPath}')
`.trim();

  log.info(`Downloading ${datasetId} from HuggingFace...`);
  const result = exec(`python3 -c "${script.replace(/"/g, '\\"')}"`, { timeout: 300_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to download dataset. Ensure Python and 'datasets' are installed:\n` +
      `  pip install datasets\n\n${result.stderr}`,
    );
  }
  log.info(result.stdout);
}

/**
 * Read a JSONL file and parse SWE-bench entries.
 * Supports filtering by repo, instance IDs, and count.
 */
export function importFromJsonl(datasetPath: string, options?: Pick<ImportOptions, 'count' | 'repo' | 'ids'>): SwebenchEntry[] {
  if (!existsSync(datasetPath)) {
    throw new Error(`Dataset file not found: ${datasetPath}`);
  }

  const content = readFileSync(datasetPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);

  let entries: SwebenchEntry[] = lines.map((line) => {
    const parsed = JSON.parse(line) as SwebenchEntry;
    return parsed;
  });

  // Filter by specific instance IDs
  if (options?.ids) {
    const idSet = new Set(options.ids.split(',').map((s) => s.trim()));
    entries = entries.filter((e) => idSet.has(e.instance_id));
  }

  // Filter by repo
  if (options?.repo) {
    entries = entries.filter((e) => e.repo === options.repo);
  }

  // Limit count
  if (options?.count && options.count > 0) {
    entries = entries.slice(0, options.count);
  }

  return entries;
}

/**
 * Convert a SWE-bench entry into a directory-based eval case.
 *
 * Creates:
 *   .alpha-loop/evals/cases/e2e/swe-{sanitized-id}/
 *   ├── issue.md           # From problem_statement
 *   ├── checks.yaml        # FAIL_TO_PASS tests as acceptance criteria
 *   ├── metadata.yaml      # repo, base_commit, instance_id, source: swe-bench
 *   └── reference.patch    # The validated fix (for comparison, not shown to agent)
 *
 * Returns the path to the created case directory.
 */
export function convertToEvalCase(
  entry: SwebenchEntry,
  projectDir?: string,
  evalDirOverride?: string,
  step?: string,
): string {
  const dir = evalsDir(projectDir, evalDirOverride);
  const sanitizedId = entry.instance_id.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const caseId = `swe-${sanitizedId}`;
  const targetStep = step ?? 'implement';

  // e2e cases go under cases/e2e/
  const casePath = join(dir, 'cases', 'e2e', caseId);
  mkdirSync(casePath, { recursive: true });

  // Parse FAIL_TO_PASS — it's a JSON string containing a list of test identifiers
  let failToPass: string[] = [];
  try {
    failToPass = JSON.parse(entry.FAIL_TO_PASS);
    if (!Array.isArray(failToPass)) failToPass = [String(entry.FAIL_TO_PASS)];
  } catch {
    failToPass = entry.FAIL_TO_PASS ? [entry.FAIL_TO_PASS] : [];
  }

  // Parse PASS_TO_PASS
  let passToPass: string[] = [];
  try {
    passToPass = JSON.parse(entry.PASS_TO_PASS);
    if (!Array.isArray(passToPass)) passToPass = [];
  } catch {
    passToPass = [];
  }

  // metadata.yaml
  const metadata = stringifyYaml({
    id: caseId,
    description: `SWE-bench: ${entry.instance_id}`,
    tags: ['swe-bench', entry.repo.replace('/', '-'), targetStep],
    source: 'swe-bench',
    swebench: {
      instance_id: entry.instance_id,
      repo: entry.repo,
      base_commit: entry.base_commit,
      version: entry.version || undefined,
    },
  });
  writeFileSync(join(casePath, 'metadata.yaml'), metadata);

  // checks.yaml — FAIL_TO_PASS tests as test_pass checks
  const checks: Array<Record<string, unknown>> = [];

  // Primary check: the tests that must go from failing to passing
  if (failToPass.length > 0) {
    checks.push({
      type: 'test_pass',
      command: buildTestCommand(entry.repo, failToPass),
    });
  }

  // Keyword checks: ensure key test identifiers appear in output
  if (failToPass.length > 0) {
    checks.push({
      type: 'keyword_present',
      keywords: failToPass.slice(0, 5), // Limit to avoid overly long checks
    });
  }

  const checksYaml = stringifyYaml({
    type: 'full',
    step: targetStep,
    eval_method: 'checks',
    status: 'ready',
    repo: entry.repo,
    fixture_ref: entry.base_commit,
    fail_to_pass: failToPass,
    pass_to_pass: passToPass.slice(0, 10), // Keep manageable
    checks,
  });
  writeFileSync(join(casePath, 'checks.yaml'), checksYaml);

  // issue.md — the problem statement
  const title = extractTitle(entry.instance_id, entry.problem_statement);
  const issueContent = `# ${title}\n\n${entry.problem_statement}\n`;
  writeFileSync(join(casePath, 'issue.md'), issueContent);

  // reference.patch — validated fix for comparison
  if (entry.patch) {
    writeFileSync(join(casePath, 'reference.patch'), entry.patch);
  }

  // test.patch — test changes for verification
  if (entry.test_patch) {
    writeFileSync(join(casePath, 'test.patch'), entry.test_patch);
  }

  return casePath;
}

/**
 * Update eval config.yaml with SWE-bench repo base commits.
 */
export function updateEvalConfig(evalDirPath: string, entries: SwebenchEntry[]): void {
  const config = loadEvalConfig(evalDirPath);
  const repos = config.swebench_repos ?? {};

  for (const entry of entries) {
    if (!repos[entry.repo]) {
      repos[entry.repo] = { base_commits: {} };
    }
    repos[entry.repo].base_commits[entry.instance_id] = entry.base_commit;
  }

  // Read existing config and update swebench_repos section
  const configPath = join(evalDirPath, 'config.yaml');
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = parseYaml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch { /* start fresh */ }
  }

  existing.swebench_repos = repos;
  writeFileSync(configPath, stringifyYaml(existing));
}

/**
 * Run the full SWE-bench import pipeline.
 * Returns the number of cases imported.
 */
export function importSwebench(options: ImportOptions): number {
  const projectDir = options.projectDir ?? process.cwd();
  const evalDirPath = evalsDir(projectDir, options.evalDir);

  // Determine dataset path
  let datasetPath = options.dataset;
  if (!datasetPath) {
    const datasetId = options.datasetId ?? 'princeton-nlp/SWE-bench_Lite';
    datasetPath = join(evalDirPath, 'datasets', `${datasetId.replace(/\//g, '_')}.jsonl`);

    if (!existsSync(datasetPath)) {
      downloadDataset(datasetId, datasetPath);
    } else {
      log.info(`Using cached dataset: ${datasetPath}`);
    }
  }

  // Parse and filter entries
  const entries = importFromJsonl(datasetPath, {
    count: options.count,
    repo: options.repo,
    ids: options.ids,
  });

  if (entries.length === 0) {
    log.warn('No matching SWE-bench entries found.');
    return 0;
  }

  log.info(`Importing ${entries.length} SWE-bench case(s)...`);

  // Convert each entry to an eval case
  const created: string[] = [];
  for (const entry of entries) {
    const casePath = convertToEvalCase(entry, projectDir, options.evalDir, options.step);
    created.push(casePath);
    log.info(`  Created: ${basename(casePath)}`);
  }

  // Update config.yaml with repo mappings
  updateEvalConfig(evalDirPath, entries);

  return created.length;
}

/** Extract a title from instance_id or first line of problem_statement. */
function extractTitle(instanceId: string, problemStatement: string): string {
  // Try to extract from first line of problem statement
  const firstLine = problemStatement.split('\n')[0].trim();
  if (firstLine && firstLine.length > 10 && firstLine.length < 200) {
    return firstLine;
  }
  // Fall back to instance_id formatted as title
  return instanceId.replace(/__/g, ': ').replace(/-/g, ' ');
}

/** Build a test command for a SWE-bench repo. */
function buildTestCommand(repo: string, tests: string[]): string {
  // Most SWE-bench repos are Python — use pytest
  const testArgs = tests.slice(0, 3).join(' ');
  return `python -m pytest ${testArgs}`;
}

/**
 * List available SWE-bench cases that have been imported.
 */
export function listImportedSwebenchCases(projectDir?: string, evalDirOverride?: string): string[] {
  const dir = evalsDir(projectDir, evalDirOverride);
  const e2eDir = join(dir, 'cases', 'e2e');
  if (!existsSync(e2eDir)) return [];

  return readdirSync(e2eDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('swe-'))
    .map((d) => d.name);
}
