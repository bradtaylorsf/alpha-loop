/**
 * Prerequisites Module
 * ====================
 *
 * Verifies that the configured AI CLI agent is installed before starting the pipeline.
 */

import { execSync } from 'node:child_process';
import type { Config, RoutingEndpoint, RoutingStageName } from '../lib/config.js';
import { resolveRoutingStage } from '../lib/config.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentCheckResult {
  agent: string;
  installed: boolean;
}

export interface PrerequisiteResult {
  ok: boolean;
  results: AgentCheckResult[];
}

// ============================================================================
// Agent Check
// ============================================================================

/**
 * Checks whether a CLI command is available on the system PATH.
 */
export function isCommandAvailable(command: string): boolean {
  // Validate command name to prevent shell injection from user-controlled config
  if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
    return false;
  }
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks that the configured agent CLI is installed. lmstudio/ollama
 * piggy-back on the claude/codex CLIs, so we probe those instead of looking
 * for a literal "lmstudio" / "ollama" binary on PATH.
 */
export function checkAgents(config: Config): PrerequisiteResult {
  const cliCommand = config.agent === 'lmstudio' ? 'claude'
    : config.agent === 'ollama' ? 'codex'
    : config.agent;
  const result: AgentCheckResult = {
    agent: config.agent,
    installed: isCommandAvailable(cliCommand),
  };

  return {
    ok: result.installed,
    results: [result],
  };
}

// ============================================================================
// Formatting
// ============================================================================

/**
 * Formats the prerequisite check results for console output.
 */
export function formatCheckResults(result: PrerequisiteResult): string {
  const lines: string[] = ['Checking agents...'];

  for (const r of result.results) {
    const icon = r.installed ? '\u2713' : '\u2717';
    lines.push(`  ${icon} ${r.agent}`);
  }

  if (!result.ok) {
    const missing = result.results.filter(r => !r.installed);
    for (const m of missing) {
      lines.push(`\nError: "${m.agent}" is not installed.`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats the pipeline startup summary.
 */
export function formatPipelineSummary(config: Config): string {
  return `Pipeline: ${config.agent}/${config.model}`;
}

// ============================================================================
// Local Endpoint Check
// ============================================================================

export interface LocalModelCheckResult {
  ok: boolean;
  /** List of model ids reported by the endpoint's /v1/models response. */
  loaded: string[];
  error?: string;
}

/**
 * Compose the /v1/models URL for an endpoint base URL. Accepts base URLs
 * with or without a trailing `/v1` segment.
 */
function buildModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Return true when the endpoint's base_url looks like a local/loopback server
 * — i.e. a check against it should be cheap and safe to run on every stage
 * start. Remote endpoints (api.anthropic.com etc.) aren't probed here.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    // URL.hostname wraps IPv6 addresses in brackets (e.g. "[::1]") — strip them.
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

/**
 * Verify that a local model server (LM Studio, Ollama, vLLM, etc.) is reachable
 * at `baseUrl` and is currently serving `model`. Uses the OpenAI-compatible
 * `/v1/models` response shape, which both LM Studio and Ollama expose even for
 * their Anthropic-compatible endpoints.
 *
 * Returns `{ ok: true }` iff the model id appears in the response. Otherwise
 * returns an actionable error describing what to do next.
 */
export async function checkLocalModel(
  baseUrl: string,
  model: string,
): Promise<LocalModelCheckResult> {
  if (!baseUrl) {
    return { ok: false, loaded: [], error: 'Missing base URL' };
  }
  const url = buildModelsUrl(baseUrl);

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, loaded: [], error: `Could not reach ${url}: ${msg}` };
  }

  if (!res.ok) {
    return { ok: false, loaded: [], error: `HTTP ${res.status} from ${url}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, loaded: [], error: `Invalid JSON from ${url}: ${msg}` };
  }

  const data = (body as { data?: unknown })?.data;
  const loaded = Array.isArray(data)
    ? (data as Array<{ id?: unknown }>)
        .map((m) => (typeof m?.id === 'string' ? m.id : ''))
        .filter((s) => s.length > 0)
    : [];

  if (!model) {
    return { ok: false, loaded, error: 'No model specified' };
  }

  if (!loaded.includes(model)) {
    const available = loaded.length > 0 ? loaded.join(', ') : '(none)';
    return {
      ok: false,
      loaded,
      error: `Model "${model}" is not loaded at ${baseUrl}. Available: ${available}`,
    };
  }

  return { ok: true, loaded };
}

/** Friendly label for common local endpoints, for use in error messages. */
function endpointLabel(endpoint: RoutingEndpoint): string {
  try {
    const port = new URL(endpoint.base_url).port;
    if (port === '1234') return 'LM Studio';
    if (port === '11434') return 'Ollama';
  } catch {
    // fall through
  }
  return 'Local model server';
}

export interface StagePrerequisiteResult {
  ok: boolean;
  /** Undefined when no local endpoint check was needed. */
  checked?: boolean;
  error?: string;
}

/**
 * Verify that the configured routing target for a stage is reachable before
 * the stage runs. No-op when the stage has no routing override or when the
 * resolved endpoint is remote. Returns an actionable error like
 * "Start LM Studio and load model <model>" when the local server is down or
 * the expected model isn't loaded.
 */
export async function checkStagePrerequisites(
  config: Config,
  stage: RoutingStageName,
): Promise<StagePrerequisiteResult> {
  const resolved = resolveRoutingStage(config, stage);
  if (!resolved || !resolved.endpoint) return { ok: true };

  const endpoint = resolved.endpoint;
  if (!isLocalEndpoint(endpoint.base_url)) return { ok: true };

  const result = await checkLocalModel(endpoint.base_url, resolved.model);
  if (result.ok) return { ok: true, checked: true };

  const label = endpointLabel(endpoint);
  const actionable = `Start ${label} and load model ${resolved.model}`;
  return {
    ok: false,
    checked: true,
    error: `${actionable} (${result.error ?? 'server did not respond'})`,
  };
}
