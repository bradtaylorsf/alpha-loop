/**
 * Codebase scan helpers for `alpha-loop init`.
 *
 * Pure file-system inspection — no agent calls, no network. Used by the init
 * wizard to pick sensible defaults so users don't have to hand-edit YAML for
 * the common case.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

export type ProjectScan = {
  packageManager: PackageManager;
  testCommand: string;
  devCommand: string;
  baseBranch: string;
  language: string;
  framework: string;
};

const PM_LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

/** Detect the project's package manager from lockfile presence. */
export function detectPackageManager(projectDir: string): PackageManager {
  for (const [lockfile, pm] of PM_LOCKFILES) {
    if (existsSync(join(projectDir, lockfile))) return pm;
  }
  if (existsSync(join(projectDir, 'package.json'))) return 'npm';
  return 'unknown';
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function readPackageJson(projectDir: string): PackageJson | null {
  const pkgPath = join(projectDir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson;
  } catch {
    return null;
  }
}

const RUN_PREFIX: Record<PackageManager, string> = {
  pnpm: 'pnpm',
  npm: 'npm run',
  yarn: 'yarn',
  bun: 'bun run',
  unknown: 'npm run',
};

/**
 * Detect the test command. Prefers package.json scripts.test; falls back to a
 * sensible default for the detected language.
 */
export function detectTestCommand(projectDir: string, pm: PackageManager): string {
  const pkg = readPackageJson(projectDir);
  if (pkg?.scripts?.test) {
    const prefix = RUN_PREFIX[pm];
    return pm === 'npm' ? `${prefix} test` : `${prefix} test`;
  }
  // Non-JS fallbacks
  if (existsSync(join(projectDir, 'pyproject.toml'))) return 'pytest';
  if (existsSync(join(projectDir, 'go.mod'))) return 'go test ./...';
  if (existsSync(join(projectDir, 'Cargo.toml'))) return 'cargo test';
  return `${RUN_PREFIX[pm]} test`;
}

/**
 * Detect the dev command. Prefers package.json scripts.dev > scripts.start;
 * falls back to language-specific defaults.
 */
export function detectDevCommand(projectDir: string, pm: PackageManager): string {
  const pkg = readPackageJson(projectDir);
  const prefix = RUN_PREFIX[pm];
  if (pkg?.scripts?.dev) return `${prefix} dev`;
  if (pkg?.scripts?.start) return pm === 'npm' ? `${prefix} start` : `${prefix} start`;
  if (existsSync(join(projectDir, 'pyproject.toml'))) return 'python -m main';
  if (existsSync(join(projectDir, 'go.mod'))) return 'go run .';
  if (existsSync(join(projectDir, 'Cargo.toml'))) return 'cargo run';
  return `${prefix} dev`;
}

/**
 * Detect the repository's default branch. Prefers `origin/HEAD`, then falls
 * back to the local current branch, then to 'main'.
 */
export function detectBaseBranch(projectDir: string): string {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1]!;
  } catch {
    // origin/HEAD not set — fall through
  }

  try {
    const branches = execSync('git branch --list main master', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (/\bmain\b/.test(branches)) return 'main';
    if (/\bmaster\b/.test(branches)) return 'master';
  } catch {
    // Not a git repo — fall through
  }

  return 'main';
}

/**
 * Best-effort language detection for documentation-only purposes (used in
 * generated YAML comments).
 */
export function detectLanguage(projectDir: string): string {
  const pkg = readPackageJson(projectDir);
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['typescript']) return 'TypeScript';
    return 'JavaScript';
  }
  if (existsSync(join(projectDir, 'pyproject.toml'))) return 'Python';
  if (existsSync(join(projectDir, 'requirements.txt'))) return 'Python';
  if (existsSync(join(projectDir, 'go.mod'))) return 'Go';
  if (existsSync(join(projectDir, 'Cargo.toml'))) return 'Rust';
  return 'unknown';
}

/**
 * Detect a framework hint. Used only for the YAML comment so users can see we
 * recognized their stack.
 */
export function detectFramework(projectDir: string): string {
  const pkg = readPackageJson(projectDir);
  if (!pkg) return '';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps['next']) return 'Next.js';
  if (deps['nuxt']) return 'Nuxt';
  if (deps['react']) return 'React';
  if (deps['vue']) return 'Vue';
  if (deps['svelte']) return 'Svelte';
  if (deps['express']) return 'Express';
  if (deps['fastify']) return 'Fastify';
  if (deps['hono']) return 'Hono';
  return '';
}

/** Run all scan helpers and return a project profile. */
export function scanProject(projectDir: string): ProjectScan {
  const packageManager = detectPackageManager(projectDir);
  return {
    packageManager,
    testCommand: detectTestCommand(projectDir, packageManager),
    devCommand: detectDevCommand(projectDir, packageManager),
    baseBranch: detectBaseBranch(projectDir),
    language: detectLanguage(projectDir),
    framework: detectFramework(projectDir),
  };
}
