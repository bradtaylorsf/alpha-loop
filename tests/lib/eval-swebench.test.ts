import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  importFromJsonl,
  convertToEvalCase,
  updateEvalConfig,
  listImportedSwebenchCases,
} from '../../src/lib/eval-swebench.js';
import type { SwebenchEntry } from '../../src/lib/eval-swebench.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-swebench-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const sampleEntry: SwebenchEntry = {
  instance_id: 'django__django-11848',
  repo: 'django/django',
  base_commit: 'a1b2c3d4e5f6',
  problem_statement: 'HttpResponse does not handle memoryview objects\n\nWhen passing a memoryview to HttpResponse, it should work but currently raises a TypeError.',
  patch: 'diff --git a/django/http/response.py b/django/http/response.py\n--- a/django/http/response.py\n+++ b/django/http/response.py\n@@ -1 +1 @@\n-old\n+new\n',
  test_patch: 'diff --git a/tests/test_http.py\n+test content\n',
  FAIL_TO_PASS: '["tests/responses/test_response.py::TestHttpResponse::test_memoryview"]',
  PASS_TO_PASS: '["tests/responses/test_response.py::TestHttpResponse::test_str", "tests/responses/test_response.py::TestHttpResponse::test_bytes"]',
  version: '3.0',
};

const sampleEntry2: SwebenchEntry = {
  instance_id: 'flask__flask-4045',
  repo: 'flask/flask',
  base_commit: 'deadbeef1234',
  problem_statement: 'Blueprint URL prefix not applied correctly',
  patch: 'diff fix',
  test_patch: 'diff test fix',
  FAIL_TO_PASS: '["tests/test_blueprints.py::test_url_prefix"]',
  PASS_TO_PASS: '[]',
  version: '2.0',
};

function writeJsonl(entries: SwebenchEntry[], filePath: string): void {
  const content = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(filePath, content);
}

describe('importFromJsonl', () => {
  it('parses all entries from a JSONL file', () => {
    const filePath = join(tempDir, 'data.jsonl');
    writeJsonl([sampleEntry, sampleEntry2], filePath);

    const entries = importFromJsonl(filePath);
    expect(entries).toHaveLength(2);
    expect(entries[0].instance_id).toBe('django__django-11848');
    expect(entries[1].instance_id).toBe('flask__flask-4045');
  });

  it('filters by repo', () => {
    const filePath = join(tempDir, 'data.jsonl');
    writeJsonl([sampleEntry, sampleEntry2], filePath);

    const entries = importFromJsonl(filePath, { repo: 'flask/flask' });
    expect(entries).toHaveLength(1);
    expect(entries[0].instance_id).toBe('flask__flask-4045');
  });

  it('filters by specific IDs', () => {
    const filePath = join(tempDir, 'data.jsonl');
    writeJsonl([sampleEntry, sampleEntry2], filePath);

    const entries = importFromJsonl(filePath, { ids: 'django__django-11848' });
    expect(entries).toHaveLength(1);
    expect(entries[0].instance_id).toBe('django__django-11848');
  });

  it('limits by count', () => {
    const filePath = join(tempDir, 'data.jsonl');
    writeJsonl([sampleEntry, sampleEntry2], filePath);

    const entries = importFromJsonl(filePath, { count: 1 });
    expect(entries).toHaveLength(1);
  });

  it('throws for non-existent file', () => {
    expect(() => importFromJsonl(join(tempDir, 'missing.jsonl'))).toThrow(/not found/);
  });

  it('handles empty file', () => {
    const filePath = join(tempDir, 'empty.jsonl');
    writeFileSync(filePath, '');
    const entries = importFromJsonl(filePath);
    expect(entries).toHaveLength(0);
  });

  it('combines multiple filters', () => {
    const filePath = join(tempDir, 'data.jsonl');
    writeJsonl([sampleEntry, sampleEntry2], filePath);

    const entries = importFromJsonl(filePath, { repo: 'django/django', count: 5 });
    expect(entries).toHaveLength(1);
    expect(entries[0].repo).toBe('django/django');
  });
});

