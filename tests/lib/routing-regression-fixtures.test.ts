/**
 * Schema + secret-scan gate for every shipped routing-regression case.
 * Breaks the build if someone adds a case without the required fields or
 * with a credential in the file.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { scanCaseDir } from '../../src/lib/eval-secret-scan.js';

const REGRESSION_DIR = join(process.cwd(), '.alpha-loop', 'evals', 'cases', 'routing-regression');

function listCaseDirs(): string[] {
  if (!existsSync(REGRESSION_DIR)) return [];
  return readdirSync(REGRESSION_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(REGRESSION_DIR, d.name));
}

describe('routing-regression case fixtures', () => {
  const caseDirs = listCaseDirs();

  it('ships at least 15 cases', () => {
    expect(caseDirs.length).toBeGreaterThanOrEqual(15);
  });

  it.each(caseDirs)('%s has required files', (dir) => {
    expect(existsSync(join(dir, 'metadata.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'checks.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'input.md'))).toBe(true);
    expect(existsSync(join(dir, 'golden.patch'))).toBe(true);
  });

  it.each(caseDirs)('%s metadata declares id, source_pr, and ci_status', (dir) => {
    const raw = readFileSync(join(dir, 'metadata.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(typeof parsed.id).toBe('string');
    expect(typeof parsed.source_pr).toBe('number');
    expect(parsed.ci_status).toBe('success');
    expect(Array.isArray(parsed.tags)).toBe(true);
    expect((parsed.tags as string[])).toContain('routing-regression');
  });

  it.each(caseDirs)('%s checks.yaml declares the required scorers', (dir) => {
    const raw = readFileSync(join(dir, 'checks.yaml'), 'utf-8');
    const parsed = parseYaml(raw) as Record<string, unknown>;
    expect(parsed.type).toBe('routing-regression');
    const scorers = parsed.scorers as Record<string, unknown>;
    expect(scorers).toBeDefined();
    expect(scorers.pipeline_success).toBeDefined();
    expect(scorers.test_pass_rate).toBeDefined();
  });

  it('all cases pass the secret scan', () => {
    // Skip when the directory hasn't been seeded yet.
    if (!existsSync(REGRESSION_DIR)) return;
    const findings = scanCaseDir(REGRESSION_DIR);
    if (findings.length > 0) {
      // Surface the dirty paths so CI failures point at the right file.
      const paths = findings.map((f) => f.path).join('\n  ');
      throw new Error(`Secret scan found dirty files:\n  ${paths}`);
    }
    expect(findings).toEqual([]);
  });

  it('CASE_FORMAT.md documents the format', () => {
    const doc = join(REGRESSION_DIR, 'CASE_FORMAT.md');
    expect(existsSync(doc)).toBe(true);
    const size = statSync(doc).size;
    expect(size).toBeGreaterThan(500);
  });
});
