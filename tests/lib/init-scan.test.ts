import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectPackageManager,
  detectTestCommand,
  detectDevCommand,
  detectLanguage,
  detectFramework,
  scanProject,
} from '../../src/lib/init-scan.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'alpha-loop-init-scan-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('detectPackageManager', () => {
  it('returns pnpm when pnpm-lock.yaml exists', () => {
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManager(tempDir)).toBe('pnpm');
  });

  it('returns yarn when yarn.lock exists', () => {
    writeFileSync(join(tempDir, 'yarn.lock'), '');
    expect(detectPackageManager(tempDir)).toBe('yarn');
  });

  it('returns bun when bun.lockb exists', () => {
    writeFileSync(join(tempDir, 'bun.lockb'), '');
    expect(detectPackageManager(tempDir)).toBe('bun');
  });

  it('returns npm when package-lock.json exists', () => {
    writeFileSync(join(tempDir, 'package-lock.json'), '');
    expect(detectPackageManager(tempDir)).toBe('npm');
  });

  it('returns npm when only package.json exists (no lockfile)', () => {
    writeFileSync(join(tempDir, 'package.json'), '{}');
    expect(detectPackageManager(tempDir)).toBe('npm');
  });

  it('returns unknown when nothing matches', () => {
    expect(detectPackageManager(tempDir)).toBe('unknown');
  });

  it('prefers pnpm-lock.yaml over package-lock.json (mixed lockfiles)', () => {
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(tempDir, 'package-lock.json'), '');
    expect(detectPackageManager(tempDir)).toBe('pnpm');
  });
});

describe('detectTestCommand', () => {
  it('uses package.json scripts.test when present', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      scripts: { test: 'jest' },
    }));
    expect(detectTestCommand(tempDir, 'pnpm')).toBe('pnpm test');
    expect(detectTestCommand(tempDir, 'npm')).toBe('npm run test');
    expect(detectTestCommand(tempDir, 'yarn')).toBe('yarn test');
    expect(detectTestCommand(tempDir, 'bun')).toBe('bun run test');
  });

  it('falls back to pytest for Python projects', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '');
    expect(detectTestCommand(tempDir, 'unknown')).toBe('pytest');
  });

  it('falls back to go test for Go projects', () => {
    writeFileSync(join(tempDir, 'go.mod'), 'module foo\n');
    expect(detectTestCommand(tempDir, 'unknown')).toBe('go test ./...');
  });

  it('falls back to cargo test for Rust projects', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '');
    expect(detectTestCommand(tempDir, 'unknown')).toBe('cargo test');
  });
});

describe('detectDevCommand', () => {
  it('prefers scripts.dev over scripts.start', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      scripts: { dev: 'tsx watch', start: 'node .' },
    }));
    expect(detectDevCommand(tempDir, 'pnpm')).toBe('pnpm dev');
  });

  it('uses scripts.start when scripts.dev is absent', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      scripts: { start: 'node .' },
    }));
    expect(detectDevCommand(tempDir, 'pnpm')).toBe('pnpm start');
  });
});

describe('detectLanguage', () => {
  it('returns TypeScript when typescript is a dep', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5' },
    }));
    expect(detectLanguage(tempDir)).toBe('TypeScript');
  });

  it('returns JavaScript when package.json exists without typescript', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: { lodash: '^4' },
    }));
    expect(detectLanguage(tempDir)).toBe('JavaScript');
  });

  it('returns Python for pyproject.toml', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '');
    expect(detectLanguage(tempDir)).toBe('Python');
  });

  it('returns Go for go.mod', () => {
    writeFileSync(join(tempDir, 'go.mod'), '');
    expect(detectLanguage(tempDir)).toBe('Go');
  });
});

describe('detectFramework', () => {
  it('detects Next.js from dependencies', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: { next: '^14', react: '^18' },
    }));
    expect(detectFramework(tempDir)).toBe('Next.js');
  });

  it('detects Express from dependencies', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: { express: '^4' },
    }));
    expect(detectFramework(tempDir)).toBe('Express');
  });

  it('returns empty string when no known framework is present', () => {
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      dependencies: { 'something-obscure': '^1' },
    }));
    expect(detectFramework(tempDir)).toBe('');
  });
});

describe('scanProject', () => {
  it('produces a complete profile for a typical TS+pnpm+React project', () => {
    writeFileSync(join(tempDir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      scripts: { test: 'jest', dev: 'vite' },
      dependencies: { react: '^18' },
      devDependencies: { typescript: '^5' },
    }));

    const profile = scanProject(tempDir);
    expect(profile.packageManager).toBe('pnpm');
    expect(profile.testCommand).toBe('pnpm test');
    expect(profile.devCommand).toBe('pnpm dev');
    expect(profile.language).toBe('TypeScript');
    expect(profile.framework).toBe('React');
    // baseBranch may be 'main' (no git) — just check it's a non-empty string
    expect(profile.baseBranch).toBeTruthy();
  });
});
