/**
 * API test response caching for AI-powered apps.
 *
 * Records real API responses on first run (RECORD_FIXTURES=true),
 * replays them from disk on subsequent runs. Keeps expensive
 * AI API calls out of the retry loop.
 */
import * as node_fs from 'node:fs';
import * as node_path from 'node:path';
import * as node_http from 'node:http';
import * as node_https from 'node:https';

export interface FixtureMetadata {
  recordedAt: string;
  service: string;
  estimatedCostUSD: number;
}

export interface FixtureEntry {
  request: {
    url: string;
    method: string;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  metadata: FixtureMetadata;
}

export interface MockExpensiveAPIOptions {
  /** Unique name for this fixture (used as filename) */
  name: string;
  /** URL pattern to intercept (string prefix or RegExp) */
  pattern: string | RegExp;
  /** Service name for metadata (e.g. "openai", "anthropic") */
  service?: string;
  /** Estimated cost per call in USD for metadata */
  estimatedCostUSD?: number;
  /** Directory to store fixtures (default: tests/fixtures) */
  fixturesDir?: string;
}

const FIXTURES_DIR_DEFAULT = node_path.resolve(
  process.cwd(),
  'tests',
  'fixtures',
);

const STALE_DAYS = 30;

/** Check whether we are in record mode */
export function isRecordMode(): boolean {
  return process.env.RECORD_FIXTURES === 'true';
}

/** Resolve the fixture file path for a given name */
export function fixturePathFor(
  name: string,
  fixturesDir: string = FIXTURES_DIR_DEFAULT,
): string {
  return node_path.join(fixturesDir, `${name}.fixture.json`);
}

/** Load a fixture from disk. Returns null when missing. */
export function loadFixture(filePath: string): FixtureEntry[] | null {
  if (!node_fs.existsSync(filePath)) return null;
  const raw = node_fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as FixtureEntry[];
}

/** Save fixture entries to disk. Creates directories as needed. */
export function saveFixture(filePath: string, entries: FixtureEntry[]): void {
  const dir = node_path.dirname(filePath);
  if (!node_fs.existsSync(dir)) {
    node_fs.mkdirSync(dir, { recursive: true });
  }
  node_fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

/**
 * Return warnings for stale fixtures (older than 30 days).
 * Callers can log or assert on these as they see fit.
 */
export function checkStaleness(entries: FixtureEntry[]): string[] {
  const warnings: string[] = [];
  const now = Date.now();
  for (const entry of entries) {
    const age = now - new Date(entry.metadata.recordedAt).getTime();
    const days = age / (1000 * 60 * 60 * 24);
    if (days > STALE_DAYS) {
      warnings.push(
        `Fixture for ${entry.request.method} ${entry.request.url} is ${Math.floor(days)} days old (recorded ${entry.metadata.recordedAt}). Re-record with RECORD_FIXTURES=true.`,
      );
    }
  }
  return warnings;
}

function matchesPattern(
  url: string,
  pattern: string | RegExp,
): boolean {
  if (typeof pattern === 'string') return url.startsWith(pattern);
  return pattern.test(url);
}

/**
 * Intercept HTTP/HTTPS requests matching `pattern`.
 *
 * - In **replay mode** (default): serves responses from the fixture file.
 *   Throws if no fixture exists — run once with RECORD_FIXTURES=true first.
 *
 * - In **record mode** (RECORD_FIXTURES=true): lets the real request through,
 *   captures the response, and writes the fixture file on `restore()`.
 *
 * Returns a handle with `restore()` to undo the monkey-patch and
 * `entries` to inspect what was captured/replayed.
 */
export function mockExpensiveAPI(opts: MockExpensiveAPIOptions): {
  restore: () => void;
  entries: FixtureEntry[];
  warnings: string[];
} {
  const {
    name,
    pattern,
    service = 'unknown',
    estimatedCostUSD = 0,
    fixturesDir = FIXTURES_DIR_DEFAULT,
  } = opts;

  const filePath = fixturePathFor(name, fixturesDir);
  const recording = isRecordMode();
  const recorded: FixtureEntry[] = [];
  const warnings: string[] = [];

  // In replay mode, load existing fixtures
  let replayQueue: FixtureEntry[] = [];
  if (!recording) {
    const loaded = loadFixture(filePath);
    if (!loaded) {
      throw new Error(
        `No fixture found for "${name}" at ${filePath}. Run with RECORD_FIXTURES=true to record.`,
      );
    }
    replayQueue = [...loaded];
    warnings.push(...checkStaleness(loaded));
  }

  // Monkey-patch http and https request
  const originalHttpRequest = node_http.request;
  const originalHttpsRequest = node_https.request;

  function createPatcher(
    original: typeof node_http.request,
  ): typeof node_http.request {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return function patchedRequest(...args: any[]): node_http.ClientRequest {
      // Determine the URL from the arguments
      let url: string | undefined;
      const firstArg = args[0];
      if (typeof firstArg === 'string') {
        url = firstArg;
      } else if (firstArg instanceof URL) {
        url = firstArg.toString();
      } else if (firstArg && typeof firstArg === 'object' && 'hostname' in firstArg) {
        const o = firstArg as node_http.RequestOptions;
        const proto = o.protocol ?? 'https:';
        url = `${proto}//${o.hostname}${o.port ? ':' + o.port : ''}${o.path ?? '/'}`;
      }

      if (!url || !matchesPattern(url, pattern)) {
        return original.apply(null, args as never) as node_http.ClientRequest;
      }

      const method =
        (typeof firstArg === 'object' && !(firstArg instanceof URL)
          ? (firstArg as node_http.RequestOptions).method
          : 'GET') ?? 'GET';

      if (!recording) {
        // --- Replay mode ---
        const entry = replayQueue.shift();
        if (!entry) {
          throw new Error(
            `Fixture "${name}" exhausted: no more recorded responses for ${method} ${url}`,
          );
        }

        // Build a fake ClientRequest that immediately emits a response
        const fakeReq = new node_http.ClientRequest(
          // Provide a minimal options object so the constructor doesn't throw
          { host: 'localhost', protocol: 'http:' },
        );

        // Suppress the actual connection attempt
        fakeReq.destroy();

        // Defer so callers can attach listeners
        process.nextTick(() => {
          const fakeRes = new node_http.IncomingMessage(
            new (require('node:net').Socket)(),
          );
          fakeRes.statusCode = entry.response.status;
          Object.assign(fakeRes.headers, entry.response.headers);

          fakeReq.emit('response', fakeRes);

          const bodyStr =
            typeof entry.response.body === 'string'
              ? entry.response.body
              : JSON.stringify(entry.response.body);
          fakeRes.push(Buffer.from(bodyStr));
          fakeRes.push(null);
        });

        return fakeReq;
      }

      // --- Record mode: let real request through, capture response ---
      const realReq = original.apply(null, args as never) as node_http.ClientRequest;

      // Capture request body
      const origWrite = realReq.write.bind(realReq);
      const bodyChunks: Buffer[] = [];
      realReq.write = function (
        chunk: unknown,
        ...rest: unknown[]
      ): boolean {
        if (chunk) bodyChunks.push(Buffer.from(chunk as string));
        return origWrite(chunk, ...(rest as [unknown]));
      } as typeof realReq.write;

      realReq.on('response', (res: node_http.IncomingMessage) => {
        const resChunks: Buffer[] = [];
        res.on('data', (c: Buffer) => resChunks.push(c));
        res.on('end', () => {
          let body: unknown;
          const raw = Buffer.concat(resChunks).toString('utf-8');
          try {
            body = JSON.parse(raw);
          } catch {
            body = raw;
          }

          let reqBody: unknown;
          if (bodyChunks.length) {
            const rawReqBody = Buffer.concat(bodyChunks).toString('utf-8');
            try {
              reqBody = JSON.parse(rawReqBody);
            } catch {
              reqBody = rawReqBody;
            }
          }

          const entry: FixtureEntry = {
            request: { url: url!, method, body: reqBody ?? null },
            response: {
              status: res.statusCode ?? 200,
              headers: Object.fromEntries(
                Object.entries(res.headers).filter(
                  ([, v]) => typeof v === 'string',
                ),
              ) as Record<string, string>,
              body,
            },
            metadata: {
              recordedAt: new Date().toISOString(),
              service,
              estimatedCostUSD,
            },
          };
          recorded.push(entry);
        });
      });

      return realReq;
    } as typeof node_http.request;
  }

  // Apply patches
  (node_http as { request: typeof node_http.request }).request =
    createPatcher(originalHttpRequest);
  (node_https as { request: typeof node_https.request }).request =
    createPatcher(originalHttpsRequest);

  function restore(): void {
    (node_http as { request: typeof node_http.request }).request =
      originalHttpRequest;
    (node_https as { request: typeof node_https.request }).request =
      originalHttpsRequest;

    // Persist recorded fixtures
    if (recording && recorded.length > 0) {
      saveFixture(filePath, recorded);
    }
  }

  return {
    restore,
    entries: recording ? recorded : replayQueue,
    warnings,
  };
}
