/**
 * Detect application and agent security surfaces from project context and files.
 * File signals decide application surfaces. The agent surface is present only when
 * the selected agent's project MCP config names at least one server.
 * An optional model call may return only the closed application-surface set.
 * Any other JSON is discarded and the file signals stand.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentType } from './agent.js';

export const APPLICATION_SURFACES = [
  'public-http',
  'credentials-at-rest',
  'command-execution',
  'cloud-control-plane',
] as const;

export const AGENT_SURFACE = 'mcp' as const;

export type ApplicationSurface = (typeof APPLICATION_SURFACES)[number];
export type SecuritySurface = ApplicationSurface | typeof AGENT_SURFACE;

export type SurfaceSignal = {
  surface: SecuritySurface;
  detected: boolean;
  signals: string[];
};

export type SurfaceDetectionResult = {
  /** Surfaces that passed detection (application + mcp when present). */
  detected: SecuritySurface[];
  /** Application surfaces only (excludes mcp). */
  application: ApplicationSurface[];
  /** Full signal report for every closed surface, including negatives. */
  signals: SurfaceSignal[];
  /** MCP server names from the selected agent's project config. */
  mcpServers: string[];
  /** True when the agent surface was detected. */
  agentSurface: boolean;
};

export type DetectSecuritySurfacesInput = {
  projectDir: string;
  agent: AgentType | string;
  /** Optional model JSON. Only a closed application-surface set is accepted. */
  modelSurfaces?: unknown;
};

const APPLICATION_SURFACE_SET = new Set<string>(APPLICATION_SURFACES);

