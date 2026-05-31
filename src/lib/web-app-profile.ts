import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { exec } from './shell.js';
import type {
  Config,
  WebAppConfig,
  WebAppScreenshotConfig,
  WebAppViewportPreset,
} from './config.js';

export type WebAppViewport = {
  preset: WebAppViewportPreset;
  width: number;
  height: number;
};

export type WebAppScreenshotPlan = {
  name: string;
  url: string;
  fullUrl: string;
  viewport: WebAppViewport;
  path: string;
  relativePath: string;
};

export type WebAppProfile = {
  setupCommand: string;
  buildCommand: string;
  testCommand: string;
  devCommand: string;
  devUrl: string;
  smokeTest: string;
  screenshots: WebAppScreenshotPlan[];
  preview: {
    url: string;
    command: string;
    required: boolean;
  };
  artifactPath: string;
  artifactRelativePath: string;
};

export type WebAppPreviewResolution = {
  url: string | null;
  source: 'url' | 'command' | 'none';
  required: boolean;
  command?: string;
  output?: string;
  exitCode?: number;
  error?: string;
};

export type WebAppVerificationSummary = {
  artifactPath: string;
  browserResultPath: string;
  screenshots: string[];
  previewUrl: string | null;
  devUrl: string;
  consoleErrors: string[];
  networkErrors: string[];
  passed: boolean;
  skipped: boolean;
  summary: string;
};

export type WebAppPRContext = Partial<WebAppVerificationSummary> & {
  qaChecklist?: string[];
  previewResolution?: WebAppPreviewResolution | null;
};