describe('convertToEvalCase', () => {
  it('creates directory-based eval case with all files', () => {
    const evalsDir = join(tempDir, '.alpha-loop', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    const casePath = convertToEvalCase(sampleEntry, tempDir);

    // Verify directory was created
    expect(existsSync(casePath)).toBe(true);
    expect(casePath).toContain('swe-django__django-11848');

    // Verify metadata.yaml
    const metadata = parseYaml(readFileSync(join(casePath, 'metadata.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(metadata.source).toBe('swe-bench');
    expect((metadata.swebench as Record<string, unknown>).instance_id).toBe('django__django-11848');
    expect((metadata.swebench as Record<string, unknown>).repo).toBe('django/django');
    expect((metadata.swebench as Record<string, unknown>).base_commit).toBe('a1b2c3d4e5f6');
    expect(metadata.tags).toContain('swe-bench');
    expect(metadata.tags).toContain('django-django');

    // Verify checks.yaml
    const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(checks.type).toBe('full');
    expect(checks.status).toBe('ready');
    expect(checks.repo).toBe('django/django');
    expect(checks.fixture_ref).toBe('a1b2c3d4e5f6');
    expect(checks.fail_to_pass).toEqual(['tests/responses/test_response.py::TestHttpResponse::test_memoryview']);
    expect(Array.isArray(checks.checks)).toBe(true);

    // Verify issue.md
    const issue = readFileSync(join(casePath, 'issue.md'), 'utf-8');
    expect(issue).toContain('HttpResponse does not handle memoryview objects');

    // Verify reference.patch
    const patch = readFileSync(join(casePath, 'reference.patch'), 'utf-8');
    expect(patch).toContain('django/http/response.py');

    // Verify test.patch
    expect(existsSync(join(casePath, 'test.patch'))).toBe(true);
  });

  it('handles non-JSON FAIL_TO_PASS gracefully', () => {
    const entry = { ...sampleEntry, FAIL_TO_PASS: 'not-json-just-a-string' };
    const evalsDir = join(tempDir, '.alpha-loop', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    const casePath = convertToEvalCase(entry, tempDir);
    const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(checks.fail_to_pass).toEqual(['not-json-just-a-string']);
  });

  it('uses custom step when provided', () => {
    const evalsDir = join(tempDir, '.alpha-loop', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    const casePath = convertToEvalCase(sampleEntry, tempDir, undefined, 'review');
    const checks = parseYaml(readFileSync(join(casePath, 'checks.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(checks.step).toBe('review');
    const metadata = parseYaml(readFileSync(join(casePath, 'metadata.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(metadata.tags).toContain('review');
  });

  it('handles empty patch and test_patch', () => {
    const entry = { ...sampleEntry, patch: '', test_patch: '' };
    const evalsDir = join(tempDir, '.alpha-loop', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    const casePath = convertToEvalCase(entry, tempDir);
    expect(existsSync(casePath)).toBe(true);
    // Empty patch should not be written
    expect(existsSync(join(casePath, 'reference.patch'))).toBe(false);
    expect(existsSync(join(casePath, 'test.patch'))).toBe(false);
  });
});

describe('updateEvalConfig', () => {
  it('creates swebench_repos section in config.yaml', () => {
    const evalsDir = join(tempDir, '.alpha-loop', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    updateEvalConfig(evalsDir, [sampleEntry, sampleEntry2]);

    const configPath = join(evalsDir, 'config.yaml');
    expect(existsSync(configPath)).toBe(true);

    const config = parseYaml(readFileSync(configPath, 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(config.swebench_repos).toBeDefined();
    expect(config.swebench_repos['django/django']).toBeDefined();
    expect((config.swebench_repos['django/django'] as Record<string, Record<string, string>>).base_commits['django__django-11848']).toBe('a1b2c3d4e5f6');
    expect(config.swebench_repos['flask/flask']).toBeDefined();
  });

  it('preserves existing fixture_repo config', () => {
    const evalsDir = join(tempDir, '.alpha-loop', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    // Write existing config
    writeFileSync(join(evalsDir, 'config.yaml'), 'fixture_repo:\n  url: test/repo\n  commit: abc123\n  fixtures: {}\n');

    updateEvalConfig(evalsDir, [sampleEntry]);

    const config = parseYaml(readFileSync(join(evalsDir, 'config.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(config.fixture_repo).toBeDefined();
    expect(config.swebench_repos).toBeDefined();
  });

  it('merges new commits into existing repo entries', () => {
    const evalsDir = join(tempDir, '.alpha-loop', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    // First import
    updateEvalConfig(evalsDir, [sampleEntry]);
    // Second import with different entry from same repo
    const entry2 = { ...sampleEntry, instance_id: 'django__django-99999', base_commit: 'newcommit123' };
    updateEvalConfig(evalsDir, [entry2]);

    const config = parseYaml(readFileSync(join(evalsDir, 'config.yaml'), 'utf-8')) as Record<string, Record<string, unknown>>;
    const djangoCommits = (config.swebench_repos['django/django'] as Record<string, Record<string, string>>).base_commits;
    expect(djangoCommits['django__django-11848']).toBe('a1b2c3d4e5f6');
    expect(djangoCommits['django__django-99999']).toBe('newcommit123');
  });
});

describe('listImportedSwebenchCases', () => {
  it('returns empty array when no cases exist', () => {
    expect(listImportedSwebenchCases(tempDir)).toEqual([]);
  });

  it('lists imported swe-bench case directories', () => {
    const evalsDir = join(tempDir, '.alpha-loop', 'evals');
    mkdirSync(evalsDir, { recursive: true });

    convertToEvalCase(sampleEntry, tempDir);
    convertToEvalCase(sampleEntry2, tempDir);

    const cases = listImportedSwebenchCases(tempDir);
    expect(cases).toHaveLength(2);
    expect(cases.some((c) => c.includes('django'))).toBe(true);
    expect(cases.some((c) => c.includes('flask'))).toBe(true);
  });

  it('ignores non-swe directories', () => {
    const e2eDir = join(tempDir, '.alpha-loop', 'evals', 'cases', 'e2e', 'custom-case');
    mkdirSync(e2eDir, { recursive: true });

    const cases = listImportedSwebenchCases(tempDir);
    expect(cases).toHaveLength(0);
  });
});