const HTTP_CONTEXT_RE = /\b(http|https|express|fastify|koa|next\.?js|hono|nest|flask|django|rails|api\s+route|public\s+route|webhook|rest\s+api|graphql)\b/i;
const CREDENTIAL_CONTEXT_RE = /\b(auth|oauth|jwt|credential|secret|password|api[_\s-]?key|token\s+storage|keychain|vault|session\s+store)\b/i;
const SHELL_CONTEXT_RE = /\b(shell|bash|zsh|powershell|child_process|subprocess|exec\(|spawn\(|command\s+execution|cli\s+entry)\b/i;
const CLOUD_CONTEXT_RE = /\b(terraform|cloudformation|pulumi|aws\s+sdk|azure\s+sdk|google\s+cloud|gcp|boto3|kubernetes|eks|gke|aks|cloud\s+control)\b/i;

const CLOUD_DEP_RE = /^(aws-sdk|@aws-sdk\/|@google-cloud\/|@azure\/|@pulumi\/|boto3|google-cloud|azure-identity|terraform)/i;
const HTTP_DEP_RE = /^(express|fastify|koa|hono|@nestjs\/|next|nuxt|@remix-run\/|astro|@hapi\/|restify)$/i;

/**
 * Accept model output only when it is a list (or {surfaces: list}) of
 * closed application-surface ids. Anything else returns null.
 */
export function parseModelApplicationSurfaces(value: unknown): ApplicationSurface[] | null {
  const list = extractSurfaceList(value);
  if (list === null) return null;
  const accepted: ApplicationSurface[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== 'string') return null;
    const surface = entry.trim();
    if (!APPLICATION_SURFACE_SET.has(surface)) return null;
    if (seen.has(surface)) continue;
    seen.add(surface);
    accepted.push(surface as ApplicationSurface);
  }
  return accepted;
}

export function detectSecuritySurfaces(input: DetectSecuritySurfacesInput): SurfaceDetectionResult {
  const context = readContext(input.projectDir);
  const fileIndex = indexProjectFiles(input.projectDir);
  const packageDeps = readPackageDeps(input.projectDir);
  const matches = (rel: string, pattern: RegExp): boolean => fileMatches(input.projectDir, rel, pattern);

  const httpSignals: string[] = [];
  if (HTTP_CONTEXT_RE.test(context)) httpSignals.push('context:http-entry');
  for (const dep of packageDeps) {
    if (HTTP_DEP_RE.test(dep)) httpSignals.push(`dependency:${dep}`);
  }
  for (const path of fileIndex.relativePaths) {
    if (/(^|\/)(app|pages)\/api(\/|$)/.test(path)) httpSignals.push(`path:${path}`);
    else if (/(^|\/)(routes|server|http)(\/|$)/.test(path) && /\.(ts|js|tsx|jsx|py|go)$/.test(path)) {
      httpSignals.push(`path:${path}`);
    } else if (/(^|\/)(server|app|main)\.(ts|js|tsx|jsx|py|go)$/.test(path)) {
      if (matches(path, /\b(listen\(|createServer\(|express\(|fastify\(|NextResponse)\b/)) {
        httpSignals.push(`path:${path}`);
      }
    }
  }

  const credentialSignals: string[] = [];
  if (CREDENTIAL_CONTEXT_RE.test(context)) credentialSignals.push('context:credentials');
  for (const path of fileIndex.relativePaths) {
    if (/(^|\/)(\.env|\.env\.example|\.env\.local)$/.test(path)) credentialSignals.push(`path:${path}`);
    else if (/(^|\/)(auth|secrets|credentials)(\/|$)/i.test(path)) credentialSignals.push(`path:${path}`);
  }

  const shellSignals: string[] = [];
  if (SHELL_CONTEXT_RE.test(context)) shellSignals.push('context:shell');
  if (packageDeps.includes('execa')) shellSignals.push('dependency:execa');
  if (packageDeps.includes('shelljs')) shellSignals.push('dependency:shelljs');
  for (const path of fileIndex.relativePaths) {
    if (/\.(sh|bash|zsh|ps1)$/.test(path)) shellSignals.push(`path:${path}`);
    else if (/(^|\/)(scripts|bin)(\/|$)/.test(path) && /\.(ts|js|mjs|cjs|py)$/.test(path)) {
      shellSignals.push(`path:${path}`);
    } else if (/\.(ts|js|mjs|cjs)$/.test(path)
      && matches(path, /from ['"]node:child_process['"]|require\(['"]child_process['"]\)/)) {
      shellSignals.push(`import:child_process:${path}`);
    }
  }

  const cloudSignals: string[] = [];
  if (CLOUD_CONTEXT_RE.test(context)) cloudSignals.push('context:cloud');
  for (const dep of packageDeps) {
    if (CLOUD_DEP_RE.test(dep)) cloudSignals.push(`dependency:${dep}`);
  }
  for (const path of fileIndex.relativePaths) {
    if (/\.tf$/.test(path) || /(^|\/)terraform(\/|$)/i.test(path)) cloudSignals.push(`path:${path}`);
    else if (/(^|\/)(Pulumi\.ya?ml|cloudformation|cdk\.json)$/i.test(path)) cloudSignals.push(`path:${path}`);
  }

  const applicationDetected = new Set<ApplicationSurface>();
  if (httpSignals.length > 0) applicationDetected.add('public-http');
  if (credentialSignals.length > 0) applicationDetected.add('credentials-at-rest');
  if (shellSignals.length > 0) applicationDetected.add('command-execution');
  if (cloudSignals.length > 0) applicationDetected.add('cloud-control-plane');

  // Model may only add members of the closed application set. It cannot invent
  // surfaces, and it cannot clear a file-signal detection.
  const modelSurfaces = parseModelApplicationSurfaces(input.modelSurfaces);
  if (modelSurfaces) {
    for (const surface of modelSurfaces) applicationDetected.add(surface);
  }

  const mcpServers = listAgentMcpServers(input.projectDir, input.agent);
  const agentSurface = mcpServers.length > 0;

  const signals: SurfaceSignal[] = [
    { surface: 'public-http', detected: applicationDetected.has('public-http'), signals: unique(httpSignals) },
    { surface: 'credentials-at-rest', detected: applicationDetected.has('credentials-at-rest'), signals: unique(credentialSignals) },
    { surface: 'command-execution', detected: applicationDetected.has('command-execution'), signals: unique(shellSignals) },
    { surface: 'cloud-control-plane', detected: applicationDetected.has('cloud-control-plane'), signals: unique(cloudSignals) },
    {
      surface: AGENT_SURFACE,
      detected: agentSurface,
      signals: agentSurface
        ? mcpServers.map((name) => `mcp:${name}`)
        : ['no MCP server named for selected agent'],
    },
  ];

  const application = APPLICATION_SURFACES.filter((surface) => applicationDetected.has(surface));
  const detected: SecuritySurface[] = [...application];
  if (agentSurface) detected.push(AGENT_SURFACE);

  return { detected, application, signals, mcpServers, agentSurface };
}

/**
 * Surfaces offered in the technique checkbox for a given "show undetected" flag.
 * The agent profile stays absent unless MCP is configured, even when showing
 * undetected application surfaces.
 */
export function surfacesForSelector(
  detection: SurfaceDetectionResult,
  showUndetected: boolean,
): SecuritySurface[] {
  if (!showUndetected) return [...detection.detected];
  const surfaces: SecuritySurface[] = [...APPLICATION_SURFACES];
  if (detection.agentSurface) surfaces.push(AGENT_SURFACE);
  return surfaces;
}

export function listAgentMcpServers(projectDir: string, agent: AgentType | string): string[] {
  switch (normalizeAgent(agent)) {
    case 'claude':
    case 'lmstudio':
      return readClaudeMcpServers(projectDir);
    case 'codex':
    case 'ollama':
      return readCodexMcpServers(projectDir);
    case 'opencode':
      return readOpenCodeMcpServers(projectDir);
    default:
      return readClaudeMcpServers(projectDir);
  }
}

function extractSurfaceList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.surfaces)) return record.surfaces;
    if (Array.isArray(record.applicationSurfaces)) return record.applicationSurfaces;
  }
  return null;
}

function readContext(projectDir: string): string {
  const path = join(projectDir, '.alpha-loop', 'context.md');
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readPackageDeps(projectDir: string): string[] {
  const path = join(projectDir, 'package.json');
  if (!existsSync(path)) return [];
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  } catch {
    return [];
  }
}

type FileIndex = {
  relativePaths: string[];
};

function indexProjectFiles(projectDir: string): FileIndex {
  const relativePaths: string[] = [];
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.alpha-loop',
    '.next',
    '.turbo',
    'vendor',
  ]);

  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')
        && entry.name !== '.env'
        && entry.name !== '.env.example'
        && entry.name !== '.env.local'
        && entry.name !== '.mcp.json'
        && entry.name !== '.codex'
        && entry.name !== '.terraform') {
        continue;
      }
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(projectDir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        relativePaths.push(`${rel}/`);
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      relativePaths.push(rel);
    }
  };

  walk(projectDir, 0);
  return { relativePaths };
}