type PackageJson = {
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const VIEWPORTS: Record<WebAppViewportPreset, Omit<WebAppViewport, 'preset'>> = {
  desktop: { width: 1440, height: 1000 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
};

function projectRelative(filePath: string, projectDir = process.cwd()): string {
  const rel = relative(projectDir, filePath);
  return rel && !rel.startsWith('..') ? rel : filePath;
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'screenshot';
}

function readPackageJson(worktree: string): PackageJson | null {
  const filePath = join(worktree, 'package.json');
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8')) as PackageJson;
  } catch {
    return null;
  }
}

function packageRunner(pkg: PackageJson | null): string {
  const manager = pkg?.packageManager?.split('@')[0]?.trim();
  if (manager === 'npm') return 'npm run';
  if (manager === 'yarn') return 'yarn';
  if (manager === 'bun') return 'bun run';
  return 'pnpm';
}

function scriptCommand(pkg: PackageJson | null, script: string): string {
  if (!pkg?.scripts?.[script]) return '';
  const runner = packageRunner(pkg);
  return runner === 'npm run' || runner === 'bun run'
    ? `${runner} ${script}`
    : `${runner} ${script}`;
}

function allDependencies(pkg: PackageJson | null): Record<string, string> {
  return {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };
}

function detectDefaultDevUrl(pkg: PackageJson | null): string {
  const deps = allDependencies(pkg);
  if ('astro' in deps) return 'http://localhost:4321';
  if ('vite' in deps || '@vitejs/plugin-react' in deps) return 'http://localhost:5173';
  if ('next' in deps) return 'http://localhost:3000';
  return 'http://localhost:3000';
}

function normalizeUrlPath(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '/';
  return trimmed;
}

function fullUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  try {
    return new URL(pathOrUrl, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  } catch {
    return pathOrUrl;
  }
}

function screenshotDefaults(config: WebAppConfig, pkg: PackageJson | null): WebAppScreenshotConfig[] {
  if (config.screenshots.length > 0) return config.screenshots;
  const deps = allDependencies(pkg);
  const defaultName = 'home';
  const url = '/';
  if ('astro' in deps || 'next' in deps || 'vite' in deps || '@vitejs/plugin-react' in deps) {
    return [
      { name: `${defaultName}-desktop`, url, viewport: 'desktop' },
      { name: `${defaultName}-mobile`, url, viewport: 'mobile' },
    ];
  }
  return [{ name: `${defaultName}-desktop`, url, viewport: 'desktop' }];
}

function screenshotPlan(
  config: WebAppConfig,
  pkg: PackageJson | null,
  args: { sessionDir: string; issueNum: number; devUrl: string },
): WebAppScreenshotPlan[] {
  const dir = join(args.sessionDir, 'screenshots', `issue-${args.issueNum}`);
  return screenshotDefaults(config, pkg).map((shot) => {
    const preset = shot.viewport;
    const base = VIEWPORTS[preset];
    const viewport = {
      preset,
      width: shot.width ?? base.width,
      height: shot.height ?? base.height,
    };
    const filePath = join(dir, `${safeName(shot.name)}.png`);
    return {
      name: shot.name,
      url: normalizeUrlPath(shot.url),
      fullUrl: fullUrl(args.devUrl, normalizeUrlPath(shot.url)),
      viewport,
      path: filePath,
      relativePath: projectRelative(filePath),
    };
  });
}

export function normalizeWebAppProfile(
  config: Config,
  args: { worktree: string; sessionDir: string; issueNum: number },
): WebAppProfile | null {
  const raw = config.webApp;
  if (!raw) return null;

  const pkg = readPackageJson(args.worktree);
  const devCommand = raw.devCommand || config.devCommand || scriptCommand(pkg, 'dev') || scriptCommand(pkg, 'start');
  const devUrl = raw.devUrl || detectDefaultDevUrl(pkg);
  const artifactPath = join(args.sessionDir, 'web-app-verification', `issue-${args.issueNum}.json`);

  return {
    setupCommand: raw.setupCommand || config.setupCommand,
    buildCommand: raw.buildCommand || scriptCommand(pkg, 'build'),
    testCommand: raw.testCommand || config.testCommand,
    devCommand,
    devUrl,
    smokeTest: raw.smokeTest || config.smokeTest,
    screenshots: screenshotPlan(raw, pkg, { ...args, devUrl }),
    preview: {
      url: raw.preview.url,
      command: raw.preview.command,
      required: raw.preview.required,
    },
    artifactPath,
    artifactRelativePath: projectRelative(artifactPath),
  };
}

export function extractFirstUrl(output: string): string | null {
  const match = output.match(/https?:\/\/[^\s<>"')]+/i);
  return match?.[0] ?? null;
}

export function resolveWebAppPreviewUrl(
  profile: WebAppProfile,
  cwd: string,
  args: { prUrl?: string | null; timeout?: number } = {},
): WebAppPreviewResolution {
  if (profile.preview.url) {
    return {
      url: profile.preview.url,
      source: 'url',
      required: profile.preview.required,
    };
  }

  if (!profile.preview.command) {
    return {
      url: null,
      source: 'none',
      required: profile.preview.required,
      error: profile.preview.required ? 'Preview URL is required but no preview.url or preview.command is configured.' : undefined,
    };
  }

  const result = exec(profile.preview.command, {
    cwd,
    timeout: args.timeout ?? 60_000,
    env: {
      ALPHA_LOOP_PR_URL: args.prUrl ?? '',
    },
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  const url = result.exitCode === 0 ? extractFirstUrl(output) : null;
  return {
    url,
    source: 'command',
    required: profile.preview.required,
    command: profile.preview.command,
    output,
    exitCode: result.exitCode,
    error: url
      ? undefined
      : result.exitCode === 0
        ? 'Preview command completed but did not print an http(s) URL.'
        : `Preview command failed with exit code ${result.exitCode}.`,
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

function readExistingBrowserArtifact(filePath: string): Partial<WebAppVerificationSummary> | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const browser = parsed.browser && typeof parsed.browser === 'object'
      ? parsed.browser as Record<string, unknown>
      : {};
    return {
      consoleErrors: stringList(parsed.consoleErrors ?? parsed.console_errors ?? browser.consoleErrors ?? browser.console_errors),
      networkErrors: stringList(parsed.networkErrors ?? parsed.network_errors ?? browser.networkErrors ?? browser.network_errors),
      summary: String(parsed.summary ?? browser.summary ?? ''),
      passed: parsed.passed === true || browser.passed === true,
      skipped: parsed.skipped === true || browser.skipped === true,
      previewUrl: parsed.previewUrl || parsed.preview_url ? String(parsed.previewUrl ?? parsed.preview_url) : null,
    };
  } catch {
    return null;
  }
}

export function collectWebAppVerificationSummary(
  profile: WebAppProfile,
  args: {
    issueNum: number;
    passed: boolean;
    skipped: boolean;
    output: string;
    previewUrl?: string | null;
  },
): WebAppVerificationSummary {
  mkdirSync(dirname(profile.artifactPath), { recursive: true });
  const existing = readExistingBrowserArtifact(profile.artifactPath);
  const summary: WebAppVerificationSummary = {
    artifactPath: profile.artifactRelativePath,
    browserResultPath: profile.artifactRelativePath,
    screenshots: profile.screenshots.map((shot) => shot.relativePath),
    previewUrl: existing?.previewUrl ?? args.previewUrl ?? (profile.preview.url || null),
    devUrl: profile.devUrl,
    consoleErrors: existing?.consoleErrors ?? [],
    networkErrors: existing?.networkErrors ?? [],
    passed: existing?.passed ?? args.passed,
    skipped: existing?.skipped ?? args.skipped,
    summary: existing?.summary || (args.output.trim().split('\n').find(Boolean) ?? 'Web app verification completed.'),
  };

  if (!existing) {
    const artifact = {
      version: 1,
      issueNum: args.issueNum,
      devUrl: profile.devUrl,
      previewUrl: summary.previewUrl,
      screenshots: profile.screenshots.map((shot) => ({
        name: shot.name,
        url: shot.fullUrl,
        viewport: shot.viewport,
        path: shot.relativePath,
      })),
      browser: {
        passed: args.passed,
        skipped: args.skipped,
        summary: summary.summary,
        consoleErrors: summary.consoleErrors,
        networkErrors: summary.networkErrors,
      },
    };
    writeFileSync(profile.artifactPath, JSON.stringify(artifact, null, 2) + '\n');
  }

  return summary;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items.map((value) => value.trim()).filter(Boolean)) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function buildWebAppQaChecklist(args: {
  issueNum: number;
  profile: WebAppProfile;
  verification?: WebAppVerificationSummary | null;
  planChecklist?: string[];
}): string[] {
  const targetUrl = args.verification?.previewUrl ?? (args.profile.preview.url || args.profile.devUrl);
  const screenshots = args.verification?.screenshots ?? args.profile.screenshots.map((shot) => shot.relativePath);
  return dedupe([
    ...(targetUrl ? [`Open ${targetUrl} and confirm issue #${args.issueNum} works in the browser.`] : []),
    ...args.profile.screenshots.map((shot) => `Review ${shot.name} at ${shot.viewport.preset} viewport (${shot.relativePath}).`),
    ...(screenshots.length === 0 ? ['Capture or review at least one browser screenshot before approving.'] : []),
    `Confirm the browser console has no unexpected errors (${args.profile.artifactRelativePath}).`,
    `Confirm network failures are expected or resolved (${args.profile.artifactRelativePath}).`,
    ...(args.planChecklist ?? []),
  ]);
}

function boolStatus(value: boolean | undefined, ok = 'none'): string {
  return value === undefined ? 'unknown' : value ? ok : 'see artifact';
}

export function formatWebAppPRSection(context: WebAppPRContext | null | undefined): string[] {
  if (!context) return [];
  const lines: string[] = ['## Web App Preview', ''];
  const previewUrl = context.previewUrl ?? context.previewResolution?.url ?? null;
  if (previewUrl) lines.push(`- Preview: ${previewUrl}`);
  if (context.devUrl) lines.push(`- Local dev URL: ${context.devUrl}`);
  if (context.artifactPath || context.browserResultPath) {
    lines.push(`- Browser results: \`${context.browserResultPath ?? context.artifactPath}\``);
  }
  if (context.previewResolution?.error) {
    lines.push(`- Preview discovery: ${context.previewResolution.error}`);
  }
  lines.push('');

  if (context.screenshots && context.screenshots.length > 0) {
    lines.push('### Screenshots', '');
    for (const screenshot of context.screenshots) {
      lines.push(`- \`${screenshot}\``);
    }
    lines.push('');
  }

  lines.push('### Browser Checks', '');
  lines.push(`- Console errors: ${context.consoleErrors && context.consoleErrors.length > 0 ? context.consoleErrors.join('; ') : boolStatus(context.passed, 'none reported')}`);
  lines.push(`- Network failures: ${context.networkErrors && context.networkErrors.length > 0 ? context.networkErrors.join('; ') : boolStatus(context.passed, 'none reported')}`);
  lines.push('');

  if (context.qaChecklist && context.qaChecklist.length > 0) {
    lines.push('## Human QA Checklist', '');
    for (const item of context.qaChecklist) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
  }

  return lines;
}
