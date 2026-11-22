import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Signup addresses are stored under data/ (outside public/).
 * No HTTP route serves this file.
 */
export function signupStorePath(): string {
  const root = process.env.SIGNUP_DATA_DIR?.trim() || join(process.cwd(), 'data');
  return join(root, 'signups.json');
}

export type SignupRecord = {
  email: string;
  createdAt: string;
};

function readAll(): SignupRecord[] {
  const path = signupStorePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (row): row is SignupRecord =>
        Boolean(row)
        && typeof row === 'object'
        && typeof (row as SignupRecord).email === 'string'
        && typeof (row as SignupRecord).createdAt === 'string',
    );
  } catch {
    return [];
  }
}

export function appendSignup(email: string): void {
  const path = signupStorePath();
  mkdirSync(dirname(path), { recursive: true });
  const records = readAll();
  records.push({ email, createdAt: new Date().toISOString() });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Practical acceptance check for the demo form (not a full RFC parser).
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
