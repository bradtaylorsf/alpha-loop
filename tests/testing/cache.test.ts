import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  mockExpensiveAPI,
  loadFixture,
  saveFixture,
  checkStaleness,
  fixturePathFor,
  isRecordMode,
  FixtureEntry,
} from '../../src/testing/cache';

/** Create a temp directory for fixture files that is cleaned up after tests */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
}

function makeEntry(overrides: Partial<FixtureEntry> = {}): FixtureEntry {
  return {
    request: { url: 'https://api.openai.com/v1/chat', method: 'POST', body: { prompt: 'hi' } },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: { text: 'hello' } },
    metadata: { recordedAt: new Date().toISOString(), service: 'openai', estimatedCostUSD: 0.01 },
    ...overrides,
  };
}

describe('fixturePathFor', () => {
  it('resolves to <dir>/<name>.fixture.json', () => {
    const result = fixturePathFor('my-test', '/tmp/fixtures');
    expect(result).toBe('/tmp/fixtures/my-test.fixture.json');
  });
});

describe('isRecordMode', () => {
  const origEnv = process.env.RECORD_FIXTURES;

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.RECORD_FIXTURES;
    } else {
      process.env.RECORD_FIXTURES = origEnv;
    }
  });

  it('returns true when RECORD_FIXTURES=true', () => {
    process.env.RECORD_FIXTURES = 'true';
    expect(isRecordMode()).toBe(true);
  });

  it('returns false when RECORD_FIXTURES is unset', () => {
    delete process.env.RECORD_FIXTURES;
    expect(isRecordMode()).toBe(false);
  });

  it('returns false when RECORD_FIXTURES is something else', () => {
    process.env.RECORD_FIXTURES = 'false';
    expect(isRecordMode()).toBe(false);
  });
});

describe('loadFixture / saveFixture', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for missing fixture', () => {
    expect(loadFixture(path.join(tmpDir, 'nope.json'))).toBeNull();
  });

  it('round-trips fixture entries', () => {
    const entries = [makeEntry()];
    const fp = path.join(tmpDir, 'test.fixture.json');
    saveFixture(fp, entries);
    const loaded = loadFixture(fp);
    expect(loaded).toEqual(entries);
  });

  it('creates nested directories', () => {
    const fp = path.join(tmpDir, 'a', 'b', 'deep.fixture.json');
    saveFixture(fp, [makeEntry()]);
    expect(fs.existsSync(fp)).toBe(true);
  });
});

describe('checkStaleness', () => {
  it('returns no warnings for fresh fixtures', () => {
    const entries = [makeEntry()];
    expect(checkStaleness(entries)).toEqual([]);
  });

  it('warns for fixtures older than 30 days', () => {
    const old = new Date();
    old.setDate(old.getDate() - 45);
    const entries = [makeEntry({ metadata: { recordedAt: old.toISOString(), service: 'openai', estimatedCostUSD: 0 } })];
    const warnings = checkStaleness(entries);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('45 days old');
    expect(warnings[0]).toContain('RECORD_FIXTURES=true');
  });
});

describe('mockExpensiveAPI', () => {
  let tmpDir: string;
  const origEnv = process.env.RECORD_FIXTURES;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    delete process.env.RECORD_FIXTURES;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) {
      delete process.env.RECORD_FIXTURES;
    } else {
      process.env.RECORD_FIXTURES = origEnv;
    }
  });

  it('throws when fixture is missing in replay mode', () => {
    expect(() =>
      mockExpensiveAPI({
        name: 'missing',
        pattern: 'https://api.openai.com',
        fixturesDir: tmpDir,
      }),
    ).toThrow(/No fixture found/);
  });

  it('replays from existing fixture file', () => {
    // Pre-seed a fixture
    const entries = [makeEntry()];
    saveFixture(path.join(tmpDir, 'replay-test.fixture.json'), entries);

    const mock = mockExpensiveAPI({
      name: 'replay-test',
      pattern: 'https://api.openai.com',
      fixturesDir: tmpDir,
    });

    try {
      // entries should be the replay queue
      expect(mock.entries).toHaveLength(1);
      expect(mock.entries[0].response.body).toEqual({ text: 'hello' });
    } finally {
      mock.restore();
    }
  });

  it('reports staleness warnings on replay', () => {
    const old = new Date();
    old.setDate(old.getDate() - 60);
    const entries = [makeEntry({ metadata: { recordedAt: old.toISOString(), service: 'openai', estimatedCostUSD: 0 } })];
    saveFixture(path.join(tmpDir, 'stale.fixture.json'), entries);

    const mock = mockExpensiveAPI({
      name: 'stale',
      pattern: 'https://api.openai.com',
      fixturesDir: tmpDir,
    });

    try {
      expect(mock.warnings.length).toBeGreaterThan(0);
      expect(mock.warnings[0]).toContain('days old');
    } finally {
      mock.restore();
    }
  });

  it('supports RegExp patterns', () => {
    const entries = [makeEntry({ request: { url: 'https://api.anthropic.com/v1/messages', method: 'POST', body: null } })];
    saveFixture(path.join(tmpDir, 'regex.fixture.json'), entries);

    const mock = mockExpensiveAPI({
      name: 'regex',
      pattern: /api\.anthropic\.com/,
      fixturesDir: tmpDir,
    });

    try {
      expect(mock.entries).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  it('preserves metadata in fixtures', () => {
    const entries = [
      makeEntry({
        metadata: {
          recordedAt: '2025-01-15T10:00:00.000Z',
          service: 'anthropic',
          estimatedCostUSD: 0.05,
        },
      }),
    ];
    saveFixture(path.join(tmpDir, 'meta.fixture.json'), entries);

    const mock = mockExpensiveAPI({
      name: 'meta',
      pattern: 'https://api.openai.com',
      fixturesDir: tmpDir,
    });

    try {
      expect(mock.entries[0].metadata.service).toBe('anthropic');
      expect(mock.entries[0].metadata.estimatedCostUSD).toBe(0.05);
    } finally {
      mock.restore();
    }
  });
});
