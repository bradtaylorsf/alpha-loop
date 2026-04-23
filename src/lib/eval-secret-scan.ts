/**
 * Secret scanner for eval cases — refuses to accept case files that contain
 * credentials, tokens, or private URLs. Runs on case check-in (via the
 * build script) and at `runEvalSuite` startup.
 *
 * Detection is regex-based. Each rule names a class of secret and includes
 * an example in the failure message so contributors can see what matched.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

export type SecretRule = {
  /** Short id for the rule (used in messages and tests). */
  id: string;
  /** Human-readable description of what this detects. */
  description: string;
  /** Regex to match against file contents. */
  pattern: RegExp;
};

/**
 * Built-in secret patterns. Conservative — we'd rather false-positive on
 * an obvious looking token than let a real one slip through.
 */
export const SECRET_RULES: SecretRule[] = [
  {
    id: 'aws-access-key',
    description: 'AWS access key id (AKIA... / ASIA...)',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: 'aws-secret-key',
    description: 'AWS secret access key (aws_secret_access_key = ...)',
    pattern: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i,
  },
  {
    id: 'github-token',
    description: 'GitHub token (ghp_, gho_, ghu_, ghs_, ghr_ prefixes)',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key (sk-ant-...)',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key (sk-...)',
    pattern: /\bsk-(?!ant-)[A-Za-z0-9]{20,}\b/,
  },
  {
    id: 'bearer-token',
    description: 'Bearer token in Authorization header',
    pattern: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  },
  {
    id: 'private-ip-url',
    description: 'Private/internal URL (RFC1918, .local, .internal)',
    pattern: /https?:\/\/(?:(?:10|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[A-Za-z0-9-]+\.(?:local|internal|corp|intranet))(?::\d+)?/i,
  },
  {
    id: 'generic-api-key-kv',
    description: 'Generic "api_key = ..." literal longer than 20 chars',
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i,
  },
  {
    id: 'private-key-block',
    description: 'PEM-encoded private key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
];

export type SecretFinding = {
  ruleId: string;
  description: string;
  match: string;
  line: number;
};

export type SecretScanResult = {
  /** Path of the file that was scanned. */
  path: string;
  /** Non-empty when the file contains a secret. */
  findings: SecretFinding[];
};

/**
 * Scan a single string of content against the rule set.
 * Returned matches are truncated to 40 characters so secrets don't leak
 * into CI logs when the scan itself reports failures.
 */
export function scanContent(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');

  for (const rule of SECRET_RULES) {
    // Run a fresh exec each time — we don't use global regexes so we're safe
    // to reuse the rule.pattern across files.
    let match: RegExpExecArray | null;
    const globalRegex = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
    while ((match = globalRegex.exec(content)) !== null) {
      const lineIndex = content.slice(0, match.index).split('\n').length;
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        match: redact(match[0]),
        line: lineIndex,
      });
      if (match[0].length === 0) globalRegex.lastIndex++;
    }
    void lines; // keep lines reference in case future rules want per-line scoping
  }

  return findings;
}

/** Redact a matched secret — show first 6 chars + length so we don't leak it. */
function redact(match: string): string {
  if (match.length <= 8) return `[${match.length} chars]`;
  return `${match.slice(0, 6)}… [${match.length} chars]`;
}

/** Extensions that get scanned; binary files are skipped. */
const SCAN_EXTENSIONS = new Set(['.md', '.yaml', '.yml', '.txt', '.json', '.patch', '.diff', '']);

/**
 * Walk a case directory and scan each text file. Returns per-file results.
 * Directories that don't exist return an empty array.
 */
export function scanCaseDir(dirPath: string): SecretScanResult[] {
  const results: SecretScanResult[] = [];
  walk(dirPath, (filePath) => {
    const ext = extname(filePath).toLowerCase();
    if (!SCAN_EXTENSIONS.has(ext)) return;
    try {
      const content = readFileSync(filePath, 'utf-8');
      const findings = scanContent(content);
      if (findings.length > 0) {
        results.push({ path: filePath, findings });
      }
    } catch {
      // Skip unreadable files.
    }
  });
  return results;
}

function walk(dir: string, visit: (filePath: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walk(full, visit);
    } else if (stat.isFile()) {
      visit(full);
    }
  }
}

/**
 * Format findings as a single human-readable block. Used by the build
 * script and CLI to print a dirty-case report.
 */
export function formatFindings(results: SecretScanResult[]): string {
  if (results.length === 0) return '';
  const lines: string[] = [];
  lines.push(`Secret scan found ${results.length} dirty file(s):`);
  for (const { path, findings } of results) {
    lines.push(`  ${path}`);
    for (const f of findings) {
      lines.push(`    [${f.ruleId}] line ${f.line}: ${f.description} — ${f.match}`);
    }
  }
  return lines.join('\n');
}