function fileMatches(projectDir: string, rel: string, pattern: RegExp): boolean {
  const full = join(projectDir, rel);
  try {
    if (!existsSync(full)) return false;
    const st = statSync(full);
    if (!st.isFile() || st.size > 512_000) return false;
    return pattern.test(readFileSync(full, 'utf8'));
  } catch {
    return false;
  }
}

function normalizeAgent(agent: string): AgentType {
  if (agent === 'claude' || agent === 'codex' || agent === 'opencode' || agent === 'lmstudio' || agent === 'ollama') {
    return agent;
  }
  return 'claude';
}

function readClaudeMcpServers(projectDir: string): string[] {
  const path = join(projectDir, '.mcp.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
      return [];
    }
    return Object.keys(parsed.mcpServers as Record<string, unknown>)
      .filter((key) => key.trim().length > 0)
      .sort();
  } catch {
    return [];
  }
}

function readCodexMcpServers(projectDir: string): string[] {
  const candidates = [
    join(projectDir, '.codex', 'config.toml'),
    join(projectDir, 'config.toml'),
  ];
  const names = new Set<string>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm)) {
        const name = match[1]?.trim();
        if (name) names.add(name);
      }
      const parsed = parseYaml(text) as Record<string, unknown> | null;
      const mcp = parsed?.mcp_servers;
      if (mcp && typeof mcp === 'object' && !Array.isArray(mcp)) {
        for (const key of Object.keys(mcp as Record<string, unknown>)) {
          if (key.trim()) names.add(key.trim());
        }
      }
    } catch {
      // ignore unreadable config
    }
  }
  return [...names].sort();
}

function readOpenCodeMcpServers(projectDir: string): string[] {
  const candidates = [
    join(projectDir, 'opencode.json'),
    join(projectDir, 'opencode.jsonc'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
      const jsonText = text.replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(jsonText) as { mcp?: unknown };
      if (!parsed.mcp || typeof parsed.mcp !== 'object' || Array.isArray(parsed.mcp)) continue;
      const mcp = parsed.mcp as Record<string, unknown>;
      if (mcp.servers && typeof mcp.servers === 'object' && !Array.isArray(mcp.servers)) {
        return Object.keys(mcp.servers as Record<string, unknown>)
          .filter((key) => key.trim().length > 0)
          .sort();
      }
      return Object.keys(mcp)
        .filter((key) => key !== 'servers' && key.trim().length > 0)
        .sort();
    } catch {
      // try next candidate
    }
  }
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
