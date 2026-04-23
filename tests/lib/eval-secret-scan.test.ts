import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanContent,
  scanCaseDir,
  formatFindings,
  SECRET_RULES,
} from '../../src/lib/eval-secret-scan.js';

describe('scanContent', () => {
  it('flags AWS access key ids', () => {
    const findings = scanContent('token = AKIAIOSFODNN7EXAMPLE');
    expect(findings.some((f) => f.ruleId === 'aws-access-key')).toBe(true);
  });

  it('flags AWS secret keys assigned as aws_secret_access_key', () => {
    // Real AWS secret keys are exactly 40 chars.
    const findings = scanContent('aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"');
    expect(findings.some((f) => f.ruleId === 'aws-secret-key')).toBe(true);
  });

  it('flags GitHub ghp_ tokens', () => {
    const findings = scanContent('GITHUB_TOKEN=ghp_1234567890abcdefghij1234567890abcdef');
    expect(findings.some((f) => f.ruleId === 'github-token')).toBe(true);
  });

  it('flags GitHub ghs_/gho_/ghu_ tokens', () => {
    const findings = scanContent('oauth=gho_1234567890abcdefghij1234567890abcdef\nserver=ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('github-token');
  });

  it('flags Anthropic sk-ant- keys', () => {
    const findings = scanContent('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop_qrs123');
    expect(findings.some((f) => f.ruleId === 'anthropic-api-key')).toBe(true);
  });

  it('flags OpenAI sk- keys but not sk-ant-', () => {
    const findings = scanContent('openai=sk-abcdefghijklmnopqrstuvwxyz123456');
    const antFindings = scanContent('anthropic=sk-ant-abcdefghijklmnop1234567890');

    expect(findings.some((f) => f.ruleId === 'openai-api-key')).toBe(true);
    expect(antFindings.some((f) => f.ruleId === 'openai-api-key')).toBe(false);
    expect(antFindings.some((f) => f.ruleId === 'anthropic-api-key')).toBe(true);
  });

  it('flags Authorization bearer tokens', () => {
    const findings = scanContent('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdef.ghij');
    expect(findings.some((f) => f.ruleId === 'bearer-token')).toBe(true);
  });

  it('flags private/internal URLs', () => {
    const rfc1918 = scanContent('server = http://10.0.0.1:8080/api');
    const corp = scanContent('https://grafana.internal/d/api');
    const localdomain = scanContent('https://foo.local/endpoint');

    expect(rfc1918.some((f) => f.ruleId === 'private-ip-url')).toBe(true);
    expect(corp.some((f) => f.ruleId === 'private-ip-url')).toBe(true);
    expect(localdomain.some((f) => f.ruleId === 'private-ip-url')).toBe(true);
  });

  it('flags PEM private key blocks', () => {
    const findings = scanContent('-----BEGIN RSA PRIVATE KEY-----\nMIIEvAIBADAN\n-----END RSA PRIVATE KEY-----');
    expect(findings.some((f) => f.ruleId === 'private-key-block')).toBe(true);
  });

  it('flags generic api_key = literal assignments', () => {
    const findings = scanContent('config.api_key = "abcdefghijklmnopqrstuvwxyz0123"');
    expect(findings.some((f) => f.ruleId === 'generic-api-key-kv')).toBe(true);
  });

  it('redacts matched secrets in findings', () => {
    const findings = scanContent('ghp_1234567890abcdefghij1234567890abcdef');
    const finding = findings.find((f) => f.ruleId === 'github-token');
    expect(finding).toBeDefined();
    // Should show first few chars + length, not the full token.
    expect(finding!.match).toMatch(/ghp_/);
    expect(finding!.match).toContain('chars]');
  });

  it('returns empty for clean content', () => {
    const findings = scanContent(`
# Clean case
This eval case describes a refactor of the fixPoint function.
The golden PR diff modifies src/fix.ts.

Reference public URL: https://github.com/example/repo
`);
    expect(findings).toEqual([]);
  });
});

describe('scanCaseDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-secretscan-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags files with secrets under the case directory', () => {
    writeFileSync(join(tempDir, 'input.md'), '# Case\n\nclean body');
    writeFileSync(join(tempDir, 'golden.patch'), 'diff --git a/x b/x\n+ANTHROPIC_API_KEY=sk-ant-realsecret1234567890');
    const results = scanCaseDir(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].path).toContain('golden.patch');
    expect(results[0].findings[0].ruleId).toBe('anthropic-api-key');
  });

  it('recursively scans nested case directories', () => {
    const nested = join(tempDir, 'cases', 'routing-regression', '001-foo');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'metadata.yaml'), 'id: 001-foo\nsource_pr: 42');
    writeFileSync(join(nested, 'input.md'), 'Content\nghp_1234567890abcdefghij1234567890abcdef');
    const results = scanCaseDir(tempDir);
    expect(results).toHaveLength(1);
    expect(results[0].findings[0].ruleId).toBe('github-token');
  });

  it('returns empty list for clean directory', () => {
    writeFileSync(join(tempDir, 'metadata.yaml'), 'id: 001\nsource_pr: 42\nci_status: success');
    writeFileSync(join(tempDir, 'input.md'), 'Plain text with https://github.com/example/repo\n');
    writeFileSync(join(tempDir, 'golden.patch'), 'diff --git a/x b/x\n+console.log("hi")\n');
    const results = scanCaseDir(tempDir);
    expect(results).toEqual([]);
  });
});

describe('formatFindings', () => {
  it('returns empty string when no findings', () => {
    expect(formatFindings([])).toBe('');
  });

  it('formats each dirty file and rule match', () => {
    const output = formatFindings([
      {
        path: '/tmp/case/input.md',
        findings: [
          { ruleId: 'github-token', description: 'GitHub token (ghp_...)', match: 'ghp_… [44 chars]', line: 3 },
        ],
      },
    ]);
    expect(output).toContain('/tmp/case/input.md');
    expect(output).toContain('github-token');
    expect(output).toContain('line 3');
  });
});

describe('SECRET_RULES', () => {
  it('exports non-empty rule set with unique ids', () => {
    const ids = SECRET_RULES.map((r) => r.id);
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
